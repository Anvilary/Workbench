/**
 * Operations on the browser storage of a profile: clone, clear the sign-in of one
 * site and delete. They quiesce the live views and popups of the affected
 * partitions first so page scripts cannot re-persist state while it is cleared.
 */

import { partitionForBrowserProfile } from '../../policy.mjs';
import { cloneBrowserProfileStorage, clearProfileSiteAuth, deleteBrowserProfileStorage } from '../security/browser-profile-storage.mjs';

export function createProfileOperations({ electron, state, sessions, closeView }) {
  const { session } = electron;
  const { views, urls, requestedUrls, profileIds, failures, tabFavicons, suspendedTabs, cloningProfiles, popups, popupOwners } = state;
  const { configuredPartitions, sessionProviders } = sessions;

  async function cloneProfile(command) {
    const { sourceProfileId, targetProfileId, clearSites } = command;
    if (cloningProfiles.has(sourceProfileId) || cloningProfiles.has(targetProfileId) ||
        [...profileIds.values()].includes(targetProfileId)) {
      throw new Error('Browser profile clone destination is in use');
    }
    cloningProfiles.add(sourceProfileId);
    cloningProfiles.add(targetProfileId);
    try {
      return await cloneBrowserProfileStorage({ sessionApi: session, sourceProfileId, targetProfileId, clearSites });
    } finally {
      cloningProfiles.delete(sourceProfileId);
      cloningProfiles.delete(targetProfileId);
    }
  }

  async function clearProfileSite(command) {
    if (cloningProfiles.has(command.profileId)) throw new Error('Browser profile operation is in progress');
    const targetProvider = command.site === 'browser' ? 'other' : command.site;
    const targetSession = session.fromPartition(partitionForBrowserProfile(
      command.profileId, targetProvider,
    ));
    cloningProfiles.add(command.profileId);
    try {
      for (const popup of [...popups]) {
        try {
          if (!popup.isDestroyed() && popup.webContents.session === targetSession) {
            popupOwners.delete(popup.webContents);
            popups.delete(popup);
            popup.destroy();
          }
        } catch {}
      }
      // Quiesce live views on the target partition before clearing storage/cache
      // so active page scripts cannot race and re-persist auth state.
      const viewsToReload = [];
      for (const [id, view] of views.entries()) {
        if (!view.webContents.isDestroyed() && view.webContents.session === targetSession) {
          const reloadUrl = requestedUrls.get(id) || urls.get(id);
          viewsToReload.push({ id, view, reloadUrl });
          failures.delete(id);
          tabFavicons.delete(id);
          try { view.webContents.stop(); } catch {}
          await view.webContents.loadURL('about:blank').catch(() => {});
        }
      }
      for (const [id, item] of [...suspendedTabs.entries()]) {
        if (item.profileId === command.profileId && item.provider === targetProvider) {
          suspendedTabs.delete(id);
          tabFavicons.delete(id);
        }
      }
      const result = await clearProfileSiteAuth({
        sessionApi: session,
        profileId: command.profileId,
        site: command.site,
      });
      for (const { id, view, reloadUrl } of viewsToReload) {
        if (views.get(id) === view && !view.webContents.isDestroyed()) {
          if (reloadUrl) {
            void view.webContents.loadURL(reloadUrl).catch(() => {});
          } else {
            view.webContents.reload();
          }
        }
      }
      return result;
    } finally {
      cloningProfiles.delete(command.profileId);
    }
  }

  async function deleteProfile(command) {
    if (cloningProfiles.has(command.profileId)) throw new Error('Browser profile operation is in progress');
    cloningProfiles.add(command.profileId);
    try {
      const tabsToClose = new Set();
      for (const [id, pid] of profileIds.entries()) {
        if (pid === command.profileId) tabsToClose.add(id);
      }
      for (const [id, item] of suspendedTabs.entries()) {
        if (item.profileId === command.profileId) tabsToClose.add(id);
      }
      for (const id of tabsToClose) {
        closeView(id);
      }
      const partitionNames = ['chatgpt', 'github', 'perplexity', 'other'].map(
        (provider) => partitionForBrowserProfile(command.profileId, provider),
      );
      const partitionSessions = new Set(
        partitionNames.map((name) => configuredPartitions.get(name) || session.fromPartition(name)),
      );
      for (const popup of [...popups]) {
        try {
          if (!popup.isDestroyed() && partitionSessions.has(popup.webContents.session)) {
            popupOwners.delete(popup.webContents);
            popups.delete(popup);
            popup.destroy();
          }
        } catch {}
      }
      const result = await deleteBrowserProfileStorage({
        sessionApi: session,
        profileId: command.profileId,
      });
      for (const name of partitionNames) {
        const sess = configuredPartitions.get(name);
        if (sess) sessionProviders.delete(sess);
        configuredPartitions.delete(name);
      }
      for (const sess of partitionSessions) {
        sessionProviders.delete(sess);
      }
      return result;
    } finally {
      cloningProfiles.delete(command.profileId);
    }
  }

  return { cloneProfile, clearProfileSite, deleteProfile };
}

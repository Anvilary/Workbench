/**
 * Chromium sessions of the browser partitions.
 *
 * One partition per (browser profile, provider). This module configures a
 * partition the first time it is needed (permissions, spellcheck, downloads) and
 * remembers which provider each session belongs to.
 */

import { DEFAULT_BROWSER_PROFILE_ID, isValidBrowserProfileId, partitionForBrowserProfile, otherUrl, authenticationUrl } from '../../policy.mjs';
import { browserDownloadHandler, resolveDownloadsDirectory, rememberCompletedDownloadPath } from './downloads.mjs';
import { configureProviderSessionPermissions } from '../security/session-permissions.mjs';
import { navigationAllowed, durablePage, downloadOriginAllowed, downloadDestinationAllowed } from './provider-policy.mjs';

export function createBrowserSessions({ electron, state, send, backend, trimCapacity }) {
  const { app, BrowserWindow, session } = electron;
  const { views, providers, popupOwners, popups, activeDownloads, reservedDownloadPaths, failures } = state;
  const configuredPartitions = new Map(); // partitionName -> Electron.Session
  const sessionProviders = new Map(); // Electron.Session -> provider
  const spellCheckConfig = {
    enabled: true,
    languages: ['en-US'],
  };

  function applySpellCheckSettings(config) {
    if (!config) return;
    if (typeof config.enabled === 'boolean') {
      spellCheckConfig.enabled = config.enabled;
    }
    if (Array.isArray(config.languages)) {
      spellCheckConfig.languages = [...config.languages];
    }
    for (const targetSession of configuredPartitions.values()) {
      try {
        if (typeof targetSession.setSpellCheckerEnabled === 'function') {
          targetSession.setSpellCheckerEnabled(spellCheckConfig.enabled);
        }
        if (typeof targetSession.setSpellCheckerLanguages === 'function') {
          const available = targetSession.availableSpellCheckerLanguages || [];
          const toEnable = spellCheckConfig.languages.filter(
            (lang) => available.length === 0 || available.includes(lang),
          );
          targetSession.setSpellCheckerLanguages(toEnable);
        }
      } catch {}
    }
  }

  function getAvailableSpellCheckerLanguages() {
    try {
      if (session.defaultSession && Array.isArray(session.defaultSession.availableSpellCheckerLanguages)) {
        return [...session.defaultSession.availableSpellCheckerLanguages];
      }
    } catch {}
    return [];
  }

  async function listCustomDictionaryWords() {
    try {
      const sess = configuredPartitions.values().next().value || session.defaultSession;
      if (sess && typeof sess.listWordsInSpellCheckerDictionary === 'function') {
        return await sess.listWordsInSpellCheckerDictionary();
      }
    } catch {}
    return [];
  }

  async function addCustomDictionaryWord(word) {
    if (typeof word !== 'string' || !word.trim()) return false;
    const clean = word.trim();
    let result = false;
    const allSessions = [session.defaultSession, ...configuredPartitions.values()];
    for (const sess of allSessions) {
      try {
        if (sess && typeof sess.addWordToSpellCheckerDictionary === 'function') {
          sess.addWordToSpellCheckerDictionary(clean);
          result = true;
        }
      } catch {}
    }
    return result;
  }

  async function removeCustomDictionaryWord(word) {
    if (typeof word !== 'string' || !word.trim()) return false;
    const clean = word.trim();
    let result = false;
    const allSessions = [session.defaultSession, ...configuredPartitions.values()];
    for (const sess of allSessions) {
      try {
        if (sess && typeof sess.removeWordFromSpellCheckerDictionary === 'function') {
          sess.removeWordFromSpellCheckerDictionary(clean);
          result = true;
        }
      } catch {}
    }
    return result;
  }

  function flushBrowserSession(sess) {
    if (!sess) return;
    try {
      if (typeof sess.flushStorageData === 'function') sess.flushStorageData();
    } catch {}
    try {
      if (sess.cookies && typeof sess.cookies.flushStore === 'function') {
        void sess.cookies.flushStore().catch(() => {});
      }
    } catch {}
  }

  function ensurePartitionSession(profileId, provider = 'chatgpt') {
    const effectiveProfileId = isValidBrowserProfileId(profileId) ? profileId : DEFAULT_BROWSER_PROFILE_ID;
    const partitionName = partitionForBrowserProfile(effectiveProfileId, provider);
    const existing = configuredPartitions.get(partitionName);
    if (existing) return existing;

    const targetSession = session.fromPartition(partitionName);
    configuredPartitions.set(partitionName, targetSession);
    sessionProviders.set(targetSession, provider);
    configureProviderSessionPermissions({
      provider,
      session: targetSession,
      backendPort: () => backend?.current()?.port,
      otherUrl,
      authenticationUrl,
    });
    if (typeof targetSession.setSpellCheckerEnabled === 'function') {
      try { targetSession.setSpellCheckerEnabled(spellCheckConfig.enabled); } catch {}
    }
    if (typeof targetSession.setSpellCheckerLanguages === 'function') {
      try {
        const available = targetSession.availableSpellCheckerLanguages || [];
        const toEnable = spellCheckConfig.languages.filter(lang => available.length === 0 || available.includes(lang));
        if (toEnable.length > 0) targetSession.setSpellCheckerLanguages(toEnable);
      } catch {}
    }
    targetSession.on('will-download', browserDownloadHandler({
      provider, views, providers, popupOwners, popups, activeDownloads,
      reservedPaths: reservedDownloadPaths,
      allowedOrigin: (value) => downloadOriginAllowed(provider, value),
      allowedDestination: (value) => downloadDestinationAllowed(provider, value),
      windowForContents: (contents) => BrowserWindow.fromWebContents(contents),
      downloadsDirectory: () => resolveDownloadsDirectory(app),
      rememberDownloadDirectory: (savedPath) => rememberCompletedDownloadPath(savedPath, { app }),
      // Native Save As is the interactive default; MAW_DOWNLOAD_AUTO_SAVE=1 is an explicit opt-in for automated/headless compatibility.
      autoSave: () => process.env.MAW_DOWNLOAD_AUTO_SAVE === '1',
      send,
      ready: (id) => {
        const contents = views.get(id)?.webContents;
        if (contents && !contents.isDestroyed() && !contents.isLoading() && !failures.has(id) && durablePage(providers.get(id), contents.getURL())) send({ type: 'ready', id });
        trimCapacity();
      },
    }));
    return targetSession;
  }

  for (const defaultProvider of ['chatgpt', 'github', 'perplexity', 'other']) {
    ensurePartitionSession(DEFAULT_BROWSER_PROFILE_ID, defaultProvider);
  }

  return {
    ensurePartitionSession,
    configuredPartitions,
    sessionProviders,
    flushBrowserSession,
    applySpellCheckSettings,
    getAvailableSpellCheckerLanguages,
    listCustomDictionaryWords,
    addCustomDictionaryWord,
    removeCustomDictionaryWord,
  };
}

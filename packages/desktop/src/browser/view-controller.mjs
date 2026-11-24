/**
 * BrowserViewController: the single owner of every native browser view.
 *
 * It creates the view state (views, URLs, providers, profile ids, suspended tabs,
 * popups, attachment and focus) and its private collaborators (layout,
 * navigation guard, sessions, eviction, page commands, profile operations), and
 * it is the only public entry point for them. The IPC router, the window and the
 * watchdog call this object; nothing else mutates a view or its bookkeeping.
 */

import { DEFAULT_BROWSER_PROFILE_ID, isValidBrowserProfileId, authenticationUrl, selectBestFavicon, isWorkbenchBackendUrl } from '../../policy.mjs';
import { navigationAllowed, durablePage } from './provider-policy.mjs';
import { createBrowserViewState } from './view-state.mjs';
import { createViewLayout } from './view-layout.mjs';
import { createNavigationGuard } from './navigation-guard.mjs';
import { createBrowserSessions } from './browser-sessions.mjs';
import { createViewEviction } from './view-eviction.mjs';
import { createPageCommands } from './page-commands.mjs';
import { createProfileOperations } from './profile-operations.mjs';

export function createBrowserViewController({
  electron, win, send, backend, secure, isWebAuthnEnabled, webauthnPreload, desktopShortcut,
}) {
  const { app, WebContentsView, session, clipboard } = electron;
  const state = createBrowserViewState();
  const {
    views, urls, providers, profileIds, requestedUrls, failures, popups, popupOwners, authEntryUrls,
    attachedViews, suspendedTabs, lastAccessedAt, activeDownloads, interactionProtected, zoomLevels,
    tabFavicons, linkOpenHistory, cloningProfiles, findRequests,
  } = state;

  const layout = createViewLayout({ win, send, state });
  const { hide, hideAll, invalidate } = layout;
  const navigation = createNavigationGuard({
    electron, win, send, backend, secure, isWebAuthnEnabled, webauthnPreload, state, layout,
    flushBrowserSession: (sess) => sessions.flushBrowserSession(sess),
    desktopShortcut,
  });
  const { guard, openExternal } = navigation;
  const sessions = createBrowserSessions({ electron, state, send, backend, trimCapacity: (...args) => trimCapacity(...args) });
  const { ensurePartitionSession } = sessions;

  function evictTab(id) {
    const view = views.get(id);
    if (!view) return;

    let currentUrl = urls.get(id) || requestedUrls.get(id);
    try {
      if (!view.webContents.isDestroyed()) {
        const activeUrl = view.webContents.getURL();
        if (durablePage(providers.get(id) ?? 'chatgpt', activeUrl)) {
          currentUrl = activeUrl;
        }
      }
    } catch {}

    const provider = providers.get(id) ?? 'chatgpt';
    const profileId = profileIds.get(id) ?? DEFAULT_BROWSER_PROFILE_ID;
    const zoomLevel = zoomLevels.get(id) ?? 0;

    suspendedTabs.set(id, {
      id,
      provider,
      profileId,
      url: currentUrl,
      requestedUrl: requestedUrls.get(id) || currentUrl,
      zoomLevel,
      suspendedAt: Date.now(),
      history: { entries: view.webContents.navigationHistory.getAllEntries(), index: view.webContents.navigationHistory.getActiveIndex() },
    });

    hide(id);
    if (!view.webContents.isDestroyed()) {
      try {
        if (typeof view.webContents.closeDevTools === 'function') view.webContents.closeDevTools();
      } catch {}
      view.webContents.close();
    }
    views.delete(id);
    urls.delete(id);
    requestedUrls.delete(id);
    failures.delete(id);
    findRequests.delete(id);

    send({ type: 'suspended', id });
  }

  const eviction = createViewEviction({ app, state, evictTab });
  const { trimCapacity } = eviction;

  function resolveTabProfileIdOrFail(id, requestedProfileId) {
    if (requestedProfileId !== undefined && !isValidBrowserProfileId(requestedProfileId)) {
      throw new Error('Invalid browser profile ID');
    }
    const knownProfileId = profileIds.get(id) ?? suspendedTabs.get(id)?.profileId;
    if (requestedProfileId === undefined && knownProfileId && knownProfileId !== DEFAULT_BROWSER_PROFILE_ID) {
      throw new Error('Browser profileId is required for custom-profile tabs');
    }
    return requestedProfileId ?? knownProfileId ?? DEFAULT_BROWSER_PROFILE_ID;
  }

  function open(id, url, provider = 'chatgpt', explicit = true, requestedProfileId = undefined) {
    if (isWorkbenchBackendUrl(url, backend?.current()?.port)) {
      send({ type: 'error', id, message: 'Navigation to Workbench backend port is blocked.' });
      return;
    }
    const providerName = provider === 'other' ? 'Browser' : provider === 'github' ? 'GitHub' : provider === 'perplexity' ? 'Perplexity' : 'ChatGPT';
    const effectiveProfileId = resolveTabProfileIdOrFail(id, requestedProfileId);
    if (cloningProfiles.has(effectiveProfileId)) throw new Error('Browser profile operation is in progress');
    const targetSession = ensurePartitionSession(effectiveProfileId, provider);
    if (views.has(id)) {
      lastAccessedAt.set(id, Date.now());
      if ((providers.get(id) ?? 'chatgpt') !== provider) {
        send({ type: 'error', id, message: 'This tab cannot change browser provider.' });
        return;
      }
      if ((profileIds.get(id) ?? DEFAULT_BROWSER_PROFILE_ID) !== effectiveProfileId) {
        closeView(id);
      } else {
        const contents = views.get(id).webContents;
        if (contents.isDestroyed()) {
          closeView(id);
        } else if (failures.has(id)) {
          if (explicit) {
            closeView(id);
          } else {
            send({ type: 'error', id, message: failures.get(id) || `${providerName} renderer stopped. Use Reload page to retry.` });
            return;
          }
        } else {
          if (!explicit && requestedUrls.get(id) !== url) {
            requestedUrls.set(id, url);
            if (urls.get(id) !== url && contents.getURL() !== url) {
              urls.set(id, url);
              void contents.loadURL(url).catch(() => {});
            }
          } else if (!contents.isLoading() && !durablePage(provider, contents.getURL())) {
            void contents.loadURL(url).catch(() => {});
          }
          if (!contents.isLoading() && durablePage(provider, contents.getURL())) {
            send({ type: 'ready', id });
            reportNavigation(id);
            if (urls.get(id) !== contents.getURL() || contents.getURL() !== url) {
              urls.set(id, contents.getURL());
              send({ type: 'committed', id, url: contents.getURL() });
            }
          }
          return;
        }
      }
    }

    let targetUrl = url;
    let initialZoom = 0;
    let history = null;
    if (suspendedTabs.has(id)) {
      const suspended = suspendedTabs.get(id);
      suspendedTabs.delete(id);
      if (suspended?.profileId === effectiveProfileId) {
        if (durablePage(provider, suspended.url)) {
          targetUrl = suspended.url;
        }
        initialZoom = suspended.zoomLevel ?? 0;
        history = suspended.history ?? null;
        send({ type: 'restoring', id });
      }
    }

    trimCapacity(id, 1);
    const viewPreload = isWebAuthnEnabled && provider === 'chatgpt' ? webauthnPreload : '';
    const view = new WebContentsView({ webPreferences: { ...secure, session: targetSession, spellcheck: true, preload: viewPreload, backgroundThrottling: true, autoplayPolicy: 'no-user-gesture-required', webgl: true } });
    view.setVisible(false);
    view.setBackgroundColor(provider === 'chatgpt' ? '#212121' : '#ffffff');
    views.set(id, view);
    providers.set(id, provider);
    profileIds.set(id, effectiveProfileId);
    urls.set(id, targetUrl);
    requestedUrls.set(id, targetUrl);
    lastAccessedAt.set(id, Date.now());
    if (initialZoom !== 0) {
      zoomLevels.set(id, initialZoom);
    }
    guard(view.webContents, provider);
    const reportFocus = () => {
      lastAccessedAt.set(id, Date.now());
      if (views.get(id) !== view || attachedViews.get(id) !== view ||
          view.webContents.isDestroyed() || state.reportedFocusedId === id) return;
      state.reportedFocusedId = id;
      send({ type: 'focused', id });
    };
    // Observe native pointer activation without cancelling page input. Bare focus events
    // also occur during attachment and programmatic focus, so they are not user intent.
    view.webContents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown') reportFocus();
    });
    const committed = (_event, url, isMainFrame = true) => {
      if (!isMainFrame || views.get(id) !== view) return;
      reportNavigation(id);
      if (!durablePage(provider, url)) return;
      const prevUrl = urls.get(id);
      urls.set(id, url);
      try {
        if (prevUrl && new URL(prevUrl).origin !== new URL(url).origin) {
          tabFavicons.delete(id);
          send({ type: 'favicon', id, favicon: '' });
        }
      } catch {}
      send({ type: 'committed', id, url });
    };
    view.webContents.on('did-navigate', (event, url) => {
      interactionProtected.delete(id);
      findRequests.delete(id);
      if (!authenticationUrl(url) && durablePage(provider, url)) {
        authEntryUrls.delete(view.webContents);
      }
      committed(event, url);
    });
    view.webContents.on('did-navigate-in-page', committed);
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      if (views.get(id) !== view || view.webContents.isDestroyed()) return;
      const best = selectBestFavicon(favicons);
      if (best) {
        tabFavicons.set(id, best);
        send({ type: 'favicon', id, favicon: best });
      }
    });
    view.webContents.on('did-start-loading', () => { failures.delete(id); send({ type: 'loading', id }); });
    view.webContents.on('did-finish-load', () => {
      if (initialZoom !== 0 && !view.webContents.isDestroyed()) {
        try { view.webContents.setZoomLevel(initialZoom); } catch {}
      }
      if (!failures.has(id) && durablePage(provider, view.webContents.getURL())) send({ type: 'ready', id });
    });
    view.webContents.on('did-stop-loading', () => {
      if (views.get(id) !== view) return;
      if (!failures.has(id) && durablePage(provider, view.webContents.getURL())) send({ type: 'ready', id });
      reportNavigation(id);
      trimCapacity(id);
    });
    view.webContents.on('did-fail-load', (_event, code, _description, failedUrl, mainFrame) => {
      if (!mainFrame) return;
      if (code === -3) {
        if (!failures.has(id) && durablePage(provider, view.webContents.getURL())) send({ type: 'ready', id });
        return;
      }
      if (authenticationUrl(failedUrl)) {
        void openExternal(failedUrl, 'This sign-in could not be opened inside MAW. Open it in your system browser?').catch(() => {});
      }
      const message = `${providerName} failed to load (${code}). Use Reload page to retry.`;
      failures.set(id, message);
      send({ type: 'error', id, message });
    });
    view.webContents.on('render-process-gone', () => {
      activeDownloads.delete(id);
      const message = `${providerName} renderer stopped. Use Reload page to retry.`;
      failures.set(id, message);
      if (attachedViews.has(id)) hide(id);
      send({ type: 'error', id, message });
    });
    if (history?.entries?.length) {
      void view.webContents.navigationHistory.restore(history).catch(() => {
        if (!view.webContents.isDestroyed()) void view.webContents.loadURL(targetUrl).catch(() => {});
      });
    } else void view.webContents.loadURL(targetUrl).catch(() => {});
  }

  function closeView(id) {
    suspendedTabs.delete(id);
    interactionProtected.delete(id);
    lastAccessedAt.delete(id);
    zoomLevels.delete(id);
    activeDownloads.delete(id);
    tabFavicons.delete(id);
    linkOpenHistory.delete(id);
    if (state.layoutFocusedId === id) state.layoutFocusedId = null;
    if (state.reportedFocusedId === id) state.reportedFocusedId = null;
    for (const [popupContents, ownerId] of [...popupOwners.entries()]) {
      if (ownerId !== id) continue;
      popupOwners.delete(popupContents);
      for (const popup of [...popups]) {
        try {
          if (!popup.isDestroyed() && popup.webContents === popupContents) {
            popups.delete(popup);
            popup.destroy();
          }
        } catch {}
      }
    }
    const view = views.get(id);
    if (view) {
      hide(id);
      if (!view.webContents.isDestroyed()) {
        try {
          if (typeof view.webContents.closeDevTools === 'function') view.webContents.closeDevTools();
        } catch {}
        view.webContents.close();
      }
    }
    views.delete(id); urls.delete(id); providers.delete(id); profileIds.delete(id); requestedUrls.delete(id); failures.delete(id); findRequests.delete(id);
  }

  function reportNavigation(id) {
    const contents = views.get(id)?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const current = contents.getURL();
    if (!(navigationAllowed(providers.get(id), current) || authenticationUrl(current))) return;
    send({ type: 'navigation', id, url: current, canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() });
  }

  const pageCommands = createPageCommands({ electron, clipboard, state, guard: navigation, send });
  const profileOperations = createProfileOperations({ electron, state, sessions, closeView });

  /** The durable browser tabs, resident or suspended, for the shell to restore after a reload. */
  function shellBrowserTabs() {
    return [
      ...[...views].map(([id, view]) => ({ id, provider: providers.get(id), url: !view.webContents.isDestroyed() ? view.webContents.getURL() : '' })),
      ...suspendedTabs.values(),
    ].filter(tab => durablePage(tab.provider, tab.url)).map(({ id, provider, url }) => ({ id, provider, url }));
  }

  function update(command) {
    const effectiveProfileId = resolveTabProfileIdOrFail(command.id, command.profileId);
    if (views.has(command.id)) {
      open(command.id, command.url, command.provider ?? providers.get(command.id) ?? 'chatgpt', false, effectiveProfileId);
    } else if (suspendedTabs.has(command.id)) {
      const item = suspendedTabs.get(command.id);
      if (item) {
        if (command.provider && command.provider !== item.provider) throw new Error('This tab cannot change browser provider.');
        if (effectiveProfileId !== item.profileId) {
          item.history = null;
          item.zoomLevel = 0;
          item.profileId = effectiveProfileId;
          profileIds.set(command.id, effectiveProfileId);
        } else if (item.url !== command.url && item.history?.entries?.length) {
          const entries = [...item.history.entries.slice(0, item.history.index + 1), { url: command.url, title: '' }];
          item.history = { entries, index: entries.length - 1 };
        }
        item.url = command.url;
        item.requestedUrl = command.url;
        if (command.provider) item.provider = command.provider;
      }
    } else if (command.profileId) {
      profileIds.set(command.id, effectiveProfileId);
    }
  }

  function retain(command) {
    for (const id of [...views.keys()]) if (!command.ids.includes(id)) closeView(id);
    for (const id of [...suspendedTabs.keys()]) if (!command.ids.includes(id)) closeView(id);
    for (const id of [...profileIds.keys()]) if (!command.ids.includes(id)) profileIds.delete(id);
  }

  /** The shell page reloaded or its renderer died: native views must not outlive it. */
  function resetForShellReload() {
    hideAll();
    state.layoutFocusedId = null;
    state.reportedFocusedId = null;
  }

  function destroyAllPopups() {
  for (const popup of [...popups]) {
    try {
      if (!popup.isDestroyed()) popup.destroy();
    } catch {}
  }
    popups.clear();
    popupOwners.clear();
  }

  /** The window is closing: release every view, popup and partition. */
  function shutdown() {
    hideAll();
    destroyAllPopups();
    for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.close();
    views.clear();
    suspendedTabs.clear();
    lastAccessedAt.clear();
    interactionProtected.clear();
    zoomLevels.clear();
    activeDownloads.clear();
    state.reservedDownloadPaths.clear();
    for (const partitionSession of sessions.configuredPartitions.values()) {
      try { partitionSession.flushStorageData(); } catch {}
    }
    return Promise.allSettled(
      [...sessions.configuredPartitions.values()].map((partitionSession) => partitionSession.cookies.flushStore()),
    );
  }

  return {
    open: (command) => open(command.id, command.url, command.provider ?? 'chatgpt', true, command.profileId),
    update,
    close: (command) => closeView(command.id),
    retain,
    applyLayout: layout.applyLayout,
    hideAll,
    invalidate,
    trimCapacity,
    hasNonVisibleViews: () => views.size > attachedViews.size,
    browserAction: pageCommands.browserAction,
    findInPage: pageCommands.findInPage,
    stopFindInPage: pageCommands.stopFindInPage,
    capture: pageCommands.capture,
    inspectPage: pageCommands.inspectPage,
    applySpellCheckSettings: sessions.applySpellCheckSettings,
    getAvailableSpellCheckerLanguages: sessions.getAvailableSpellCheckerLanguages,
    listCustomDictionaryWords: sessions.listCustomDictionaryWords,
    addCustomDictionaryWord: sessions.addCustomDictionaryWord,
    removeCustomDictionaryWord: sessions.removeCustomDictionaryWord,
    cloneProfile: profileOperations.cloneProfile,
    clearProfileSite: profileOperations.clearProfileSite,
    deleteProfile: profileOperations.deleteProfile,
    favicons: () => Object.fromEntries(tabFavicons),
    shellBrowserTabs,
    resetForShellReload,
    destroyAllPopups,
    shutdown,
    openExternal,
    tryOpenOAuthLoopback: navigation.tryOpenOAuthLoopback,
    sessionProviderOf: (sess) => sessions.sessionProviders.get(sess),
    attachedViews: () => attachedViews,
    /** Read-only sources for the resource monitor. */
    collectorSources: () => ({ views, providers, urls, attachedViews, suspendedTabs }),
  };
}

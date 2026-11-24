/**
 * Navigation, popup and sign-in security for every native browser view.
 *
 * Decides where a view may navigate, which new windows are allowed, how sign-in
 * flows and OAuth loopback callbacks are handled and when a link is opened in the
 * system browser instead. The state it touches (popups, sign-in entry URLs,
 * interaction protection) is owned by the BrowserViewController.
 */

import { otherUrl, externalUrl, targetWebProvider, isSameSite, authenticationUrl, decideWindowOpen, getBrowserZoomAction } from '../../policy.mjs';
import { isTypingInput } from '../performance/resource-budget.mjs';
import { isOAuthLoopbackCallback, createOAuthLoopbackGate } from '../security/oauth-loopback.mjs';
import { applyWebContentsZoom } from './zoom-controller.mjs';
import { navigationAllowed, isProviderFileDeliveryUrl } from './provider-policy.mjs';

export function createNavigationGuard({
  electron, win, send, backend, secure, isWebAuthnEnabled, webauthnPreload, state,
  layout, flushBrowserSession, desktopShortcut,
}) {
  const { shell, dialog } = electron;
  const { views, urls, popups, popupOwners, authEntryUrls, interactionProtected, zoomLevels, linkOpenHistory, findRequests } = state;
  const { invalidate, hideAll } = layout;

  function allowLinkOpen(tabId) {
    const now = Date.now();
    const history = (linkOpenHistory.get(tabId) || []).filter(t => now - t < 2000);
    if (history.length >= 5) return false;
    history.push(now);
    linkOpenHistory.set(tabId, history);
    return true;
  }

  async function openExternal(url, reason) {
    if (!(externalUrl(url) || authenticationUrl(url)) || win.isDestroyed()) return;
    if (process.env.MAW_EXTERNAL_POLICY === 'deny') {
      send({ type: 'error', message: reason || 'External browser opening was cancelled.' });
      return;
    }
    hideAll();
    try {
      const answer = await dialog.showMessageBox(win, { type: 'question', message: reason || 'Open this destination in your browser?', detail: new URL(url).origin, buttons: ['Cancel', 'Open browser'], defaultId: 0, cancelId: 0 });
      if (answer.response === 1) await shell.openExternal(url);
    } finally {
      if (!win.isDestroyed()) send({ type: 'layout-needed' });
    }
  }

  function applyBrowserZoom(id, contents, action) {
    applyWebContentsZoom(id, contents, action, zoomLevels, send);
  }

  const allowOAuthLoopback = createOAuthLoopbackGate({ maxRequests: 3, windowMs: 10_000 });

  function isContentsInAuthFlow(contents, provider) {
    if (!contents || contents.isDestroyed()) return false;
    if (authEntryUrls.has(contents)) return true;
    let currentUrl = '';
    try { currentUrl = contents.getURL() || ''; } catch {}
    if (!currentUrl) return false;
    if (authenticationUrl(currentUrl)) return true;
    if (provider === 'github' && /^https:\/\/github\.com\/(?:login|sessions)\//i.test(currentUrl)) return true;
    return false;
  }

  function tryOpenOAuthLoopback(url, sourceKey = 'global') {
    if (!isOAuthLoopbackCallback(url, { excludePort: backend.current().port })) return false;
    if (process.env.MAW_EXTERNAL_POLICY === 'deny') {
      send({ type: 'error', message: 'External browser opening was cancelled.' });
      return true;
    }
    if (!allowOAuthLoopback(sourceKey)) return true;
    void shell.openExternal(url).catch(() => {});
    return true;
  }

  function guard(contents, provider = 'chatgpt', allowPopup = true) {
    const getTabId = () => [...views.entries()].find(([, v]) => v.webContents === contents)?.[0] || popupOwners.get(contents);
    const isAuthFlow = () => isContentsInAuthFlow(contents, provider);
    const handleFileDelivery = (event, url) => {
      if (typeof url === 'string' && url.startsWith('blob:')) {
        event.preventDefault();
        if (isProviderFileDeliveryUrl(provider, url)) {
          contents.downloadURL(url);
        } else {
          const id = getTabId();
          if (id) send({ type: 'download-failed', id, filename: 'download', reason: 'blocked' });
        }
        return true;
      }
      if (isProviderFileDeliveryUrl(provider, url)) {
        event.preventDefault();
        contents.downloadURL(url);
        return true;
      }
      return false;
    };
    const isSameSiteOrAllowed = (url) => {
      // Sign-in stays in this browsing context. A workspace tab has no opener,
      // drops a form body, and leaves the provider document empty.
      let currentUrl = '';
      try { currentUrl = contents.getURL() || ''; } catch { currentUrl = ''; }
      if (authenticationUrl(url)) {
        if (!authEntryUrls.has(contents)) {
          if (currentUrl && currentUrl !== 'about:blank' && !authenticationUrl(currentUrl)) {
            authEntryUrls.set(contents, currentUrl);
          } else {
            const openerId = getTabId();
            const opener = openerId ? views.get(openerId)?.webContents : null;
            if (opener && !opener.isDestroyed()) {
              try {
                const openerUrl = opener.getURL() || urls.get(openerId) || '';
                if (openerUrl && openerUrl !== 'about:blank' && !authenticationUrl(openerUrl)) {
                  authEntryUrls.set(contents, openerUrl);
                }
              } catch {}
            }
          }
        }
        return true;
      }
      // Leave the identity provider only for the site that started sign-in, or the popup opener.
      if (authenticationUrl(currentUrl) && (navigationAllowed(provider, url) || (provider === 'other' && otherUrl(url, 8192)))) {
        if (provider !== 'other') return true;
        return otherUrl(url, 8192);
      }
      if (provider === 'other') {
        return otherUrl(url, 8192);
      }
      return navigationAllowed(provider, url);
    };
    const navigation = (event, url, isInPlace, isMainFrame) => {
      if (isMainFrame === false) return;
      if (handleFileDelivery(event, url)) return;
      if (isAuthFlow() && tryOpenOAuthLoopback(url, getTabId() || 'popup')) {
        event.preventDefault();
        return;
      }
      if (isSameSiteOrAllowed(url)) return;
      event.preventDefault();
      const id = getTabId();
      if (id && provider !== 'other' && targetWebProvider(url)) {
        if (allowLinkOpen(id)) {
          send({ type: 'open-web-tab', sourceTabId: id, url });
        }
        return;
      }
      if (id) {
        send({ type: 'error', id, message: `Navigation to "${url}" was blocked for security.` });
      } else {
        send({ type: 'error', message: `Navigation to "${url}" was blocked for security.` });
      }
    };
    const redirect = (event, url, isInPlace, isMainFrame) => {
      if (isMainFrame === false) return;
      if (handleFileDelivery(event, url)) return;
      if (isAuthFlow() && tryOpenOAuthLoopback(url, getTabId() || 'popup')) {
        event.preventDefault();
        return;
      }
      if (navigationAllowed(provider, url) || authenticationUrl(url)) return;
      if (provider === 'other' && otherUrl(url, 8192)) return;
      event.preventDefault();
      const id = getTabId();
      if (id && provider !== 'other' && targetWebProvider(url)) {
        if (allowLinkOpen(id)) {
          send({ type: 'open-web-tab', sourceTabId: id, url });
        }
        return;
      }
      if (id) {
        send({ type: 'error', id, message: `Redirect to "${url}" was blocked for security.` });
      } else {
        send({ type: 'error', message: `Redirect to "${url}" was blocked for security.` });
      }
    };
    contents.on('will-navigate', navigation);
    contents.on('will-redirect', redirect);
    contents.on('will-attach-webview', event => event.preventDefault());
    const popupWindow = () => ({ action: 'allow', overrideBrowserWindowOptions: {
      parent: win, autoHideMenuBar: true, width: 640, height: 760,
      webPreferences: { ...secure, session: contents.session, preload: isWebAuthnEnabled && provider === 'chatgpt' ? webauthnPreload : '', backgroundThrottling: true, autoplayPolicy: 'no-user-gesture-required', webgl: true },
    } });
    contents.setWindowOpenHandler(({ url, disposition, features }) => {
      if (typeof url === 'string' && url.startsWith('blob:')) {
        if (isProviderFileDeliveryUrl(provider, url)) {
          contents.downloadURL(url);
        } else {
          const id = getTabId();
          if (id) send({ type: 'download-failed', id, filename: 'download', reason: 'blocked' });
        }
        return { action: 'deny' };
      }
      if (isProviderFileDeliveryUrl(provider, url)) {
        contents.downloadURL(url);
        return { action: 'deny' };
      }
      if (isAuthFlow() && tryOpenOAuthLoopback(url, getTabId() || 'popup')) {
        return { action: 'deny' };
      }
      const decision = decideWindowOpen({
        url, disposition, features, allowPopup, popupOpen: popups.size >= 1,
        permitted: navigationAllowed(provider, url),
        tabbable: !!(getTabId() && targetWebProvider(url)),
        external: externalUrl(url) || authenticationUrl(url),
      });
      if (decision === 'popup') return popupWindow();
      if (decision === 'tab') {
        const id = getTabId();
        if (id && allowLinkOpen(id)) send({ type: 'open-web-tab', sourceTabId: id, url });
        return { action: 'deny' };
      }
      if (decision === 'external') {
        const reason = authenticationUrl(url) ? 'This sign-in cannot continue inside the workspace. Open it in your system browser?' : undefined;
        void openExternal(url, reason).catch(() => send({ type: 'error', message: 'Could not open external browser.' }));
      }
      return { action: 'deny' };
    });
    contents.on('did-create-window', popup => {
      popups.add(popup);
      // Capture the contents now. After 'closed', popup.webContents throws
      // "Object has been destroyed" and would skip removing this popup.
      const popupContents = popup.webContents;
      const tabId = getTabId();
      if (tabId) popupOwners.set(popupContents, tabId);
      const openerUrl = contents.getURL() || (tabId ? urls.get(tabId) : '');
      if (openerUrl && openerUrl !== 'about:blank' && !authenticationUrl(openerUrl)) {
        authEntryUrls.set(popupContents, openerUrl);
      }
      popup.setMenu(null);
      guard(popupContents, provider, false);
      let authLoadFailed = false;
      popupContents.on('did-fail-load', (_event, code, _description, failedUrl, isMainFrame) => {
        if (authLoadFailed || !isMainFrame || code === -3 || !authenticationUrl(failedUrl)) return;
        authLoadFailed = true;
        if (!popup.isDestroyed()) popup.close();
        void openExternal(failedUrl, 'This sign-in could not be opened inside MAW. Open it in your system browser?').catch(() => {});
      });
      popup.on('closed', () => {
        popupOwners.delete(popupContents);
        popups.delete(popup);
        flushBrowserSession(contents.session);
        invalidate();
      });
    });
    contents.on('before-input-event', (event, input) => {
      const id = getTabId();
      if (input.type === 'keyDown' && (input.control || input.meta) && input.key.toLowerCase() === 'f') {
        event.preventDefault();
        send({ type: 'open-find-in-page', id });
        return;
      }
      if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'l') {
        event.preventDefault(); send({ type: 'address-shortcut', id }); return;
      }
      const zoomAction = getBrowserZoomAction(input);
      if (zoomAction && id) {
        event.preventDefault();
        applyBrowserZoom(id, contents, zoomAction);
        return;
      }
      if (id && isTypingInput(input)) interactionProtected.add(id);
      desktopShortcut(event, input);
    });
    contents.on('found-in-page', (_event, result) => {
      const id = getTabId();
      if (!id) return;
      const activeFind = findRequests?.get(id);
      if (activeFind && typeof activeFind.requestId === 'number' && result.requestId !== activeFind.requestId) {
        return;
      }
      send({
        type: 'found-in-page',
        id,
        requestId: result.requestId,
        searchId: activeFind?.searchId,
        searchText: activeFind?.text,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        selectionArea: result.selectionArea,
        finalUpdate: result.finalUpdate,
      });
    });
    contents.on('context-menu', (event, params) => {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      const id = [...views.entries()].find(([, view]) => view.webContents === contents)?.[0];
      if (!id) return;
      const misspelledWord = (params.isEditable && typeof params.misspelledWord === 'string') ? params.misspelledWord : '';
      const dictionarySuggestions = (misspelledWord && Array.isArray(params.dictionarySuggestions))
        ? params.dictionarySuggestions.filter(s => typeof s === 'string' && s.length > 0 && s.length <= 256)
        : [];
      send({
        type: 'browser-context',
        id,
        selection: typeof params.selectionText === 'string' && params.selectionText.length > 0,
        selectionText: typeof params.selectionText === 'string' ? params.selectionText : '',
        linkURL: typeof params.linkURL === 'string' ? params.linkURL : '',
        pageURL: typeof params.pageURL === 'string' && params.pageURL ? params.pageURL : (contents.getURL() || ''),
        isEditable: params.isEditable === true,
        misspelledWord,
        dictionarySuggestions,
        canGoBack: contents.navigationHistory?.canGoBack ? contents.navigationHistory.canGoBack() : contents.canGoBack(),
        canGoForward: contents.navigationHistory?.canGoForward ? contents.navigationHistory.canGoForward() : contents.canGoForward(),
        x: Number.isFinite(params.x) ? params.x : 0,
        y: Number.isFinite(params.y) ? params.y : 0,
      });
    });
  }

  return { guard, openExternal, tryOpenOAuthLoopback, isContentsInAuthFlow, applyBrowserZoom };
}

/**
 * Commands that act on the page inside one native view: back, forward, reload,
 * copy, zoom, spellcheck replacement, opening links, find in page and capture.
 */

import { externalUrl, targetWebProvider, authenticationUrl } from '../../policy.mjs';

export function createPageCommands({ clipboard, state, guard, send }) {
  const { views, providers, failures, lastAccessedAt, authEntryUrls } = state;
  const { isContentsInAuthFlow, tryOpenOAuthLoopback, openExternal, applyBrowserZoom } = guard;

  function browserAction(command) {
    const view = views.get(command.id);
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    lastAccessedAt.set(command.id, Date.now());
    if (command.action === 'back') {
      const canBack = contents.navigationHistory?.canGoBack ? contents.navigationHistory.canGoBack() : contents.canGoBack();
      if (canBack) {
        if (typeof contents.navigationHistory?.goBack === 'function') contents.navigationHistory.goBack();
        else contents.goBack();
      }
    }
    if (command.action === 'forward') {
      const canForward = contents.navigationHistory?.canGoForward ? contents.navigationHistory.canGoForward() : contents.canGoForward();
      if (canForward) {
        if (typeof contents.navigationHistory?.goForward === 'function') contents.navigationHistory.goForward();
        else contents.goForward();
      }
    }
    if (command.action === 'reload') {
      failures.delete(command.id);
      contents.reload();
    }
    if (command.action === 'copy-url') clipboard.writeText(contents.getURL());
    if (command.action === 'copy-link' && typeof command.url === 'string') clipboard.writeText(command.url);
    if (command.action === 'copy-selection') contents.copy();
    if (command.action === 'replace-misspelling' && typeof command.word === 'string') {
      if (typeof contents.replaceMisspelling === 'function') {
        contents.replaceMisspelling(command.word);
      }
    }
    if (command.action === 'open-page') void openExternal(contents.getURL());
    if (command.action === 'open-link') {
      if (isContentsInAuthFlow(contents, providers.get(command.id)) && tryOpenOAuthLoopback(command.url, command.id)) {
        return;
      }
      if (authenticationUrl(command.url)) {
        try {
          const current = contents.getURL();
          if (current && current !== 'about:blank' && !authenticationUrl(current)) authEntryUrls.set(contents, current);
        } catch { /* the current document is already gone */ }
        void contents.loadURL(command.url).catch(() => {});
        return;
      }
      const target = targetWebProvider(command.url);
      if (target) {
        send({ type: 'open-web-tab', sourceTabId: command.id, url: command.url });
      } else if (externalUrl(command.url)) {
        void openExternal(command.url);
      }
    }
    if (command.action === 'zoom-in' || command.action === 'zoom-out' || command.action === 'zoom-reset') {
      applyBrowserZoom(command.id, contents, command.action);
    }
  }

  function findInPage(command) {
    const view = views.get(command.id);
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed()) return { ok: false };
    const options = {};
    if ('forward' in command) options.forward = command.forward;
    if ('findNext' in command) options.findNext = command.findNext;
    if ('matchCase' in command) options.matchCase = command.matchCase;
    const requestId = contents.findInPage(command.text, options);
    return { ok: true, requestId };
  }

  function stopFindInPage(command) {
    const view = views.get(command.id);
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed()) return { ok: false };
    const action = command.action || 'clearSelection';
    contents.stopFindInPage(action);
    return { ok: true };
  }

  /** In-memory visual capture fallback for overlapping overlays. */
  async function capture(command) {
    const view = views.get(command.id);
    if (!view || view.webContents.isDestroyed()) {
      return { ok: false };
    }
    let timeoutId;
    try {
      const image = await Promise.race([
        view.webContents.capturePage(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('capture-timeout')), 1500);
        }),
      ]);
      if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) {
        return { ok: false };
      }
      let dataUrl;
      if (typeof image.toJPEG === 'function') {
        try {
          dataUrl = `data:image/jpeg;base64,${image.toJPEG(75).toString('base64')}`;
        } catch {
          dataUrl = image.toDataURL();
        }
      } else {
        dataUrl = image.toDataURL();
      }
      return { ok: true, dataUrl };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { browserAction, findInPage, stopFindInPage, capture };
}

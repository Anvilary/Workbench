import { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, shell, dialog, clipboard, ClipboardItem } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { PARTITION, GITHUB_PARTITION, PERPLEXITY_PARTITION, CHANNEL, serviceUrl, trustedSender, validCommand, nativeBounds, nativeBoundsForRect, embeddedUrl, externalUrl, isDownloadOrFileDeliveryUrl, githubEmbeddedUrl, perplexityUrl, perplexityEmbeddedUrl } from './policy.mjs';
import { fileClipboardPayload, resolveClipboardTarget } from './file-clipboard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Deliberately distinct from both production MAW and any Brave/Neko profile.
app.setPath('userData', path.resolve(process.env.MAW_DESKTOP_DATA_DIR || path.join(app.getPath('appData'), 'maw-desktop-prototype')));
app.setName(process.env.MAW_DESKTOP_PRODUCTION === '1' ? 'My Amazing Workspace' : 'MAW ChatGPT Prototype');
if (app.commandLine.hasSwitch('no-sandbox')) throw new Error('MAW desktop requires Chromium sandboxing');
app.enableSandbox();
let local = serviceUrl(process.env.MAW_DESKTOP_URL || '');
delete process.env.MAW_DESKTOP_URL;
if (!app.requestSingleInstanceLock({ serviceUrl: local.href })) app.exit(0);
// Do not await app.whenReady() at module scope: Electron waits for ESM
// evaluation before emitting ready, which would deadlock initialization.
async function start() {
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const secure = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false };
  const chatSession = session.fromPartition(PARTITION);
  const githubSession = session.fromPartition(GITHUB_PARTITION);
  const perplexitySession = session.fromPartition(PERPLEXITY_PARTITION);
  // Permit clipboard writing only from the official ChatGPT origin.
  // Clipboard reading and all unrelated permissions remain denied.
  const canWriteClipboard = (contents, requestingUrl) => {
    try {
      return !!contents &&
        new URL(contents.getURL()).origin === 'https://chatgpt.com' &&
        new URL(requestingUrl).origin === 'https://chatgpt.com';
    } catch {
      return false;
    }
  };

  chatSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      permission === 'clipboard-sanitized-write' &&
      canWriteClipboard(contents, details?.requestingUrl)
    );
  });

  chatSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    permission === 'clipboard-sanitized-write' &&
    canWriteClipboard(contents, requestingOrigin)
  );
  const githubClipboard = (contents, requestingUrl) => {
    try {
      return !!contents &&
        new URL(contents.getURL()).origin === 'https://github.com' &&
        new URL(requestingUrl).origin === 'https://github.com';
    } catch { return false; }
  };
  githubSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permission === 'clipboard-sanitized-write' && githubClipboard(contents, details?.requestingUrl));
  });
  githubSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    permission === 'clipboard-sanitized-write' && githubClipboard(contents, requestingOrigin)
  );
  const perplexityClipboard = (contents, requestingUrl) => {
    try {
      if (!contents) return false;
      const origin = new URL(contents.getURL()).origin;
      const reqOrigin = new URL(requestingUrl).origin;
      const allowedOrigins = ['https://www.perplexity.ai', 'https://perplexity.ai'];
      return allowedOrigins.includes(origin) && allowedOrigins.includes(reqOrigin);
    } catch { return false; }
  };
  perplexitySession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permission === 'clipboard-sanitized-write' && perplexityClipboard(contents, details?.requestingUrl));
  });
  perplexitySession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    permission === 'clipboard-sanitized-write' && perplexityClipboard(contents, requestingOrigin)
  );

  const win = new BrowserWindow({ width: 1280, height: 860, title: 'MAW · ChatGPT feasibility prototype', autoHideMenuBar: true,
    webPreferences: { ...secure, partition: 'persist:maw-shell-prototype', preload: path.join(here, 'preload.cjs') } });
  const views = new Map();
  const urls = new Map();
  const providers = new Map();
  const requestedUrls = new Map();
  const failures = new Map();
  let layoutFocusedId = null;
  // Native clicks must not make an unchanged renderer layout look like a new focus request.
  let reportedFocusedId = null;
  const popups = new Set();
  const popupOwners = new Map(); // popup WebContents -> tabId
  const attachedViews = new Map(); // id -> WebContentsView (up to 4 simultaneously visible)
  let shuttingDown = false;
  const send = state => { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNEL + ':state', state); };

  // FEATURE 10: Official ChatGPT downloads with native Save As dialog and security validation
  chatSession.on('will-download', (event, item, webContents) => {
    // 1. Verify that download originates from an authorized WebContents (view or popup)
    let tabEntry = [...views.entries()].find(([, v]) => v.webContents === webContents);
    let tabId = tabEntry?.[0];
    if (!tabEntry) {
      const ownerId = popupOwners.get(webContents);
      if (ownerId && views.has(ownerId)) {
        tabId = ownerId;
        tabEntry = [ownerId, views.get(ownerId)];
      }
    }
    if (!tabEntry) {
      event.preventDefault();
      return;
    }

    // 2. Verify initiator origin (Electron 45 getInitiatorOrigin)
    const initiator = typeof item.getInitiatorOrigin === 'function' ? item.getInitiatorOrigin() : null;
    if (initiator) {
      try {
        const origin = new URL(initiator).origin;
        if (origin !== 'https://chatgpt.com' && origin !== 'https://chat.openai.com') {
          event.preventDefault();
          return;
        }
      } catch {
        event.preventDefault();
        return;
      }
    }

    // 3. Verify destination URL and URL chain
    const destinationUrls = [item.getURL(), ...(typeof item.getURLChain === 'function' ? item.getURLChain() : [])];
    const destinationAllowed = destinationUrls.every(u => isDownloadOrFileDeliveryUrl(u) || chatUrl(u));
    if (!destinationAllowed) {
      event.preventDefault();
      return;
    }

    // If download originated from a popup window, safely hide and close when download completes
    const popupWin = BrowserWindow.fromWebContents(webContents);
    if (popupWin && popups.has(popupWin)) {
      try { popupWin.hide(); } catch {}
      item.once('done', () => {
        if (!popupWin.isDestroyed()) {
          popupWin.close();
        }
      });
    }

    // 4. Sanitize suggested filename
    let rawFilename = item.getFilename() || 'download';
    let baseFilename = path.basename(rawFilename).replace(/[\u0000-\u001f\u007f\\/:]/g, '_').trim();
    if (!baseFilename || baseFilename === '.' || baseFilename === '..') {
      baseFilename = 'download';
    }

    // 4. Default to Ubuntu Downloads directory and prompt native Save As dialog
    let downloadsDir;
    try {
      downloadsDir = app.getPath('downloads');
    } catch {
      downloadsDir = process.env.HOME ? path.join(process.env.HOME, 'Downloads') : '/tmp';
    }
    const defaultPath = path.join(downloadsDir, baseFilename);
    if (process.env.MAW_DOWNLOAD_AUTO_SAVE === '1') {
      item.setSavePath(defaultPath);
    } else {
      item.setSaveDialogOptions({
        defaultPath,
        title: 'Save File',
      });
    }

    send({ type: 'download-start', id: tabId, filename: baseFilename });

    item.on('updated', (_event, state) => {
      if (state === 'progressing') {
        const total = item.getTotalBytes();
        const received = item.getReceivedBytes();
        const percent = total > 0 ? Math.round((received / total) * 100) : null;
        send({ type: 'download-progress', id: tabId, filename: baseFilename, percent });
      } else if (state === 'interrupted') {
        if (!item.canResume()) {
          item.cancel();
        }
      }
    });

    item.once('done', (_event, state) => {
      if (state === 'completed') {
        send({ type: 'download-complete', id: tabId, filename: baseFilename, savePath: item.getSavePath() });
      } else if (state === 'cancelled') {
        // Clean cancellation - no error message
        send({ type: 'download-cancelled', id: tabId, filename: baseFilename });
      } else {
        // Interrupted or failed
        send({ type: 'download-failed', id: tabId, filename: baseFilename, message: 'Download interrupted.' });
      }
      const view = views.get(tabId);
      const viewContents = view?.webContents;
      if (viewContents && !viewContents.isDestroyed() && !viewContents.isLoading() && !failures.has(tabId) && durablePage(providers.get(tabId) ?? 'chatgpt', viewContents.getURL())) {
        send({ type: 'ready', id: tabId });
      }
    });
  });

  function hideAll() {
    for (const [id, view] of attachedViews) {
      if (!win.isDestroyed() && !view.webContents.isDestroyed()) {
        try { win.contentView.removeChildView(view); } catch {}
        try { view.setVisible(false); } catch {}
      }
    }
    attachedViews.clear();
  }

  function hide(id) {
    if (id) {
      const view = attachedViews.get(id);
      if (view) {
        if (!win.isDestroyed() && !view.webContents.isDestroyed()) {
          try { win.contentView.removeChildView(view); } catch {}
          try { view.setVisible(false); } catch {}
        }
        attachedViews.delete(id);
      }
    } else {
      hideAll();
    }
  }

  githubSession.on('will-download', (event, item, webContents) => {
    let tabEntry = [...views.entries()].find(([, view]) => view.webContents === webContents);
    if (!tabEntry) {
      const ownerId = popupOwners.get(webContents);
      if (ownerId && views.has(ownerId)) {
        tabEntry = [ownerId, views.get(ownerId)];
      }
    }
    if (!tabEntry || providers.get(tabEntry[0]) !== 'github') {
      event.preventDefault();
      return;
    }
    const initiator = typeof item.getInitiatorOrigin === 'function' ? item.getInitiatorOrigin() : null;
    if (initiator) {
      try {
        const host = new URL(initiator).hostname;
        const allowed = host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com');
        if (!allowed) {
          event.preventDefault();
          return;
        }
      } catch {
        event.preventDefault();
        return;
      }
    }
    const destinationUrls = [item.getURL(), ...(typeof item.getURLChain === 'function' ? item.getURLChain() : [])];
    if (!destinationUrls.every(u => githubEmbeddedUrl(u))) {
      event.preventDefault();
      return;
    }
    const popupWin = BrowserWindow.fromWebContents(webContents);
    if (popupWin && popups.has(popupWin)) {
      try { popupWin.hide(); } catch {}
      item.once('done', () => {
        if (!popupWin.isDestroyed()) {
          popupWin.close();
        }
      });
    }
  });

  perplexitySession.on('will-download', (event, item, webContents) => {
    let tabEntry = [...views.entries()].find(([, view]) => view.webContents === webContents);
    if (!tabEntry) {
      const ownerId = popupOwners.get(webContents);
      if (ownerId && views.has(ownerId)) {
        tabEntry = [ownerId, views.get(ownerId)];
      }
    }
    if (!tabEntry || providers.get(tabEntry[0]) !== 'perplexity') {
      event.preventDefault();
      return;
    }
    const initiator = typeof item.getInitiatorOrigin === 'function' ? item.getInitiatorOrigin() : null;
    if (initiator) {
      try {
        const origin = new URL(initiator).origin;
        if (origin !== 'https://www.perplexity.ai' && origin !== 'https://perplexity.ai') {
          event.preventDefault();
          return;
        }
      } catch {
        event.preventDefault();
        return;
      }
    }
    const destinationUrls = [item.getURL(), ...(typeof item.getURLChain === 'function' ? item.getURLChain() : [])];
    if (!destinationUrls.every(u => perplexityEmbeddedUrl(u))) {
      event.preventDefault();
      return;
    }
    const popupWin = BrowserWindow.fromWebContents(webContents);
    if (popupWin && popups.has(popupWin)) {
      try { popupWin.hide(); } catch {}
      item.once('done', () => {
        if (!popupWin.isDestroyed()) {
          popupWin.close();
        }
      });
    }
    let rawFilename = item.getFilename() || 'download';
    let baseFilename = path.basename(rawFilename).replace(/[\u0000-\u001f\u007f\\/:]/g, '_').trim();
    if (!baseFilename || baseFilename === '.' || baseFilename === '..') {
      baseFilename = 'download';
    }
    let downloadsDir;
    try {
      downloadsDir = app.getPath('downloads');
    } catch {
      downloadsDir = process.env.HOME ? path.join(process.env.HOME, 'Downloads') : '/tmp';
    }
    const defaultPath = path.join(downloadsDir, baseFilename);
    if (process.env.MAW_DOWNLOAD_AUTO_SAVE === '1') {
      item.setSavePath(defaultPath);
    } else {
      item.setSaveDialogOptions({ defaultPath, title: 'Save File' });
    }
    const tabId = tabEntry[0];
    send({ type: 'download-start', id: tabId, filename: baseFilename });
    item.on('updated', (_event, state) => {
      if (state === 'progressing') {
        const total = item.getTotalBytes();
        const received = item.getReceivedBytes();
        const percent = total > 0 ? Math.round((received / total) * 100) : null;
        send({ type: 'download-progress', id: tabId, filename: baseFilename, percent });
      } else if (state === 'interrupted') {
        if (!item.canResume()) item.cancel();
      }
    });
    item.once('done', (_event, state) => {
      if (state === 'completed') {
        send({ type: 'download-complete', id: tabId, filename: baseFilename, savePath: item.getSavePath() });
      } else if (state === 'cancelled') {
        send({ type: 'download-cancelled', id: tabId, filename: baseFilename });
      } else {
        send({ type: 'download-failed', id: tabId, filename: baseFilename, message: 'Download interrupted.' });
      }
      const view = views.get(tabId);
      const viewContents = view?.webContents;
      if (viewContents && !viewContents.isDestroyed() && !viewContents.isLoading() && !failures.has(tabId) && durablePage(providers.get(tabId) ?? 'chatgpt', viewContents.getURL())) {
        send({ type: 'ready', id: tabId });
      }
    });
  });

  function invalidate() { hideAll(); send({ type: 'layout-needed' }); }

  async function openExternal(url) {
    if (!externalUrl(url) || win.isDestroyed()) return;
    hideAll();
    const answer = await dialog.showMessageBox(win, { type: 'question', message: 'Open this destination in your browser?', detail: new URL(url).origin, buttons: ['Cancel', 'Open browser'], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) await shell.openExternal(url);
    send({ type: 'layout-needed' });
  }

  function navigationAllowed(provider, url) {
    if (provider === 'github') return githubEmbeddedUrl(url);
    if (provider === 'perplexity') return perplexityEmbeddedUrl(url);
    return embeddedUrl(url);
  }

  function guard(contents, provider = 'chatgpt', allowPopup = true) {
    const getTabId = () => [...views.entries()].find(([, v]) => v.webContents === contents)?.[0] || popupOwners.get(contents);
    const handleFileDelivery = (event, url) => {
      if (provider === 'chatgpt' && isDownloadOrFileDeliveryUrl(url)) {
        event.preventDefault();
        contents.downloadURL(url);
        return true;
      }
      return false;
    };
    const navigation = (event, url) => {
      if (handleFileDelivery(event, url)) return;
      if (navigationAllowed(provider, url)) return;
      event.preventDefault();
      void openExternal(url).catch(() => send({ type: 'error', message: 'Could not open external browser.' }));
    };
    contents.on('will-navigate', navigation);
    contents.on('will-redirect', navigation);
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (provider === 'chatgpt' && isDownloadOrFileDeliveryUrl(url)) {
        contents.downloadURL(url);
        return { action: 'deny' };
      }
      if (allowPopup && navigationAllowed(provider, url) && popups.size < 1) return { action: 'allow', overrideBrowserWindowOptions: {
        parent: win, autoHideMenuBar: true, width: 640, height: 760,
        webPreferences: { ...secure, session: provider === 'github' ? githubSession : provider === 'perplexity' ? perplexitySession : chatSession, preload: '' },
      } };
      void openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('did-create-window', popup => {
      popups.add(popup);
      const tabId = getTabId();
      if (tabId) popupOwners.set(popup.webContents, tabId);
      popup.setMenu(null);
      guard(popup.webContents, provider, false);
      popup.on('closed', () => {
        popupOwners.delete(popup.webContents);
        popups.delete(popup);
        invalidate();
      });
    });
    contents.on('before-input-event', desktopShortcut);
    contents.on('context-menu', (event, params) => {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      const id = [...views.entries()].find(([, view]) => view.webContents === contents)?.[0];
      if (!id) return;
      send({
        type: 'browser-context',
        id,
        selection: typeof params.selectionText === 'string' && params.selectionText.length > 0,
        linkURL: typeof params.linkURL === 'string' ? params.linkURL : '',
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
        x: Number.isFinite(params.x) ? params.x : 0,
        y: Number.isFinite(params.y) ? params.y : 0,
      });
    });
  }

  function desktopShortcut(event, input) {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { event.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    if (input.control && (input.key === 'Tab' || input.key === 'PageUp' || input.key === 'PageDown')) {
      event.preventDefault(); send({ type: 'tab-shortcut', direction: input.shift || input.key === 'PageUp' ? -1 : 1 });
    }
    if (input.control && input.key.toLowerCase() === 'w') { event.preventDefault(); send({ type: 'close-shortcut' }); }
  }

  function chatUrlForPersistence(value) {
    try {
      const url = new URL(value);
      return url.origin === 'https://chatgpt.com' && !/^\/(api|auth)(\/|$)/.test(url.pathname) &&
        ![...url.searchParams.keys()].some(key => /token|code|state|session/i.test(key));
    } catch { return false; }
  }

  function durablePage(provider, value) {
    if (provider === 'github') {
      try {
        const url = new URL(value);
        return url.origin === 'https://github.com' && ![...url.searchParams.keys()].some(key => /token|code|state|session/i.test(key));
      } catch { return false; }
    }
    if (provider === 'perplexity') {
      try {
        const url = new URL(value);
        return perplexityUrl(value) && !/^\/(api|auth)(\/|$)/.test(url.pathname) &&
          ![...url.searchParams.keys()].some(key => /token|code|state|session/i.test(key));
      } catch { return false; }
    }
    return chatUrlForPersistence(value);
  }

  function open(id, url, provider = 'chatgpt') {
    const providerName = provider === 'github' ? 'GitHub' : provider === 'perplexity' ? 'Perplexity' : 'ChatGPT';
    const targetSession = provider === 'github' ? githubSession : provider === 'perplexity' ? perplexitySession : chatSession;
    if (views.has(id)) {
      if ((providers.get(id) ?? 'chatgpt') !== provider) {
        send({ type: 'error', id, message: 'This tab cannot change browser provider.' });
        return;
      }
      const contents = views.get(id).webContents;
      if (contents.isDestroyed() || failures.has(id)) {
        closeView(id);
      } else {
        if (requestedUrls.get(id) !== url || contents.getURL() !== url) {
          requestedUrls.set(id, url);
          urls.set(id, url);
          void contents.loadURL(url).catch(() => {});
        } else if (!contents.isLoading() && !durablePage(provider, contents.getURL())) {
          void contents.loadURL(url).catch(() => {});
        }
        if (!contents.isLoading() && durablePage(provider, contents.getURL())) {
          send({ type: 'ready', id });
          if (urls.get(id) !== url) send({ type: 'committed', id, url: contents.getURL() });
        }
        return;
      }
    }
    if (views.size >= 8) throw new Error('Prototype view limit reached');
    const view = new WebContentsView({ webPreferences: { ...secure, session: targetSession, backgroundThrottling: true } });
    view.setVisible(false);
    view.setBackgroundColor('#212121');
    views.set(id, view);
    providers.set(id, provider);
    urls.set(id, url);
    requestedUrls.set(id, url);
    guard(view.webContents, provider);
    const reportFocus = () => {
      if (views.get(id) !== view || attachedViews.get(id) !== view ||
          view.webContents.isDestroyed() || reportedFocusedId === id) return;
      reportedFocusedId = id;
      send({ type: 'focused', id });
    };
    // Observe native pointer activation without cancelling page input. Bare focus events
    // also occur during attachment and programmatic focus, so they are not user intent.
    view.webContents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown') reportFocus();
    });
    const committed = (_event, url, isMainFrame = true) => {
      if (!isMainFrame || !durablePage(provider, url)) return;
      urls.set(id, url);
      send({ type: 'committed', id, url });
    };
    view.webContents.on('did-navigate', committed);
    view.webContents.on('did-navigate-in-page', committed);
    view.webContents.on('did-start-loading', () => { failures.delete(id); send({ type: 'loading', id }); });
    view.webContents.on('did-finish-load', () => { if (!failures.has(id) && durablePage(provider, view.webContents.getURL())) send({ type: 'ready', id }); });
    view.webContents.on('did-stop-loading', () => { if (!failures.has(id) && durablePage(provider, view.webContents.getURL())) send({ type: 'ready', id }); });
    view.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame) {
        if (code === -3) {
          if (!failures.has(id) && durablePage(provider, view.webContents.getURL())) {
            send({ type: 'ready', id });
          }
        } else {
          const message = `${providerName} failed to load (${code}). Use Reload page to retry.`;
          failures.set(id, message);
          send({ type: 'error', id, message });
        }
      }
    });
    view.webContents.on('render-process-gone', () => {
      const message = `${providerName} renderer stopped. Use Reload page to retry.`;
      failures.set(id, message);
      if (attachedViews.has(id)) hide(id);
      send({ type: 'error', id, message });
    });
    void view.webContents.loadURL(url).catch(() => {});
  }

  function closeView(id) {
    const view = views.get(id);
    if (!view) return;
    hide(id);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    views.delete(id); urls.delete(id); providers.delete(id); requestedUrls.delete(id); failures.delete(id);
  }

  ipcMain.handle(CHANNEL, async (event, command) => {
    if (!trustedSender(event, win.webContents, local.origin) || !validCommand(command)) throw new Error('Invalid desktop request');
    if (command.type === 'open') open(command.id, command.url, command.provider ?? 'chatgpt');
    if (command.type === 'update' && views.has(command.id)) open(command.id, command.url, command.provider ?? providers.get(command.id) ?? 'chatgpt');
    if (command.type === 'browser-action') {
      const view = views.get(command.id);
      const contents = view?.webContents;
      if (!contents || contents.isDestroyed()) return;
      if (command.action === 'back' && contents.canGoBack()) contents.goBack();
      if (command.action === 'forward' && contents.canGoForward()) contents.goForward();
      if (command.action === 'reload') {
        failures.delete(command.id);
        contents.reload();
      }
      if (command.action === 'copy-url') clipboard.writeText(contents.getURL());
      if (command.action === 'copy-selection') contents.copy();
      if (command.action === 'open-page') void openExternal(contents.getURL());
      if (command.action === 'open-link') void openExternal(command.url);
      if (command.action === 'zoom-in') contents.setZoomLevel(Math.min(3, contents.getZoomLevel() + 0.5));
      if (command.action === 'zoom-out') contents.setZoomLevel(Math.max(-3, contents.getZoomLevel() - 0.5));
      if (command.action === 'zoom-reset') contents.setZoomLevel(0);
    }
    if (command.type === 'copy-file') {
      const resolved = await resolveClipboardTarget(command.cwd, command.relative, { requireAuthoritative: true });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      try {
        const payload = fileClipboardPayload(resolved.absolute);
        if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
          const item = new ClipboardItem({
            'text/uri-list': new Blob([payload.uriList], { type: 'text/uri-list' }),
            'x-special/gnome-copied-files': new Blob([payload.gnome], { type: 'x-special/gnome-copied-files' }),
          });
          await clipboard.write([item]);
        } else if (typeof clipboard.writeBuffer === 'function') {
          clipboard.writeBuffer('text/uri-list', payload.uriList);
          clipboard.writeBuffer('x-special/gnome-copied-files', payload.gnome);
        }
        return { ok: true, directory: resolved.directory };
      } catch (err) {
        console.error('[desktop] copy-file error:', err);
        return { ok: false, error: 'unavailable' };
      }
    }
    if (command.type === 'close') closeView(command.id);
    if (command.type === 'retain') for (const id of views.keys()) if (!command.ids.includes(id)) closeView(id);

    // FEATURE 4: In-memory visual capture fallback for overlapping overlays
    if (command.type === 'capture' && views.has(command.id)) {
      const view = views.get(command.id);
      if (view && !view.webContents.isDestroyed()) {
        try {
          const image = await view.webContents.capturePage();
          return { ok: true, dataUrl: image.toDataURL() };
        } catch {
          return { ok: false };
        }
      }
      return { ok: false };
    }

    // FEATURE 3: Centralized Multi-WebContentsView layout coordinator (atomic reconciliation)
    if (command.type === 'layout') {
      const focusedId = 'focusedId' in command ? command.focusedId : command.id ?? null;
      const focusChanged = focusedId !== layoutFocusedId;
      layoutFocusedId = focusedId;
      if (focusChanged) reportedFocusedId = focusedId;
      const targetViews = Array.isArray(command.views)
        ? command.views
        : (command.id && command.bounds ? [{ id: command.id, bounds: command.bounds }] : []);

      if (win.isMinimized() || targetViews.length === 0) {
        hideAll();
        return;
      }

      const contentSize = win.getContentSize();
      const zoom = win.webContents.getZoomFactor();
      const targetIds = new Set(targetViews.map(v => v.id));

      // 1. Detach views no longer visible
      for (const [attachedId, attachedView] of [...attachedViews.entries()]) {
        if (!targetIds.has(attachedId)) {
          win.contentView.removeChildView(attachedView);
          attachedView.setVisible(false);
          attachedViews.delete(attachedId);
        }
      }

      // 2. Attach and update bounds for visible views
      for (const item of targetViews) {
        const view = views.get(item.id);
        if (!view || view.webContents.isDestroyed()) continue;

        const bounds = nativeBoundsForRect(item.bounds, command.viewport, contentSize, zoom);
        if (!bounds) continue;

        if (!attachedViews.has(item.id)) {
          win.contentView.addChildView(view);
          attachedViews.set(item.id, view);
        }

        view.setBounds(bounds);
        view.setVisible(true);
      }

      // Geometry updates and overlay restoration must preserve focus in MAW controls.
      if (focusChanged && focusedId && attachedViews.has(focusedId)) {
        const focusedView = attachedViews.get(focusedId);
        if (focusedView && !focusedView.webContents.isDestroyed() && !focusedView.webContents.isFocused()) {
          focusedView.webContents.focus();
        }
      }
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url).catch(() => {}); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin === local.origin && new URL(url).pathname === '/') return; } catch {}
    event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => { if (new URL(url).origin !== local.origin) event.preventDefault(); });
  win.webContents.on('did-start-loading', hideAll);
  win.webContents.on('render-process-gone', hideAll);
  for (const event of ['resize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(event, invalidate);
  win.webContents.on('before-input-event', desktopShortcut);
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    try {
      const next = serviceUrl(data.serviceUrl);
      if (next.href !== local.href) { hideAll(); local = next; void win.loadURL(local.href).catch(() => {}); }
    } catch { return; }
    if (win.isMinimized()) win.restore(); win.show(); win.focus();
  });
  win.on('close', event => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    hideAll();
    for (const popup of popups) popup.destroy();
    for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.close();
    views.clear();
    chatSession.flushStorageData();
    githubSession.flushStorageData();
    void Promise.allSettled([chatSession.cookies.flushStore(), githubSession.cookies.flushStore()]).finally(() => win.close());
  });
  app.on('window-all-closed', () => app.quit());
  await win.loadURL(local.href);
}
void start().catch(() => { console.error('MAW desktop could not start. Check service readiness and the desktop runtime installation.'); app.exit(1); });

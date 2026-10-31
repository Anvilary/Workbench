import { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { PARTITION, CHANNEL, serviceUrl, trustedSender, validCommand, nativeBounds, nativeBoundsForRect, embeddedUrl, externalUrl, isDownloadOrFileDeliveryUrl } from './policy.mjs';

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

  const win = new BrowserWindow({ width: 1280, height: 860, title: 'MAW · ChatGPT feasibility prototype', autoHideMenuBar: true,
    webPreferences: { ...secure, partition: 'persist:maw-shell-prototype', preload: path.join(here, 'preload.cjs') } });
  const views = new Map();
  const urls = new Map();
  const requestedUrls = new Map();
  const failures = new Map();
  const focusPending = new Set();
  const popups = new Set();
  const attachedViews = new Map(); // id -> WebContentsView (up to 4 simultaneously visible)
  let shuttingDown = false;
  const send = state => { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNEL + ':state', state); };

  // FEATURE 10: Official ChatGPT downloads with native Save As dialog and security validation
  chatSession.on('will-download', (event, item, webContents) => {
    // 1. Verify that download originates from an authorized WebContents
    const tabEntry = [...views.entries()].find(([, v]) => v.webContents === webContents);
    if (!tabEntry) {
      event.preventDefault();
      return;
    }
    const [tabId] = tabEntry;

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

    // 3. Sanitize suggested filename
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

  function invalidate() { hideAll(); send({ type: 'layout-needed' }); }

  async function openExternal(url) {
    if (!externalUrl(url) || win.isDestroyed()) return;
    hideAll();
    const answer = await dialog.showMessageBox(win, { type: 'question', message: 'Open this destination in your browser?', detail: new URL(url).origin, buttons: ['Cancel', 'Open browser'], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) await shell.openExternal(url);
    send({ type: 'layout-needed' });
  }

  function guard(contents, allowPopup = true) {
    const navigation = (event, url) => {
      if (embeddedUrl(url) || isDownloadOrFileDeliveryUrl(url)) return;
      event.preventDefault();
      void openExternal(url).catch(() => send({ type: 'error', message: 'Could not open external browser.' }));
    };
    contents.on('will-navigate', navigation);
    contents.on('will-redirect', navigation);
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (allowPopup && embeddedUrl(url) && popups.size < 1) return { action: 'allow', overrideBrowserWindowOptions: {
        parent: win, autoHideMenuBar: true, width: 640, height: 760,
        webPreferences: { ...secure, session: chatSession, preload: '' },
      } };
      void openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('did-create-window', popup => {
      popups.add(popup);
      popup.setMenu(null);
      guard(popup.webContents, false);
      popup.on('closed', () => { popups.delete(popup); invalidate(); });
    });
    contents.on('before-input-event', desktopShortcut);
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

  function open(id, url) {
    if (views.has(id)) {
      const contents = views.get(id).webContents;
      if (contents.isDestroyed() || (failures.has(id) && requestedUrls.get(id) === url)) {
        send({ type: 'error', id, message: failures.get(id) || 'ChatGPT renderer stopped. Use Reload page to retry.' });
        return;
      }
      if (requestedUrls.get(id) !== url) {
        requestedUrls.set(id, url);
        if (urls.get(id) !== url) { urls.set(id, url); void contents.loadURL(url).catch(() => {}); }
      }
      if (!contents.isLoading() && chatUrlForPersistence(contents.getURL())) {
        send({ type: 'ready', id });
        if (urls.get(id) !== url) send({ type: 'committed', id, url: contents.getURL() });
      }
      return;
    }
    if (views.size >= 8) throw new Error('Prototype view limit reached');
    const view = new WebContentsView({ webPreferences: { ...secure, session: chatSession, backgroundThrottling: true } });
    view.setVisible(false);
    view.setBackgroundColor('#212121');
    views.set(id, view);
    urls.set(id, url);
    requestedUrls.set(id, url);
    guard(view.webContents);
    const committed = (_event, url, isMainFrame = true) => {
      if (!isMainFrame || !chatUrlForPersistence(url)) return;
      urls.set(id, url);
      send({ type: 'committed', id, url });
    };
    view.webContents.on('did-navigate', committed);
    view.webContents.on('did-navigate-in-page', committed);
    view.webContents.on('did-start-loading', () => { failures.delete(id); send({ type: 'loading', id }); });
    view.webContents.on('did-finish-load', () => { if (chatUrlForPersistence(view.webContents.getURL())) send({ type: 'ready', id }); });
    view.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        const message = `ChatGPT failed to load (${code}). Use Reload page to retry.`;
        failures.set(id, message); send({ type: 'error', id, message });
      }
    });
    view.webContents.on('render-process-gone', () => {
      const message = 'ChatGPT renderer stopped. Use Reload page to retry.';
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
    views.delete(id); urls.delete(id); requestedUrls.delete(id); failures.delete(id); focusPending.delete(id);
  }

  ipcMain.handle(CHANNEL, async (event, command) => {
    if (!trustedSender(event, win.webContents, local.origin) || !validCommand(command)) throw new Error('Invalid desktop request');
    if (command.type === 'open') { focusPending.add(command.id); open(command.id, command.url); }
    if (command.type === 'update' && views.has(command.id)) open(command.id, command.url);
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

        if (focusPending.delete(item.id)) {
          view.webContents.focus();
        }
      }

      // 3. Focus ownership
      if (command.focusedId && attachedViews.has(command.focusedId)) {
        const focusedView = attachedViews.get(command.focusedId);
        if (focusedView && !focusedView.webContents.isDestroyed()) {
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
    void chatSession.cookies.flushStore().finally(() => win.close());
  });
  app.on('window-all-closed', () => app.quit());
  await win.loadURL(local.href);
}
void start().catch(() => { console.error('MAW desktop could not start. Check service readiness and the desktop runtime installation.'); app.exit(1); });

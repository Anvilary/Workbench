import { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { PARTITION, CHANNEL, serviceUrl, trustedSender, validCommand, nativeBounds, embeddedUrl, externalUrl } from './policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Deliberately distinct from both production MAW and any Brave/Neko profile.
app.setPath('userData', path.resolve(process.env.MAW_DESKTOP_DATA_DIR || path.join(app.getPath('appData'), 'maw-desktop-prototype')));
app.setName('MAW ChatGPT Prototype');
if (app.commandLine.hasSwitch('no-sandbox')) throw new Error('MAW desktop requires Chromium sandboxing');
app.enableSandbox();
const local = serviceUrl(process.env.MAW_DESKTOP_URL || '');
if (!app.requestSingleInstanceLock()) app.exit(0);
// Do not await app.whenReady() at module scope: Electron waits for ESM
// evaluation before emitting ready, which would deadlock initialization.
async function start() {
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const secure = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false };
  const chatSession = session.fromPartition(PARTITION);
  chatSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  chatSession.setPermissionCheckHandler(() => false);
  chatSession.on('will-download', event => event.preventDefault());
  const win = new BrowserWindow({ width: 1280, height: 860, title: 'MAW · ChatGPT feasibility prototype', autoHideMenuBar: true,
    webPreferences: { ...secure, partition: 'persist:maw-shell-prototype', preload: path.join(here, 'preload.cjs') } });
  const views = new Map();
  const urls = new Map();
  const requestedUrls = new Map();
  const failures = new Map();
  const focusPending = new Set();
  const popups = new Set();
  let active = null;
  let shuttingDown = false;
  const send = state => { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNEL + ':state', state); };
  function hide() {
    if (active) {
      const focused = !active.webContents.isDestroyed() && active.webContents.isFocused();
      win.contentView.removeChildView(active);
      active.setVisible(false);
      active = null;
      if (focused && !win.webContents.isDestroyed()) win.webContents.focus();
    }
  }
  function invalidate() { hide(); send({ type: 'layout-needed' }); }
  async function openExternal(url) {
    if (!externalUrl(url) || win.isDestroyed()) return;
    hide();
    const answer = await dialog.showMessageBox(win, { type: 'question', message: 'Open this destination in your browser?', detail: new URL(url).origin, buttons: ['Cancel', 'Open browser'], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) await shell.openExternal(url);
    send({ type: 'layout-needed' });
  }
  function guard(contents, allowPopup = true) {
    const navigation = (event, url) => {
      if (embeddedUrl(url)) return;
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
      if (active === view) invalidate();
      send({ type: 'error', id, message });
    });
    void view.webContents.loadURL(url).catch(() => {});
  }
  function closeView(id) {
    const view = views.get(id);
    if (!view) return;
    if (active === view) hide();
    if (!view.webContents.isDestroyed()) view.webContents.close();
    views.delete(id); urls.delete(id); requestedUrls.delete(id); failures.delete(id); focusPending.delete(id);
  }
  ipcMain.handle(CHANNEL, (event, command) => {
    if (!trustedSender(event, win.webContents, local.origin) || !validCommand(command)) throw new Error('Invalid desktop request');
    if (command.type === 'open') { focusPending.add(command.id); open(command.id, command.url); }
    if (command.type === 'update' && views.has(command.id)) open(command.id, command.url);
    if (command.type === 'close') closeView(command.id);
    if (command.type === 'retain') for (const id of views.keys()) if (!command.ids.includes(id)) closeView(id);
    if (command.type === 'layout') {
      const bounds = nativeBounds(command, win.getContentSize(), win.webContents.getZoomFactor());
      const view = views.get(command.id);
      if (!bounds || !view || view.webContents.isDestroyed() || win.isMinimized()) { hide(); return; }
      if (active !== view) {
        hide();
        win.contentView.addChildView(view);
        active = view;
      }
      view.setBounds(bounds);
      view.setVisible(true);
      if (focusPending.delete(command.id)) view.webContents.focus();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url).catch(() => {}); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin === local.origin && new URL(url).pathname === '/') return; } catch {}
    event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => { if (new URL(url).origin !== local.origin) event.preventDefault(); });
  win.webContents.on('did-start-loading', hide);
  win.webContents.on('render-process-gone', hide);
  for (const event of ['resize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(event, invalidate);
  win.webContents.on('before-input-event', desktopShortcut);
  app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
  win.on('close', event => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    hide();
    for (const popup of popups) popup.destroy();
    for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.close();
    views.clear();
    chatSession.flushStorageData();
    void chatSession.cookies.flushStore().finally(() => win.close());
  });
  app.on('window-all-closed', () => app.quit());
  await win.loadURL(local.href);
}
void start().catch(error => { console.error('MAW desktop failed:', error.message); app.exit(1); });

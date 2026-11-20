/**
 * The main shell window and its page level security.
 *
 * Creates the BrowserWindow that hosts the shell page, the channel the main
 * process uses to talk to it, and the handlers that keep that page on the local
 * backend origin.
 */

import path from 'node:path';
import { CHANNEL, externalUrl } from '../../policy.mjs';
import { configureShellSessionSecurity } from '../security/session-permissions.mjs';

export function createMainWindow({ electron, secure, backend, here }) {
  const { BrowserWindow } = electron;
  const iconPath = path.join(here, 'icon.png');
  const win = new BrowserWindow({ width: 1280, height: 860, title: 'Anvilary Workbench', autoHideMenuBar: true,
    backgroundColor: '#0e0e10',
    icon: iconPath,
    webPreferences: { ...secure, partition: 'persist:maw-shell-prototype', preload: path.join(here, 'preload.cjs') } });
  configureShellSessionSecurity({
    session: win.webContents.session,
    getLocalOrigin: () => backend.current().origin,
    externalUrl,
  });
  const send = state => { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNEL + ':state', state); };
  return { win, send };
}

export function wireShellWindowEvents({ win, send, backend, controller, performance, desktopShortcut }) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (controller.tryOpenOAuthLoopback(url, 'shell')) {
      return { action: 'deny' };
    }
    void controller.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (controller.tryOpenOAuthLoopback(url, 'shell')) {
      event.preventDefault();
      return;
    }
    try { if (new URL(url).origin === backend.current().origin && new URL(url).pathname === '/') return; } catch {}
    event.preventDefault();
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (controller.tryOpenOAuthLoopback(url, 'shell')) {
      event.preventDefault();
      return;
    }
    try { if (new URL(url).origin !== backend.current().origin) event.preventDefault(); } catch { event.preventDefault(); }
  });
  win.webContents.on('did-start-loading', () => {
    controller.resetForShellReload();
    performance.reset();
  });
  win.webContents.on('render-process-gone', () => {
    controller.resetForShellReload();
    performance.reset();
    controller.destroyAllPopups();
  });
  for (const event of ['minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(event, controller.invalidate);
  win.on('resize', () => send({ type: 'layout-needed' }));
  win.webContents.on('before-input-event', desktopShortcut);
}

// Trusted native dialog for collecting security key PIN.
// Uses an isolated BrowserWindow with contextIsolation: true and sandbox: true.
// The collected PIN is never persisted to disk or logged.

import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Displays a native modal PIN dialog to collect the hardware security key PIN.
 * @param {object} options
 * @param {BrowserWindow|null} [options.parentWindow]
 * @param {string} [options.title]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<string>}
 */
export function requestPinDialog({
  parentWindow = null,
  title = 'Security Key PIN',
  timeoutMs = 60000,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const win = new BrowserWindow({
      width: 380,
      height: 210,
      modal: Boolean(parentWindow && !parentWindow.isDestroyed()),
      parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
      show: false,
      resizable: false,
      autoHideMenuBar: true,
      title,
      webPreferences: {
        preload: path.join(here, 'webauthn-dialog-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const cleanup = () => {
      ipcMain.removeListener('maw:webauthn:pin-submit', onSubmit);
      ipcMain.removeListener('maw:webauthn:pin-cancel', onCancel);
      clearTimeout(timer);
    };

    const onSubmit = (_event, pin) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { win.close(); } catch {}
      resolve(pin);
    };

    const onCancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { win.close(); } catch {}
      reject(new Error('NotAllowedError: PIN entry was cancelled'));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      try { win.close(); } catch {}
      reject(new Error('NotAllowedError: PIN entry timed out'));
    }, timeoutMs);

    ipcMain.on('maw:webauthn:pin-submit', onSubmit);
    ipcMain.on('maw:webauthn:pin-cancel', onCancel);

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('NotAllowedError: PIN entry window was closed'));
      }
    });

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });

    win.loadFile(path.join(here, 'webauthn-dialog.html'));
  });
}

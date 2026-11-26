// Trusted native dialog for collecting security key PIN.
// Uses an isolated BrowserWindow with contextIsolation: true and sandbox: true.
// The collected PIN is never persisted to disk or logged.

import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidWebAuthnPin } from './policy.mjs';
import crypto from 'node:crypto';
import { calculatePinDialogPosition } from './dialog-position.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export { calculatePinDialogPosition };

/**
 * Displays a native PIN dialog positioned relative to the requesting browser pane.
 * @param {object} options
 * @param {BrowserWindow|null} [options.parentWindow]
 * @param {{ x: number, y: number, width: number, height: number }|null} [options.paneBounds]
 * @param {string} [options.rpId]
 * @param {string} [options.title]
 * @param {string} [options.error]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<string>}
 */
export function requestPinDialog({
  parentWindow = null,
  paneBounds = null,
  rpId = '',
  title = 'Security Key PIN',
  error = '',
  timeoutMs = 60000,
  signal = null,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('NotAllowedError: security key operation cancelled'));
      return;
    }
    let settled = false;
    const requestId = crypto.randomUUID();

    const dialogWidth = 400;
    const dialogHeight = error ? 260 : 230;

    const win = new BrowserWindow({
      width: dialogWidth,
      height: dialogHeight,
      useContentSize: true,
      modal: false,
      parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
      alwaysOnTop: true,
      show: false,
      resizable: false,
      autoHideMenuBar: true,
      title,
      webPreferences: {
        preload: path.join(here, 'dialog-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    if (parentWindow && !parentWindow.isDestroyed()) {
      const contentBounds = parentWindow.getContentBounds();
      const pos = calculatePinDialogPosition({
        contentBounds,
        paneBounds,
        dialogWidth,
        dialogHeight,
      });
      win.setPosition(pos.x, pos.y);
    }

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { if (!win.isDestroyed()) win.close(); } catch {}
      reject(new Error('NotAllowedError: security key operation cancelled'));
    };

    const cleanup = () => {
      ipcMain.removeListener('workbench:webauthn:pin-submit', onSubmit);
      ipcMain.removeListener('workbench:webauthn:pin-cancel', onCancel);
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const onSubmit = (event, payload) => {
      if (settled) return;
      if (event.sender !== win.webContents) return;
      if (!payload || payload.requestId !== requestId) return;
      settled = true;
      cleanup();
      try { win.close(); } catch {}
      if (isValidWebAuthnPin(payload.pin)) resolve(payload.pin);
      else reject(new Error('NotAllowedError: Invalid security key PIN input'));
    };

    const onCancel = (event, payload) => {
      if (settled) return;
      if (event.sender !== win.webContents) return;
      if (payload && payload.requestId && payload.requestId !== requestId) return;
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

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    ipcMain.on('workbench:webauthn:pin-submit', onSubmit);
    ipcMain.on('workbench:webauthn:pin-cancel', onCancel);

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

    const query = { requestId };
    if (rpId) query.rpId = rpId;
    if (error) query.error = error;
    win.loadFile(path.join(here, 'dialog.html'), { query });
  });
}

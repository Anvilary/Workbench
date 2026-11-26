import { workbenchEnv } from '../../scripts/workbench/env.mjs';
import { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, shell, dialog, clipboard, ClipboardItem } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { serviceUrl } from './policy.mjs';
import { createBackendEndpoint } from './src/app/backend-endpoint.mjs';
import { startBackendWatchdog } from './src/app/backend-watchdog.mjs';
import { installLifecycle } from './src/app/lifecycle.mjs';
import { createMainWindow, wireShellWindowEvents } from './src/app/main-window.mjs';
import { configureProcess } from './src/app/process-setup.mjs';
import { installDesktopDiagnostics } from './src/app/diagnostic-log.mjs';
import { createDesktopShortcut } from './src/app/shell-shortcuts.mjs';
import { createBrowserViewController } from './src/browser/view-controller.mjs';
import { createClipboardCommands } from './src/ipc/clipboard-commands.mjs';
import { registerCommandRouter } from './src/ipc/command-router.mjs';
import { createPerformanceChannel } from './src/performance/performance-channel.mjs';
import { isOAuthLoopbackCallback } from './src/security/oauth-loopback.mjs';
import { registerWebAuthnIpc } from './src/security/webauthn-ipc.mjs';

export { isOAuthLoopbackCallback };

/*
 * Composition entry point of the desktop shell. Each responsibility lives in
 * src/: app/ (process, window, lifecycle, backend), browser/ (native views,
 * owned by the BrowserViewController), ipc/ (the privileged command channel),
 * security/, performance/ and gpu/.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const electron = { app, BrowserWindow, WebContentsView, ipcMain, session, shell, dialog, clipboard };
// First: from here on, main-process errors leave a trace on disk.
const logger = installDesktopDiagnostics({ app, dialog });
const { backendUrl: initialBackendUrl, hardwareAcceleration } = configureProcess({ app, logger });

// Do not await app.whenReady() at module scope: Electron waits for ESM
// evaluation before emitting ready, which would deadlock initialization.
async function start() {
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const isWebAuthnEnabled = workbenchEnv('WEBAUTHN_ENABLED') !== '0';
  const webauthnPreload = path.join(here, 'src/security/webauthn/preload.cjs');
  const secure = { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false };

  const backend = createBackendEndpoint(initialBackendUrl, { serviceUrl });
  const { win, send } = createMainWindow({ electron, secure, backend, here });
  const appState = { shuttingDown: false };
  const desktopShortcut = createDesktopShortcut({ win, send });
  const controller = createBrowserViewController({
    electron, win, send, backend, secure, isWebAuthnEnabled, webauthnPreload, desktopShortcut,
  });
  const performance = createPerformanceChannel({ app, win, send, backend, controller });
  registerCommandRouter({
    ipcMain, win, dialog, backend, controller, performance, hardwareAcceleration,
    clipboardCommands: createClipboardCommands({ clipboard, ClipboardItem }),
  });
  const webauthn = isWebAuthnEnabled
    ? registerWebAuthnIpc({
      ipcMain, BrowserWindow, win,
      sessionProviderOf: controller.sessionProviderOf,
      attachedViews: controller.attachedViews(),
    })
    : null;
  wireShellWindowEvents({ win, send, backend, controller, performance, desktopShortcut });
  const watchdog = startBackendWatchdog({ win, send, backend, controller, appState });
  installLifecycle({ app, win, backend, controller, performance, webauthn, watchdog, appState });
  await win.loadURL(backend.current().href);
}
void start().catch((error) => { logger.error('desktop start failed', error); console.error('Workbench desktop could not start. Check service readiness and the desktop runtime installation.'); app.exit(1); });

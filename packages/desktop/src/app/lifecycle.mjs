/**
 * Application lifecycle: a second instance asking to show the window, and an
 * orderly shutdown when the window closes.
 */

import { serviceUrl } from '../../policy.mjs';

export function installLifecycle({ app, win, backend, controller, performance, webauthn, watchdog, appState }) {
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    try {
      const next = serviceUrl(data.serviceUrl);
      if (next.href !== backend.current().href) { controller.hideAll(); backend.set(next); void win.loadURL(backend.current().href).catch(() => {}); }
    } catch { return; }
    if (win.isMinimized()) win.restore(); win.show(); win.focus();
  });
  win.on('close', event => {
    if (appState.shuttingDown) return;
    event.preventDefault();
    appState.shuttingDown = true;
    webauthn?.abortActive();
    clearInterval(watchdog);
    performance.dispose();
    void controller.shutdown().finally(() => win.close());
  });
  app.on('window-all-closed', () => app.quit());
}

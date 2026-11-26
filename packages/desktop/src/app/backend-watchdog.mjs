/**
 * Backend watchdog.
 *
 * Every two seconds: trim resident views if some are not visible, probe the
 * backend and, when it moved, reconnect the shell to the new endpoint.
 */

export function startBackendWatchdog({ win, send, backend, controller, appState }) {
  let backendFailureCount = 0;
  let trimTick = 0;
  const checkInterval = setInterval(async () => {
    if (appState.shuttingDown) return;
    if (controller.hasNonVisibleViews() && ++trimTick % 5 === 0) {
      controller.trimCapacity();
    }
    try {
      const probe = await fetch(backend.current(), { signal: AbortSignal.timeout(1200), redirect: 'error' });
      if (probe.ok) {
        backendFailureCount = 0;
        return;
      }
      backendFailureCount++;
    } catch {
      backendFailureCount++;
    }

    if (backendFailureCount > 0) {
      try {
        const discovered = await backend.readiness();
        if (discovered.url.href !== backend.current().href) {
          const originChanged = discovered.url.origin !== backend.current().origin;
          if (originChanged) {
            // Only Workbench's own renderer storage crosses a loopback-port change.
            // Website sessions and live views stay in their existing partitions.
            backend.setPendingShellStorage(await win.webContents.executeJavaScript('({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) })'));
          }
          backend.set(discovered.url);
          backendFailureCount = 0;
          if (originChanged) {
            controller.hideAll();
            await win.loadURL(backend.current().href);
            return;
          }
          send({
            type: 'backend-reconnected',
            url: discovered.url.href,
            token: discovered.url.searchParams.get('token'),
            port: discovered.url.port,
          });
        }
      } catch {}
    }
  }, 2000);
  checkInterval.unref();
  return checkInterval;
}

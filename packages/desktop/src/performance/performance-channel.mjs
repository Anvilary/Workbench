/**
 * The performance panel's subscription to the resource monitor.
 *
 * Owns the single ResourceCollector and whether the shell is subscribed to it.
 */

import { ResourceCollector } from './resource-monitor.mjs';

export function createPerformanceChannel({ app, win, send, backend, controller }) {
  const resourceCollector = new ResourceCollector({
    app,
    win,
    ...controller.collectorSources(),
    getBackendReadiness: () => backend.readiness(),
    getBrowserLifecycle: () => controller.browserLifecycleTelemetry(),
    onState: (snapshot) => {
      send({ type: 'performance-update', snapshot });
    },
  });
  let performanceSubscribed = false;

  return {
    async subscribe() {
    const snapshot = await (performanceSubscribed ? resourceCollector.refresh() : (performanceSubscribed = true, resourceCollector.subscribe()));
    return { ok: true, snapshot };
    },
    unsubscribe() {
    if (performanceSubscribed) resourceCollector.unsubscribe();
    performanceSubscribed = false;
    return { ok: true };
    },
    pause() {
      resourceCollector.pause();
      return { ok: true };
    },
    resume() {
      resourceCollector.resume();
      return { ok: true };
    },
    async refresh() {
      const snapshot = await resourceCollector.refresh();
      return { ok: true, snapshot };
    },
    /** The shell page reloaded or crashed: the panel is gone with it. */
    reset() {
      if (performanceSubscribed) resourceCollector.unsubscribe();
      performanceSubscribed = false;
    },
    dispose: () => resourceCollector.dispose(),
  };
}

/**
 * A fake Electron harness for the BrowserViewController.
 *
 * It implements only what the controller actually calls: anything else answers with a
 * no-op function, so the harness never has to track Electron's full surface. Tests drive
 * lifecycle events by emitting WebContents events directly.
 */

const noop = () => {};

function withNoopFallback(target) {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      return noop;
    },
    has: () => true,
  });
}

export function createFakeWebContents({ url = 'about:blank', processId = 4242 } = {}) {
  const listeners = new Map();
  const state = { url, destroyed: false, loading: false, devTools: false, throttled: true, probeResult: false, probeCalls: [] };
  const base = {
    __state: state,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return base;
    },
    once(event, handler) { return base.on(event, handler); },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
    isDestroyed: () => state.destroyed,
    getURL: () => state.url,
    isLoading: () => state.loading,
    isDevToolsOpened: () => state.devTools,
    closeDevTools: () => { state.devTools = false; },
    getOSProcessId: () => processId,
    setBackgroundThrottling: (value) => { state.throttled = value; },
    loadURL: (next) => { state.url = next; return Promise.resolve(); },
    close: () => { state.destroyed = true; },
    downloadURL: noop,
    setZoomLevel: noop,
    setWindowOpenHandler: noop,
    executeJavaScriptInIsolatedWorld: (worldId, scripts) => {
      state.probeCalls.push({ worldId, scripts });
      return Promise.resolve(state.probeResult);
    },
    navigationHistory: {
      getAllEntries: () => [{ url: state.url, title: '' }],
      getActiveIndex: () => 0,
      canGoBack: () => false,
      canGoForward: () => false,
      restore: () => Promise.resolve(),
    },
    session: withNoopFallback({ cookies: withNoopFallback({ flushStore: () => Promise.resolve() }) }),
  };
  return withNoopFallback(base);
}

export function createFakeElectron() {
  const sessions = new Map();
  const created = [];
  const electron = {
    app: withNoopFallback({ getAppMetrics: () => [], getPath: () => '/tmp/maw-harness' }),
    clipboard: withNoopFallback({}),
    session: withNoopFallback({
      fromPartition: (name) => {
        if (!sessions.has(name)) {
          sessions.set(name, withNoopFallback({
            cookies: withNoopFallback({ flushStore: () => Promise.resolve() }),
            availableSpellCheckerLanguages: ['en-US'],
            listWordsInSpellCheckerDictionary: () => Promise.resolve([]),
          }));
        }
        return sessions.get(name);
      },
    }),
    WebContentsView: class {
      constructor(options) {
        this.options = options;
        this.webContents = createFakeWebContents();
        this.visible = false;
        created.push(this);
      }

      setVisible(value) { this.visible = value; }
      setBackgroundColor() {}
      setBounds() {}
      setBorderRadius() {}
    },
    BrowserWindow: class {},
  };
  return { electron, createdViews: created };
}

export function createFakeWindow() {
  const window = withNoopFallback({
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    contentView: withNoopFallback({ addChildView: noop, removeChildView: noop, children: [] }),
    webContents: createFakeWebContents(),
  });
  return window;
}

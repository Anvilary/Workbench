import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppSettingsCoordinator } from '../../../src/features/settings/useAppSettings.ts';
import {
  BROWSER_SETTINGS_STORAGE_KEY,
  createDefaultBrowserSettings,
  getBrowserSettingsStoreState,
  mutateAuthoritativeCustomDictionary,
  resetBrowserSettingsStoreForTests,
  retryNativeDictionarySync,
  setActiveAppSettings,
  subscribeBrowserSettingsStore,
  syncAuthoritativeBrowserSettings,
} from '../../../src/features/browser/browser-settings-store.ts';

function createMockConnection() {
  const msgListeners = new Set();
  const statusListeners = new Set();
  const sentImmediate = [];
  const queuedSend = [];
  let connected = true;

  return {
    onMessage: (fn) => {
      msgListeners.add(fn);
      return () => msgListeners.delete(fn);
    },
    onStatus: (fn) => {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    send: (msg) => {
      queuedSend.push(msg);
      return connected;
    },
    sendImmediate: (msg) => {
      if (!connected) return false;
      sentImmediate.push(msg);
      return true;
    },
    emitMessage: (msg) => {
      for (const l of msgListeners) l(msg);
    },
    setConnected: (next) => {
      connected = next;
      const st = next ? 'open' : 'reconnecting';
      for (const l of statusListeners) l(st);
    },
    sentImmediate,
    queuedSend,
  };
}

function makeAppStatus(overrides = {}) {
  const base = createDefaultBrowserSettings();
  return {
    consoleShell: 'auto',
    consoleShells: [],
    shellName: null,
    disabledAgents: [],
    disabledAtStart: [],
    browser: {
      ...base,
      ...overrides,
    },
  };
}

function makeBridge(handler) {
  const commands = [];
  const bridge = {
    command: async (cmd) => {
      commands.push(cmd);
      return await handler(cmd);
    },
    subscribe: () => () => {},
  };
  return { bridge, commands };
}

function coordinatorToApi(coord) {
  return {
    get status() {
      return coord.getSnapshot().status;
    },
    get problem() {
      return coord.getSnapshot().problem;
    },
    setConsoleShell: coord.setConsoleShell,
    setDisabledAgents: coord.setDisabledAgents,
    setBrowserSettings: coord.setBrowserSettings,
    updateBrowserSettings: coord.updateBrowserSettings,
    dismissProblem: coord.dismissProblem,
  };
}

test('Authoritative-first commit: rejects on server rejection, disconnected before send, and disconnect before ack without native mutation', async () => {
  resetBrowserSettingsStoreForTests();
  const { bridge, commands } = makeBridge(async () => ({ ok: true }));
  globalThis.window = {
    mawChatGpt: bridge,
    addEventListener: () => {},
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  };

  const conn = createMockConnection();
  const coord = createAppSettingsCoordinator(conn, { timeoutMs: 200 });
  const api = coordinatorToApi(coord);
  setActiveAppSettings(api);
  const unsub = subscribeBrowserSettingsStore(() => {});

  const initStatus = makeAppStatus({
    spellCheck: { enabled: true, languages: ['en-US'], configuredLanguages: ['en-US'], customWordsByProfile: { main: ['initial'] } },
  });
  conn.emitMessage({ type: 'settings.status', settings: initStatus });
  syncAuthoritativeBrowserSettings(initStatus.browser);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(commands.filter((c) => c.type === 'reconcile-custom-dictionary').length, 1);

  // 1. Server-side rejection -> mutation fails BEFORE native partition changes
  const pReject = mutateAuthoritativeCustomDictionary('add', 'badword', 'main', api);
  const reqReject = conn.sentImmediate.at(-1);
  assert.ok(reqReject.requestId);
  conn.emitMessage({
    type: 'error',
    code: 'settings-failed',
    text: { key: 'settingsFailed' },
    requestId: reqReject.requestId,
  });
  const resReject = await pReject;
  assert.equal(resReject.success, false);
  assert.deepEqual(getBrowserSettingsStoreState().settings.spellCheck?.customWordsByProfile?.main, ['initial']);
  assert.equal(commands.filter((c) => c.type === 'reconcile-custom-dictionary').length, 1);

  // 2. Disconnect mid-flight before ack -> resolves failure without hanging or queuing into outbox
  const pLost = mutateAuthoritativeCustomDictionary('add', 'lostword', 'main', api);
  conn.setConnected(false);
  const resLost = await pLost;
  assert.equal(resLost.success, false);
  assert.match(resLost.error ?? '', /Connection lost/);
  assert.equal(conn.queuedSend.length, 0);

  // 3. Disconnected before send -> rejects immediately without touching native bridge
  const pDisconnected = mutateAuthoritativeCustomDictionary('add', 'offlineword', 'main', api);
  const resDisconnected = await pDisconnected;
  assert.equal(resDisconnected.success, false);
  assert.match(resDisconnected.error ?? '', /Not connected/);

  unsub();
  coord.dispose();
  delete globalThis.window;
});

test('localStorage cache never runs native dictionary reconciliation; reconnect converges without blocked queue', async () => {
  resetBrowserSettingsStoreForTests();
  const { bridge, commands } = makeBridge(async () => ({ ok: true }));
  const storage = new Map();
  storage.set(
    BROWSER_SETTINGS_STORAGE_KEY,
    JSON.stringify(
      makeAppStatus({
        spellCheck: {
          enabled: true,
          languages: ['en-US'],
          configuredLanguages: ['en-US'],
          customWordsByProfile: { main: ['staleLocalWord'] },
        },
      }).browser,
    ),
  );
  globalThis.window = {
    mawChatGpt: bridge,
    addEventListener: () => {},
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
    },
  };

  const conn = createMockConnection();
  const coord = createAppSettingsCoordinator(conn);
  const api = coordinatorToApi(coord);
  setActiveAppSettings(api);
  const unsub = subscribeBrowserSettingsStore(() => {});
  const unsub2 = subscribeBrowserSettingsStore(() => {});

  // Non-authoritative localStorage cache must NEVER trigger reconcile-custom-dictionary
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(commands.filter((c) => c.type === 'reconcile-custom-dictionary').length, 0);

  // Authoritative snapshot on connect replaces localStorage cache and reconciles once
  const serverSnap = makeAppStatus({
    spellCheck: {
      enabled: true,
      languages: ['en-US'],
      configuredLanguages: ['en-US'],
      customWordsByProfile: { main: ['serverAuthoritative'] },
    },
  });
  conn.emitMessage({ type: 'settings.status', settings: serverSnap });
  syncAuthoritativeBrowserSettings(serverSnap.browser);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    getBrowserSettingsStoreState().settings.spellCheck?.customWordsByProfile?.main,
    ['serverAuthoritative'],
  );
  const recCmds = commands.filter((c) => c.type === 'reconcile-custom-dictionary');
  assert.equal(recCmds.length, 1);
  assert.deepEqual(recCmds[0]?.customWordsByProfile, { main: ['serverAuthoritative'] });

  // Simulate ack loss after commit followed by reconnect delivering newer authoritative state
  const pMut = mutateAuthoritativeCustomDictionary('add', 'clientAttempted', 'main', api);
  conn.setConnected(false);
  const ackLost = await pMut;
  assert.equal(ackLost.success, false);

  conn.setConnected(true);
  const serverLater = makeAppStatus({
    spellCheck: {
      enabled: true,
      languages: ['en-US'],
      configuredLanguages: ['en-US'],
      customWordsByProfile: { main: ['serverLaterWin'] },
    },
  });
  conn.emitMessage({ type: 'settings.status', settings: serverLater });
  syncAuthoritativeBrowserSettings(serverLater.browser);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    getBrowserSettingsStoreState().settings.spellCheck?.customWordsByProfile?.main,
    ['serverLaterWin'],
  );

  unsub();
  unsub2();
  coord.dispose();
  delete globalThis.window;
});

test('Scenario 8: failed native reconciliation leaves applied revision unmarked and recovers deterministically via retry and focus events', async () => {
  resetBrowserSettingsStoreForTests();
  let failReconcile = true;
  const focusHandlers = new Set();
  const { bridge, commands } = makeBridge(async (cmd) => {
    if (cmd.type === 'reconcile-custom-dictionary' && failReconcile) {
      return { ok: false, failedPartitions: ['persist:maw-github'], error: 'Partition write failed' };
    }
    return { ok: true };
  });
  globalThis.window = {
    mawChatGpt: bridge,
    addEventListener: (ev, fn) => {
      if (ev === 'focus') focusHandlers.add(fn);
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  };

  const conn = createMockConnection();
  const coord = createAppSettingsCoordinator(conn);
  const api = coordinatorToApi(coord);
  setActiveAppSettings(api);
  const unsub = subscribeBrowserSettingsStore(() => {});

  const initial = makeAppStatus({
    spellCheck: { enabled: true, languages: ['en-US'], configuredLanguages: ['en-US'], customWordsByProfile: {} },
  });
  conn.emitMessage({ type: 'settings.status', settings: initial });
  syncAuthoritativeBrowserSettings(initial.browser);
  await new Promise((r) => setTimeout(r, 10));

  // Commit word while native reconciliation fails
  const addPromise = mutateAuthoritativeCustomDictionary('add', 'durableword', 'main', api);
  const req = conn.sentImmediate.at(-1);
  const committedStatus = makeAppStatus({
    spellCheck: {
      enabled: true,
      languages: ['en-US'],
      configuredLanguages: ['en-US'],
      customWordsByProfile: { main: ['durableword'] },
    },
  });
  conn.emitMessage({ type: 'settings.status', requestId: req.requestId, settings: committedStatus });

  const addRes = await addPromise;
  assert.equal(addRes.success, true);
  assert.equal(addRes.nativeSyncPending, true);
  assert.equal(getBrowserSettingsStoreState().nativeDictionarySync.status, 'failed');
  assert.deepEqual(getBrowserSettingsStoreState().nativeDictionarySync.failedPartitions, ['persist:maw-github']);

  // Recover via explicit retry on the same desired revision
  failReconcile = false;
  const retryRes = await retryNativeDictionarySync();
  assert.equal(retryRes.ok, true);
  assert.equal(getBrowserSettingsStoreState().nativeDictionarySync.status, 'synced');
  assert.deepEqual(getBrowserSettingsStoreState().nativeDictionarySync.failedPartitions, []);
  const reconciles = commands.filter((c) => c.type === 'reconcile-custom-dictionary');
  assert.equal(reconciles.at(-1)?.customWordsByProfile?.main?.[0], 'durableword');

  // Subsequent failed mutation also recovers cleanly when a window focus event fires
  failReconcile = true;
  const add2 = mutateAuthoritativeCustomDictionary('add', 'secondword', 'main', api);
  const req2 = conn.sentImmediate.at(-1);
  conn.emitMessage({
    type: 'settings.status',
    requestId: req2.requestId,
    settings: makeAppStatus({
      spellCheck: {
        enabled: true,
        languages: ['en-US'],
        configuredLanguages: ['en-US'],
        customWordsByProfile: { main: ['durableword', 'secondword'] },
      },
    }),
  });
  const add2Res = await add2;
  assert.equal(add2Res.nativeSyncPending, true);
  assert.equal(getBrowserSettingsStoreState().nativeDictionarySync.status, 'failed');

  failReconcile = false;
  for (const fn of focusHandlers) fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getBrowserSettingsStoreState().nativeDictionarySync.status, 'synced');

  unsub();
  coord.dispose();
  delete globalThis.window;
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageCommands } from '../../../src/browser/page-commands.mjs';
import { canEvictView, MemoryPressureTier, selectEvictionCandidate } from '../../../src/performance/resource-budget.mjs';

function mockWebContents({ isOpened = false } = {}) {
  let devToolsOpened = isOpened;
  let inspectedCoords = null;
  let devToolsOptions = null;
  let destroyed = false;

  return {
    isDestroyed: () => destroyed,
    isLoading: () => false,
    getURL: () => 'https://chatgpt.com/',
    openDevTools: (options) => {
      devToolsOpened = true;
      devToolsOptions = options;
    },
    closeDevTools: () => {
      devToolsOpened = false;
    },
    isDevToolsOpened: () => devToolsOpened,
    inspectElement: (x, y) => {
      inspectedCoords = { x, y };
    },
    close: () => {
      destroyed = true;
    },
    getInspectedCoords: () => inspectedCoords,
    getDevToolsOptions: () => devToolsOptions,
  };
}

test('pageCommands.inspectPage: opens detached DevTools for target tab', () => {
  const contents = mockWebContents();
  const views = new Map([['tab-1', { webContents: contents }]]);
  const state = {
    views,
    providers: new Map([['tab-1', 'chatgpt']]),
    failures: new Set(),
    lastAccessedAt: new Map(),
    authEntryUrls: new Map(),
    findRequests: new Map(),
  };

  const pageCommands = createPageCommands({
    electron: {},
    clipboard: {},
    state,
    guard: {},
    send: () => {},
  });

  const result = pageCommands.inspectPage({ id: 'tab-1' });
  assert.equal(result.ok, true);
  assert.equal(contents.isDevToolsOpened(), true);
  assert.deepEqual(contents.getDevToolsOptions(), { mode: 'detach', activate: true });
});

test('pageCommands.inspectPage: passes coordinates to inspectElement when provided', () => {
  const contents = mockWebContents();
  const views = new Map([['tab-1', { webContents: contents }]]);
  const state = {
    views,
    providers: new Map([['tab-1', 'chatgpt']]),
    failures: new Set(),
    lastAccessedAt: new Map(),
    authEntryUrls: new Map(),
    findRequests: new Map(),
  };

  const pageCommands = createPageCommands({
    electron: {},
    clipboard: {},
    state,
    guard: {},
    send: () => {},
  });

  const result = pageCommands.inspectPage({ id: 'tab-1', x: 250.7, y: 180.2 });
  assert.equal(result.ok, true);
  assert.equal(contents.isDevToolsOpened(), true);
  assert.deepEqual(contents.getInspectedCoords(), { x: 251, y: 180 });
});

test('pageCommands.inspectPage: fails safely for unknown or destroyed tab', () => {
  const state = {
    views: new Map(),
    providers: new Map(),
    failures: new Set(),
    lastAccessedAt: new Map(),
    authEntryUrls: new Map(),
    findRequests: new Map(),
  };

  const pageCommands = createPageCommands({
    electron: {},
    clipboard: {},
    state,
    guard: {},
    send: () => {},
  });

  const result = pageCommands.inspectPage({ id: 'unknown-tab' });
  assert.equal(result.ok, false);
});

test('canEvictView: protects tabs with open DevTools from background eviction', () => {
  const contents = mockWebContents({ isOpened: true });
  const id = 'tab-with-devtools';
  const views = new Map([[id, { webContents: contents }]]);

  const evictable = canEvictView({
    id,
    attachedViews: new Set(), // not currently attached/visible
    layoutFocusedId: null,
    activeDownloads: new Map(),
    popupOwners: new Map(),
    views,
    providers: new Map([[id, 'other']]),
    interactionProtected: new Set(),
    durablePage: () => true,
  });

  assert.equal(evictable, false, 'Tab with open DevTools must not be evicted in background');

  // When DevTools is closed, it becomes eligible for eviction
  contents.closeDevTools();
  const evictableAfterClose = canEvictView({
    id,
    attachedViews: new Set(),
    layoutFocusedId: null,
    activeDownloads: new Map(),
    popupOwners: new Map(),
    views,
    providers: new Map([[id, 'other']]),
    interactionProtected: new Set(),
    durablePage: () => true,
  });

  assert.equal(evictableAfterClose, true);
});

test('canEvictView and selectEvictionCandidate: DevTools remains protected under critical pressure', () => {
  const devToolsContents = mockWebContents({ isOpened: true });
  const ordinaryContents = mockWebContents({ isOpened: false });
  const views = new Map([
    ['tab-devtools', { webContents: devToolsContents }],
    ['tab-ordinary', { webContents: ordinaryContents }],
  ]);
  const providers = new Map([
    ['tab-devtools', 'other'],
    ['tab-ordinary', 'other'],
  ]);
  const lastAccessedAt = new Map([
    ['tab-devtools', 1000],
    ['tab-ordinary', 2000],
  ]);

  for (const tier of [MemoryPressureTier.NORMAL, MemoryPressureTier.MODERATE, MemoryPressureTier.HIGH]) {
    assert.equal(canEvictView({
      id: 'tab-devtools',
      attachedViews: new Set(),
      layoutFocusedId: null,
      activeDownloads: new Map(),
      popupOwners: new Map(),
      views,
      providers,
      interactionProtected: new Set(),
      durablePage: () => true,
      memoryTier: tier,
    }), false, `DevTools tab must be protected under ${tier} pressure`);
  }

  // Critical pressure retains the DevTools tab and reclaims the ordinary tab.
  assert.equal(canEvictView({
    id: 'tab-devtools',
    attachedViews: new Set(),
    layoutFocusedId: null,
    activeDownloads: new Map(),
    popupOwners: new Map(),
    views,
    providers,
    interactionProtected: new Set(),
    durablePage: () => true,
    memoryTier: MemoryPressureTier.CRITICAL,
  }), false);

  const firstCandidate = selectEvictionCandidate({
    residentIds: views.keys(),
    lastAccessedAt,
    canEvict: (id) => canEvictView({
      id,
      attachedViews: new Set(),
      layoutFocusedId: null,
      activeDownloads: new Map(),
      popupOwners: new Map(),
      views,
      providers,
      interactionProtected: new Set(),
      durablePage: () => true,
      memoryTier: MemoryPressureTier.CRITICAL,
    }),
    isProtected: (id) => Boolean(views.get(id)?.webContents?.isDevToolsOpened?.()),
    now: 50_000,
  });
  assert.equal(firstCandidate, 'tab-ordinary');
});

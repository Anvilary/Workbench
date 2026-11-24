import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageCommands } from '../../../src/browser/page-commands.mjs';
import { canEvictView } from '../../../src/performance/resource-budget.mjs';

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

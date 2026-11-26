import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserViewState } from '../../../src/browser/view-state.mjs';
import { createViewEviction } from '../../../src/browser/view-eviction.mjs';

function fakeView({ url = 'https://chatgpt.com/', loading = false, devTools = false, destroyed = false } = {}) {
  return {
    webContents: {
      isDestroyed: () => destroyed,
      isLoading: () => loading,
      getURL: () => url,
      isDevToolsOpened: () => devTools,
      close: () => {},
      closeDevTools: () => {},
    },
  };
}

function setup({ maxResident, tier, aiUnload = false } = {}) {
  const state = createBrowserViewState();
  const evicted = [];
  const previousMax = process.env.WORKBENCH_MAX_RESIDENT_VIEWS;
  const previousTier = process.env.WORKBENCH_MEMORY_PRESSURE_TIER;
  if (maxResident !== undefined) process.env.WORKBENCH_MAX_RESIDENT_VIEWS = String(maxResident);
  if (tier !== undefined) process.env.WORKBENCH_MEMORY_PRESSURE_TIER = tier;
  const aiUnloadRef = { enabled: aiUnload };
  const eviction = createViewEviction({
    app: { getAppMetrics: () => [] },
    state,
    isAiUnloadUnderPressureEnabled: () => aiUnloadRef.enabled,
    evictTab: (id) => {
      evicted.push(id);
      state.views.delete(id);
      state.interactionProtected.delete(id);
      state.suspendedTabs.set(id, { id, provider: state.providers.get(id) ?? 'chatgpt' });
    },
  });
  const restoreEnv = () => {
    if (previousMax === undefined) delete process.env.WORKBENCH_MAX_RESIDENT_VIEWS;
    else process.env.WORKBENCH_MAX_RESIDENT_VIEWS = previousMax;
    if (previousTier === undefined) delete process.env.WORKBENCH_MEMORY_PRESSURE_TIER;
    else process.env.WORKBENCH_MEMORY_PRESSURE_TIER = previousTier;
  };
  return { state, eviction, evicted, restoreEnv, aiUnloadRef };
}

test('telemetry reports residency, attachment and suspension counts', () => {
  const { state, eviction, restoreEnv } = setup();
  try {
    state.views.set('a', fakeView());
    state.views.set('b', fakeView({ url: 'https://github.com/org/repo' }));
    state.providers.set('a', 'chatgpt');
    state.providers.set('b', 'github');
    state.attachedViews.set('a', state.views.get('a'));
    state.suspendedTabs.set('z', { id: 'z', provider: 'chatgpt' });

    const telemetry = eviction.collectTelemetry();
    assert.equal(telemetry.residentViews, 2);
    assert.equal(telemetry.attachedViews, 1);
    assert.equal(telemetry.detachedViews, 1);
    assert.equal(telemetry.suspendedViews, 1);
    assert.equal(telemetry.protectedCounts.provider, 1);
    assert.equal(telemetry.rendererProcessCount, null, 'the monitor fills the renderer process count');
  } finally {
    restoreEnv();
  }
});

test('telemetry counts every applying protection reason and exposes protection age', () => {
  const { state, eviction, restoreEnv } = setup();
  try {
    state.views.set('loading', fakeView({ loading: true }));
    state.views.set('devtools', fakeView({ devTools: true }));
    state.views.set('typed', fakeView());
    state.views.set('downloading', fakeView());
    state.views.set('popup-owner', fakeView());
    state.views.set('nondurable', fakeView({ url: 'https://auth.openai.com/authorize' }));
    for (const id of state.views.keys()) state.providers.set(id, 'chatgpt');
    state.interactionProtected.add('typed');
    state.activeDownloads.set('downloading', 1);
    state.popupOwners.set({}, 'popup-owner');
    state.layoutFocusedId = 'typed';

    const start = Date.now();
    const first = eviction.collectTelemetry(start);
    assert.equal(first.protectedCounts.loading, 1);
    assert.equal(first.protectedCounts.devtools, 1);
    assert.equal(first.protectedCounts.interaction, 1);
    assert.equal(first.protectedCounts.download, 1);
    assert.equal(first.protectedCounts.popup, 1);
    assert.equal(first.protectedCounts.focused, 1);
    assert.equal(first.protectedCounts.nondurable, 1);
    assert.equal(first.protectedCounts.provider, 6);
    assert.equal(first.protectionAgeMs.interaction, 0);

    const later = eviction.collectTelemetry(start + 5_000);
    assert.equal(later.protectionAgeMs.interaction, 5_000);

    state.interactionProtected.delete('typed');
    const cleared = eviction.collectTelemetry(start + 6_000);
    assert.equal(cleared.protectedCounts.interaction, 0);
    assert.equal(cleared.protectionAgeMs.interaction, null);
  } finally {
    restoreEnv();
  }
});

test('tier and budget are unavailable until the governor has run, then mirror it', () => {
  const { state, eviction, restoreEnv } = setup({ maxResident: 1 });
  try {
    const before = eviction.collectTelemetry();
    assert.equal(before.tier, null);
    assert.equal(before.budget, null);
    assert.equal(before.overBudget, null);
    assert.equal(before.evictionBlockers, null);

    state.views.set('a', fakeView({ url: 'https://github.com/org/repo' }));
    state.views.set('b', fakeView({ url: 'https://github.com/org/other' }));
    state.providers.set('a', 'github');
    state.providers.set('b', 'github');
    state.lastAccessedAt.set('a', 1);
    state.lastAccessedAt.set('b', 2);

    eviction.trimCapacity();
    const after = eviction.collectTelemetry();
    assert.equal(after.tier, 'override');
    assert.equal(after.budget, 1);
    assert.equal(after.overBudget, false);
    assert.notEqual(after.lastEviction, null);
    assert.equal(after.lastEviction.id, 'a');
    assert.equal(after.lastEviction.reclaimedPssBytes, null);
    assert.equal(typeof after.lastEviction.reclaimedPssUnavailableReason, 'string');
  } finally {
    restoreEnv();
  }
});

test('eviction blockers record why a trim pass stopped over budget', () => {
  const { state, eviction, evicted, restoreEnv } = setup({ maxResident: 1 });
  try {
    state.views.set('ai-1', fakeView());
    state.views.set('ai-2', fakeView({ url: 'https://www.perplexity.ai/' }));
    state.providers.set('ai-1', 'chatgpt');
    state.providers.set('ai-2', 'perplexity');
    state.lastAccessedAt.set('ai-1', 1);
    state.lastAccessedAt.set('ai-2', 2);

    eviction.trimCapacity();
    assert.deepEqual(evicted, [], 'provider-protected views are never evicted by default');

    const telemetry = eviction.collectTelemetry();
    assert.equal(telemetry.overBudget, true);
    assert.deepEqual(telemetry.evictionBlockers, { provider: 2 });
    assert.equal(telemetry.aiUnloadUnderPressure, false);
  } finally {
    restoreEnv();
  }
});

test('a pool of only protected views still yields an emergency candidate under CRITICAL', () => {
  const { state, eviction, evicted, restoreEnv } = setup({ maxResident: 1, tier: 'critical' });
  try {
    state.views.set('ai-1', fakeView());
    state.views.set('ai-2', fakeView());
    state.providers.set('ai-1', 'chatgpt');
    state.providers.set('ai-2', 'chatgpt');
    state.interactionProtected.add('ai-1');
    state.interactionProtected.add('ai-2');
    state.lastAccessedAt.set('ai-1', 1);
    state.lastAccessedAt.set('ai-2', 2);

    eviction.trimCapacity();
    assert.deepEqual(evicted, ['ai-1'], 'the least recently used protected view is the emergency candidate');
  } finally {
    restoreEnv();
  }
});

test('the governor hysteresis state is never advanced by telemetry reads', () => {
  const { state, eviction, restoreEnv } = setup({ maxResident: 2 });
  try {
    state.views.set('a', fakeView({ url: 'https://github.com/org/repo' }));
    state.providers.set('a', 'github');
    state.attachedViews.set('a', state.views.get('a'));
    eviction.trimCapacity(undefined, 1);
    const first = eviction.peekResourceBudgetInfo();
    assert.notEqual(first, null);
    eviction.collectTelemetry();
    eviction.collectTelemetry();
    assert.deepEqual(eviction.peekResourceBudgetInfo(), first);
  } finally {
    restoreEnv();
  }
});

test('the opt-in policy makes provider tabs evictable at HIGH, and only then', () => {
  for (const [tier, expected] of [['normal', []], ['moderate', []], ['high', ['ai-1']], ['critical', ['ai-1']]]) {
    const { state, eviction, evicted, restoreEnv } = setup({ maxResident: 1, tier, aiUnload: true });
    try {
      state.views.set('ai-1', fakeView());
      state.views.set('ai-2', fakeView());
      state.providers.set('ai-1', 'chatgpt');
      state.providers.set('ai-2', 'chatgpt');
      state.lastAccessedAt.set('ai-1', 1);
      state.lastAccessedAt.set('ai-2', 2);

      eviction.trimCapacity();
      assert.deepEqual(evicted, expected, `tier ${tier}`);
      assert.equal(eviction.collectTelemetry().aiUnloadUnderPressure, true);
    } finally {
      restoreEnv();
    }
  }
});

test('the opt-in policy never overrides the other retention rules at HIGH', () => {
  const cases = [
    ['attached', (state) => state.attachedViews.set('ai-1', state.views.get('ai-1'))],
    ['focused', (state) => { state.layoutFocusedId = 'ai-1'; }],
    ['downloading', (state) => state.activeDownloads.set('ai-1', 1)],
    ['popup owner', (state) => state.popupOwners.set({}, 'ai-1')],
    ['devtools', (state) => { state.views.set('ai-1', fakeView({ devTools: true })); }],
    ['loading', (state) => { state.views.set('ai-1', fakeView({ loading: true })); }],
    ['interaction', (state) => state.interactionProtected.add('ai-1')],
  ];
  for (const [label, apply] of cases) {
    const { state, eviction, evicted, restoreEnv } = setup({ maxResident: 1, tier: 'high', aiUnload: true });
    try {
      state.views.set('ai-1', fakeView());
      state.providers.set('ai-1', 'chatgpt');
      state.lastAccessedAt.set('ai-1', 1);
      apply(state);

      eviction.trimCapacity();
      assert.deepEqual(evicted, [], `a ${label} view must stay resident`);
    } finally {
      restoreEnv();
    }
  }
});

test('turning the policy off restores provider protection at HIGH', () => {
  const { state, eviction, evicted, restoreEnv, aiUnloadRef } = setup({ maxResident: 1, tier: 'high', aiUnload: true });
  try {
    state.views.set('ai-1', fakeView());
    state.views.set('ai-2', fakeView());
    state.providers.set('ai-1', 'chatgpt');
    state.providers.set('ai-2', 'chatgpt');
    state.lastAccessedAt.set('ai-1', 1);
    state.lastAccessedAt.set('ai-2', 2);

    aiUnloadRef.enabled = false;
    eviction.trimCapacity();
    assert.deepEqual(evicted, []);
    assert.equal(eviction.collectTelemetry().aiUnloadUnderPressure, false);
  } finally {
    restoreEnv();
  }
});

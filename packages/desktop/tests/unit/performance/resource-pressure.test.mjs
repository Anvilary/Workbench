import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assessPressure, calculateResourceBudget, canEvictView, createPressureGovernor, readSystemPressure } from '../../../resource-budget.mjs';

const GB = 1024 ** 3;
const roomy = { freeBytes: 20 * GB, availableBytes: 20 * GB, totalBytes: 28 * GB, attachedCount: 1 };
const calm = { memorySome60: 0.3, memoryFull60: 0, swapFreeRatio: 0.8 };

test('calm conditions leave the budget unchanged', () => {
  const base = calculateResourceBudget(roomy);
  const calmResult = calculateResourceBudget({ ...roomy, pressure: calm });
  assert.equal(calmResult.memoryTier, base.memoryTier);
  assert.equal(calmResult.budget, base.budget);
  assert.deepEqual(calmResult.pressureReasons, []);
});

test('a CPU-saturating compile or test run does not shrink the tab budget while memory is healthy', () => {
  const base = calculateResourceBudget(roomy);
  // CPU data may be present in a pressure object (older callers); it must have no effect at all.
  const busy = calculateResourceBudget({ ...roomy, pressure: { ...calm, cpuSome10: 100, cpuSome60: 100 } });
  assert.equal(busy.memoryTier, base.memoryTier);
  assert.equal(busy.budget, base.budget);
});

test('only sustained memory stalls raise the tier, with the documented thresholds', () => {
  assert.equal(assessPressure({ ...calm, memorySome60: 4.9 }).tier, 'normal');
  assert.equal(assessPressure({ ...calm, memorySome60: 5 }).tier, 'moderate');
  assert.equal(assessPressure({ ...calm, memorySome60: 11.9 }).tier, 'moderate');
  assert.equal(assessPressure({ ...calm, memorySome60: 12 }).tier, 'high');
  assert.equal(assessPressure({ ...calm, memoryFull60: 2 }).tier, 'high');
  const stalled = calculateResourceBudget({ ...roomy, pressure: { ...calm, memorySome60: 13 } });
  assert.equal(stalled.memoryTier, 'high');
  assert.equal(stalled.budget, 1, 'only the visible view stays resident');
});

test('swap exhaustion matters only together with tight RAM, and a full swap with ample RAM is ignored', () => {
  assert.equal(assessPressure({ ...calm, swapFreeRatio: 0.02 }, 0.7).tier, 'normal');
  assert.equal(assessPressure({ ...calm, swapFreeRatio: 0.02 }, 0.2).tier, 'high');
});

test('stall and swap signals can never reach critical, so protected AI tabs keep their sessions', () => {
  const worst = calculateResourceBudget({ ...roomy, pressure: { memorySome60: 100, memoryFull60: 100, swapFreeRatio: 0 } });
  assert.equal(worst.memoryTier, 'high');
});

test('hysteresis: escalation is immediate, a raised floor is held, and it releases only after the hold', () => {
  const gov = createPressureGovernor({ holdMs: 120_000 });
  assert.equal(gov.assess(calm, 0.7, 0).tier, 'normal');
  assert.equal(gov.assess({ ...calm, memorySome60: 13 }, 0.7, 1_000).tier, 'high', 'immediate escalation');
  const held = gov.assess(calm, 0.7, 60_000);
  assert.equal(held.tier, 'high', 'still held 59 s after the last justification');
  assert.ok(held.reasons.includes('held'));
  assert.equal(gov.assess(calm, 0.7, 120_999).tier, 'high');
  assert.equal(gov.assess(calm, 0.7, 121_001).tier, 'normal', 'released after the hold');
});

test('hysteresis prevents flapping when pressure hovers around a threshold', () => {
  const gov = createPressureGovernor({ holdMs: 120_000 });
  const readings = [13, 3, 13, 2, 14, 1, 13, 0.5]; // noisy around the HIGH line, one reading every 10 s
  const tiers = readings.map((v, i) => gov.assess({ ...calm, memorySome60: v }, 0.7, i * 10_000).tier);
  assert.deepEqual(tiers, Array(readings.length).fill('high'), 'the tier never drops back and forth');
});

test('a tab working set alone cannot reach critical while the system has ample memory', () => {
  const ample = { freeBytes: 16 * GB, availableBytes: 16 * GB, totalBytes: 28 * GB, attachedCount: 2 };
  const r = calculateResourceBudget({ ...ample, tabWorkingSetBytes: 4.5 * GB });
  assert.equal(r.memoryTier, 'high');
  assert.equal(r.budget, 2);
  // not ample (6 GiB of 16 GiB): the existing emergency behavior is preserved
  assert.equal(calculateResourceBudget({ freeBytes: 6 * GB, availableBytes: 6 * GB, totalBytes: 16 * GB, tabWorkingSetBytes: 4.5 * GB, attachedCount: 2 }).memoryTier, 'critical');
  // genuinely low RAM is still critical regardless
  assert.equal(calculateResourceBudget({ freeBytes: 0.5 * GB, availableBytes: 0.5 * GB, totalBytes: 28 * GB, attachedCount: 1, pressure: calm }).memoryTier, 'critical');
});

test('signals never lower a tier and the explicit override still applies', () => {
  assert.equal(calculateResourceBudget({ ...roomy, pressure: { ...calm, memorySome60: 50 }, tierOverride: 'normal' }).memoryTier, 'normal');
  const tight = { freeBytes: 3 * GB, availableBytes: 3 * GB, totalBytes: 28 * GB, attachedCount: 1 };
  assert.equal(calculateResourceBudget({ ...tight, pressure: calm }).memoryTier, calculateResourceBudget(tight).memoryTier);
});

function viewEnv(overrides = {}) {
  const view = { webContents: { isDestroyed: () => false, isLoading: () => false, getURL: () => 'https://chatgpt.com/c/1' } };
  return {
    id: 'a', attachedViews: new Map(), layoutFocusedId: null, activeDownloads: new Map(), popupOwners: new Map(),
    views: new Map([['a', view]]), providers: new Map([['a', 'chatgpt']]), interactionProtected: new Set(),
    durablePage: () => true, memoryTier: 'high', ...overrides,
  };
}

test('protections hold at the highest tier the stall signals can produce', () => {
  assert.equal(canEvictView(viewEnv()), false, 'protected AI provider (active or unfinished conversation)');
  assert.equal(canEvictView(viewEnv({ providers: new Map([['a', 'github']]) })), true, 'ordinary hidden tab is evictable');
  const protectedCases = {
    attached: { attachedViews: new Map([['a', {}]]) },
    focused: { layoutFocusedId: 'a' },
    downloading: { activeDownloads: new Map([['a', 1]]) },
    'owns an auth/popup window': { popupOwners: new Map([['p', 'a']]) },
    'unsaved typing or form input': { interactionProtected: new Set(['a']) },
    'authentication page (not durable)': { durablePage: () => false },
  };
  for (const [name, o] of Object.entries(protectedCases)) {
    assert.equal(canEvictView(viewEnv({ providers: new Map([['a', 'github']]), ...o })), false, name);
  }
});

test('readSystemPressure parses sustained PSI and swap, and degrades to nulls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maw-psi-'));
  try {
    await mkdir(path.join(root, 'pressure'));
    await writeFile(path.join(root, 'pressure', 'memory'), 'some avg10=99.00 avg60=7.50 avg300=0.50 total=1\nfull avg10=50.00 avg60=3.25 avg300=0.00 total=1\n');
    await writeFile(path.join(root, 'meminfo'), 'SwapTotal:       1000 kB\nSwapFree:         50 kB\n');
    assert.deepEqual(readSystemPressure(root), { memorySome60: 7.5, memoryFull60: 3.25, swapFreeRatio: 0.05 }, 'avg10 spikes are ignored');
    assert.deepEqual(readSystemPressure(path.join(root, 'missing')), { memorySome60: null, memoryFull60: null, swapFreeRatio: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateResourceBudget,
  selectEvictionCandidate,
  MemoryPressureTier,
} from './resource-budget.mjs';

const GB = 1024 * 1024 * 1024;

test('calculateResourceBudget: normal memory conditions', () => {
  // 16 GB total, 10 GB free -> normal tier with high free RAM (budget = safeAttached + 2)
  const res1 = calculateResourceBudget({
    freeBytes: 10 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 500 * 1024 * 1024,
    attachedCount: 2,
  });
  assert.equal(res1.tier, MemoryPressureTier.NORMAL);
  assert.equal(res1.budget, 4);

  // 16 GB total, 5 GB free -> normal tier (budget = safeAttached + 2)
  const res2 = calculateResourceBudget({
    freeBytes: 5 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 800 * 1024 * 1024,
    attachedCount: 1,
  });
  assert.equal(res2.tier, MemoryPressureTier.NORMAL);
  assert.equal(res2.budget, 3);
});

test('calculateResourceBudget: moderate memory pressure', () => {
  // 3 GB free (between 2GB and 4GB) -> moderate tier (budget = safeAttached + 1)
  const res = calculateResourceBudget({
    freeBytes: 3 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 800 * 1024 * 1024,
    attachedCount: 2,
  });
  assert.equal(res.tier, MemoryPressureTier.MODERATE);
  assert.equal(res.budget, 3);

  // High tab working set triggers moderate pressure even with free RAM
  const resTabLoad = calculateResourceBudget({
    freeBytes: 6 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 1.8 * GB,
    attachedCount: 1,
  });
  assert.equal(resTabLoad.tier, MemoryPressureTier.MODERATE);
  assert.equal(resTabLoad.budget, 2);
});

test('calculateResourceBudget: high memory pressure', () => {
  // 1.5 GB free (between 1GB and 2GB) -> high tier (budget = safeAttached)
  const res = calculateResourceBudget({
    freeBytes: 1.5 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 500 * 1024 * 1024,
    attachedCount: 2,
  });
  assert.equal(res.tier, MemoryPressureTier.HIGH);
  assert.equal(res.budget, 2);

  // High tab working set (2.8 GB)
  const resTabLoad = calculateResourceBudget({
    freeBytes: 6 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 2.8 * GB,
    attachedCount: 2,
  });
  assert.equal(resTabLoad.tier, MemoryPressureTier.HIGH);
  assert.equal(resTabLoad.budget, 2);
});

test('calculateResourceBudget: critical memory pressure', () => {
  // 500 MB free (< 1GB) -> critical tier (budget = safeAttached)
  const res = calculateResourceBudget({
    freeBytes: 500 * 1024 * 1024,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 500 * 1024 * 1024,
    attachedCount: 1,
  });
  assert.equal(res.tier, MemoryPressureTier.CRITICAL);
  assert.equal(res.budget, 1);

  // 4 attached views during critical pressure must never be evicted
  const resAttached = calculateResourceBudget({
    freeBytes: 400 * 1024 * 1024,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 500 * 1024 * 1024,
    attachedCount: 4,
  });
  assert.equal(resAttached.tier, MemoryPressureTier.CRITICAL);
  assert.equal(resAttached.budget, 4, 'Budget must never be less than attached count');
});

test('calculateResourceBudget: environment override MAW_MAX_RESIDENT_VIEWS', () => {
  const res = calculateResourceBudget({
    freeBytes: 10 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 0,
    attachedCount: 2,
    envOverride: '5',
  });
  assert.equal(res.tier, MemoryPressureTier.OVERRIDE);
  assert.equal(res.budget, 5);

  // Override respects attached count if attached views exceed override
  const resAttached = calculateResourceBudget({
    freeBytes: 10 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 0,
    attachedCount: 4,
    envOverride: '2',
  });
  assert.equal(resAttached.budget, 4);
});

test('selectEvictionCandidate: selects LRU candidate among evictable views', () => {
  const residentIds = ['tab1', 'tab2', 'tab3', 'tab4'];
  const lastAccessedAt = new Map([
    ['tab1', 1000],
    ['tab2', 3000],
    ['tab3', 2000],
    ['tab4', 4000],
  ]);

  // tab1 is oldest (1000)
  const candidate1 = selectEvictionCandidate({
    residentIds,
    lastAccessedAt,
    canEvict: () => true,
  });
  assert.equal(candidate1, 'tab1');

  // If tab1 cannot be evicted, tab3 (2000) is next
  const candidate2 = selectEvictionCandidate({
    residentIds,
    lastAccessedAt,
    canEvict: id => id !== 'tab1',
  });
  assert.equal(candidate2, 'tab3');

  // If excludeId is tab1, tab3 is selected
  const candidate3 = selectEvictionCandidate({
    residentIds,
    lastAccessedAt,
    canEvict: () => true,
    excludeId: 'tab1',
  });
  assert.equal(candidate3, 'tab3');
});

test('selectEvictionCandidate: returns null when no views can be evicted', () => {
  const residentIds = ['tab1', 'tab2'];
  const lastAccessedAt = new Map([
    ['tab1', 1000],
    ['tab2', 2000],
  ]);

  const candidate = selectEvictionCandidate({
    residentIds,
    lastAccessedAt,
    canEvict: () => false,
  });
  assert.equal(candidate, null);
});

test('selectEvictionCandidate: anti-thrashing dwell hysteresis prioritizes matured candidates', () => {
  const residentIds = ['tab-recent', 'tab-mature'];
  const now = 100000;
  // tab-recent was accessed 5 seconds ago (< 15s dwell)
  // tab-mature was accessed 20 seconds ago (>= 15s dwell)
  const lastAccessedAt = new Map([
    ['tab-recent', now - 5000],
    ['tab-mature', now - 20000],
  ]);

  const candidate = selectEvictionCandidate({
    residentIds,
    lastAccessedAt,
    canEvict: () => true,
    minDwellMs: 15000,
    now,
  });
  // tab-mature is selected because it passed the 15s dwell threshold
  assert.equal(candidate, 'tab-mature');

  // When all candidates are within the dwell threshold (< 15s), fallback selects oldest
  const lastAccessedAtRecentOnly = new Map([
    ['tab-a', now - 3000], // 3s ago
    ['tab-b', now - 8000], // 8s ago (older)
  ]);
  const fallbackCandidate = selectEvictionCandidate({
    residentIds: ['tab-a', 'tab-b'],
    lastAccessedAt: lastAccessedAtRecentOnly,
    canEvict: () => true,
    minDwellMs: 15000,
    now,
  });
  assert.equal(fallbackCandidate, 'tab-b');
});

test('data safety: generative AI tabs protected from eviction in normal memory tier', () => {
  // Simulate canEvict with provider check across tiers
  function mockCanEvict(id, provider, tier) {
    if (tier === MemoryPressureTier.NORMAL) {
      if (provider === 'chatgpt' || provider === 'perplexity') return false;
    }
    return true;
  }

  const residentIds = ['tab-chatgpt', 'tab-docs'];
  const lastAccessedAt = new Map([
    ['tab-chatgpt', 1000], // oldest
    ['tab-docs', 2000],
  ]);

  // Under normal tier, tab-chatgpt is protected from automatic eviction
  const normalCandidate = selectEvictionCandidate({
    residentIds,
    lastAccessedAt,
    canEvict: (id) => mockCanEvict(id, id === 'tab-chatgpt' ? 'chatgpt' : 'github', MemoryPressureTier.NORMAL),
    minDwellMs: 1000,
    now: 5000,
  });
  assert.equal(normalCandidate, 'tab-docs', 'tab-docs is evicted because tab-chatgpt is protected in normal tier');

  // Under critical tier, tab-chatgpt can be evicted if necessary to protect system from OOM
  const criticalCandidate = selectEvictionCandidate({
    residentIds,
    lastAccessedAt,
    canEvict: (id) => mockCanEvict(id, id === 'tab-chatgpt' ? 'chatgpt' : 'github', MemoryPressureTier.CRITICAL),
    minDwellMs: 1000,
    now: 5000,
  });
  assert.equal(criticalCandidate, 'tab-chatgpt', 'under critical pressure oldest candidate is evictable');
});

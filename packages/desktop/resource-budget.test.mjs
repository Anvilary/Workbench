import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateResourceBudget,
  selectEvictionCandidate,
  MemoryPressureTier,
} from './resource-budget.mjs';

const GB = 1024 * 1024 * 1024;

test('calculateResourceBudget: normal memory conditions', () => {
  // 16 GB total, 10 GB free -> normal tier with high free RAM (budget >= 14)
  const res1 = calculateResourceBudget({
    freeBytes: 10 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 500 * 1024 * 1024,
    attachedCount: 2,
  });
  assert.equal(res1.tier, MemoryPressureTier.NORMAL);
  assert.equal(res1.budget, 14);

  // 16 GB total, 5 GB free -> normal tier (budget = 10)
  const res2 = calculateResourceBudget({
    freeBytes: 5 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 800 * 1024 * 1024,
    attachedCount: 1,
  });
  assert.equal(res2.tier, MemoryPressureTier.NORMAL);
  assert.equal(res2.budget, 10);
});

test('calculateResourceBudget: moderate memory pressure', () => {
  // 3 GB free (between 2GB and 4GB)
  const res = calculateResourceBudget({
    freeBytes: 3 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 800 * 1024 * 1024,
    attachedCount: 2,
  });
  assert.equal(res.tier, MemoryPressureTier.MODERATE);
  assert.equal(res.budget, 6);

  // High tab working set triggers moderate pressure even with free RAM
  const resTabLoad = calculateResourceBudget({
    freeBytes: 6 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 1.8 * GB,
    attachedCount: 1,
  });
  assert.equal(resTabLoad.tier, MemoryPressureTier.MODERATE);
  assert.equal(resTabLoad.budget, 6);
});

test('calculateResourceBudget: high memory pressure', () => {
  // 1.5 GB free (between 1GB and 2GB)
  const res = calculateResourceBudget({
    freeBytes: 1.5 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 500 * 1024 * 1024,
    attachedCount: 2,
  });
  assert.equal(res.tier, MemoryPressureTier.HIGH);
  assert.equal(res.budget, 4);

  // High tab working set (2.8 GB)
  const resTabLoad = calculateResourceBudget({
    freeBytes: 6 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 2.8 * GB,
    attachedCount: 2,
  });
  assert.equal(resTabLoad.tier, MemoryPressureTier.HIGH);
  assert.equal(resTabLoad.budget, 4);
});

test('calculateResourceBudget: critical memory pressure', () => {
  // 500 MB free (< 1GB)
  const res = calculateResourceBudget({
    freeBytes: 500 * 1024 * 1024,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 500 * 1024 * 1024,
    attachedCount: 1,
  });
  assert.equal(res.tier, MemoryPressureTier.CRITICAL);
  assert.equal(res.budget, 2);

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

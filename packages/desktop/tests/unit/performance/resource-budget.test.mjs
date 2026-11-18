import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateResourceBudget,
  selectEvictionCandidate,
  MemoryPressureTier,
  isProtectedProvider,
} from '../../../resource-budget.mjs';

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

// Helper modeling canEvict matching packages/desktop/main.mjs
function createMockCanEvict({ attachedIds = new Set(), focusedId = null, providers = new Map() } = {}) {
  return function canEvict(id, tier = MemoryPressureTier.NORMAL) {
    if (attachedIds.has(id)) return false;
    if (focusedId === id) return false;
    const provider = providers.get(id) ?? 'chatgpt';
    if (isProtectedProvider(provider) && tier !== MemoryPressureTier.CRITICAL) {
      return false;
    }
    return true;
  };
}

test('data safety: NORMAL memory pressure protects ChatGPT and Perplexity tabs', () => {
  const providers = new Map([
    ['tab-chatgpt', 'chatgpt'],
    ['tab-perplexity', 'perplexity'],
    ['tab-docs', 'github'],
  ]);
  const residentIds = ['tab-chatgpt', 'tab-perplexity', 'tab-docs'];
  const lastAccessedAt = new Map([
    ['tab-chatgpt', 1000],
    ['tab-perplexity', 1500],
    ['tab-docs', 2000],
  ]);
  const canEvict = createMockCanEvict({ providers });

  // When ordinary tabs are present, ordinary tab is evicted even though AI tabs are older
  const candidate = selectEvictionCandidate({
    residentIds,
    lastAccessedAt,
    canEvict: (id) => canEvict(id, MemoryPressureTier.NORMAL),
    isProtected: (id) => isProtectedProvider(providers.get(id)),
    minDwellMs: 500,
    now: 5000,
  });
  assert.equal(candidate, 'tab-docs', 'tab-docs must be evicted; AI tabs remain protected');

  // When ONLY AI tabs are resident in background, eviction returns null
  const aiOnlyCandidate = selectEvictionCandidate({
    residentIds: ['tab-chatgpt', 'tab-perplexity'],
    lastAccessedAt,
    canEvict: (id) => canEvict(id, MemoryPressureTier.NORMAL),
    isProtected: (id) => isProtectedProvider(providers.get(id)),
    minDwellMs: 500,
    now: 5000,
  });
  assert.equal(aiOnlyCandidate, null, 'AI tabs must never be evicted under normal memory pressure');
});

test('data safety: MODERATE memory pressure protects ChatGPT and Perplexity tabs', () => {
  const providers = new Map([
    ['tab-chatgpt', 'chatgpt'],
    ['tab-perplexity', 'perplexity'],
    ['tab-github', 'github'],
  ]);
  const lastAccessedAt = new Map([
    ['tab-chatgpt', 1000],
    ['tab-perplexity', 2000],
    ['tab-github', 3000],
  ]);
  const canEvict = createMockCanEvict({ providers });

  // Ordinary tab is evicted under MODERATE pressure
  const candidate = selectEvictionCandidate({
    residentIds: ['tab-chatgpt', 'tab-perplexity', 'tab-github'],
    lastAccessedAt,
    canEvict: (id) => canEvict(id, MemoryPressureTier.MODERATE),
    isProtected: (id) => isProtectedProvider(providers.get(id)),
    minDwellMs: 500,
    now: 5000,
  });
  assert.equal(candidate, 'tab-github');

  // Once ordinary tab is gone, AI tabs are protected from eviction under MODERATE pressure
  const aiCandidate = selectEvictionCandidate({
    residentIds: ['tab-chatgpt', 'tab-perplexity'],
    lastAccessedAt,
    canEvict: (id) => canEvict(id, MemoryPressureTier.MODERATE),
    isProtected: (id) => isProtectedProvider(providers.get(id)),
    minDwellMs: 500,
    now: 5000,
  });
  assert.equal(aiCandidate, null, 'ChatGPT and Perplexity must remain protected under MODERATE memory pressure');
});

test('data safety: HIGH memory pressure retains protection while sufficient headroom remains', () => {
  const providers = new Map([
    ['tab-chatgpt', 'chatgpt'],
    ['tab-github', 'github'],
  ]);
  const lastAccessedAt = new Map([
    ['tab-chatgpt', 1000],
    ['tab-github', 2000],
  ]);
  const canEvict = createMockCanEvict({ providers });

  // Under HIGH pressure, ordinary tab is evicted first
  const candidate = selectEvictionCandidate({
    residentIds: ['tab-chatgpt', 'tab-github'],
    lastAccessedAt,
    canEvict: (id) => canEvict(id, MemoryPressureTier.HIGH),
    isProtected: (id) => isProtectedProvider(providers.get(id)),
    minDwellMs: 500,
    now: 5000,
  });
  assert.equal(candidate, 'tab-github');

  // Under HIGH pressure, AI tab retains protection because memory is not CRITICAL
  const aiCandidate = selectEvictionCandidate({
    residentIds: ['tab-chatgpt'],
    lastAccessedAt,
    canEvict: (id) => canEvict(id, MemoryPressureTier.HIGH),
    isProtected: (id) => isProtectedProvider(providers.get(id)),
    minDwellMs: 500,
    now: 5000,
  });
  assert.equal(aiCandidate, null, 'AI tabs must retain protection under HIGH pressure when headroom remains');
});

test('data safety: CRITICAL memory pressure emergency eviction permits AI tab eviction as last resort', () => {
  const providers = new Map([
    ['tab-chatgpt-1', 'chatgpt'],
    ['tab-chatgpt-2', 'chatgpt'],
    ['tab-docs', 'github'],
  ]);
  const lastAccessedAt = new Map([
    ['tab-chatgpt-1', 1000], // oldest AI tab
    ['tab-chatgpt-2', 3000],
    ['tab-docs', 2000], // ordinary tab, accessed after chatgpt-1
  ]);
  const canEvict = createMockCanEvict({ providers });

  // Phase 1: Ordinary tab MUST be evicted first, even though tab-chatgpt-1 is older!
  const firstCandidate = selectEvictionCandidate({
    residentIds: ['tab-chatgpt-1', 'tab-chatgpt-2', 'tab-docs'],
    lastAccessedAt,
    canEvict: (id) => canEvict(id, MemoryPressureTier.CRITICAL),
    isProtected: (id) => isProtectedProvider(providers.get(id)),
    minDwellMs: 500,
    now: 5000,
  });
  assert.equal(firstCandidate, 'tab-docs', 'Unprotected tab must be evicted first even if an AI tab is older');

  // Phase 2: Once ordinary tabs are gone, emergency policy allows evicting background AI tab (LRU)
  const secondCandidate = selectEvictionCandidate({
    residentIds: ['tab-chatgpt-1', 'tab-chatgpt-2'],
    lastAccessedAt,
    canEvict: (id) => canEvict(id, MemoryPressureTier.CRITICAL),
    isProtected: (id) => isProtectedProvider(providers.get(id)),
    minDwellMs: 500,
    now: 5000,
  });
  assert.equal(secondCandidate, 'tab-chatgpt-1', 'Oldest background AI tab evicted as emergency last resort');
});

test('data safety: Two visible AI tabs are protected under all pressure tiers including CRITICAL', () => {
  const attachedIds = new Set(['tab-chatgpt-1', 'tab-chatgpt-2']);
  const providers = new Map([
    ['tab-chatgpt-1', 'chatgpt'],
    ['tab-chatgpt-2', 'chatgpt'],
  ]);
  const lastAccessedAt = new Map([
    ['tab-chatgpt-1', 1000],
    ['tab-chatgpt-2', 2000],
  ]);
  const canEvict = createMockCanEvict({ attachedIds, providers });

  for (const tier of [MemoryPressureTier.NORMAL, MemoryPressureTier.MODERATE, MemoryPressureTier.HIGH, MemoryPressureTier.CRITICAL]) {
    const candidate = selectEvictionCandidate({
      residentIds: ['tab-chatgpt-1', 'tab-chatgpt-2'],
      lastAccessedAt,
      canEvict: (id) => canEvict(id, tier),
      isProtected: (id) => isProtectedProvider(providers.get(id)),
      minDwellMs: 0,
      now: 5000,
    });
    assert.equal(candidate, null, `Visible AI tabs must never be evicted under tier ${tier}`);
  }
});

test('data safety: One visible and one background AI tab', () => {
  const attachedIds = new Set(['tab-visible-chat']);
  const providers = new Map([
    ['tab-visible-chat', 'chatgpt'],
    ['tab-bg-chat', 'chatgpt'],
  ]);
  const lastAccessedAt = new Map([
    ['tab-visible-chat', 2000],
    ['tab-bg-chat', 1000],
  ]);
  const canEvict = createMockCanEvict({ attachedIds, providers });

  // Under NORMAL, MODERATE, HIGH: neither is evictable
  for (const tier of [MemoryPressureTier.NORMAL, MemoryPressureTier.MODERATE, MemoryPressureTier.HIGH]) {
    const candidate = selectEvictionCandidate({
      residentIds: ['tab-visible-chat', 'tab-bg-chat'],
      lastAccessedAt,
      canEvict: (id) => canEvict(id, tier),
      isProtected: (id) => isProtectedProvider(providers.get(id)),
      minDwellMs: 0,
      now: 5000,
    });
    assert.equal(candidate, null, `Under ${tier}, background AI tab is protected`);
  }

  // Under CRITICAL: visible tab is protected; background tab can be evicted
  const criticalCandidate = selectEvictionCandidate({
    residentIds: ['tab-visible-chat', 'tab-bg-chat'],
    lastAccessedAt,
    canEvict: (id) => canEvict(id, MemoryPressureTier.CRITICAL),
    isProtected: (id) => isProtectedProvider(providers.get(id)),
    minDwellMs: 0,
    now: 5000,
  });
  assert.equal(criticalCandidate, 'tab-bg-chat', 'Under CRITICAL, only background AI tab can be evicted');
});

test('data safety: Several ordinary background webpages evicted in deterministic LRU order before AI tabs', () => {
  const providers = new Map([
    ['doc-1', 'github'],
    ['doc-2', 'github'],
    ['doc-3', 'github'],
    ['chat-1', 'chatgpt'],
    ['chat-2', 'perplexity'],
  ]);
  const lastAccessedAt = new Map([
    ['chat-1', 100],
    ['doc-1', 200],
    ['chat-2', 300],
    ['doc-2', 400],
    ['doc-3', 500],
  ]);
  const canEvict = createMockCanEvict({ providers });

  const resident = new Set(['doc-1', 'doc-2', 'doc-3', 'chat-1', 'chat-2']);
  const evicted = [];

  // Run eviction loop under CRITICAL pressure
  while (resident.size > 2) {
    const candidate = selectEvictionCandidate({
      residentIds: resident,
      lastAccessedAt,
      canEvict: (id) => canEvict(id, MemoryPressureTier.CRITICAL),
      isProtected: (id) => isProtectedProvider(providers.get(id)),
      minDwellMs: 50,
      now: 1000,
    });
    if (!candidate) break;
    evicted.push(candidate);
    resident.delete(candidate);
  }

  // First 3 evicted must be doc-1, doc-2, doc-3 in strict LRU order
  assert.deepEqual(evicted, ['doc-1', 'doc-2', 'doc-3'], 'Ordinary tabs must all be evicted before any AI tab');
  assert.ok(resident.has('chat-1') && resident.has('chat-2'), 'AI tabs must remain resident');
});

test('data safety: Standby quota changes do not evict protected content merely to meet arbitrary count', () => {
  const providers = new Map([
    ['tab-chatgpt', 'chatgpt'],
    ['tab-perplexity', 'perplexity'],
    ['tab-github', 'github'],
  ]);
  const canEvict = createMockCanEvict({ providers });

  // Standby quota MAW_MAX_RESIDENT_VIEWS = 1
  const budgetInfo = calculateResourceBudget({
    freeBytes: 8 * GB,
    totalBytes: 16 * GB,
    attachedCount: 0,
    envOverride: '1',
  });
  assert.equal(budgetInfo.budget, 1);
  assert.equal(budgetInfo.tier, MemoryPressureTier.OVERRIDE);
  assert.equal(budgetInfo.memoryTier, MemoryPressureTier.NORMAL);

  // In main.mjs, effectiveTier under OVERRIDE is memoryTier (NORMAL)
  const effectiveTier = budgetInfo.tier === MemoryPressureTier.OVERRIDE
    ? budgetInfo.memoryTier
    : budgetInfo.tier;

  const resident = new Set(['tab-chatgpt', 'tab-perplexity', 'tab-github']);
  const lastAccessedAt = new Map([
    ['tab-chatgpt', 1000],
    ['tab-perplexity', 2000],
    ['tab-github', 3000],
  ]);

  // Evict down toward quota
  const evictions = [];
  while (resident.size >= budgetInfo.budget) {
    const candidate = selectEvictionCandidate({
      residentIds: resident,
      lastAccessedAt,
      canEvict: (id) => canEvict(id, effectiveTier),
      isProtected: (id) => isProtectedProvider(providers.get(id)),
      minDwellMs: 500,
      now: 5000,
    });
    if (!candidate) break;
    evictions.push(candidate);
    resident.delete(candidate);
  }

  // Only the ordinary github tab is evicted to reduce count; protected AI tabs are NOT evicted
  assert.deepEqual(evictions, ['tab-github']);
  assert.equal(resident.size, 2, 'Protected tabs remain resident even if exceeding count quota');
});

test('data safety: Repeated memory pressure transitions update eviction eligibility dynamically', () => {
  const providers = new Map([['tab-ai', 'chatgpt']]);
  const lastAccessedAt = new Map([['tab-ai', 1000]]);
  const canEvict = createMockCanEvict({ providers });
  const params = (tier) => ({
    residentIds: ['tab-ai'],
    lastAccessedAt,
    canEvict: (id) => canEvict(id, tier),
    isProtected: (id) => isProtectedProvider(providers.get(id)),
    minDwellMs: 100,
    now: 5000,
  });

  // Cycle 1: NORMAL -> protected
  assert.equal(selectEvictionCandidate(params(MemoryPressureTier.NORMAL)), null);
  // Cycle 2: MODERATE -> protected
  assert.equal(selectEvictionCandidate(params(MemoryPressureTier.MODERATE)), null);
  // Cycle 3: HIGH -> protected
  assert.equal(selectEvictionCandidate(params(MemoryPressureTier.HIGH)), null);
  // Cycle 4: CRITICAL -> evictable (emergency last resort)
  assert.equal(selectEvictionCandidate(params(MemoryPressureTier.CRITICAL)), 'tab-ai');
  // Cycle 5: Recovery back to NORMAL -> protected immediately
  assert.equal(selectEvictionCandidate(params(MemoryPressureTier.NORMAL)), null);
  // Cycle 6: Back to MODERATE -> protected
  assert.equal(selectEvictionCandidate(params(MemoryPressureTier.MODERATE)), null);
});

test('data safety: Rapid tab switching updates lastAccessedAt and preserves active tab', () => {
  const providers = new Map([
    ['tab-a', 'chatgpt'],
    ['tab-b', 'perplexity'],
  ]);
  const attachedIds = new Set();
  const lastAccessedAt = new Map();
  const canEvict = createMockCanEvict({ attachedIds, providers });

  let now = 10000;
  // User rapidly toggles between tab-a and tab-b
  for (let step = 0; step < 10; step++) {
    now += 500;
    const active = step % 2 === 0 ? 'tab-a' : 'tab-b';
    attachedIds.clear();
    attachedIds.add(active);
    lastAccessedAt.set(active, now);

    // Active tab is never evictable under any tier
    for (const tier of [MemoryPressureTier.NORMAL, MemoryPressureTier.MODERATE, MemoryPressureTier.CRITICAL]) {
      assert.equal(canEvict(active, tier), false);
    }
  }
});

test('calculateResourceBudget: tierOverride deterministically controls memory pressure tier', () => {
  const base = {
    freeBytes: 10 * GB,
    totalBytes: 16 * GB,
    tabWorkingSetBytes: 0,
    attachedCount: 1,
  };

  const critical = calculateResourceBudget({ ...base, tierOverride: 'critical' });
  assert.equal(critical.memoryTier, MemoryPressureTier.CRITICAL);
  assert.equal(critical.budget, 1);

  const high = calculateResourceBudget({ ...base, tierOverride: 'high' });
  assert.equal(high.memoryTier, MemoryPressureTier.HIGH);
  assert.equal(high.budget, 1);

  const moderate = calculateResourceBudget({ ...base, tierOverride: 'moderate' });
  assert.equal(moderate.memoryTier, MemoryPressureTier.MODERATE);
  assert.equal(moderate.budget, 2);

  const normal = calculateResourceBudget({ ...base, tierOverride: 'normal' });
  assert.equal(normal.memoryTier, MemoryPressureTier.NORMAL);
  assert.equal(normal.budget, 3);
});

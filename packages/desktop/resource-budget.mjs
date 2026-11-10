import fs from 'node:fs';
import os from 'node:os';

/**
 * Resource Budget & Resident Tab Pool Policy
 *
 * Implements bounded, resource-aware lifecycle management for native browser views
 * (ChatGPT, Perplexity, GitHub) in Electron.
 */

export const MemoryPressureTier = {
  NORMAL: 'normal',
  MODERATE: 'moderate',
  HIGH: 'high',
  CRITICAL: 'critical',
  OVERRIDE: 'override',
};

const GB = 1024 * 1024 * 1024;

export function readSystemMemory(procRoot = '/proc') {
  const fallback = { freeBytes: os.freemem(), availableBytes: os.freemem(), totalBytes: os.totalmem() };
  try {
    const info = fs.readFileSync(`${procRoot}/meminfo`, 'utf8');
    const value = (name) => Number(info.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm'))?.[1]) * 1024;
    const freeBytes = value('MemFree'), totalBytes = value('MemTotal'), availableBytes = value('MemAvailable');
    if (Number.isFinite(freeBytes) && totalBytes > 0 && Number.isFinite(availableBytes)) return { freeBytes, totalBytes, availableBytes };
  } catch {}
  return fallback;
}

/**
 * Checks whether a provider represents a generative AI surface with unpersisted
 * user drafts (prompt textareas, active queries) that must be protected against
 * routine automatic eviction.
 *
 * @param {string} provider
 * @returns {boolean}
 */
export function isProtectedProvider(provider) {
  return provider === 'chatgpt' || provider === 'perplexity';
}

/**
 * Calculates the resident browser view budget according to available system memory,
 * memory pressure tier, measured Tab renderer working set, and currently visible panes.
 *
 * @param {object} params
 * @param {number} params.freeBytes - Node os.freemem() in bytes
 * @param {number} params.totalBytes - Node os.totalmem() in bytes
 * @param {number} [params.tabWorkingSetBytes=0] - Sum of Electron app.getAppMetrics() 'Tab' workingSetSize in bytes
 * @param {number} [params.attachedCount=0] - Number of currently attached/visible browser views in layout (0-4)
 * @param {string|number|undefined} [params.envOverride] - Optional MAW_MAX_RESIDENT_VIEWS env override
 * @param {string|undefined} [params.tierOverride] - Optional MAW_MEMORY_PRESSURE_TIER override (for testing)
 * @returns {{ tier: string, memoryTier: string, budget: number, freeRatio: number }}
 */
export function calculateResourceBudget({
  freeBytes,
  availableBytes = freeBytes,
  totalBytes,
  tabWorkingSetBytes = 0,
  attachedCount = 0,
  envOverride,
  tierOverride,
}) {
  const safeAttached = Math.max(0, Number(attachedCount) || 0);
  const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 0;
  const availableRatio = totalBytes > 0 ? availableBytes / totalBytes : 0;

  // 1. Determine physical memory pressure tier based on system RAM and Tab working set
  let memoryTier = MemoryPressureTier.NORMAL;
  if (availableBytes < 1 * GB || availableRatio < 0.08 || tabWorkingSetBytes >= 4 * GB) {
    memoryTier = MemoryPressureTier.CRITICAL;
  } else if (availableBytes < 2 * GB || availableRatio < 0.15 || tabWorkingSetBytes >= 2.5 * GB) {
    memoryTier = MemoryPressureTier.HIGH;
  } else if (availableBytes < 4 * GB || availableRatio < 0.25 || tabWorkingSetBytes >= 1.5 * GB) {
    memoryTier = MemoryPressureTier.MODERATE;
  }

  // Explicit tier override (e.g. for deterministic testing of pressure tiers)
  if (tierOverride) {
    const normalized = String(tierOverride).toLowerCase();
    if (Object.values(MemoryPressureTier).includes(normalized)) {
      memoryTier = normalized;
    }
  }

  // 2. Determine base standby budget based on memory pressure tier
  let budget;
  switch (memoryTier) {
    case MemoryPressureTier.CRITICAL:
    case MemoryPressureTier.HIGH:
      budget = Math.max(1, safeAttached);
      break;
    case MemoryPressureTier.MODERATE:
      budget = Math.max(1, safeAttached + 1);
      break;
    case MemoryPressureTier.NORMAL:
    default:
      budget = Math.max(2, safeAttached + 2);
      break;
  }

  // 3. Manual environment override takes precedence for standby budget quota,
  // clamped to at least visible views. Note: Setting an arbitrary quota MUST NOT
  // override the physical memory pressure tier (Requirement 12).
  let hasOverride = false;
  if (envOverride !== undefined && envOverride !== null && envOverride !== '') {
    const parsed = parseInt(String(envOverride), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      budget = Math.max(safeAttached, parsed);
      hasOverride = true;
    }
  }

  return {
    tier: hasOverride ? MemoryPressureTier.OVERRIDE : memoryTier,
    memoryTier,
    budget,
    freeRatio,
  };
}

/**
 * Internal helper to find an eviction candidate using anti-thrashing dwell hysteresis
 * and least-recently-used access timestamp.
 */
function findCandidate({
  residentIds,
  lastAccessedAt,
  canEvict,
  excludeId,
  minDwellMs,
  now,
}) {
  let maturedOldestId = null;
  let maturedOldestTime = Infinity;
  let fallbackOldestId = null;
  let fallbackOldestTime = Infinity;

  for (const id of residentIds) {
    if (excludeId && id === excludeId) continue;
    if (!canEvict(id)) continue;

    const accessTime = lastAccessedAt.get(id) ?? 0;
    // Anti-thrashing hysteresis: prioritize candidates older than minimum dwell threshold
    if (now - accessTime >= minDwellMs) {
      if (accessTime < maturedOldestTime) {
        maturedOldestTime = accessTime;
        maturedOldestId = id;
      }
    }
    // Fallback: track absolute oldest in case all candidates are within dwell window
    if (accessTime < fallbackOldestTime) {
      fallbackOldestTime = accessTime;
      fallbackOldestId = id;
    }
  }

  return maturedOldestId ?? fallbackOldestId;
}

/**
 * Selects the least-recently-used candidate for suspension from the resident pool,
 * applying anti-thrashing hysteresis and prioritizing ordinary unprotected tabs
 * before any protected AI tab.
 *
 * @param {object} params
 * @param {Iterable<string>} params.residentIds - All currently resident view IDs
 * @param {Map<string, number>} params.lastAccessedAt - Map of tab ID -> timestamp of last access
 * @param {(id: string) => boolean} params.canEvict - Function returning true if tab is eligible for eviction
 * @param {(id: string) => boolean} [params.isProtected] - Optional function returning true if tab is a protected generative AI view
 * @param {string} [params.excludeId] - Tab ID currently being opened/focused that must not be evicted
 * @param {number} [params.minDwellMs=15000] - Minimum age threshold before candidate is prioritized for eviction
 * @param {number} [params.now=Date.now()] - Current epoch timestamp
 * @returns {string|null} The tab ID to evict, or null if no evictable candidate is found
 */
export function selectEvictionCandidate({
  residentIds,
  lastAccessedAt,
  canEvict,
  isProtected,
  excludeId,
  minDwellMs = 15000,
  now = Date.now(),
}) {
  // If isProtected function is provided, first search exclusively for unprotected candidates.
  // This guarantees ordinary tabs (documentation, web) are always evicted before any
  // protected generative AI tab, even under emergency pressure.
  if (typeof isProtected === 'function') {
    const unprotectedCandidate = findCandidate({
      residentIds,
      lastAccessedAt,
      canEvict: (id) => canEvict(id) && !isProtected(id),
      excludeId,
      minDwellMs,
      now,
    });
    if (unprotectedCandidate) {
      return unprotectedCandidate;
    }
  }

  // Fallback: search among all eligible evictable candidates (including protected in emergency)
  return findCandidate({
    residentIds,
    lastAccessedAt,
    canEvict,
    excludeId,
    minDwellMs,
    now,
  });
}

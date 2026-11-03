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
 * @returns {{ tier: string, budget: number, freeRatio: number }}
 */
export function calculateResourceBudget({
  freeBytes,
  totalBytes,
  tabWorkingSetBytes = 0,
  attachedCount = 0,
  envOverride,
}) {
  const safeAttached = Math.max(0, Number(attachedCount) || 0);

  // Manual environment override takes precedence, clamped to at least visible views
  if (envOverride !== undefined && envOverride !== null && envOverride !== '') {
    const parsed = parseInt(String(envOverride), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return {
        tier: MemoryPressureTier.OVERRIDE,
        budget: Math.max(safeAttached, parsed),
        freeRatio: totalBytes > 0 ? freeBytes / totalBytes : 0,
      };
    }
  }

  const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 0;

  // 1. CRITICAL PRESSURE: < 1GB free RAM OR < 8% free OR > 4GB Tab working set
  // Budget strictly pinned to visible views (minimum 2 to allow fast switching)
  if (freeBytes < 1 * GB || freeRatio < 0.08 || tabWorkingSetBytes >= 4 * GB) {
    return {
      tier: MemoryPressureTier.CRITICAL,
      budget: Math.max(2, safeAttached),
      freeRatio,
    };
  }

  // 2. HIGH PRESSURE: < 2GB free RAM OR < 15% free OR > 2.5GB Tab working set
  // Budget covers 4 split panes
  if (freeBytes < 2 * GB || freeRatio < 0.15 || tabWorkingSetBytes >= 2.5 * GB) {
    return {
      tier: MemoryPressureTier.HIGH,
      budget: Math.max(4, safeAttached),
      freeRatio,
    };
  }

  // 3. MODERATE PRESSURE: < 4GB free RAM OR < 25% free OR > 1.5GB Tab working set
  // Budget allows visible panes + 2 background tabs
  if (freeBytes < 4 * GB || freeRatio < 0.25 || tabWorkingSetBytes >= 1.5 * GB) {
    return {
      tier: MemoryPressureTier.MODERATE,
      budget: Math.max(6, safeAttached + 2),
      freeRatio,
    };
  }

  // 4. NORMAL OPERATION: Plenty of RAM
  if (freeBytes >= 8 * GB && freeRatio >= 0.35) {
    return {
      tier: MemoryPressureTier.NORMAL,
      budget: Math.max(14, safeAttached + 8),
      freeRatio,
    };
  }

  return {
    tier: MemoryPressureTier.NORMAL,
    budget: Math.max(10, safeAttached + 6),
    freeRatio,
  };
}

/**
 * Selects the least-recently-used candidate for suspension from the resident pool.
 *
 * @param {object} params
 * @param {Iterable<string>} params.residentIds - All currently resident view IDs
 * @param {Map<string, number>} params.lastAccessedAt - Map of tab ID -> timestamp of last access
 * @param {(id: string) => boolean} params.canEvict - Function returning true if tab is eligible for eviction
 * @param {string} [params.excludeId] - Tab ID currently being opened/focused that must not be evicted
 * @returns {string|null} The tab ID to evict, or null if no evictable candidate is found
 */
export function selectEvictionCandidate({
  residentIds,
  lastAccessedAt,
  canEvict,
  excludeId,
}) {
  let oldestId = null;
  let oldestTime = Infinity;

  for (const id of residentIds) {
    if (excludeId && id === excludeId) continue;
    if (!canEvict(id)) continue;

    const accessTime = lastAccessedAt.get(id) ?? 0;
    if (accessTime < oldestTime) {
      oldestTime = accessTime;
      oldestId = id;
    }
  }

  return oldestId;
}

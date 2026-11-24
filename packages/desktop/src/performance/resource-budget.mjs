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
 * Reads sustained memory-stall pressure (PSI avg60) and swap occupancy. Unlike free RAM, PSI measures how much time
 * tasks actually spend stalled waiting for memory. The 60 second average is deliberate: a compile or test run that
 * briefly spikes stalls must not evict browser sessions. CPU pressure is intentionally NOT read: evicting hidden
 * views does not relieve CPU (hidden views are already throttled), so it could only cost the user their sessions.
 * Every field is null when unavailable (older kernels, containers).
 */
export function readSystemPressure(procRoot = '/proc') {
  const result = { memorySome60: null, memoryFull60: null, swapFreeRatio: null };
  const psi = (kind) => {
    try {
      const line = fs.readFileSync(`${procRoot}/pressure/memory`, 'utf8').split('\n').find((l) => l.startsWith(`${kind} `));
      const value = Number(line?.match(/avg60=([0-9.]+)/)?.[1]);
      return Number.isFinite(value) ? value : null;
    } catch { return null; }
  };
  result.memorySome60 = psi('some');
  result.memoryFull60 = psi('full');
  try {
    const info = fs.readFileSync(`${procRoot}/meminfo`, 'utf8');
    const kb = (name) => Number(info.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm'))?.[1]);
    const total = kb('SwapTotal'), free = kb('SwapFree');
    if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) result.swapFreeRatio = free / total;
  } catch {}
  return result;
}

const TIER_ORDER = ['normal', 'moderate', 'high', 'critical'];
const rank = (tier) => TIER_ORDER.indexOf(tier);
const atLeast = (current, floor) => (rank(floor) > rank(current) ? floor : current);

/**
 * Raw tier floor implied by sustained stalls and swap. Capped at HIGH on purpose: only the RAM-based rules may reach
 * CRITICAL, the one tier that can evict protected AI tabs with unsaved drafts.
 */
export function assessPressure(pressure, availableRatio = 1) {
  let tier = MemoryPressureTier.NORMAL;
  const reasons = [];
  const raise = (floor, reason) => {
    const next = atLeast(tier, floor);
    if (next !== tier) tier = next;
    if (rank(floor) >= rank(tier)) reasons.push(reason);
  };
  if (pressure) {
    if (pressure.memorySome60 != null && pressure.memorySome60 >= 5) raise(MemoryPressureTier.MODERATE, 'memory-stall-sustained');
    if (pressure.memorySome60 != null && pressure.memorySome60 >= 12) raise(MemoryPressureTier.HIGH, 'memory-stall-heavy');
    if (pressure.memoryFull60 != null && pressure.memoryFull60 >= 2) raise(MemoryPressureTier.HIGH, 'memory-stall-full');
    if (pressure.swapFreeRatio != null && pressure.swapFreeRatio < 0.10 && availableRatio < 0.30) raise(MemoryPressureTier.HIGH, 'swap-exhausted');
  }
  return { tier, reasons };
}

/**
 * Hysteresis: a raised floor is held for `holdMs` after the signal last justified it, so a pressure reading that
 * hovers around a threshold does not make the budget flap and trigger repeated eviction. Escalation is immediate.
 */
export function createPressureGovernor({ holdMs = 120_000 } = {}) {
  let held = MemoryPressureTier.NORMAL;
  let heldAt = 0;
  let heldReasons = [];
  return {
    assess(pressure, availableRatio, now = Date.now()) {
      const raw = assessPressure(pressure, availableRatio);
      if (rank(raw.tier) >= rank(held) || now - heldAt >= holdMs) {
        held = raw.tier; heldAt = now; heldReasons = raw.reasons;
        return { tier: held, reasons: [...heldReasons] };
      }
      return { tier: held, reasons: [...heldReasons, 'held'] };
    },
  };
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

const NON_TYPING_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock',
  'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'ContextMenu', 'PrintScreen', 'Pause',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24',
]);

/**
 * Returns true only for non-modifier keyboard input that may edit page form/draft
 * content, excluding shortcuts and navigation keys.
 */
export function isTypingInput(input) {
  if (!input || input.type !== 'keyDown') return false;
  if (input.control || input.meta || input.alt) return false;
  const key = typeof input.key === 'string' ? input.key : '';
  if (!key || NON_TYPING_KEYS.has(key)) return false;
  return key.length === 1 || key === 'Enter' || key === 'Backspace' || key === 'Delete';
}

/**
 * Evaluates whether a resident browser view is eligible for background eviction.
 * Attached, focused, loading, downloading, and popup-owning views are never evicted.
 * Protected AI providers and views with unsaved typing input are preserved under
 * NORMAL/MODERATE/HIGH memory pressure and only become emergency eviction candidates
 * under CRITICAL pressure (after unprotected tabs via selectEvictionCandidate).
 */
export function canEvictView({
  id,
  attachedViews,
  layoutFocusedId,
  activeDownloads,
  popupOwners,
  views,
  providers,
  interactionProtected,
  durablePage,
  memoryTier = MemoryPressureTier.NORMAL,
}) {
  if (attachedViews.has(id)) return false;
  if (layoutFocusedId === id) return false;
  if ((activeDownloads.get(id) ?? 0) > 0) return false;
  for (const ownerId of popupOwners.values()) {
    if (ownerId === id) return false;
  }
  const view = views.get(id);
  if (!view || view.webContents.isDestroyed()) return false;
  if (view.webContents.isLoading()) return false;
  if (typeof view.webContents.isDevToolsOpened === 'function' && view.webContents.isDevToolsOpened()) return false;

  const provider = providers.get(id) ?? 'chatgpt';
  if (!durablePage(provider, view.webContents.getURL())) return false;

  if (memoryTier !== MemoryPressureTier.CRITICAL) {
    if (interactionProtected.has(id) || isProtectedProvider(provider)) return false;
  }

  return true;
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
 * @param {object} [params.pressure] - Optional readSystemPressure() result: sustained memory stalls and swap occupancy
 * @param {{assess: Function}} [params.pressureGovernor] - Optional createPressureGovernor() applying hysteresis to `pressure`
 * @param {number} [params.now] - Timestamp for the governor (tests)
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
  pressure,
  pressureGovernor,
  now = Date.now(),
}) {
  const safeAttached = Math.max(0, Number(attachedCount) || 0);
  const freeRatio = totalBytes > 0 ? freeBytes / totalBytes : 0;
  const availableRatio = totalBytes > 0 ? availableBytes / totalBytes : 0;

  // 1. Determine physical memory pressure tier based on system RAM and Tab working set
  let memoryTier = MemoryPressureTier.NORMAL;
  // A large tab working set alone must not reach CRITICAL (the only tier that may evict protected AI tabs) while the
  // system itself has ample memory: with 16 GiB free on a 28 GiB machine, 4 GiB of tabs is not an emergency.
  const ampleMemory = availableBytes >= 8 * GB && availableRatio >= 0.30;
  if (availableBytes < 1 * GB || availableRatio < 0.08 || (tabWorkingSetBytes >= 4 * GB && !ampleMemory)) {
    memoryTier = MemoryPressureTier.CRITICAL;
  } else if (availableBytes < 2 * GB || availableRatio < 0.15 || tabWorkingSetBytes >= 2.5 * GB) {
    memoryTier = MemoryPressureTier.HIGH;
  } else if (availableBytes < 4 * GB || availableRatio < 0.25 || tabWorkingSetBytes >= 1.5 * GB) {
    memoryTier = MemoryPressureTier.MODERATE;
  }

  // 1b. Sustained memory stalls and swap exhaustion only ever raise the tier, up to HIGH (see assessPressure).
  const pressureReasons = [];
  if (pressure) {
    const assessed = pressureGovernor ? pressureGovernor.assess(pressure, availableRatio, now) : assessPressure(pressure, availableRatio);
    const raised = atLeast(memoryTier, assessed.tier);
    if (raised !== memoryTier) { memoryTier = raised; pressureReasons.push(...assessed.reasons); }
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
    pressureReasons,
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

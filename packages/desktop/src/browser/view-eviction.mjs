import { workbenchEnv } from '../../../../scripts/workbench/env.mjs';
/**
 * Resource aware eviction of native browser views.
 *
 * Decides how many views may stay resident under the current memory budget and
 * which one to suspend next. Suspending itself (evictTab) mutates the tab
 * lifecycle and stays with the BrowserViewController, which passes it in.
 *
 * This module is also the single source of truth for lifecycle telemetry: the
 * resource monitor reads the governor's own tier, budget, protection reasons and
 * eviction blockers from here instead of recomputing them.
 */

import { calculateResourceBudget, selectEvictionCandidate, isProtectedProvider, readSystemMemory, readSystemPressure, createPressureGovernor, canEvictView } from '../performance/resource-budget.mjs';
import { durablePage } from './provider-policy.mjs';
import { markProtectionReason, clearProtectionReason } from './view-state.mjs';

/** Protection reasons reported in telemetry, in the order eviction evaluates them. */
export const PROTECTION_REASONS = Object.freeze([
  'focused', 'download', 'popup', 'loading', 'nondurable', 'devtools', 'interaction', 'provider',
]);

/**
 * reclaimedPssBytes is deliberately not measured: renderer processes are shared
 * between views, and reading smaps synchronously in the main process costs about
 * 1.6 ms per process. Telemetry reports the explicit unavailable reason instead.
 */
const RECLAIM_UNAVAILABLE_REASON = 'shared-renderer-attribution';

export function createViewEviction({ app, state, evictTab }) {
  const { views, providers, urls, attachedViews, suspendedTabs, lastAccessedAt, activeDownloads, popupOwners, interactionProtected } = state;

  let lastBudgetInfo = null;
  let lastEviction = null;
  let lastTrim = null;

  function devToolsOpen(id) {
    const contents = views.get(id)?.webContents;
    try {
      return Boolean(contents && !contents.isDestroyed() && typeof contents.isDevToolsOpened === 'function' && contents.isDevToolsOpened());
    } catch {
      return false;
    }
  }

  function canEvict(id) {
    return canEvictView({
      id,
      attachedViews,
      layoutFocusedId: state.layoutFocusedId,
      activeDownloads,
      popupOwners,
      views,
      providers,
      interactionProtected,
      durablePage,
    });
  }

  function ownsPopup(id) {
    for (const ownerId of popupOwners.values()) {
      if (ownerId === id) return true;
    }
    return false;
  }

  /** Every protection reason that currently applies to a resident view. */
  function protectionReasonsOf(id) {
    const reasons = [];
    const view = views.get(id);
    const contents = view?.webContents;
    if (state.layoutFocusedId === id) reasons.push('focused');
    if ((activeDownloads.get(id) ?? 0) > 0) reasons.push('download');
    if (ownsPopup(id)) reasons.push('popup');
    let loading = false;
    let currentUrl = urls.get(id) ?? '';
    try {
      if (contents && !contents.isDestroyed()) {
        loading = contents.isLoading();
        currentUrl = contents.getURL() || currentUrl;
      }
    } catch {}
    if (loading) reasons.push('loading');
    const provider = providers.get(id) ?? 'chatgpt';
    if (!durablePage(provider, currentUrl)) reasons.push('nondurable');
    if (devToolsOpen(id)) reasons.push('devtools');
    if (interactionProtected.has(id)) reasons.push('interaction');
    if (isProtectedProvider(provider)) reasons.push('provider');
    return reasons;
  }

  /** The first reason that stops a resident view from being evicted right now, if any. */
  function blockReasonOf(id) {
    if (canEvict(id)) return null;
    const reasons = protectionReasonsOf(id);
    for (const reason of PROTECTION_REASONS) {
      if (reasons.includes(reason)) return reason;
    }
    return 'unknown';
  }

  const pressureGovernor = createPressureGovernor();
  function getResourceBudgetInfo() {
    let tabWorkingSetBytes = 0;
    try {
      if (typeof app.getAppMetrics === 'function') {
        const metrics = app.getAppMetrics();
        for (const m of metrics) {
          if (m.type === 'Tab' && m.memory?.workingSetSize) {
            tabWorkingSetBytes += m.memory.workingSetSize * 1024;
          }
        }
      }
    } catch {}

    const { freeBytes, availableBytes, totalBytes } = readSystemMemory();

    const info = calculateResourceBudget({
      freeBytes,
      availableBytes,
      totalBytes,
      tabWorkingSetBytes,
      pressure: readSystemPressure(),
      pressureGovernor,
      attachedCount: attachedViews.size,
      envOverride: workbenchEnv('MAX_RESIDENT_VIEWS'),
      tierOverride: workbenchEnv('MEMORY_PRESSURE_TIER'),
    });
    lastBudgetInfo = { ...info, computedAt: Date.now() };
    return info;
  }

  /**
   * The governor's last computed tier and budget, without assessing pressure again:
   * createPressureGovernor().assess mutates the 120 s hysteresis hold, so telemetry
   * must never call it. Null until the governor has run once.
   */
  function peekResourceBudgetInfo() {
    return lastBudgetInfo ? { ...lastBudgetInfo } : null;
  }

  function trimCapacity(excludeId, reserve = 0) {
    if (views.size === 0) return;
    if (reserve === 0 && views.size <= attachedViews.size) return;
    const { budget, memoryTier } = getResourceBudgetInfo();
    while (views.size > Math.max(0, budget - reserve)) {
      const candidateId = selectEvictionCandidate({
        residentIds: views.keys(),
        lastAccessedAt,
        canEvict: (id) => canEvict(id),
        excludeId,
      });

      if (!candidateId) {
        const blockers = {};
        for (const id of views.keys()) {
          if (excludeId && id === excludeId) continue;
          const reason = blockReasonOf(id);
          if (reason) blockers[reason] = (blockers[reason] ?? 0) + 1;
        }
        lastTrim = {
          at: Date.now(),
          budget,
          residentViews: views.size,
          overBudget: true,
          blockers,
        };
        break;
      }
      evictTab(candidateId);
      lastEviction = {
        at: Date.now(),
        id: candidateId,
        tier: memoryTier,
        reclaimedPssBytes: null,
        reclaimedPssUnavailableReason: RECLAIM_UNAVAILABLE_REASON,
      };
      lastTrim = { at: Date.now(), budget, residentViews: views.size, overBudget: views.size > Math.max(0, budget - reserve), blockers: {} };
    }
  }

  /**
   * The browser lifecycle section of the performance snapshot, computed from the
   * governor's own state. rendererProcessCount is filled by the resource monitor,
   * which is the only place that maps views to renderer processes.
   */
  function collectTelemetry(now = Date.now()) {
    const protectedCounts = {};
    const protectionAgeMs = {};
    for (const reason of PROTECTION_REASONS) {
      protectedCounts[reason] = 0;
      protectionAgeMs[reason] = null;
    }

    for (const id of views.keys()) {
      const reasons = protectionReasonsOf(id);
      const active = new Set(reasons);
      for (const reason of reasons) {
        protectedCounts[reason] += 1;
        markProtectionReason(state, id, reason, now);
      }
      const stamps = state.protectionSince.get(id);
      if (stamps) {
        for (const reason of Object.keys(stamps)) {
          if (!active.has(reason)) {
            clearProtectionReason(state, id, reason);
            continue;
          }
          const age = Math.max(0, now - stamps[reason]);
          if (protectionAgeMs[reason] === null || age > protectionAgeMs[reason]) protectionAgeMs[reason] = age;
        }
      }
    }
    for (const id of state.protectionSince.keys()) {
      if (!views.has(id)) state.protectionSince.delete(id);
    }

    const budgetInfo = peekResourceBudgetInfo();
    const budget = budgetInfo ? budgetInfo.budget : null;

    return {
      residentViews: views.size,
      attachedViews: attachedViews.size,
      detachedViews: Math.max(0, views.size - attachedViews.size),
      suspendedViews: suspendedTabs.size,
      protectedCounts,
      protectionAgeMs,
      tier: budgetInfo ? budgetInfo.tier : null,
      memoryTier: budgetInfo ? budgetInfo.memoryTier : null,
      budget,
      budgetSampleAgeMs: budgetInfo ? Math.max(0, now - budgetInfo.computedAt) : null,
      overBudget: budget === null ? null : views.size > budget,
      evictionBlockers: lastTrim ? { ...lastTrim.blockers } : null,
      lastTrimAt: lastTrim ? lastTrim.at : null,
      rendererProcessCount: null,
      lastEviction: lastEviction ? { ...lastEviction } : null,
    };
  }

  return { canEvict, getResourceBudgetInfo, peekResourceBudgetInfo, trimCapacity, collectTelemetry, protectionReasonsOf };
}

/**
 * Resource aware eviction of native browser views.
 *
 * Decides how many views may stay resident under the current memory budget and
 * which one to suspend next. Suspending itself (evictTab) mutates the tab
 * lifecycle and stays with the BrowserViewController, which passes it in.
 */

import { calculateResourceBudget, selectEvictionCandidate, isProtectedProvider, readSystemMemory, readSystemPressure, createPressureGovernor, canEvictView } from '../performance/resource-budget.mjs';
import { durablePage } from './provider-policy.mjs';

export function createViewEviction({ app, state, evictTab }) {
  const { views, providers, attachedViews, lastAccessedAt, activeDownloads, popupOwners, interactionProtected } = state;

  function canEvict(id, memoryTier) {
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
      memoryTier,
    });
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

    return calculateResourceBudget({
      freeBytes,
      availableBytes,
      totalBytes,
      tabWorkingSetBytes,
      pressure: readSystemPressure(),
      pressureGovernor,
      attachedCount: attachedViews.size,
      envOverride: process.env.MAW_MAX_RESIDENT_VIEWS,
      tierOverride: process.env.MAW_MEMORY_PRESSURE_TIER,
    });
  }

  function trimCapacity(excludeId, reserve = 0) {
    if (views.size === 0) return;
    if (reserve === 0 && views.size <= attachedViews.size) return;
    const { budget, memoryTier } = getResourceBudgetInfo();
    while (views.size > Math.max(0, budget - reserve)) {
      const candidateId = selectEvictionCandidate({
        residentIds: views.keys(),
        lastAccessedAt,
        canEvict: (id) => canEvict(id, memoryTier),
        isProtected: (id) => isProtectedProvider(providers.get(id) ?? 'chatgpt') || interactionProtected.has(id),
        excludeId,
      });

      if (!candidateId) break;
      evictTab(candidateId);
    }
  }

  return { canEvict, getResourceBudgetInfo, trimCapacity };
}

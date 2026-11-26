import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MAX_LEAVES, type AgencyCliProfile, type SplitDirection, type WorkspaceId } from '@anvilary/workbench-shared';
import type { WorkspaceTab } from '../workspaces/workspace-model.js';
import type { useWorkbenchStore } from '../workspaces/useWorkbenchStore.js';
import { insertionIndex } from './tab-geometry.mjs';
import { setTabDragPreview, useTabDragPreview, type TabDragSplitTarget } from './tab-drag-store.js';
import { getWorkspaceTabDisplayName } from '../workspaces/workspace-tab-helpers.js';

interface CachedHeaderGeometry {
  rect: DOMRect;
  scrollLeft: number;
  tabRects: { left: number; width: number }[];
}

interface CachedPaneGeometry {
  paneId: string;
  paneEl: HTMLElement;
  rect: DOMRect;
  bodyRect: DOMRect | null;
  stripEl: HTMLElement | null;
  stripRect: DOMRect | null;
}

interface ActiveTabDrag {
  tabId: string;
  pointerId: number;
  startX: number;
  startY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  isDragging: boolean;
  targetIndex: number;
  overPaneId: string | null;
  splitTarget: TabDragSplitTarget | null;
  sourceWidth: number;
  captureEl: HTMLElement | null;
  ghostEl: HTMLElement | null;
  shieldEl: HTMLElement | null;
  cachedPanes: CachedPaneGeometry[];
  cachedHeaders: Map<string, CachedHeaderGeometry>;
  rafId: number;
  latestX: number;
  latestY: number;
}

export interface UseTabPointerDragOptions {
  paneId: string;
  workspaceId: WorkspaceId;
  paneTabs: readonly WorkspaceTab[];
  tabs: readonly WorkspaceTab[];
  profiles: readonly AgencyCliProfile[];
  favicons?: Record<string, string>;
  onMoveTabToPane: (tabId: string, targetPaneId: string, targetIndex?: number) => void;
  onSplitPane?: (targetPaneId: string, direction: SplitDirection, tabIdToMove: string) => void;
  request: ReturnType<typeof useWorkbenchStore>['request'];
  reportError: (error: string) => void;
}

function snapshotAllPanes(): CachedPaneGeometry[] {
  const result: CachedPaneGeometry[] = [];
  const panes = document.querySelectorAll<HTMLElement>('.wb-split-pane');
  for (const paneEl of panes) {
    const paneId = paneEl.id.replace('pane-container-', '');
    if (!paneId) continue;
    const rect = paneEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const bodyEl = paneEl.querySelector<HTMLElement>('.wb-pane-body');
    const stripEl = paneEl.querySelector<HTMLElement>('.wb-pane-tabs');
    result.push({
      paneId,
      paneEl,
      rect,
      bodyRect: bodyEl ? bodyEl.getBoundingClientRect() : null,
      stripEl,
      stripRect: stripEl ? stripEl.getBoundingClientRect() : null,
    });
  }
  return result;
}

function findCachedPaneAtPoint(
  cachedPanes: readonly CachedPaneGeometry[],
  clientX: number,
  clientY: number,
): CachedPaneGeometry | null {
  for (const item of cachedPanes) {
    const { rect } = item;
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return item;
    }
  }
  return null;
}

function measureHeaderGeometry(paneEl: HTMLElement): CachedHeaderGeometry | null {
  const header = paneEl.querySelector<HTMLElement>('.wb-pane-header');
  if (!header) return null;
  const strip = header.querySelector<HTMLElement>('.wb-pane-tabs');
  const scrollLeft = strip?.scrollLeft ?? 0;
  const headerRect = header.getBoundingClientRect();
  const tabEls = [...header.querySelectorAll<HTMLElement>('.wb-session-tab')];
  const tabRects = tabEls.map((element) => {
    const rect = element.getBoundingClientRect();
    // Subtract any inline translateX shift so midpoints remain stable in layout space
    const styleTransform = element.style.transform;
    let shiftX = 0;
    if (styleTransform && styleTransform.startsWith('translateX(')) {
      const parsed = Number.parseFloat(styleTransform.slice('translateX('.length));
      if (Number.isFinite(parsed)) shiftX = parsed;
    }
    return { left: rect.left - shiftX, width: rect.width };
  });
  return { rect: headerRect, scrollLeft, tabRects };
}

function detectSplitEdge(
  paneGeom: CachedPaneGeometry,
  totalPanes: number,
  sourcePaneId: string,
  sourceTabCount: number,
  targetTabCount: number,
  clientX: number,
  clientY: number,
): TabDragSplitTarget | null {
  if (totalPanes >= MAX_LEAVES) return null;
  if (paneGeom.paneId === sourcePaneId && sourceTabCount <= 1) return null;
  if (targetTabCount === 0) return null;

  const rect = paneGeom.bodyRect;
  if (
    !rect ||
    clientX < rect.left ||
    clientX > rect.right ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return null;
  }

  const edgeThreshold = Math.min(48, Math.max(28, Math.min(rect.width, rect.height) * 0.16));
  const distRight = rect.right - clientX;
  const distBottom = rect.bottom - clientY;

  if (distRight <= edgeThreshold && distRight <= distBottom && rect.width >= 280) {
    return { paneId: paneGeom.paneId, direction: 'row' };
  }
  if (distBottom <= edgeThreshold && rect.height >= 180) {
    return { paneId: paneGeom.paneId, direction: 'column' };
  }
  return null;
}

export function useTabPointerDrag({
  paneId,
  workspaceId,
  paneTabs,
  tabs,
  profiles,
  favicons,
  onMoveTabToPane,
  onSplitPane,
  request,
  reportError,
}: UseTabPointerDragOptions) {
  const dragPreview = useTabDragPreview();
  const [dragState, setDragState] = useState<{ tabId: string; targetIndex: number } | null>(null);
  const suppressTabClickUntil = useRef(0);
  const tabDrag = useRef<ActiveTabDrag | null>(null);

  const cleanupDrag = () => {
    const drag = tabDrag.current;
    if (!drag) return;
    tabDrag.current = null;
    if (drag.isDragging) {
      suppressTabClickUntil.current = Date.now() + 200;
      document.body.classList.remove('wb-pane-dragging');
      setDragState(null);
      setTabDragPreview(null);
    }
    if (drag.captureEl) {
      try {
        if (drag.captureEl.hasPointerCapture(drag.pointerId)) {
          drag.captureEl.releasePointerCapture(drag.pointerId);
        }
      } catch {}
    }
    if (drag.rafId) cancelAnimationFrame(drag.rafId);
    drag.ghostEl?.remove();
    drag.shieldEl?.remove();
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && tabDrag.current) {
        cleanupDrag();
      }
    };
    const onBlur = () => {
      if (tabDrag.current) cleanupDrag();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
      cleanupDrag();
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest('[data-close], input')) return;
    const tabEl = (event.target as Element).closest<HTMLElement>('.wb-session-tab');
    if (!tabEl) return;
    const tabId = tabEl.getAttribute('data-tab-id');
    if (!tabId) return;

    const idx = paneTabs.findIndex((t) => t.id === tabId);
    const rect = tabEl.getBoundingClientRect();
    tabDrag.current = {
      tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabOffsetX: event.clientX - rect.left,
      grabOffsetY: event.clientY - rect.top,
      isDragging: false,
      targetIndex: idx,
      overPaneId: paneId,
      splitTarget: null,
      sourceWidth: rect.width,
      captureEl: null,
      ghostEl: null,
      shieldEl: null,
      cachedPanes: [],
      cachedHeaders: new Map(),
      rafId: 0,
      latestX: event.clientX,
      latestY: event.clientY,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = tabDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (!drag.isDragging) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 6) {
        return;
      }
      drag.isDragging = true;
      drag.captureEl = event.currentTarget;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.cachedPanes = snapshotAllPanes();
      for (const p of drag.cachedPanes) {
        const measured = measureHeaderGeometry(p.paneEl);
        if (measured) drag.cachedHeaders.set(p.paneId, measured);
      }

      const sourceTab = paneTabs.find((t) => t.id === drag.tabId);
      if (sourceTab) {
        const ghost = document.createElement('div');
        ghost.className = 'wb-tab-drag-ghost';
        const iconSpan = document.createElement('span');
        iconSpan.setAttribute('aria-hidden', 'true');
        const sourceFav = favicons?.[sourceTab.id];
        if (sourceTab.kind === 'web' && sourceFav) {
          const img = document.createElement('img');
          img.className = 'wb-tab-favicon';
          img.src = sourceFav;
          iconSpan.appendChild(img);
        } else if (sourceTab.kind === 'web') {
          iconSpan.textContent = '◎';
        } else {
          iconSpan.textContent =
            sourceTab.kind === 'editor'
              ? '✎'
              : sourceTab.session?.kind === 'agent'
                ? '◇'
                : '>_';
        }
        const titleSpan = document.createElement('span');
        titleSpan.className = 'agency-truncate';
        titleSpan.textContent = getWorkspaceTabDisplayName(sourceTab, profiles);
        ghost.appendChild(iconSpan);
        ghost.appendChild(titleSpan);
        ghost.style.transform = `translate3d(${event.clientX - drag.grabOffsetX}px, ${event.clientY - drag.grabOffsetY}px, 0)`;
        document.body.appendChild(ghost);
        drag.ghostEl = ghost;
      }

      if (!document.querySelector('.wb-pane-drag-shield')) {
        const shield = document.createElement('div');
        shield.className = 'wb-pane-drag-shield';
        shield.setAttribute('aria-hidden', 'true');
        document.body.appendChild(shield);
        drag.shieldEl = shield;
      }
      document.body.classList.add('wb-pane-dragging');
    }

    event.preventDefault();

    drag.latestX = event.clientX;
    drag.latestY = event.clientY;
    if (drag.rafId === 0) {
      drag.rafId = requestAnimationFrame(() => {
        const current = tabDrag.current;
        if (current && current.rafId !== 0) {
          current.rafId = 0;
          if (current.ghostEl) {
            current.ghostEl.style.transform = `translate3d(${current.latestX - current.grabOffsetX}px, ${current.latestY - current.grabOffsetY}px, 0)`;
          }
        }
      });
    }

    const hit = findCachedPaneAtPoint(drag.cachedPanes, event.clientX, event.clientY);
    if (!hit) {
      if (drag.overPaneId !== null) {
        drag.overPaneId = null;
        drag.splitTarget = null;
        setDragState(null);
        setTabDragPreview(null);
      }
      return;
    }
    const { paneEl: targetPaneEl, paneId: targetPaneId, stripEl, stripRect } = hit;

    if (stripEl && stripRect && stripEl.scrollWidth > stripEl.clientWidth) {
      if (event.clientY >= stripRect.top - 12 && event.clientY <= stripRect.bottom + 12) {
        if (event.clientX < stripRect.left + 28) {
          stripEl.scrollLeft -= 10;
          drag.cachedHeaders.delete(targetPaneId);
        } else if (event.clientX > stripRect.right - 28) {
          stripEl.scrollLeft += 10;
          drag.cachedHeaders.delete(targetPaneId);
        }
      }
    }

    const currentScrollLeft = stripEl?.scrollLeft ?? 0;
    let headerData = drag.cachedHeaders.get(targetPaneId);
    if (!headerData || headerData.scrollLeft !== currentScrollLeft) {
      const measured = measureHeaderGeometry(targetPaneEl);
      if (measured) {
        headerData = measured;
        drag.cachedHeaders.set(targetPaneId, headerData);
      }
    }

    const rects = headerData?.tabRects ?? [];
    const nextSplitTarget = detectSplitEdge(
      hit,
      drag.cachedPanes.length,
      paneId,
      paneTabs.length,
      rects.length,
      event.clientX,
      event.clientY,
    );
    const target = nextSplitTarget
      ? rects.length
      : rects.length > 0
        ? insertionIndex(event.clientX, rects)
        : 0;

    const splitChanged =
      drag.splitTarget?.paneId !== nextSplitTarget?.paneId ||
      drag.splitTarget?.direction !== nextSplitTarget?.direction;

    if (target !== drag.targetIndex || targetPaneId !== drag.overPaneId || splitChanged) {
      drag.targetIndex = target;
      drag.overPaneId = targetPaneId;
      drag.splitTarget = nextSplitTarget;
      setDragState({ tabId: drag.tabId, targetIndex: target });
      setTabDragPreview({
        tabId: drag.tabId,
        sourcePaneId: paneId,
        sourceIndex: paneTabs.findIndex((tab) => tab.id === drag.tabId),
        width: drag.sourceWidth,
        overPaneId: nextSplitTarget ? null : targetPaneId,
        overIndex: nextSplitTarget ? null : target,
        splitTarget: nextSplitTarget,
      });
    }
  };

  const onPointerUp = async (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragInfo = tabDrag.current;
    if (!dragInfo || dragInfo.pointerId !== event.pointerId) return;

    cleanupDrag();

    if (!dragInfo.isDragging) return;

    suppressTabClickUntil.current = Date.now() + 200;
    const hit = findCachedPaneAtPoint(dragInfo.cachedPanes, event.clientX, event.clientY);
    if (!hit) return;
    const destination = hit.paneId;

    const cached = dragInfo.cachedHeaders.get(destination) ?? measureHeaderGeometry(hit.paneEl);
    const rects = cached?.tabRects ?? [];
    const split = detectSplitEdge(hit, dragInfo.cachedPanes.length, paneId, paneTabs.length, rects.length, event.clientX, event.clientY);
    if (split && onSplitPane) {
      onSplitPane(split.paneId, split.direction, dragInfo.tabId);
      return;
    }
    const insertion = rects.length > 0 ? insertionIndex(event.clientX, rects) : 0;
    const sourceIndex = paneTabs.findIndex((tab) => tab.id === dragInfo.tabId);
    const finalIndex = destination === paneId && insertion > sourceIndex ? insertion - 1 : insertion;

    onMoveTabToPane(dragInfo.tabId, destination, finalIndex);

    if (destination !== paneId) return;
    if (sourceIndex === -1 || finalIndex === sourceIndex) return;

    const paneIds = paneTabs.map((t) => t.id);
    const [moved] = paneIds.splice(sourceIndex, 1);
    if (!moved) return;
    paneIds.splice(Math.max(0, Math.min(paneIds.length, finalIndex)), 0, moved);

    const paneIdSet = new Set(paneIds);
    let slot = 0;
    const nextGlobalIds = tabs.map((t) => (paneIdSet.has(t.id) ? paneIds[slot++]! : t.id));
    try {
      await request({ type: 'agency.tabs.order', workspaceId, tabIds: nextGlobalIds });
    } catch (reason) {
      reportError(String(reason));
    }
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tabDrag.current?.pointerId === event.pointerId) cleanupDrag();
  };

  return {
    dragPreview,
    dragState,
    suppressTabClickUntil,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}

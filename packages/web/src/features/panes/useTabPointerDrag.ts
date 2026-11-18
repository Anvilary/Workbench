import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AgencyCliProfile, WorkspaceId } from '@agent-workbench/shared';
import type { WorkspaceTab } from '../../agency/model.js';
import type { useAgencyStore } from '../../agency/useAgencyStore.js';
import { insertionIndex } from '../../agency/split/tab-geometry.mjs';
import { setTabDragPreview, useTabDragPreview } from '../../agency/split/tab-drag-store.js';
import { getWorkspaceTabDisplayName } from '../workspaces/workspace-tab-helpers.js';

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
  sourceWidth: number;
  ghostEl: HTMLElement | null;
  shieldEl: HTMLElement | null;
  cachedHeaders: Map<string, { rect: DOMRect; tabRects: { left: number; width: number }[] }>;
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
  request: ReturnType<typeof useAgencyStore>['request'];
  reportError: (error: string) => void;
}

export function useTabPointerDrag({
  paneId,
  workspaceId,
  paneTabs,
  tabs,
  profiles,
  favicons,
  onMoveTabToPane,
  request,
  reportError,
}: UseTabPointerDragOptions) {
  const dragPreview = useTabDragPreview();
  const [dragState, setDragState] = useState<{ tabId: string; targetIndex: number } | null>(null);
  const suppressTabClickUntil = useRef(0);
  const tabDrag = useRef<ActiveTabDrag | null>(null);

  const cleanupDrag = () => {
    if (tabDrag.current?.rafId) {
      cancelAnimationFrame(tabDrag.current.rafId);
      tabDrag.current.rafId = 0;
    }
    if (tabDrag.current?.ghostEl) {
      tabDrag.current.ghostEl.remove();
      tabDrag.current.ghostEl = null;
    }
    if (tabDrag.current?.shieldEl) {
      tabDrag.current.shieldEl.remove();
      tabDrag.current.shieldEl = null;
    }
    document.body.classList.remove('maw-pane-dragging');
    tabDrag.current = null;
    setDragState(null);
    setTabDragPreview(null);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && tabDrag.current) {
        cleanupDrag();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      cleanupDrag();
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('[data-close], input')) return;
    const tabEl = (event.target as Element).closest<HTMLElement>('.maw-session-tab');
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
      sourceWidth: rect.width,
      ghostEl: null,
      shieldEl: null,
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
      event.currentTarget.setPointerCapture(event.pointerId);

      const sourceTab = paneTabs.find((t) => t.id === drag.tabId);
      if (sourceTab) {
        const ghost = document.createElement('div');
        ghost.className = 'maw-tab-drag-ghost';
        const iconSpan = document.createElement('span');
        iconSpan.setAttribute('aria-hidden', 'true');
        const sourceFav = favicons?.[sourceTab.id];
        if (sourceTab.kind === 'web' && sourceFav) {
          const img = document.createElement('img');
          img.className = 'maw-tab-favicon';
          img.src = sourceFav;
          iconSpan.appendChild(img);
        } else {
          iconSpan.textContent =
            sourceTab.kind === 'web'
              ? '🌐'
              : sourceTab.kind === 'editor'
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

      if (!document.querySelector('.maw-pane-drag-shield')) {
        const shield = document.createElement('div');
        shield.className = 'maw-pane-drag-shield';
        shield.setAttribute('aria-hidden', 'true');
        document.body.appendChild(shield);
        drag.shieldEl = shield;
      }
      document.body.classList.add('maw-pane-dragging');
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

    let targetPaneId: string | null = null;
    let targetPaneEl: HTMLElement | null = null;

    const currentHeader = drag.overPaneId ? drag.cachedHeaders.get(drag.overPaneId) : undefined;
    if (
      currentHeader &&
      event.clientX >= currentHeader.rect.left &&
      event.clientX <= currentHeader.rect.right &&
      event.clientY >= currentHeader.rect.top &&
      event.clientY <= currentHeader.rect.bottom
    ) {
      targetPaneId = drag.overPaneId;
    } else {
      const elUnder = document.elementFromPoint(event.clientX, event.clientY);
      targetPaneEl = elUnder?.closest<HTMLElement>('.maw-split-pane') ?? null;
      targetPaneId = targetPaneEl?.id.replace('pane-container-', '') ?? null;
    }

    if (!targetPaneId) return;

    let headerData = drag.cachedHeaders.get(targetPaneId);
    if (!headerData) {
      const pEl = targetPaneEl ?? document.getElementById(`pane-container-${targetPaneId}`);
      const header = pEl?.querySelector<HTMLElement>('.maw-pane-header');
      if (header) {
        const headerRect = header.getBoundingClientRect();
        const tabEls = [...header.querySelectorAll<HTMLElement>('.maw-session-tab')];
        const tabRects = tabEls.map((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, width: rect.width };
        });
        headerData = { rect: headerRect, tabRects };
        drag.cachedHeaders.set(targetPaneId, headerData);
      }
    }

    const rects = headerData?.tabRects ?? [];
    const target = targetPaneId && rects.length > 0 ? insertionIndex(event.clientX, rects) : rects.length;

    if (target !== drag.targetIndex || targetPaneId !== drag.overPaneId) {
      drag.targetIndex = target;
      drag.overPaneId = targetPaneId;
      setDragState({ tabId: drag.tabId, targetIndex: target });
      setTabDragPreview({
        tabId: drag.tabId,
        sourcePaneId: paneId,
        sourceIndex: paneTabs.findIndex((tab) => tab.id === drag.tabId),
        width: drag.sourceWidth,
        overPaneId: targetPaneId,
        overIndex: target,
      });
    }
  };

  const onPointerUp = async (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragInfo = tabDrag.current;
    if (!dragInfo || dragInfo.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    cleanupDrag();

    if (!dragInfo.isDragging) return;

    suppressTabClickUntil.current = Date.now() + 200;
    const elUnder = document.elementFromPoint(event.clientX, event.clientY);
    const destination =
      elUnder?.closest('.maw-split-pane')?.id.replace('pane-container-', '') ?? dragInfo.overPaneId;
    if (!destination) return;

    const targetPaneEl = document.getElementById(`pane-container-${destination}`);
    const targetHeader = targetPaneEl?.querySelector('.maw-pane-header');
    const targetElements = targetHeader
      ? [...targetHeader.querySelectorAll<HTMLElement>('.maw-session-tab')]
      : [];
    const targetIndex = targetElements.findIndex((element) => {
      const rect = element.getBoundingClientRect();
      return event.clientX < rect.left + rect.width / 2;
    });
    const insertion = targetIndex < 0 ? targetElements.length : targetIndex;
    const sourceIndex = paneTabs.findIndex((tab) => tab.id === dragInfo.tabId);
    onMoveTabToPane(
      dragInfo.tabId,
      destination,
      destination === paneId && insertion > sourceIndex ? insertion - 1 : insertion,
    );

    if (destination !== paneId) return;
    const currentIdx = tabs.findIndex((t) => t.id === dragInfo.tabId);
    const targetPaneTab = paneTabs[dragInfo.targetIndex];
    const targetIdx = targetPaneTab ? tabs.findIndex((t) => t.id === targetPaneTab.id) : tabs.length;
    if (currentIdx !== -1 && targetIdx !== currentIdx && targetIdx !== currentIdx + 1) {
      const ids = tabs.map((t) => t.id);
      const [draggedId] = ids.splice(currentIdx, 1);
      const insertIdx = targetIdx > currentIdx ? targetIdx - 1 : targetIdx;
      ids.splice(insertIdx, 0, draggedId!);
      try {
        await request({ type: 'agency.tabs.order', workspaceId, tabIds: ids });
      } catch (reason) {
        reportError(String(reason));
      }
    }
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    cleanupDrag();
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

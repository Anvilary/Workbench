import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectId, WorkspaceId } from '@anvilary/workbench-shared';
import type { AgencyProject, AgencyWorkspace } from '@anvilary/workbench-shared';

/**
 * Pointer drag and drop for the sidebar's projects and workspaces.
 *
 * The hook owns the drag session (ghost position, insertion slot, the live
 * announcement for assistive technology and the click suppression that follows
 * a drag). The sidebar owns the data: it passes the groups and the reorder
 * callbacks, and a predicate that says whether a drag may start now (an open
 * menu or an inline rename blocks it).
 */

export interface SidebarActiveDrag {
  kind: 'project' | 'workspace';
  id: string;
  projectId: ProjectId;
  label: string;
  fromIndex: number;
  insertIndex: number | null;
  rowLeft: number;
  rowWidth: number;
  rowHeight: number;
  displacement: number;
  ghostTop: number;
  valid: boolean;
}

export function resolveInsertionIndex(
  rects: readonly { top: number; height: number }[],
  clientY: number,
  sourceIndex: number,
): number {
  let rawIndex = rects.length;
  for (let i = 0; i < rects.length; i += 1) {
    const midY = rects[i]!.top + rects[i]!.height / 2;
    if (clientY < midY) {
      rawIndex = i;
      break;
    }
  }
  // Adjust raw slot so insertIndex is the final array index after removing sourceIndex
  return rawIndex > sourceIndex ? rawIndex - 1 : rawIndex;
}

export function siblingDisplacementPx(
  index: number,
  fromIndex: number,
  insertIndex: number | null,
  draggedHeight: number,
): number {
  if (insertIndex === null || index === fromIndex) return 0;
  if (insertIndex > fromIndex && index > fromIndex && index <= insertIndex) return -draggedHeight;
  if (insertIndex < fromIndex && index >= insertIndex && index < fromIndex) return draggedHeight;
  return 0;
}

export interface SidebarDragParams {
  kind: 'project' | 'workspace';
  id: string;
  projectId: ProjectId;
  label: string;
  fromIndex: number;
}

export interface UseSidebarDragOptions {
  groups: readonly { project: AgencyProject; items: readonly AgencyWorkspace[] }[];
  onReorderProjects: ((ids: ProjectId[]) => void) | undefined;
  onReorderWorkspaces?: ((projectId: ProjectId, ids: WorkspaceId[]) => void) | undefined;
  navRef: React.RefObject<HTMLElement | null>;
  sideSectionRef: React.RefObject<HTMLDivElement | null>;
  dragGhostRef: React.RefObject<HTMLDivElement | null>;
  /** True while something else (an open menu, an inline rename of that row) owns the pointer. */
  isDragBlocked: (params: SidebarDragParams) => boolean;
}

export function useSidebarDrag({
  groups, onReorderProjects, onReorderWorkspaces, navRef, sideSectionRef, dragGhostRef, isDragBlocked,
}: UseSidebarDragOptions) {
  const [activeDrag, setActiveDrag] = useState<SidebarActiveDrag | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const suppressClickUntil = useRef<number>(0);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const callbacksRef = useRef({ onReorderProjects, onReorderWorkspaces });
  callbacksRef.current = { onReorderProjects, onReorderWorkspaces };
  const isDragBlockedRef = useRef(isDragBlocked);
  isDragBlockedRef.current = isDragBlocked;
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    dragCleanupRef.current?.();
    document.body.classList.remove('agency-sidebar-dragging');
  }, []);

  const beginPointerDrag =   useCallback((
    e: React.PointerEvent<HTMLElement>,
    params: SidebarDragParams,
  ) => {
    if (e.button !== 0 || !e.isPrimary || isDragBlockedRef.current(params)) return;
    const targetEl = e.target as HTMLElement | null;
    if (targetEl?.closest('.agency-dropdown, .agency-row-action, input')) return;

    if (params.kind === 'workspace') {
      e.stopPropagation();
    }

    const scroller = sideSectionRef.current;
    const navRect = navRef.current?.getBoundingClientRect();
    if (!scroller || !navRect) return;
    const viewport = scroller.getBoundingClientRect();
    const scope = params.kind === 'project'
      ? scroller
      : scroller.querySelector<HTMLElement>(`[data-sidebar-project-children="${params.projectId}"]`);
    if (!scope) return;
    const bounds = scope.getBoundingClientRect();
    const rows = Array.from(scope.querySelectorAll<HTMLElement>(
      params.kind === 'project' ? '[data-sidebar-project-id]' : '[data-sidebar-workspace-id]',
    ), row => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    const scrollStart = scroller.scrollTop;
    const captureTarget = e.currentTarget;
    const rowRect = captureTarget.getBoundingClientRect();
    const projectSection = params.kind === 'project' ? captureTarget.closest('.agency-project') : null;
    const displacement = projectSection
      ? projectSection.getBoundingClientRect().height + (parseFloat(getComputedStyle(projectSection).marginBottom) || 0)
      : rowRect.height;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const offsetY = startY - rowRect.top;
    let started = false;
    let hasCapture = false;
    let shieldEl: HTMLDivElement | null = null;
    let autoScrollRaf: number | null = null;
    let ghostRaf: number | null = null;
    let pendingGhostTop = rowRect.top;
    let autoScrollDelta = 0;
    let lastX = startX;
    let lastY = startY;
    let lastCommittedInsertIndex: number | null | undefined = undefined;
    let lastCommittedValid: boolean | undefined = undefined;

    const stopAutoScroll = () => {
      if (autoScrollRaf !== null) {
        window.cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = null;
      }
      autoScrollDelta = 0;
    };

    const stopGhostRaf = () => {
      if (ghostRaf !== null) {
        window.cancelAnimationFrame(ghostRaf);
        ghostRaf = null;
      }
    };

    const scheduleGhostPosition = (ghostTop: number) => {
      pendingGhostTop = ghostTop;
      if (ghostRaf !== null) return;
      ghostRaf = window.requestAnimationFrame(() => {
        ghostRaf = null;
        if (dragGhostRef.current) {
          dragGhostRef.current.style.top = `${pendingGhostTop}px`;
        }
      });
    };

    const applyDragState = (next: SidebarActiveDrag, force = false) => {
      scheduleGhostPosition(next.ghostTop);
      if (
        force ||
        next.insertIndex !== lastCommittedInsertIndex ||
        next.valid !== lastCommittedValid
      ) {
        lastCommittedInsertIndex = next.insertIndex;
        lastCommittedValid = next.valid;
        setActiveDrag(next);
      }
    };

    const tickAutoScroll = () => {
      autoScrollRaf = null;
      if (autoScrollDelta === 0) return;
      const previous = scroller.scrollTop;
      scroller.scrollTop += autoScrollDelta;
      if (previous === scroller.scrollTop) return;
      applyDragState(computeState(lastX, lastY));
      autoScrollRaf = window.requestAnimationFrame(tickAutoScroll);
    };

    const computeState = (clientX: number, clientY: number): SidebarActiveDrag => {
      const scrollDelta = scroller.scrollTop - scrollStart;
      const scopeDelta = params.kind === 'workspace' ? scrollDelta : 0;
      const clampMinTop = Math.min(viewport.bottom, Math.max(viewport.top, bounds.top - scopeDelta));
      const bottom = Math.max(clampMinTop, Math.min(viewport.bottom, bounds.bottom - scopeDelta));
      const clampMaxTop = Math.max(clampMinTop, bottom - rowRect.height);
      const valid = clientX >= navRect.left && clientX <= navRect.right &&
        clientY >= clampMinTop - 12 && clientY <= bottom + 12 && rows.length > 0;
      const insertIndex = valid ? resolveInsertionIndex(rows, clientY + scrollDelta, params.fromIndex) : null;
      const ghostTop = Math.max(clampMinTop, Math.min(clampMaxTop, clientY - offsetY));

      return {
        kind: params.kind,
        id: params.id,
        projectId: params.projectId,
        label: params.label,
        fromIndex: params.fromIndex,
        insertIndex,
        rowLeft: rowRect.left,
        rowWidth: rowRect.width,
        rowHeight: rowRect.height,
        displacement,
        ghostTop,
        valid,
      };
    };

    const onLostPointerCapture = (capEvent: PointerEvent) => {
      if (capEvent.pointerId === pointerId && hasCapture) {
        hasCapture = false;
        // Detaching a native Chromium WebContentsView when the drag shield mounts can
        // release element pointer capture without ending the physical drag. Keep the
        // drag session alive via window-level pointermove/pointerup/pointercancel/blur.
      }
    };

    const cleanup = () => {
      stopAutoScroll();
      stopGhostRaf();
      captureTarget.removeEventListener('lostpointercapture', onLostPointerCapture);
      if (hasCapture) {
        hasCapture = false;
        try {
          if (captureTarget.hasPointerCapture?.(pointerId)) {
            captureTarget.releasePointerCapture(pointerId);
          }
        } catch {
          // Ignore if target was detached before release.
        }
      }
      shieldEl?.remove();
      shieldEl = null;
      document.body.classList.remove('agency-sidebar-dragging');
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('resize', onCancel);
      dragCleanupRef.current = null;
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      let justStarted = false;
      if (!started) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
        started = true;
        justStarted = true;
        suppressClickUntil.current = Date.now() + 300;
        document.body.classList.add('agency-sidebar-dragging');
        if (!document.querySelector('.agency-sidebar-drag-shield')) {
          const shield = document.createElement('div');
          shield.className = 'agency-sidebar-drag-shield';
          shield.setAttribute('aria-hidden', 'true');
          document.body.appendChild(shield);
          shieldEl = shield;
        }
        try {
          if (typeof captureTarget.setPointerCapture === 'function') {
            captureTarget.setPointerCapture(pointerId);
            hasCapture = true;
            captureTarget.addEventListener('lostpointercapture', onLostPointerCapture);
          }
        } catch {
          // Synthetic pointer events in tests may not support pointer capture.
        }
      }

      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;
      if (lastX >= navRect.left && lastX <= navRect.right) {
        if (lastY < viewport.top + 28) autoScrollDelta = -6;
        else if (lastY > viewport.bottom - 28) autoScrollDelta = 6;
        else autoScrollDelta = 0;
        if (autoScrollDelta !== 0 && autoScrollRaf === null) {
          autoScrollRaf = window.requestAnimationFrame(tickAutoScroll);
        }
      } else {
        autoScrollDelta = 0;
      }

      applyDragState(computeState(lastX, lastY), justStarted);
    };

    const onCancel = () => {
      cleanup();
      if (started) suppressClickUntil.current = Date.now() + 300;
      setActiveDrag(null);
    };

    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        onCancel();
      }
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      const current = started ? computeState(upEvent.clientX, upEvent.clientY) : null;
      cleanup();
      setActiveDrag(null);
      if (started) suppressClickUntil.current = Date.now() + 300;
      if (!started || !current || !current.valid || current.insertIndex === null || current.insertIndex === current.fromIndex) {
        return;
      }
      if (current.kind === 'project' && callbacksRef.current.onReorderProjects) {
        const ids = groupsRef.current.map((g) => g.project.id);
        const fromIdx = ids.indexOf(current.id as ProjectId);
        if (fromIdx !== -1) {
          const nextIds = [...ids];
          nextIds.splice(fromIdx, 1);
          const bounded = Math.max(0, Math.min(nextIds.length, current.insertIndex));
          nextIds.splice(bounded, 0, current.id as ProjectId);
          callbacksRef.current.onReorderProjects(nextIds);
          setLiveAnnouncement(`Moved project ${current.label} to position ${bounded + 1} of ${nextIds.length}`);
        }
      } else if (current.kind === 'workspace' && callbacksRef.current.onReorderWorkspaces) {
        const group = groupsRef.current.find((g) => g.project.id === current.projectId);
        const ids = group ? group.items.map((w) => w.id) : [];
        const fromIdx = ids.indexOf(current.id as WorkspaceId);
        if (fromIdx !== -1) {
          const nextIds = [...ids];
          nextIds.splice(fromIdx, 1);
          const bounded = Math.max(0, Math.min(nextIds.length, current.insertIndex));
          nextIds.splice(bounded, 0, current.id as WorkspaceId);
          callbacksRef.current.onReorderWorkspaces(current.projectId, nextIds);
          setLiveAnnouncement(`Moved workspace ${current.label} to position ${bounded + 1} of ${nextIds.length}`);
        }
      }
    };

    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onCancel);
    window.addEventListener('resize', onCancel);
  }, []);;

  return { activeDrag, liveAnnouncement, setLiveAnnouncement, suppressClickUntil, beginPointerDrag };
}

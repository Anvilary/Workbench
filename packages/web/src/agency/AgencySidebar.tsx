import { t } from '../i18n/index.js';
import { agencySessionText } from './agency-labels.js';
import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_BROWSER_PROFILE_ID } from '@agent-workbench/shared';
import type {
  AgencyProject, AgencyRuntimeSession, AgencyWorkspace, BrowserProfile, EditorTab, ProjectId, WorkspaceId, WebTab,
} from '@agent-workbench/shared';
import { activeByProject, isAttention, workspaceTabs } from './model.js';
import { InlineRenameInput } from '../shared/ui/InlineRenameInput.js';
import { StatusDot } from '../shared/ui/StatusDot.js';
import type { AnchorRect } from '../shared/ui/ModalDialog.js';
import { handleMenuArrowNavigation } from '../shared/hooks/useMenuKeyboardNav.js';
import { calculateSidebarDropdownPosition } from '../shared/lib/overlay-position.js';
import { AgencyDoneView } from '../features/workspaces/AgencyDoneView.js';
import { DeleteWorkspaceDialog } from '../features/workspaces/DeleteWorkspaceDialog.js';
import { SidebarConfirmDialogs } from '../features/workspaces/SidebarConfirmDialogs.js';
import { SidebarDropdownMenu } from '../features/workspaces/SidebarDropdownMenu.js';

export { AgencyDoneView, DeleteWorkspaceDialog, calculateSidebarDropdownPosition };

export interface AgencySidebarProps {
  projects: readonly AgencyProject[];
  workspaces: readonly AgencyWorkspace[];
  sessions: readonly AgencyRuntimeSession[];
  webTabs?: readonly WebTab[];
  editorTabs?: readonly EditorTab[];
  browserProfiles?: readonly BrowserProfile[];
  selected: WorkspaceId | null;
  showingDone?: boolean;
  onSelect: (id: WorkspaceId) => void;
  onDoneView?: () => void;
  onCreate: (project?: ProjectId) => void;
  onCreateProject: () => void;
  onCollapse: () => void;
  onDone: (workspace: AgencyWorkspace) => void;
  onArchiveWorkspace: (workspace: AgencyWorkspace) => void;
  onDeleteWorkspace: (workspace: AgencyWorkspace) => Promise<void> | void;
  onRenameProject: (project: AgencyProject, newName: string) => void;
  onRenameWorkspace?: (workspace: AgencyWorkspace, newName: string) => void;
  onUpdateProjectProfile?: (project: AgencyProject, profileId: string | null) => void;
  onUpdateWorkspaceProfile?: (workspace: AgencyWorkspace, profileId: string | null) => void;
  onArchiveProject: (project: AgencyProject) => void;
  onDeleteProject: (project: AgencyProject, cascade?: boolean) => Promise<void> | void;
  onRestore: (workspace: AgencyWorkspace) => void;
  onReorderProjects?: (projectIds: readonly ProjectId[]) => void;
  onReorderWorkspaces?: (projectId: ProjectId, workspaceIds: readonly WorkspaceId[]) => void;
}

export function SidebarToggleIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6 2.5v11" />
    </svg>
  );
}

interface SidebarActiveDrag {
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

function resolveInsertionIndex(
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

function siblingDisplacementPx(
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

export function AgencySidebar({
  projects, workspaces, sessions, webTabs = [], editorTabs = [], browserProfiles = [], selected, showingDone = false,
  onSelect, onCreate, onCreateProject, onDone, onArchiveWorkspace, onDeleteWorkspace,
  onRenameProject, onRenameWorkspace, onUpdateProjectProfile, onUpdateWorkspaceProfile,
  onArchiveProject, onDeleteProject, onCollapse, onReorderProjects, onReorderWorkspaces,
}: AgencySidebarProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<{ type: 'project' | 'workspace'; id: string; trigger: 'click' | 'hover' } | null>(null);
  const [activeDrag, setActiveDrag] = useState<SidebarActiveDrag | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const suppressClickUntil = useRef<number>(0);
  const navRef = useRef<HTMLElement | null>(null);
  const sideSectionRef = useRef<HTMLDivElement | null>(null);

  const [inlineRenamingProjectId, setInlineRenamingProjectId] = useState<ProjectId | null>(null);
  const [inlineRenameProjectValue, setInlineRenameProjectValue] = useState<string>('');
  const [inlineRenamingWorkspaceId, setInlineRenamingWorkspaceId] = useState<WorkspaceId | null>(null);
  const [inlineRenameWorkspaceValue, setInlineRenameWorkspaceValue] = useState<string>('');

  const [archivingProject, setArchivingProject] = useState<AgencyProject | null>(null);
  const [deletingProject, setDeletingProject] = useState<AgencyProject | null>(null);
  const [archivingWorkspace, setArchivingWorkspace] = useState<AgencyWorkspace | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<AgencyWorkspace | null>(null);
  const [dialogAnchorRect, setDialogAnchorRect] = useState<AnchorRect | null>(null);

  const graceTimerRef = useRef<number | null>(null);
  const activeTriggerRef = useRef<HTMLElement | null>(null);
  const activeMenuRef = useRef<HTMLDivElement | null>(null);

  const setMenuRef = useCallback((el: HTMLDivElement | null) => {
    activeMenuRef.current = el;
  }, []);

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current !== null) {
      window.clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  const closeMenu = useCallback(() => {
    clearGraceTimer();
    setOpenMenu(null);
  }, [clearGraceTimer]);

  const handleTriggerClick = (type: 'project' | 'workspace', id: string, e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    clearGraceTimer();
    if (openMenu?.type === type && openMenu.id === id) {
      closeMenu();
    } else {
      activeTriggerRef.current = e.currentTarget;
      setOpenMenu({ type, id, trigger: 'click' });
    }
  };

  const handleTriggerMouseEnter = (type: 'project' | 'workspace', id: string, e: React.MouseEvent<HTMLElement>) => {
    clearGraceTimer();
    if (openMenu && openMenu.trigger === 'hover' && (openMenu.type !== type || openMenu.id !== id)) {
      activeTriggerRef.current = e.currentTarget;
      setOpenMenu({ type, id, trigger: 'hover' });
    }
  };

  const handleTriggerMouseLeave = () => {
    if (openMenu?.trigger === 'hover') {
      clearGraceTimer();
      graceTimerRef.current = window.setTimeout(() => {
        closeMenu();
      }, 700);
    }
  };

  const handleMenuMouseEnter = () => {
    clearGraceTimer();
  };

  const handleMenuMouseLeave = () => {
    if (openMenu?.trigger === 'hover') {
      clearGraceTimer();
      graceTimerRef.current = window.setTimeout(() => {
        closeMenu();
      }, 700);
    }
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    handleMenuArrowNavigation(e, activeMenuRef.current, closeMenu);
  };

  const groups = activeByProject(projects, workspaces);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const callbacksRef = useRef({ onReorderProjects, onReorderWorkspaces });
  callbacksRef.current = { onReorderProjects, onReorderWorkspaces };
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    dragCleanupRef.current?.();
    document.body.classList.remove('agency-sidebar-dragging');
  }, []);

  const beginPointerDrag = useCallback((
    e: React.PointerEvent<HTMLElement>,
    params: { kind: 'project' | 'workspace'; id: string; projectId: ProjectId; label: string; fromIndex: number },
  ) => {
    if (e.button !== 0 || !e.isPrimary || openMenu) return;
    const targetEl = e.target as HTMLElement | null;
    if (targetEl?.closest('.agency-dropdown, .agency-row-action, input')) return;
    if (params.kind === 'project' && inlineRenamingProjectId === params.id) return;
    if (params.kind === 'workspace' && inlineRenamingWorkspaceId === params.id) return;

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
      params.kind === 'project' ? '[data-sidebar-project-id] > .agency-project-row' : '[data-sidebar-workspace-id]',
    ), row => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    const scrollStart = scroller.scrollTop;
    const rowRect = e.currentTarget.getBoundingClientRect();
    const projectSection = params.kind === 'project' ? e.currentTarget.closest('.agency-project') : null;
    const displacement = projectSection
      ? projectSection.getBoundingClientRect().height + (parseFloat(getComputedStyle(projectSection).marginBottom) || 0)
      : rowRect.height;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const offsetY = startY - rowRect.top;
    let started = false;
    let autoScrollRaf: number | null = null;
    let autoScrollDelta = 0;
    let lastX = startX;
    let lastY = startY;

    const stopAutoScroll = () => {
      if (autoScrollRaf !== null) {
        window.cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = null;
      }
      autoScrollDelta = 0;
    };

    const tickAutoScroll = () => {
      autoScrollRaf = null;
      if (autoScrollDelta === 0) return;
      const previous = scroller.scrollTop;
      scroller.scrollTop += autoScrollDelta;
      if (previous === scroller.scrollTop) return;
      setActiveDrag(computeState(lastX, lastY));
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

    const cleanup = () => {
      stopAutoScroll();
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
      if (!started) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
        started = true;
        suppressClickUntil.current = Date.now() + 300;
        document.body.classList.add('agency-sidebar-dragging');
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

      setActiveDrag(computeState(lastX, lastY));
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
  }, [inlineRenamingProjectId, inlineRenamingWorkspaceId, openMenu]);

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function captureDialogAnchorRect(): AnchorRect | null {
    const trigger = activeTriggerRef.current;
    if (!trigger) return null;
    const row = trigger.closest('.agency-project-row, .agency-workspace-nav-row') ?? trigger;
    const rect = row.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }

  function handleProjectDeleteClick(project: AgencyProject) {
    setDialogAnchorRect(captureDialogAnchorRect());
    setDeletingProject(project);
  }

  return (
    <>
      <nav ref={navRef} className="agency-sidebar-nav" aria-label={t('agency.ui.projectsAndWorkspaces')}>
        <div className="agency-sr-only" aria-live="polite" aria-atomic="true">
          {liveAnnouncement}
        </div>
        <header className="agency-nav-head">
          <div className="agency-nav-brand">
            <img src="/brand/maw-logo-128.png" alt="" className="agency-nav-logo" width="56" height="56" />
            <strong>{t('agency.ui.agency')}</strong>
          </div>
          <button className="agency-icon-button" type="button" onClick={onCollapse} aria-label={t('agency.ui.collapseSidebar')} aria-expanded={true}>
            <SidebarToggleIcon />
          </button>
        </header>
        <div ref={sideSectionRef} className="agency-side-section">
          <div className="agency-side-heading">
            <span>{t('agency.ui.projects')}</span>
            <button className="agency-icon-button agency-add-project-btn" type="button" onClick={onCreateProject} title={t('agency.ui.newProject')} aria-label={t('agency.ui.newProject')}>+</button>
          </div>
          {groups.length === 0 && <p className="agency-muted agency-empty-nav">{t('agency.ui.createAProjectToBegin')}</p>}
          {groups.map(({ project, items }, projectIndex) => {
            const isMenuOpen = openMenu?.type === 'project' && openMenu.id === project.id;
            const isProjectDrag = activeDrag?.kind === 'project';
            const isProjectDragging = isProjectDrag && activeDrag.id === project.id;
            const projectDisplacement = isProjectDrag
              ? siblingDisplacementPx(projectIndex, activeDrag.fromIndex, activeDrag.insertIndex, activeDrag.displacement)
              : 0;
            const projectInsert = isProjectDrag ? activeDrag.insertIndex : null;
            const isProjectTargetBefore = isProjectDrag && projectInsert !== null && (
              (projectInsert < activeDrag.fromIndex && projectIndex === projectInsert) ||
              (projectInsert > activeDrag.fromIndex && projectIndex === projectInsert + 1)
            );
            const isProjectTargetAfter = isProjectDrag && projectInsert !== null &&
              projectInsert === groups.length - 1 && projectIndex === groups.length - 1 && activeDrag.fromIndex !== projectIndex;
            const projectClassName = [
              'agency-project',
              isProjectDragging ? 'agency-is-dragging' : '',
              isProjectTargetBefore ? 'agency-drop-target-before' : '',
              isProjectTargetAfter ? 'agency-drop-target-after' : '',
            ].filter(Boolean).join(' ');
            const projectStyle: CSSProperties | undefined = isProjectDrag && !isProjectDragging && projectDisplacement !== 0
              ? { transform: `translateY(${projectDisplacement}px)` }
              : undefined;

            return (
              <section
                key={project.id}
                data-sidebar-project-id={project.id}
                className={projectClassName}
                style={projectStyle}
              >
                <div
                  className="agency-project-row"
                  onPointerDown={(e) => beginPointerDrag(e, {
                    kind: 'project',
                    id: project.id,
                    projectId: project.id,
                    label: project.name,
                    fromIndex: projectIndex,
                  })}
                >
                  <button
                    type="button"
                    className="agency-project-toggle"
                    aria-expanded={!collapsed.has(project.id)}
                    onClick={() => {
                      if (Date.now() < suppressClickUntil.current) return;
                      if (inlineRenamingProjectId === project.id) return;
                      toggle(project.id);
                    }}
                    onKeyDown={(e) => {
                      if (inlineRenamingProjectId === project.id) return;
                      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && onReorderProjects) {
                        e.preventDefault();
                        const currentIds = groups.map((g) => g.project.id);
                        const idx = currentIds.indexOf(project.id);
                        if (idx !== -1) {
                          const targetIdx = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
                          if (targetIdx >= 0 && targetIdx < currentIds.length) {
                            const nextIds = [...currentIds];
                            [nextIds[idx], nextIds[targetIdx]] = [nextIds[targetIdx]!, nextIds[idx]!];
                            onReorderProjects(nextIds);
                            setLiveAnnouncement(`Moved project ${project.name} to position ${targetIdx + 1} of ${nextIds.length}`);
                          }
                        }
                      }
                    }}
                    title={project.name}
                  >
                    <span aria-hidden="true" className={'agency-chevron' + (collapsed.has(project.id) ? '' : ' open')}>›</span>
                    {inlineRenamingProjectId === project.id ? (
                      <InlineRenameInput
                        initialValue={inlineRenameProjectValue}
                        onCommit={(clean) => {
                          if (clean !== project.name) {
                            onRenameProject(project, clean);
                          }
                          setInlineRenamingProjectId(null);
                        }}
                        onCancel={() => {
                          setInlineRenamingProjectId(null);
                        }}
                        ariaLabel={t('agency.ui.renameProject')}
                      />
                    ) : (
                      <span className="agency-project-name">{project.name}</span>
                    )}
                  </button>
                  <div className="agency-dropdown" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="agency-row-action"
                      title={t('agency.ui.projectActions')}
                      aria-label={t('agency.ui.projectActions')}
                      aria-haspopup="true"
                      aria-expanded={isMenuOpen}
                      onClick={(e) => handleTriggerClick('project', project.id, e)}
                      onMouseEnter={(e) => handleTriggerMouseEnter('project', project.id, e)}
                      onMouseLeave={handleTriggerMouseLeave}
                    >
                      ⋯
                    </button>
                  </div>
                </div>
                {!collapsed.has(project.id) && (
                  <div className="agency-project-children" data-sidebar-project-children={project.id}>
                    {items.map((workspace, workspaceIndex) => {
                      const collection = workspaceTabs(sessions, workspace.id);
                      const attention = collection.some(item => isAttention(item.activity));
                      const working = collection.some(item => item.activity === 'working');
                      const isWsMenuOpen = openMenu?.type === 'workspace' && openMenu.id === workspace.id;
                      const isWsDrag = activeDrag?.kind === 'workspace' && activeDrag.projectId === workspace.projectId;
                      const isWsDragging = isWsDrag && activeDrag.id === workspace.id;
                      const wsDisplacement = isWsDrag
                        ? siblingDisplacementPx(workspaceIndex, activeDrag.fromIndex, activeDrag.insertIndex, activeDrag.displacement)
                        : 0;
                      const wsInsert = isWsDrag ? activeDrag.insertIndex : null;
                      const isWsTargetBefore = isWsDrag && wsInsert !== null && (
                        (wsInsert < activeDrag.fromIndex && workspaceIndex === wsInsert) ||
                        (wsInsert > activeDrag.fromIndex && workspaceIndex === wsInsert + 1)
                      );
                      const isWsTargetAfter = isWsDrag && wsInsert !== null &&
                        wsInsert === items.length - 1 && workspaceIndex === items.length - 1 && activeDrag.fromIndex !== workspaceIndex;
                      const wsRowClassName = [
                        'agency-workspace-nav-row',
                        selected === workspace.id && !showingDone ? 'selected' : '',
                        isWsDragging ? 'agency-is-dragging' : '',
                        isWsTargetBefore ? 'agency-drop-target-before' : '',
                        isWsTargetAfter ? 'agency-drop-target-after' : '',
                      ].filter(Boolean).join(' ');
                      const wsStyle: CSSProperties | undefined = isWsDrag && !isWsDragging && wsDisplacement !== 0
                        ? { transform: `translateY(${wsDisplacement}px)` }
                        : undefined;
                      const statusTone = attention ? 'attention' : working ? 'working' : collection.some(item => item.lifecycle === 'running') ? 'idle' : 'muted';

                      return (
                        <div
                          className={wsRowClassName}
                          style={wsStyle}
                          data-sidebar-workspace-id={workspace.id}
                          key={workspace.id}
                          onPointerDown={(e) => beginPointerDrag(e, {
                            kind: 'workspace',
                            id: workspace.id,
                            projectId: workspace.projectId,
                            label: workspace.name,
                            fromIndex: workspaceIndex,
                          })}
                        >
                          <button
                            className="agency-workspace-nav-button"
                            type="button"
                            onClick={() => {
                              if (Date.now() < suppressClickUntil.current) return;
                              if (inlineRenamingWorkspaceId === workspace.id) return;
                              onSelect(workspace.id);
                            }}
                            onKeyDown={(e) => {
                              if (inlineRenamingWorkspaceId === workspace.id) return;
                              if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && onReorderWorkspaces) {
                                e.preventDefault();
                                const currentWsIds = items.map((w) => w.id);
                                const idx = currentWsIds.indexOf(workspace.id);
                                if (idx !== -1) {
                                  const targetIdx = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
                                  if (targetIdx >= 0 && targetIdx < currentWsIds.length) {
                                    const nextIds = [...currentWsIds];
                                    [nextIds[idx], nextIds[targetIdx]] = [nextIds[targetIdx]!, nextIds[idx]!];
                                    onReorderWorkspaces(workspace.projectId, nextIds);
                                    setLiveAnnouncement(`Moved workspace ${workspace.name} to position ${targetIdx + 1} of ${nextIds.length}`);
                                  }
                                }
                              }
                            }}
                            aria-current={selected === workspace.id && !showingDone ? 'page' : undefined}
                            title={workspace.cwd}
                          >
                            <StatusDot
                              tone={statusTone}
                              title={collection.map(item => agencySessionText(item)).join(', ')}
                              ariaLabel={t('agency.tabs.sessionCount', { count: collection.length })}
                            />
                            {inlineRenamingWorkspaceId === workspace.id ? (
                              <InlineRenameInput
                                initialValue={inlineRenameWorkspaceValue}
                                onCommit={(clean) => {
                                  if (clean !== workspace.name && onRenameWorkspace) {
                                    onRenameWorkspace(workspace, clean);
                                  }
                                  setInlineRenamingWorkspaceId(null);
                                }}
                                onCancel={() => {
                                  setInlineRenamingWorkspaceId(null);
                                }}
                                ariaLabel={t('agency.ui.renameWorkspace')}
                              />
                            ) : (
                              <span className="agency-truncate">{workspace.name}</span>
                            )}
                          </button>
                          <div className="agency-dropdown" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="agency-row-action"
                              title={t('agency.ui.workspaceActions')}
                              aria-label={t('agency.ui.workspaceActions')}
                              aria-haspopup="true"
                              aria-expanded={isWsMenuOpen}
                              onClick={(e) => handleTriggerClick('workspace', workspace.id, e)}
                              onMouseEnter={(e) => handleTriggerMouseEnter('workspace', workspace.id, e)}
                              onMouseLeave={handleTriggerMouseLeave}
                            >
                              ⋯
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {items.length === 0 && <span className="agency-project-empty">{t('agency.ui.noActiveWorkspaces')}</span>}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </nav>

      {activeDrag && typeof document !== 'undefined' && document.body && createPortal(
        <div
          className={`agency-sidebar-drag-ghost ${activeDrag.valid ? '' : 'is-invalid'}`.trim()}
          aria-hidden="true"
          style={{
            position: 'fixed',
            left: `${activeDrag.rowLeft}px`,
            top: `${activeDrag.ghostTop}px`,
            width: `${activeDrag.rowWidth}px`,
            height: `${activeDrag.rowHeight}px`,
            pointerEvents: 'none',
            zIndex: 1200,
          }}
        >
          <span>{activeDrag.label}</span>
        </div>,
        document.body,
      )}

      {openMenu && activeTriggerRef.current && (
        openMenu.type === 'project' ? (() => {
          const project = projects.find((p) => p.id === openMenu.id);
          if (!project) return null;
          return (
            <SidebarDropdownMenu
              anchor={activeTriggerRef.current}
              menuRef={setMenuRef}
              onMouseEnter={handleMenuMouseEnter}
              onMouseLeave={handleMenuMouseLeave}
              onKeyDown={handleMenuKeyDown}
            >
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item"
                onClick={() => {
                  closeMenu();
                  onCreate(project.id);
                }}
              >
                {t('agency.ui.addWorkspace')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item"
                onClick={() => {
                  closeMenu();
                  setInlineRenamingProjectId(project.id);
                  setInlineRenameProjectValue(project.name);
                }}
              >
                {t('agency.ui.renameProject')}
              </button>
              {onUpdateProjectProfile && (
                <div className="agency-dropdown-profile-row" onClick={(e) => e.stopPropagation()}>
                  <label className="agency-dropdown-profile-label">
                    <span>{t('settings.browser.profiles')}</span>
                    <select
                      className="agency-dropdown-profile-select"
                      aria-label={t('settings.browser.profiles')}
                      value={project.browserProfileId ?? DEFAULT_BROWSER_PROFILE_ID}
                      onChange={(e) => {
                        const val = e.target.value;
                        onUpdateProjectProfile(project, val === DEFAULT_BROWSER_PROFILE_ID ? null : val);
                      }}
                    >
                      {(browserProfiles.length > 0
                        ? browserProfiles
                        : [{ id: DEFAULT_BROWSER_PROFILE_ID, name: t('settings.browser.mainProfile') }]
                      ).map((prof) => (
                        <option key={prof.id} value={prof.id}>
                          {prof.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item"
                onClick={() => {
                  setDialogAnchorRect(captureDialogAnchorRect());
                  closeMenu();
                  setArchivingProject(project);
                }}
              >
                {t('agency.ui.archiveProject')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item agency-text-danger"
                onClick={() => {
                  handleProjectDeleteClick(project);
                  closeMenu();
                }}
              >
                {t('agency.ui.deleteProject')}
              </button>
            </SidebarDropdownMenu>
          );
        })() : (() => {
          const workspace = workspaces.find((w) => w.id === openMenu.id);
          if (!workspace) return null;
          return (
            <SidebarDropdownMenu
              anchor={activeTriggerRef.current}
              menuRef={setMenuRef}
              onMouseEnter={handleMenuMouseEnter}
              onMouseLeave={handleMenuMouseLeave}
              onKeyDown={handleMenuKeyDown}
            >
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item"
                onClick={() => {
                  closeMenu();
                  setInlineRenamingWorkspaceId(workspace.id);
                  setInlineRenameWorkspaceValue(workspace.name);
                }}
              >
                {t('agency.ui.renameWorkspace')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item"
                title={t('agency.ui.markNamedDone', { name: workspace.name })}
                onClick={() => {
                  closeMenu();
                  onDone(workspace);
                }}
              >
                {t('agency.ui.markDone')}
              </button>
              {onUpdateWorkspaceProfile && (
                <div className="agency-dropdown-profile-row" onClick={(e) => e.stopPropagation()}>
                  <label className="agency-dropdown-profile-label">
                    <span>{t('settings.browser.profiles')}</span>
                    <select
                      className="agency-dropdown-profile-select"
                      aria-label={t('settings.browser.profiles')}
                      value={workspace.browserProfileId ?? ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        onUpdateWorkspaceProfile(workspace, val || null);
                      }}
                    >
                      <option value="">
                        {t('settings.browser.inheritProfile', {
                          name: (() => {
                            const parent = projects.find((p) => p.id === workspace.projectId);
                            const parentProfileId = parent?.browserProfileId ?? DEFAULT_BROWSER_PROFILE_ID;
                            return browserProfiles.find((bp) => bp.id === parentProfileId)?.name ?? t('settings.browser.mainProfile');
                          })(),
                        })}
                      </option>
                      {(browserProfiles.length > 0
                        ? browserProfiles
                        : [{ id: DEFAULT_BROWSER_PROFILE_ID, name: t('settings.browser.mainProfile') }]
                      ).map((prof) => (
                        <option key={prof.id} value={prof.id}>
                          {prof.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item"
                onClick={() => {
                  setDialogAnchorRect(captureDialogAnchorRect());
                  closeMenu();
                  setArchivingWorkspace(workspace);
                }}
              >
                {t('agency.ui.archiveWorkspace')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item agency-text-danger"
                onClick={() => {
                  setDialogAnchorRect(captureDialogAnchorRect());
                  closeMenu();
                  setDeletingWorkspace(workspace);
                }}
              >
                {t('agency.ui.deleteWorkspace')}
              </button>
            </SidebarDropdownMenu>
          );
        })()
      )}

      <SidebarConfirmDialogs
        archivingProject={archivingProject}
        deletingProject={deletingProject}
        archivingWorkspace={archivingWorkspace}
        deletingWorkspace={deletingWorkspace}
        anchorRect={dialogAnchorRect}
        workspaces={workspaces}
        sessions={sessions}
        webTabs={webTabs}
        editorTabs={editorTabs}
        onCloseArchiveProject={() => { setArchivingProject(null); setDialogAnchorRect(null); }}
        onConfirmArchiveProject={onArchiveProject}
        onCloseDeleteProject={() => { setDeletingProject(null); setDialogAnchorRect(null); }}
        onConfirmDeleteProject={onDeleteProject}
        onCloseArchiveWorkspace={() => { setArchivingWorkspace(null); setDialogAnchorRect(null); }}
        onConfirmArchiveWorkspace={onArchiveWorkspace}
        onCloseDeleteWorkspace={() => { setDeletingWorkspace(null); setDialogAnchorRect(null); }}
        onConfirmDeleteWorkspace={onDeleteWorkspace}
      />
    </>
  );
}

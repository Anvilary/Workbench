import { t } from '../../i18n/index.js';
import { siblingDisplacementPx, useSidebarDrag } from './useSidebarDrag.js';
import { agencySessionText } from '../workspaces/workspace-labels.js';
import { useState, useRef, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_BROWSER_PROFILE_ID } from '@agent-workbench/shared';
import type {
  AgencyProject, AgencyRuntimeSession, AgencyWorkspace, BrowserProfile, EditorTab, ProjectId, WorkspaceId, WebTab,
} from '@agent-workbench/shared';
import { activeByProject, isAttention, workspaceTabs } from '../workspaces/workspace-model.js';
import { InlineRenameInput } from '../../shared/ui/InlineRenameInput.js';
import { StatusDot } from '../../shared/ui/StatusDot.js';
import type { AnchorRect } from '../../shared/ui/ModalDialog.js';
import { handleMenuArrowNavigation } from '../../shared/hooks/useMenuKeyboardNav.js';
import { calculateSidebarDropdownPosition } from '../../shared/lib/overlay-position.js';
import { WorkspaceDoneView } from '../workspaces/WorkspaceDoneView.js';
import { DeleteWorkspaceDialog } from './DeleteWorkspaceDialog.js';
import { SidebarConfirmDialogs } from './SidebarConfirmDialogs.js';
import { SidebarDropdownMenu } from './SidebarDropdownMenu.js';

export { WorkspaceDoneView, DeleteWorkspaceDialog, calculateSidebarDropdownPosition };

export function AgencyBrand({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div className={expanded ? 'agency-nav-brand' : 'agency-topbar-collapsed-brand'}>
      <button
        type="button"
        className="agency-brand-toggle"
        onClick={onToggle}
        aria-label={expanded ? t('agency.ui.collapseSidebar') : t('agency.ui.expandSidebar')}
        aria-expanded={expanded}
        title={expanded ? t('agency.ui.collapseSidebar') : t('agency.ui.expandSidebar')}
      >
        <img
          src="/brand/workbench-logo-128.png"
          alt=""
          className={expanded ? 'agency-nav-logo' : 'agency-topbar-logo'}
          width="38"
          height="38"
        />
      </button>
      <strong>{t('agency.ui.agency')}</strong>
    </div>
  );
}

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


export function WorkbenchSidebar({
  projects, workspaces, sessions, webTabs = [], editorTabs = [], browserProfiles = [], selected, showingDone = false,
  onSelect, onCreate, onCreateProject, onDone, onArchiveWorkspace, onDeleteWorkspace,
  onRenameProject, onRenameWorkspace, onUpdateProjectProfile, onUpdateWorkspaceProfile,
  onArchiveProject, onDeleteProject, onCollapse, onReorderProjects, onReorderWorkspaces,
}: AgencySidebarProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<{ type: 'project' | 'workspace'; id: string; trigger: 'click' | 'hover' } | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const sideSectionRef = useRef<HTMLDivElement | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);

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
  const { activeDrag, liveAnnouncement, setLiveAnnouncement, suppressClickUntil, beginPointerDrag } = useSidebarDrag({
    groups, onReorderProjects, onReorderWorkspaces, navRef, sideSectionRef, dragGhostRef,
    isDragBlocked: (params) =>
      openMenu !== null ||
      (params.kind === 'project' && inlineRenamingProjectId === params.id) ||
      (params.kind === 'workspace' && inlineRenamingWorkspaceId === params.id),
  });

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
          <AgencyBrand expanded={true} onToggle={onCollapse} />
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
          ref={dragGhostRef}
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
                      value={
                        project.browserProfileId &&
                        (browserProfiles.length === 0 || browserProfiles.some((bp) => bp.id === project.browserProfileId))
                          ? project.browserProfileId
                          : DEFAULT_BROWSER_PROFILE_ID
                      }
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
                      value={
                        workspace.browserProfileId &&
                        (browserProfiles.length === 0 || browserProfiles.some((bp) => bp.id === workspace.browserProfileId))
                          ? workspace.browserProfileId
                          : ''
                      }
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

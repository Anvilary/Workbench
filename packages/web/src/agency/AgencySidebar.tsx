import { t } from '../i18n/index.js';
import { agencySessionText } from './agency-labels.js';
import { useState, useRef, useCallback } from 'react';
import type {
  AgencyProject, AgencyRuntimeSession, AgencyWorkspace, ProjectId, WorkspaceId, WebTab,
} from '@agent-workbench/shared';
import { activeByProject, isAttention, workspaceTabs } from './model.js';
import { InlineRenameInput } from '../shared/ui/InlineRenameInput.js';
import { StatusDot } from '../shared/ui/StatusDot.js';
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
  onArchiveProject: (project: AgencyProject) => void;
  onDeleteProject: (project: AgencyProject) => void;
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

export function AgencySidebar({
  projects, workspaces, sessions, webTabs = [], selected, showingDone = false,
  onSelect, onCreate, onCreateProject, onDone, onArchiveWorkspace, onDeleteWorkspace,
  onRenameProject, onRenameWorkspace, onArchiveProject, onDeleteProject, onCollapse,
  onReorderProjects, onReorderWorkspaces,
}: AgencySidebarProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<{ type: 'project' | 'workspace'; id: string; trigger: 'click' | 'hover' } | null>(null);
  const [draggedProjectId, setDraggedProjectId] = useState<ProjectId | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<{ id: ProjectId; position: 'before' | 'after' } | null>(null);
  const [draggedWorkspace, setDraggedWorkspace] = useState<{ id: WorkspaceId; projectId: ProjectId } | null>(null);
  const [workspaceDropTarget, setWorkspaceDropTarget] = useState<{ id: WorkspaceId; position: 'before' | 'after' } | null>(null);
  const suppressClickUntil = useRef<number>(0);

  const [inlineRenamingProjectId, setInlineRenamingProjectId] = useState<ProjectId | null>(null);
  const [inlineRenameProjectValue, setInlineRenameProjectValue] = useState<string>('');
  const [inlineRenamingWorkspaceId, setInlineRenamingWorkspaceId] = useState<WorkspaceId | null>(null);
  const [inlineRenameWorkspaceValue, setInlineRenameWorkspaceValue] = useState<string>('');

  const [archivingProject, setArchivingProject] = useState<AgencyProject | null>(null);
  const [deletingProject, setDeletingProject] = useState<AgencyProject | null>(null);
  const [projectDeleteBlocked, setProjectDeleteBlocked] = useState<AgencyProject | null>(null);
  const [archivingWorkspace, setArchivingWorkspace] = useState<AgencyWorkspace | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<AgencyWorkspace | null>(null);

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

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleProjectDeleteClick(project: AgencyProject) {
    const projectWorkspaces = workspaces.filter((w) => w.projectId === project.id);
    if (projectWorkspaces.length > 0) {
      setProjectDeleteBlocked(project);
    } else {
      setDeletingProject(project);
    }
  }

  return (
    <>
      <nav className="agency-sidebar-nav" aria-label={t('agency.ui.projectsAndWorkspaces')}>
        <header className="agency-nav-head">
          <div className="agency-nav-brand">
            <img src="/brand/maw-logo-128.png" alt="" className="agency-nav-logo" width="56" height="56" />
            <strong>{t('agency.ui.agency')}</strong>
          </div>
          <button className="agency-icon-button" type="button" onClick={onCollapse} aria-label={t('agency.ui.collapseSidebar')} aria-expanded={true}>
            <SidebarToggleIcon />
          </button>
        </header>
        <div className="agency-side-section">
          <div className="agency-side-heading">
            <span>{t('agency.ui.projects')}</span>
            <button className="agency-icon-button" type="button" onClick={onCreateProject} title={t('agency.ui.newProject')} aria-label={t('agency.ui.newProject')}>+</button>
          </div>
          {groups.length === 0 && <p className="agency-muted agency-empty-nav">{t('agency.ui.createAProjectToBegin')}</p>}
          {groups.map(({ project, items }) => {
            const isMenuOpen = openMenu?.type === 'project' && openMenu.id === project.id;
            const isProjectDragging = draggedProjectId === project.id;
            const isProjectTargetBefore = projectDropTarget?.id === project.id && projectDropTarget.position === 'before';
            const isProjectTargetAfter = projectDropTarget?.id === project.id && projectDropTarget.position === 'after';
            const projectClassName = [
              'agency-project',
              isProjectDragging ? 'agency-is-dragging' : '',
              isProjectTargetBefore ? 'agency-drop-target-before' : '',
              isProjectTargetAfter ? 'agency-drop-target-after' : '',
            ].filter(Boolean).join(' ');

            return (
              <section
                key={project.id}
                className={projectClassName}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/maw-project-id') && draggedProjectId) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                    if (projectDropTarget?.id !== project.id || projectDropTarget?.position !== pos) {
                      setProjectDropTarget({ id: project.id, position: pos });
                    }
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    if (projectDropTarget?.id === project.id) {
                      setProjectDropTarget(null);
                    }
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const sourceId = (e.dataTransfer.getData('application/maw-project-id') || draggedProjectId) as ProjectId;
                  if (sourceId && onReorderProjects) {
                    suppressClickUntil.current = Date.now() + 300;
                    const currentIds = groups.map((g) => g.project.id);
                    const fromIdx = currentIds.indexOf(sourceId);
                    const toIdx = currentIds.indexOf(project.id);
                    if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
                      const nextIds = [...currentIds];
                      nextIds.splice(fromIdx, 1);
                      const insertIdx = projectDropTarget?.position === 'after'
                        ? (toIdx > fromIdx ? toIdx : toIdx + 1)
                        : (toIdx > fromIdx ? toIdx - 1 : toIdx);
                      nextIds.splice(Math.max(0, Math.min(nextIds.length, insertIdx)), 0, sourceId);
                      onReorderProjects(nextIds);
                    }
                  }
                  setDraggedProjectId(null);
                  setProjectDropTarget(null);
                }}
              >
                <div
                  className="agency-project-row"
                  draggable={!openMenu && inlineRenamingProjectId !== project.id}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/maw-project-id', project.id);
                    e.dataTransfer.effectAllowed = 'move';
                    setDraggedProjectId(project.id);
                  }}
                  onDragEnd={() => {
                    suppressClickUntil.current = Date.now() + 300;
                    setDraggedProjectId(null);
                    setProjectDropTarget(null);
                  }}
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
                  <div className="agency-project-children">
                    {items.map((workspace) => {
                      const collection = workspaceTabs(sessions, workspace.id);
                      const attention = collection.some(item => isAttention(item.activity));
                      const working = collection.some(item => item.activity === 'working');
                      const isWsMenuOpen = openMenu?.type === 'workspace' && openMenu.id === workspace.id;
                      const isWsDragging = draggedWorkspace?.id === workspace.id;
                      const isWsTargetBefore = workspaceDropTarget?.id === workspace.id && workspaceDropTarget.position === 'before';
                      const isWsTargetAfter = workspaceDropTarget?.id === workspace.id && workspaceDropTarget.position === 'after';
                      const wsRowClassName = [
                        'agency-workspace-nav-row',
                        selected === workspace.id && !showingDone ? 'selected' : '',
                        isWsDragging ? 'agency-is-dragging' : '',
                        isWsTargetBefore ? 'agency-drop-target-before' : '',
                        isWsTargetAfter ? 'agency-drop-target-after' : '',
                      ].filter(Boolean).join(' ');
                      const statusTone = attention ? 'attention' : working ? 'working' : collection.some(item => item.lifecycle === 'running') ? 'idle' : 'muted';

                      return (
                        <div
                          className={wsRowClassName}
                          key={workspace.id}
                          draggable={!openMenu && inlineRenamingWorkspaceId !== workspace.id}
                          onDragStart={(e) => {
                            e.stopPropagation();
                            e.dataTransfer.setData('application/maw-workspace-id', workspace.id);
                            e.dataTransfer.setData('application/maw-workspace-project-id', workspace.projectId);
                            e.dataTransfer.effectAllowed = 'move';
                            setDraggedWorkspace({ id: workspace.id, projectId: workspace.projectId });
                          }}
                          onDragOver={(e) => {
                            e.stopPropagation();
                            if (e.dataTransfer.types.includes('application/maw-workspace-id') && draggedWorkspace) {
                              if (draggedWorkspace.projectId !== workspace.projectId) {
                                e.dataTransfer.dropEffect = 'none';
                                return;
                              }
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                              const rect = e.currentTarget.getBoundingClientRect();
                              const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                              if (workspaceDropTarget?.id !== workspace.id || workspaceDropTarget?.position !== pos) {
                                setWorkspaceDropTarget({ id: workspace.id, position: pos });
                              }
                            }
                          }}
                          onDragLeave={(e) => {
                            e.stopPropagation();
                            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                              if (workspaceDropTarget?.id === workspace.id) {
                                setWorkspaceDropTarget(null);
                              }
                            }
                          }}
                          onDrop={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            const sourceId = (e.dataTransfer.getData('application/maw-workspace-id') || draggedWorkspace?.id) as WorkspaceId;
                            const sourceProjectId = (e.dataTransfer.getData('application/maw-workspace-project-id') || draggedWorkspace?.projectId) as ProjectId;
                            if (sourceId && sourceProjectId === workspace.projectId && onReorderWorkspaces) {
                              suppressClickUntil.current = Date.now() + 300;
                              const currentWsIds = items.map((w) => w.id);
                              const fromIdx = currentWsIds.indexOf(sourceId);
                              const toIdx = currentWsIds.indexOf(workspace.id);
                              if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
                                const nextIds = [...currentWsIds];
                                nextIds.splice(fromIdx, 1);
                                const insertIdx = workspaceDropTarget?.position === 'after'
                                  ? (toIdx > fromIdx ? toIdx : toIdx + 1)
                                  : (toIdx > fromIdx ? toIdx - 1 : toIdx);
                                nextIds.splice(Math.max(0, Math.min(nextIds.length, insertIdx)), 0, sourceId);
                                onReorderWorkspaces(workspace.projectId, nextIds);
                              }
                            }
                            setDraggedWorkspace(null);
                            setWorkspaceDropTarget(null);
                          }}
                          onDragEnd={(e) => {
                            e.stopPropagation();
                            suppressClickUntil.current = Date.now() + 300;
                            setDraggedWorkspace(null);
                            setWorkspaceDropTarget(null);
                          }}
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
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item"
                onClick={() => {
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
                  closeMenu();
                  handleProjectDeleteClick(project);
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
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item"
                onClick={() => {
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
        projectDeleteBlocked={projectDeleteBlocked}
        archivingWorkspace={archivingWorkspace}
        deletingWorkspace={deletingWorkspace}
        sessions={sessions}
        webTabs={webTabs}
        onCloseArchiveProject={() => setArchivingProject(null)}
        onConfirmArchiveProject={onArchiveProject}
        onCloseProjectDeleteBlocked={() => setProjectDeleteBlocked(null)}
        onCloseDeleteProject={() => setDeletingProject(null)}
        onConfirmDeleteProject={onDeleteProject}
        onCloseArchiveWorkspace={() => setArchivingWorkspace(null)}
        onConfirmArchiveWorkspace={onArchiveWorkspace}
        onCloseDeleteWorkspace={() => setDeletingWorkspace(null)}
        onConfirmDeleteWorkspace={onDeleteWorkspace}
      />
    </>
  );
}

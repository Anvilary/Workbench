import { t } from '../i18n/index.js';
import { agencySessionText } from './agency-labels.js';
import { useState, useRef, useEffect, useCallback } from 'react';
import type {
  AgencyProject, AgencyRuntimeSession, AgencyWorkspace, ProjectId, WorkspaceId, WebTab,
} from '@agent-workbench/shared';
import { activeByProject, isAttention, workspaceTabs } from './model.js';

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

  // Inline renaming state
  const [inlineRenamingProjectId, setInlineRenamingProjectId] = useState<ProjectId | null>(null);
  const [inlineRenameProjectValue, setInlineRenameProjectValue] = useState<string>('');
  const [inlineRenamingWorkspaceId, setInlineRenamingWorkspaceId] = useState<WorkspaceId | null>(null);
  const [inlineRenameWorkspaceValue, setInlineRenameWorkspaceValue] = useState<string>('');

  // Modals state
  const [archivingProject, setArchivingProject] = useState<AgencyProject | null>(null);
  const [deletingProject, setDeletingProject] = useState<AgencyProject | null>(null);
  const [projectDeleteBlocked, setProjectDeleteBlocked] = useState<AgencyProject | null>(null);
  const [archivingWorkspace, setArchivingWorkspace] = useState<AgencyWorkspace | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<AgencyWorkspace | null>(null);

  // Context menu lifecycle refs & handlers
  const graceTimerRef = useRef<number | null>(null);
  const activeTriggerRef = useRef<HTMLElement | null>(null);
  const activeMenuRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!openMenu) return;

    function handlePointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (
        activeMenuRef.current?.contains(target) ||
        activeTriggerRef.current?.contains(target)
      ) {
        return;
      }
      closeMenu();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        const trigger = activeTriggerRef.current;
        closeMenu();
        trigger?.focus();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      clearGraceTimer();
    };
  }, [openMenu, closeMenu, clearGraceTimer]);

  useEffect(() => {
    if (!openMenu || !activeMenuRef.current || !activeTriggerRef.current) return;
    const menuEl = activeMenuRef.current;
    const triggerRect = activeTriggerRef.current.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();

    if (triggerRect.bottom + menuRect.height > window.innerHeight - 8) {
      menuEl.style.top = 'auto';
      menuEl.style.bottom = '100%';
      menuEl.style.marginTop = '0';
      menuEl.style.marginBottom = '4px';
    } else {
      menuEl.style.top = '100%';
      menuEl.style.bottom = 'auto';
      menuEl.style.marginTop = '4px';
      menuEl.style.marginBottom = '0';
    }

    if (menuRect.left < 8) {
      menuEl.style.left = '0';
      menuEl.style.right = 'auto';
    }
  }, [openMenu]);

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
    const items = activeMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    if (!items || items.length === 0) return;
    const itemsArray = Array.from(items);
    const currentIndex = itemsArray.indexOf(document.activeElement as HTMLButtonElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = currentIndex === -1 || currentIndex === itemsArray.length - 1 ? 0 : currentIndex + 1;
      itemsArray[nextIndex]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = currentIndex <= 0 ? itemsArray.length - 1 : currentIndex - 1;
      itemsArray[prevIndex]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      itemsArray[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      itemsArray[itemsArray.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      closeMenu();
    }
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
            <img src="/brand/maw-logo-64.png" alt="MAW" className="agency-nav-logo" width="34" height="34" />
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
                      <input
                        type="text"
                        className="agency-inline-rename-input"
                        value={inlineRenameProjectValue}
                        autoFocus
                        maxLength={120}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setInlineRenameProjectValue(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const clean = inlineRenameProjectValue.trim();
                            if (clean && clean !== project.name) {
                              onRenameProject(project, clean);
                            }
                            setInlineRenamingProjectId(null);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setInlineRenamingProjectId(null);
                          }
                        }}
                        onBlur={() => {
                          const clean = inlineRenameProjectValue.trim();
                          if (clean && clean !== project.name) {
                            onRenameProject(project, clean);
                          }
                          setInlineRenamingProjectId(null);
                        }}
                        ref={(input) => {
                          if (input) {
                            input.select();
                          }
                        }}
                        aria-label={t('agency.ui.renameProject')}
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
                    {isMenuOpen && (
                      <div
                        className="agency-dropdown-menu"
                        role="menu"
                        ref={(el) => {
                          if (el) {
                            activeMenuRef.current = el;
                          }
                        }}
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
                      </div>
                    )}
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
                            <span className={'agency-status-dot ' + (attention ? 'attention' : working ? 'working' : collection.some(item => item.lifecycle === 'running') ? 'idle' : 'muted')} title={collection.map(item => agencySessionText(item)).join(', ')} aria-label={t('agency.tabs.sessionCount', { count: collection.length })} />
                            {inlineRenamingWorkspaceId === workspace.id ? (
                              <input
                                type="text"
                                className="agency-inline-rename-input"
                                value={inlineRenameWorkspaceValue}
                                autoFocus
                                maxLength={120}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => setInlineRenameWorkspaceValue(e.target.value)}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const clean = inlineRenameWorkspaceValue.trim();
                                    if (clean && clean !== workspace.name && onRenameWorkspace) {
                                      onRenameWorkspace(workspace, clean);
                                    }
                                    setInlineRenamingWorkspaceId(null);
                                  } else if (e.key === 'Escape') {
                                    e.preventDefault();
                                    setInlineRenamingWorkspaceId(null);
                                  }
                                }}
                                onBlur={() => {
                                  const clean = inlineRenameWorkspaceValue.trim();
                                  if (clean && clean !== workspace.name && onRenameWorkspace) {
                                    onRenameWorkspace(workspace, clean);
                                  }
                                  setInlineRenamingWorkspaceId(null);
                                }}
                                ref={(input) => {
                                  if (input) {
                                    input.select();
                                  }
                                }}
                                aria-label={t('agency.ui.renameWorkspace')}
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
                            {isWsMenuOpen && (
                              <div
                                className="agency-dropdown-menu"
                                role="menu"
                                ref={(el) => {
                                  if (el) {
                                    activeMenuRef.current = el;
                                  }
                                }}
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
                              </div>
                            )}
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

      {/* Archive Project Confirmation */}
      {archivingProject && (
        <div className="agency-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setArchivingProject(null); }}>
          <div className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-archive-proj-title">
            <div className="agency-dialog-head">
              <h2 id="agency-archive-proj-title">{t('agency.ui.confirmArchiveProject', { name: archivingProject.name })}</h2>
              <button type="button" className="agency-icon-button" onClick={() => setArchivingProject(null)}>×</button>
            </div>
            <p className="agency-muted">{t('agency.ui.archiveProjectWarning')}</p>
            <div className="agency-dialog-actions">
              <button type="button" className="agency-secondary-button" onClick={() => setArchivingProject(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="agency-primary-button"
                onClick={() => {
                  onArchiveProject(archivingProject);
                  setArchivingProject(null);
                }}
              >
                {t('agency.ui.archiveProject')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Project Blocked Dialog */}
      {projectDeleteBlocked && (
        <div className="agency-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setProjectDeleteBlocked(null); }}>
          <div className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-del-proj-blocked">
            <div className="agency-dialog-head">
              <h2 id="agency-del-proj-blocked">{t('agency.ui.deleteProject')}</h2>
              <button type="button" className="agency-icon-button" onClick={() => setProjectDeleteBlocked(null)}>×</button>
            </div>
            <p className="agency-error">{t('agency.ui.cannotDeleteProjectNonEmpty')}</p>
            <div className="agency-dialog-actions">
              <button type="button" className="agency-primary-button" onClick={() => setProjectDeleteBlocked(null)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Project Confirmation */}
      {deletingProject && (
        <div className="agency-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setDeletingProject(null); }}>
          <div className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-del-proj-title">
            <div className="agency-dialog-head">
              <h2 id="agency-del-proj-title">{t('agency.ui.confirmDeleteProject', { name: deletingProject.name })}</h2>
              <button type="button" className="agency-icon-button" onClick={() => setDeletingProject(null)}>×</button>
            </div>
            <p className="agency-muted">{t('agency.ui.deleteProjectWarning')}</p>
            <div className="agency-dialog-actions">
              <button type="button" className="agency-secondary-button" onClick={() => setDeletingProject(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="agency-primary-button agency-text-danger"
                onClick={() => {
                  onDeleteProject(deletingProject);
                  setDeletingProject(null);
                }}
              >
                {t('agency.ui.deleteProject')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Archive Workspace Confirmation */}
      {archivingWorkspace && (() => {
        const hasRunning = sessions.some(
          (s) => s.workspaceId === archivingWorkspace.id && (s.lifecycle === 'running' || s.lifecycle === 'starting')
        );
        return (
          <div className="agency-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setArchivingWorkspace(null); }}>
            <div className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-arch-ws-title">
              <div className="agency-dialog-head">
                <h2 id="agency-arch-ws-title">{t('agency.ui.confirmArchiveWorkspace', { name: archivingWorkspace.name })}</h2>
                <button type="button" className="agency-icon-button" onClick={() => setArchivingWorkspace(null)}>×</button>
              </div>
              <p className="agency-muted">{t('agency.ui.archiveWorkspaceWarning')}</p>
              {hasRunning && <p className="agency-error" role="alert">{t('agency.ui.activeProcessesWarning')}</p>}
              <div className="agency-dialog-actions">
                <button type="button" className="agency-secondary-button" onClick={() => setArchivingWorkspace(null)}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="agency-primary-button"
                  onClick={() => {
                    onArchiveWorkspace(archivingWorkspace);
                    setArchivingWorkspace(null);
                  }}
                >
                  {t('agency.ui.archiveWorkspace')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delete Workspace Confirmation */}
      {deletingWorkspace && (
        <DeleteWorkspaceDialog
          workspace={deletingWorkspace}
          sessions={sessions}
          webTabs={webTabs}
          onConfirm={onDeleteWorkspace}
          onClose={() => setDeletingWorkspace(null)}
        />
      )}
    </>
  );
}

export function DeleteWorkspaceDialog({
  workspace,
  sessions,
  webTabs = [],
  onConfirm,
  onClose,
}: {
  workspace: AgencyWorkspace;
  sessions: readonly AgencyRuntimeSession[];
  webTabs?: readonly WebTab[];
  onConfirm: (workspace: AgencyWorkspace) => Promise<void> | void;
  onClose: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsSessions = sessions.filter((s) => s.workspaceId === workspace.id);
  const runningClis = wsSessions.filter(
    (s) => s.kind === 'agent' && (s.lifecycle === 'running' || s.lifecycle === 'starting')
  ).length;
  const runningTerminals = wsSessions.filter(
    (s) => s.kind === 'terminal' && (s.lifecycle === 'running' || s.lifecycle === 'starting')
  ).length;
  const stoppingSessions = wsSessions.filter((s) => s.lifecycle === 'stopping').length;
  const chatGptTabs = webTabs.filter((t) => t.workspaceId === workspace.id && !t.closedAt).length;
  const exitedTabs = wsSessions.filter(
    (s) => s.lifecycle === 'exited' && s.tab?.current && !s.tab.closedAt
  ).length;

  const totalActive = runningClis + runningTerminals + stoppingSessions + chatGptTabs;
  const totalResources = totalActive + exitedTabs;

  async function handleDelete() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(workspace);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="agency-modal-backdrop"
      onMouseDown={(e) => {
        if (!busy && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-del-ws-title">
        <div className="agency-dialog-head">
          <h2 id="agency-del-ws-title">{t('agency.ui.confirmDeleteWorkspace', { name: workspace.name })}</h2>
          <button type="button" className="agency-icon-button" disabled={busy} onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </div>
        <p className="agency-muted">{t('agency.ui.deleteWorkspaceWarning')}</p>

        <div className="agency-resource-summary" style={{ margin: '12px 0', padding: '10px 14px', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px', fontSize: '13px' }}>
          {totalResources === 0 ? (
            <p className="agency-muted" style={{ margin: 0 }}>{t('agency.ui.deleteNoActiveResources')}</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {runningClis > 0 && <li>{t('agency.ui.deleteResourcesActiveClis', { count: runningClis })}</li>}
              {runningTerminals > 0 && <li>{t('agency.ui.deleteResourcesActiveTerminals', { count: runningTerminals })}</li>}
              {stoppingSessions > 0 && <li>{t('agency.ui.deleteResourcesUnresolvedSessions', { count: stoppingSessions })}</li>}
              {chatGptTabs > 0 && <li>{t('agency.ui.deleteResourcesChatGptTabs', { count: chatGptTabs })}</li>}
              {exitedTabs > 0 && <li>{t('agency.ui.deleteResourcesExitedTabs', { count: exitedTabs })}</li>}
            </ul>
          )}
        </div>

        {totalActive > 0 && (
          <p className="agency-error" role="alert" style={{ margin: '8px 0' }}>
            {t('agency.ui.deleteInterruptionWarning')}
          </p>
        )}

        {error && (
          <p className="agency-error" role="alert" style={{ margin: '8px 0' }}>
            {error}
          </p>
        )}

        <div className="agency-dialog-actions">
          <button type="button" className="agency-secondary-button" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="agency-primary-button agency-text-danger"
            disabled={busy}
            onClick={() => void handleDelete()}
          >
            {busy ? t('agency.ui.deletingWorkspace') : t('agency.ui.deleteWorkspace')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgencyDoneView({
  workspaces,
  projects,
  sessions = [],
  webTabs = [],
  onRestore,
  onArchiveWorkspace,
  onDeleteWorkspace,
}: {
  workspaces: readonly AgencyWorkspace[];
  projects: readonly AgencyProject[];
  sessions?: readonly AgencyRuntimeSession[];
  webTabs?: readonly WebTab[];
  onRestore: (workspace: AgencyWorkspace) => void;
  onArchiveWorkspace?: (workspace: AgencyWorkspace) => void;
  onDeleteWorkspace?: (workspace: AgencyWorkspace) => Promise<void> | void;
}): JSX.Element {
  const [tab, setTab] = useState<'done' | 'archived'>('done');
  const [confirmDelete, setConfirmDelete] = useState<AgencyWorkspace | null>(null);

  const doneList = workspaces
    .filter((ws) => ws.status === 'done')
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  const archivedList = workspaces
    .filter((ws) => ws.status === 'archived')
    .sort((a, b) => (b.archivedAt ?? b.updatedAt ?? '').localeCompare(a.archivedAt ?? a.updatedAt ?? ''));

  const items = tab === 'done' ? doneList : archivedList;

  return (
    <section className="agency-done-view" aria-labelledby="agency-done-title">
      <h1 id="agency-done-title">{tab === 'done' ? t('agency.ui.doneWorkspaces') : t('agency.ui.archivedWorkspaces')}</h1>
      <p className="agency-muted">{t('agency.ui.archivedFromActiveNavigationSessionsFilesAndHistory')}</p>

      <div className="agency-done-tabs" style={{ display: 'flex', gap: '8px', margin: '16px 0 24px' }}>
        <button
          type="button"
          className={'agency-secondary-button' + (tab === 'done' ? ' agency-text-button selected' : '')}
          onClick={() => setTab('done')}
        >
          {t('agency.ui.done')} ({doneList.length})
        </button>
        <button
          type="button"
          className={'agency-secondary-button' + (tab === 'archived' ? ' agency-text-button selected' : '')}
          onClick={() => setTab('archived')}
        >
          {t('agency.ui.archived')} ({archivedList.length})
        </button>
      </div>

      {items.length === 0 && <div className="agency-empty-state">{t('agency.ui.noCompletedWorkspacesYet')}</div>}
      {items.map((ws) => (
        <article key={ws.id} className="agency-done-row">
          <div>
            <strong>{ws.name}</strong>
            <p>{projects.find((p) => p.id === ws.projectId)?.name ?? t('agency.ui.project')} · {ws.cwd}</p>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button type="button" className="agency-secondary-button" onClick={() => onRestore(ws)}>
              {t('agency.ui.restore')}
            </button>
            {tab === 'done' && onArchiveWorkspace && (
              <button type="button" className="agency-secondary-button" onClick={() => onArchiveWorkspace(ws)}>
                {t('agency.ui.archiveWorkspace')}
              </button>
            )}
            {onDeleteWorkspace && (
              <button
                type="button"
                className="agency-secondary-button agency-text-danger"
                onClick={() => setConfirmDelete(ws)}
              >
                {t('agency.ui.deleteWorkspace')}
              </button>
            )}
          </div>
        </article>
      ))}

      {confirmDelete && onDeleteWorkspace && (
        <DeleteWorkspaceDialog
          workspace={confirmDelete}
          sessions={sessions}
          webTabs={webTabs}
          onConfirm={onDeleteWorkspace}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </section>
  );
}

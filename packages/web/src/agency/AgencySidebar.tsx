import { t } from '../i18n/index.js';
import { agencySessionText } from './agency-labels.js';
import { useState } from 'react';
import type {
  AgencyProject, AgencyRuntimeSession, AgencyWorkspace, ProjectId, WorkspaceId,
} from '@agent-workbench/shared';
import { activeByProject, isAttention, workspaceTabs } from './model.js';

export interface AgencySidebarProps {
  projects: readonly AgencyProject[];
  workspaces: readonly AgencyWorkspace[];
  sessions: readonly AgencyRuntimeSession[];
  selected: WorkspaceId | null;
  showingDone?: boolean;
  onSelect: (id: WorkspaceId) => void;
  onDoneView?: () => void;
  onCreate: (project?: ProjectId) => void;
  onCreateProject: () => void;
  onCollapse: () => void;
  onDone: (workspace: AgencyWorkspace) => void;
  onArchiveWorkspace: (workspace: AgencyWorkspace) => void;
  onDeleteWorkspace: (workspace: AgencyWorkspace) => void;
  onRenameProject: (project: AgencyProject, newName: string) => void;
  onArchiveProject: (project: AgencyProject) => void;
  onDeleteProject: (project: AgencyProject) => void;
  onRestore: (workspace: AgencyWorkspace) => void;
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
  projects, workspaces, sessions, selected, showingDone = false,
  onSelect, onCreate, onCreateProject, onDone, onArchiveWorkspace, onDeleteWorkspace,
  onRenameProject, onArchiveProject, onDeleteProject, onCollapse,
}: AgencySidebarProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [openMenu, setOpenMenu] = useState<{ type: 'project' | 'workspace'; id: string } | null>(null);

  // Modals state
  const [renamingProject, setRenamingProject] = useState<AgencyProject | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [archivingProject, setArchivingProject] = useState<AgencyProject | null>(null);
  const [deletingProject, setDeletingProject] = useState<AgencyProject | null>(null);
  const [projectDeleteBlocked, setProjectDeleteBlocked] = useState<AgencyProject | null>(null);
  const [archivingWorkspace, setArchivingWorkspace] = useState<AgencyWorkspace | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<AgencyWorkspace | null>(null);

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
            <svg className="agency-nav-diamond" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2.5 21.5 12 12 21.5 2.5 12Z" />
            </svg>
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
            return (
              <section key={project.id} className="agency-project">
                <div className="agency-project-row">
                  <button type="button" className="agency-project-toggle" aria-expanded={!collapsed.has(project.id)}
                    onClick={() => toggle(project.id)} title={project.name}>
                    <span aria-hidden="true" className={'agency-chevron' + (collapsed.has(project.id) ? '' : ' open')}>›</span>
                    <span className="agency-project-name">{project.name}</span>
                    <span className="agency-count">{items.length}</span>
                  </button>
                  <button type="button" className="agency-icon-button agency-project-add" title={t('agency.ui.newWorkspaceIn', { name: project.name })}
                    aria-label={t('agency.ui.newWorkspaceIn', { name: project.name })} onClick={() => onCreate(project.id)}>+</button>
                  <div className="agency-dropdown" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="agency-icon-button agency-project-add"
                      title={t('agency.ui.projectActions')}
                      aria-label={t('agency.ui.projectActions')}
                      aria-haspopup="true"
                      aria-expanded={isMenuOpen}
                      onClick={() => setOpenMenu(isMenuOpen ? null : { type: 'project', id: project.id })}
                    >
                      ⋯
                    </button>
                    {isMenuOpen && (
                      <div className="agency-dropdown-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          className="agency-dropdown-item"
                          onClick={() => {
                            setOpenMenu(null);
                            setRenameValue(project.name);
                            setRenamingProject(project);
                          }}
                        >
                          {t('agency.ui.renameProject')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="agency-dropdown-item"
                          onClick={() => {
                            setOpenMenu(null);
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
                            setOpenMenu(null);
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
                      return (
                        <div className={'agency-workspace-nav-row' + (selected === workspace.id && !showingDone ? ' selected' : '')}
                          key={workspace.id}>
                          <button className="agency-workspace-nav-button" type="button" onClick={() => onSelect(workspace.id)}
                            aria-current={selected === workspace.id && !showingDone ? 'page' : undefined}
                            title={workspace.cwd}>
                            <span className={'agency-status-dot ' + (attention ? 'attention' : working ? 'working' : collection.some(item => item.lifecycle === 'running') ? 'idle' : 'muted')} title={collection.map(item => agencySessionText(item)).join(', ')} aria-label={t('agency.tabs.sessionCount', { count: collection.length })} />
                            <span className="agency-truncate">{workspace.name}</span>
                          </button>
                          <div className="agency-dropdown" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="agency-row-action"
                              title={t('agency.ui.workspaceActions')}
                              aria-label={t('agency.ui.workspaceActions')}
                              aria-haspopup="true"
                              aria-expanded={isWsMenuOpen}
                              onClick={() => setOpenMenu(isWsMenuOpen ? null : { type: 'workspace', id: workspace.id })}
                            >
                              ⋯
                            </button>
                            {isWsMenuOpen && (
                              <div className="agency-dropdown-menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="agency-dropdown-item"
                                  title={t('agency.ui.markNamedDone', { name: workspace.name })}
                                  onClick={() => {
                                    setOpenMenu(null);
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
                                    setOpenMenu(null);
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
                                    setOpenMenu(null);
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

      {/* Rename Project Modal */}
      {renamingProject && (
        <div className="agency-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setRenamingProject(null); }}>
          <div className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-rename-project-title">
            <div className="agency-dialog-head">
              <h2 id="agency-rename-project-title">{t('agency.ui.editProjectName')}</h2>
              <button type="button" className="agency-icon-button" onClick={() => setRenamingProject(null)}>×</button>
            </div>
            <label className="agency-field">
              <span>{t('agency.ui.name')}</span>
              <input
                autoFocus
                value={renameValue}
                maxLength={120}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && renameValue.trim()) {
                    onRenameProject(renamingProject, renameValue.trim());
                    setRenamingProject(null);
                  }
                  if (e.key === 'Escape') setRenamingProject(null);
                }}
              />
            </label>
            <div className="agency-dialog-actions">
              <button type="button" className="agency-secondary-button" onClick={() => setRenamingProject(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="agency-primary-button"
                disabled={!renameValue.trim()}
                onClick={() => {
                  onRenameProject(renamingProject, renameValue.trim());
                  setRenamingProject(null);
                }}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

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
      {deletingWorkspace && (() => {
        const hasRunning = sessions.some(
          (s) => s.workspaceId === deletingWorkspace.id && (s.lifecycle === 'running' || s.lifecycle === 'starting')
        );
        return (
          <div className="agency-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setDeletingWorkspace(null); }}>
            <div className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-del-ws-title">
              <div className="agency-dialog-head">
                <h2 id="agency-del-ws-title">{t('agency.ui.confirmDeleteWorkspace', { name: deletingWorkspace.name })}</h2>
                <button type="button" className="agency-icon-button" onClick={() => setDeletingWorkspace(null)}>×</button>
              </div>
              <p className="agency-muted">{t('agency.ui.deleteWorkspaceWarning')}</p>
              {hasRunning && <p className="agency-error" role="alert">{t('agency.ui.activeProcessesWarning')}</p>}
              <div className="agency-dialog-actions">
                <button type="button" className="agency-secondary-button" onClick={() => setDeletingWorkspace(null)}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="agency-primary-button agency-text-danger"
                  onClick={() => {
                    onDeleteWorkspace(deletingWorkspace);
                    setDeletingWorkspace(null);
                  }}
                >
                  {t('agency.ui.deleteWorkspace')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}

export function AgencyDoneView({
  workspaces,
  projects,
  onRestore,
  onArchiveWorkspace,
  onDeleteWorkspace,
}: {
  workspaces: readonly AgencyWorkspace[];
  projects: readonly AgencyProject[];
  onRestore: (workspace: AgencyWorkspace) => void;
  onArchiveWorkspace?: (workspace: AgencyWorkspace) => void;
  onDeleteWorkspace?: (workspace: AgencyWorkspace) => void;
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

      {confirmDelete && (
        <div className="agency-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmDelete(null); }}>
          <div className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-confirm-del-done">
            <div className="agency-dialog-head">
              <h2 id="agency-confirm-del-done">{t('agency.ui.confirmDeleteWorkspace', { name: confirmDelete.name })}</h2>
              <button type="button" className="agency-icon-button" onClick={() => setConfirmDelete(null)}>×</button>
            </div>
            <p className="agency-muted">{t('agency.ui.deleteWorkspaceWarning')}</p>
            <div className="agency-dialog-actions">
              <button type="button" className="agency-secondary-button" onClick={() => setConfirmDelete(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="agency-primary-button agency-text-danger"
                onClick={() => {
                  onDeleteWorkspace?.(confirmDelete);
                  setConfirmDelete(null);
                }}
              >
                {t('agency.ui.deleteWorkspace')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

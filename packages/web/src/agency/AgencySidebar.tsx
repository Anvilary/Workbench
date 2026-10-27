import { t } from '../i18n/index.js';
import { useState } from 'react';
import type {
  AgencyProject, AgencyRuntimeSession, AgencyWorkspace, ProjectId, WorkspaceId,
} from '@agent-workbench/shared';
import { activeByProject, activityLabel, currentSession, isAttention, latestSession } from './model.js';

export interface AgencySidebarProps {
  projects: readonly AgencyProject[];
  workspaces: readonly AgencyWorkspace[];
  sessions: readonly AgencyRuntimeSession[];
  selected: WorkspaceId | null;
  showingDone: boolean;
  onSelect: (id: WorkspaceId) => void;
  onDoneView: () => void;
  onCreate: (project?: ProjectId) => void;
  onCreateProject: () => void;
  onDone: (workspace: AgencyWorkspace) => void;
  onRestore: (workspace: AgencyWorkspace) => void;
}

function WorkspaceIndicator({ session }: { session: AgencyRuntimeSession | undefined }) {
  if (!session) return <span className="agency-status-dot muted" title={t('agency.ui.noSession')} />;
  const label = activityLabel(session.activity, session.lifecycle);
  const tone = isAttention(session.activity) ? 'attention' :
    session.lifecycle === 'running' && session.activity === 'working' ? 'working' :
    session.lifecycle === 'exited' || session.lifecycle === 'failed' ? 'muted' : 'idle';
  return <span className={'agency-status-dot ' + tone} title={label} aria-label={label} />;
}

export function AgencySidebar({
  projects, workspaces, sessions, selected, showingDone,
  onSelect, onDoneView, onCreate, onCreateProject, onDone, onRestore,
}: AgencySidebarProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const done = workspaces.filter((ws) => ws.status === 'done')
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  const groups = activeByProject(projects, workspaces);

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <nav className="agency-sidebar-nav" aria-label={t('agency.ui.projectsAndWorkspaces')}>
      <header className="agency-nav-head">
        <span className="agency-brand-mark" aria-hidden="true">◇</span>
        <strong>{t('agency.ui.agency')}</strong>
        <span className="agency-brand-caption">{t('agency.ui.workspace')}</span>
        <button className="agency-icon-button" type="button" onClick={onCreateProject} title={t('agency.ui.newProject')} aria-label={t('agency.ui.newProject')}>+</button>
      </header>
      <div className="agency-side-section">
        <div className="agency-side-heading">
          <span>{t('agency.ui.projects')}</span>
          <button className="agency-icon-button" type="button" onClick={() => onCreate()} title={t('agency.ui.newWorkspace')} aria-label={t('agency.ui.newWorkspace')}>+</button>
        </div>
        {groups.length === 0 && <p className="agency-muted agency-empty-nav">{t('agency.ui.createAProjectToBegin')}</p>}
        {groups.map(({ project, items }) => (
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
            </div>
            {!collapsed.has(project.id) && (
              <div className="agency-project-children">
                {items.map((workspace) => {
                  const session = currentSession(sessions, workspace.id, 'agent') ??
                    currentSession(sessions, workspace.id, 'terminal') ??
                    latestSession(sessions, workspace.id, 'agent') ??
                    latestSession(sessions, workspace.id, 'terminal');
                  return (
                    <div className={'agency-workspace-nav-row' + (selected === workspace.id && !showingDone ? ' selected' : '')}
                      key={workspace.id}>
                      <button className="agency-workspace-nav-button" type="button" onClick={() => onSelect(workspace.id)}
                        aria-current={selected === workspace.id && !showingDone ? 'page' : undefined}
                        title={workspace.cwd}>
                        <WorkspaceIndicator session={session} />
                        <span className="agency-truncate">{workspace.name}</span>
                      </button>
                      <button type="button" className="agency-row-action" title={t('agency.ui.markNamedDone', { name: workspace.name })}
                        aria-label={t('agency.ui.markNamedDone', { name: workspace.name })} onClick={() => onDone(workspace)}>✓</button>
                    </div>
                  );
                })}
                {items.length === 0 && <span className="agency-project-empty">{t('agency.ui.noActiveWorkspaces')}</span>}
              </div>
            )}
          </section>
        ))}
      </div>
      <div className="agency-nav-bottom">
        <button className={'agency-history-toggle' + (showingDone ? ' selected' : '')} type="button"
          onClick={() => { setHistoryOpen(!historyOpen); onDoneView(); }} aria-expanded={historyOpen}>
          <span aria-hidden="true">▤</span>{t('agency.ui.done')}<span className="agency-count">{done.length}</span>
        </button>
        {historyOpen && (
          <div className="agency-history-mini">
            {done.length === 0 && <p className="agency-muted">{t('agency.ui.nothingCompletedYet')}</p>}
            {done.slice(0, 8).map((ws) => (
              <div className="agency-workspace-nav-row" key={ws.id}>
                <button type="button" className="agency-workspace-nav-button" onClick={onDoneView}>
                  <span className="agency-status-dot muted" />
                  <span className="agency-truncate">{ws.name}</span>
                </button>
                <button type="button" className="agency-row-action" aria-label={t('agency.ui.restoreNamed', { name: ws.name })}
                  title={t('agency.ui.restoreNamed', { name: ws.name })} onClick={() => onRestore(ws)}>↺</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

export function AgencyDoneView({ workspaces, projects, onRestore }: {
  workspaces: readonly AgencyWorkspace[];
  projects: readonly AgencyProject[];
  onRestore: (workspace: AgencyWorkspace) => void;
}): JSX.Element {
  const done = workspaces.filter((ws) => ws.status === 'done')
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  return (
    <section className="agency-done-view" aria-labelledby="agency-done-title">
      <h1 id="agency-done-title">{t('agency.ui.doneWorkspaces')}</h1>
      <p className="agency-muted">{t('agency.ui.archivedFromActiveNavigationSessionsFilesAndHistory')}</p>
      {done.length === 0 && <div className="agency-empty-state">{t('agency.ui.noCompletedWorkspacesYet')}</div>}
      {done.map((ws) => (
        <article key={ws.id} className="agency-done-row">
          <div>
            <strong>{ws.name}</strong>
            <p>{projects.find((p) => p.id === ws.projectId)?.name ?? t('agency.ui.project')} · {ws.cwd}</p>
          </div>
          <button type="button" className="agency-secondary-button" onClick={() => onRestore(ws)}>{t('agency.ui.restore')}</button>
        </article>
      ))}
    </section>
  );
}

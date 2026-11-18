import { useState } from 'react';
import type { AgencyProject, AgencyRuntimeSession, AgencyWorkspace, EditorTab, WebTab } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import { DeleteWorkspaceDialog } from './DeleteWorkspaceDialog.js';

export interface AgencyDoneViewProps {
  workspaces: readonly AgencyWorkspace[];
  projects: readonly AgencyProject[];
  sessions?: readonly AgencyRuntimeSession[];
  webTabs?: readonly WebTab[];
  editorTabs?: readonly EditorTab[];
  onRestore: (workspace: AgencyWorkspace) => void;
  onArchiveWorkspace?: (workspace: AgencyWorkspace) => void;
  onDeleteWorkspace?: (workspace: AgencyWorkspace) => Promise<void> | void;
}

export function AgencyDoneView({
  workspaces,
  projects,
  sessions = [],
  webTabs = [],
  editorTabs = [],
  onRestore,
  onArchiveWorkspace,
  onDeleteWorkspace,
}: AgencyDoneViewProps): JSX.Element {
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
      <h1 id="agency-done-title">
        {tab === 'done' ? t('agency.ui.doneWorkspaces') : t('agency.ui.archivedWorkspaces')}
      </h1>
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

      {items.length === 0 && (
        <div className="agency-empty-state">{t('agency.ui.noCompletedWorkspacesYet')}</div>
      )}
      {items.map((ws) => (
        <article key={ws.id} className="agency-done-row">
          <div>
            <strong>{ws.name}</strong>
            <p>
              {projects.find((p) => p.id === ws.projectId)?.name ?? t('agency.ui.project')} · {ws.cwd}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button type="button" className="agency-secondary-button" onClick={() => onRestore(ws)}>
              {t('agency.ui.restore')}
            </button>
            {tab === 'done' && onArchiveWorkspace && (
              <button
                type="button"
                className="agency-secondary-button"
                onClick={() => onArchiveWorkspace(ws)}
              >
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
          editorTabs={editorTabs}
          onConfirm={onDeleteWorkspace}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </section>
  );
}

import { useState } from 'react';
import type {
  AgencyProject,
  AgencyRuntimeSession,
  AgencyWorkspace,
  EditorTab,
  WebTab,
} from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import { ModalDialog, type AnchorRect } from '../../shared/ui/ModalDialog.js';
import { editorDraftStore } from '../../agency/editorDraftStore.js';

export interface DeleteProjectDialogProps {
  project: AgencyProject;
  workspaces: readonly AgencyWorkspace[];
  sessions: readonly AgencyRuntimeSession[];
  webTabs?: readonly WebTab[];
  editorTabs?: readonly EditorTab[];
  anchorRect?: AnchorRect | null;
  onConfirm: (project: AgencyProject, cascade: boolean) => Promise<void> | void;
  onClose: () => void;
}

export function DeleteProjectDialog({
  project,
  workspaces,
  sessions,
  webTabs = [],
  editorTabs = [],
  anchorRect = null,
  onConfirm,
  onClose,
}: DeleteProjectDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectWorkspaces = workspaces.filter((w) => w.projectId === project.id);
  const wsIds = new Set(projectWorkspaces.map((w) => w.id));
  const activeCount = projectWorkspaces.filter((w) => w.status === 'active').length;
  const doneCount = projectWorkspaces.filter((w) => w.status === 'done').length;
  const archivedCount = projectWorkspaces.filter((w) => w.status === 'archived').length;

  const projectSessions = sessions.filter((s) => wsIds.has(s.workspaceId));
  const runningClis = projectSessions.filter(
    (s) => s.kind === 'agent' && (s.lifecycle === 'running' || s.lifecycle === 'starting'),
  ).length;
  const runningTerminals = projectSessions.filter(
    (s) => s.kind === 'terminal' && (s.lifecycle === 'running' || s.lifecycle === 'starting'),
  ).length;
  const stoppingSessions = projectSessions.filter((s) => s.lifecycle === 'stopping').length;
  const browserTabs = webTabs.filter((tab) => wsIds.has(tab.workspaceId) && !tab.closedAt).length;
  const openEditors = editorTabs.filter((tab) => wsIds.has(tab.workspaceId) && !tab.closedAt);
  const dirtyIds = new Set(editorDraftStore.listDirtyTabIds());
  const dirtyEditors = openEditors.filter((tab) => dirtyIds.has(tab.id)).length;

  const cascade = projectWorkspaces.length > 0;
  const activeResources =
    runningClis + runningTerminals + stoppingSessions + browserTabs + openEditors.length;

  async function handleDelete() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(project, cascade);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      title={t('agency.ui.confirmDeleteProject', { name: project.name })}
      titleId="agency-del-proj-title"
      anchorRect={anchorRect}
      onClose={onClose}
      closeLabel={t('common.close')}
      closeDisabled={busy}
      actions={
        <>
          <button type="button" className="agency-secondary-button" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="agency-primary-button agency-text-danger"
            disabled={busy}
            onClick={() => void handleDelete()}
          >
            {busy ? t('agency.ui.deletingWorkspace') : t('agency.ui.deleteProject')}
          </button>
        </>
      }
    >
      <p className="agency-muted">
        {cascade
          ? t('agency.ui.deleteProjectCascadeWarning')
          : t('agency.ui.deleteProjectWarning')}
      </p>

      {cascade && (
        <div
          className="agency-resource-summary"
          style={{
            margin: '12px 0',
            padding: '10px 14px',
            background: 'rgba(255, 255, 255, 0.04)',
            borderRadius: '6px',
            fontSize: '13px',
          }}
        >
          <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <li>
              {t('agency.ui.deleteProjectWorkspacesCount', { count: projectWorkspaces.length })}
              {` (${[
                activeCount > 0 ? t('agency.ui.deleteProjectStatusActive', { count: activeCount }) : null,
                doneCount > 0 ? t('agency.ui.deleteProjectStatusDone', { count: doneCount }) : null,
                archivedCount > 0 ? t('agency.ui.deleteProjectStatusArchived', { count: archivedCount }) : null,
              ]
                .filter(Boolean)
                .join(', ')})`}
            </li>
            {runningClis > 0 && <li>{t('agency.ui.deleteResourcesActiveClis', { count: runningClis })}</li>}
            {runningTerminals > 0 && <li>{t('agency.ui.deleteResourcesActiveTerminals', { count: runningTerminals })}</li>}
            {stoppingSessions > 0 && <li>{t('agency.ui.deleteResourcesUnresolvedSessions', { count: stoppingSessions })}</li>}
            {browserTabs > 0 && <li>{t('agency.ui.deleteResourcesBrowserTabs', { count: browserTabs })}</li>}
            {openEditors.length > 0 && (
              <li>
                {t('agency.ui.deleteResourcesEditorTabs', { count: openEditors.length })}
                {dirtyEditors > 0 ? ` (${t('agency.ui.deleteResourcesUnsavedCount', { count: dirtyEditors })})` : ''}
              </li>
            )}
          </ul>
        </div>
      )}

      {activeResources > 0 && (
        <p className="agency-error" role="alert" style={{ margin: '8px 0' }}>
          {t('agency.ui.deleteInterruptionWarning')}
        </p>
      )}

      {error && (
        <p className="agency-error" role="alert" style={{ margin: '8px 0' }}>
          {error}
        </p>
      )}
    </ModalDialog>
  );
}

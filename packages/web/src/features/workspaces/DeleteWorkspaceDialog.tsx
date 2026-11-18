import { useState } from 'react';
import type { AgencyRuntimeSession, AgencyWorkspace, EditorTab, WebTab } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import { ModalDialog, type AnchorRect } from '../../shared/ui/ModalDialog.js';
import { editorDraftStore } from '../../agency/editorDraftStore.js';

export interface DeleteWorkspaceDialogProps {
  workspace: AgencyWorkspace;
  sessions: readonly AgencyRuntimeSession[];
  webTabs?: readonly WebTab[];
  editorTabs?: readonly EditorTab[];
  anchorRect?: AnchorRect | null;
  onConfirm: (workspace: AgencyWorkspace) => Promise<void> | void;
  onClose: () => void;
}

export function DeleteWorkspaceDialog({
  workspace,
  sessions,
  webTabs = [],
  editorTabs = [],
  anchorRect = null,
  onConfirm,
  onClose,
}: DeleteWorkspaceDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsSessions = sessions.filter((s) => s.workspaceId === workspace.id);
  const runningClis = wsSessions.filter(
    (s) => s.kind === 'agent' && (s.lifecycle === 'running' || s.lifecycle === 'starting'),
  ).length;
  const runningTerminals = wsSessions.filter(
    (s) => s.kind === 'terminal' && (s.lifecycle === 'running' || s.lifecycle === 'starting'),
  ).length;
  const stoppingSessions = wsSessions.filter((s) => s.lifecycle === 'stopping').length;
  const browserTabs = webTabs.filter((tab) => tab.workspaceId === workspace.id && !tab.closedAt).length;
  const openEditorTabs = editorTabs.filter((tab) => tab.workspaceId === workspace.id && !tab.closedAt);
  const dirtyIds = new Set(editorDraftStore.listDirtyTabIds());
  const dirtyEditorTabs = openEditorTabs.filter((tab) => dirtyIds.has(tab.id)).length;
  const exitedTabs = wsSessions.filter(
    (s) => s.lifecycle === 'exited' && s.tab?.current && !s.tab.closedAt,
  ).length;

  const totalActive = runningClis + runningTerminals + stoppingSessions + browserTabs + openEditorTabs.length;
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
    <ModalDialog
      title={t('agency.ui.confirmDeleteWorkspace', { name: workspace.name })}
      titleId="agency-del-ws-title"
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
            {busy ? t('agency.ui.deletingWorkspace') : t('agency.ui.deleteWorkspace')}
          </button>
        </>
      }
    >
      <p className="agency-muted">{t('agency.ui.deleteWorkspaceWarning')}</p>

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
        {totalResources === 0 ? (
          <p className="agency-muted" style={{ margin: 0 }}>
            {t('agency.ui.deleteNoActiveResources')}
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {runningClis > 0 && <li>{t('agency.ui.deleteResourcesActiveClis', { count: runningClis })}</li>}
            {runningTerminals > 0 && <li>{t('agency.ui.deleteResourcesActiveTerminals', { count: runningTerminals })}</li>}
            {stoppingSessions > 0 && <li>{t('agency.ui.deleteResourcesUnresolvedSessions', { count: stoppingSessions })}</li>}
            {browserTabs > 0 && <li>{t('agency.ui.deleteResourcesBrowserTabs', { count: browserTabs })}</li>}
            {openEditorTabs.length > 0 && (
              <li>
                {t('agency.ui.deleteResourcesEditorTabs', { count: openEditorTabs.length })}
                {dirtyEditorTabs > 0 ? ` (${t('agency.ui.deleteResourcesUnsavedCount', { count: dirtyEditorTabs })})` : ''}
              </li>
            )}
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
    </ModalDialog>
  );
}

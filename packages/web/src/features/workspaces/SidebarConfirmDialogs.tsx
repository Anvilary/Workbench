import type { AgencyProject, AgencyRuntimeSession, AgencyWorkspace, EditorTab, WebTab } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog.js';
import type { AnchorRect } from '../../shared/ui/ModalDialog.js';
import { DeleteWorkspaceDialog } from './DeleteWorkspaceDialog.js';
import { DeleteProjectDialog } from './DeleteProjectDialog.js';

export interface SidebarConfirmDialogsProps {
  archivingProject: AgencyProject | null;
  deletingProject: AgencyProject | null;
  archivingWorkspace: AgencyWorkspace | null;
  deletingWorkspace: AgencyWorkspace | null;
  anchorRect?: AnchorRect | null;
  workspaces: readonly AgencyWorkspace[];
  sessions: readonly AgencyRuntimeSession[];
  webTabs: readonly WebTab[];
  editorTabs?: readonly EditorTab[];
  onCloseArchiveProject: () => void;
  onConfirmArchiveProject: (project: AgencyProject) => void;
  onCloseDeleteProject: () => void;
  onConfirmDeleteProject: (project: AgencyProject, cascade: boolean) => Promise<void> | void;
  onCloseArchiveWorkspace: () => void;
  onConfirmArchiveWorkspace: (workspace: AgencyWorkspace) => void;
  onCloseDeleteWorkspace: () => void;
  onConfirmDeleteWorkspace: (workspace: AgencyWorkspace) => Promise<void> | void;
}

export function SidebarConfirmDialogs({
  archivingProject,
  deletingProject,
  archivingWorkspace,
  deletingWorkspace,
  anchorRect = null,
  workspaces,
  sessions,
  webTabs,
  editorTabs = [],
  onCloseArchiveProject,
  onConfirmArchiveProject,
  onCloseDeleteProject,
  onConfirmDeleteProject,
  onCloseArchiveWorkspace,
  onConfirmArchiveWorkspace,
  onCloseDeleteWorkspace,
  onConfirmDeleteWorkspace,
}: SidebarConfirmDialogsProps): JSX.Element {
  const archiveWorkspaceHasRunning = archivingWorkspace
    ? sessions.some(
        (s) =>
          s.workspaceId === archivingWorkspace.id &&
          (s.lifecycle === 'running' || s.lifecycle === 'starting'),
      )
    : false;

  return (
    <>
      {archivingProject && (
        <ConfirmDialog
          title={t('agency.ui.confirmArchiveProject', { name: archivingProject.name })}
          titleId="agency-archive-proj-title"
          message={t('agency.ui.archiveProjectWarning')}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('agency.ui.archiveProject')}
          anchorRect={anchorRect}
          onClose={onCloseArchiveProject}
          onConfirm={() => {
            onConfirmArchiveProject(archivingProject);
            onCloseArchiveProject();
          }}
        />
      )}

      {deletingProject && (
        <DeleteProjectDialog
          project={deletingProject}
          workspaces={workspaces}
          sessions={sessions}
          webTabs={webTabs}
          editorTabs={editorTabs}
          anchorRect={anchorRect}
          onClose={onCloseDeleteProject}
          onConfirm={onConfirmDeleteProject}
        />
      )}

      {archivingWorkspace && (
        <ConfirmDialog
          title={t('agency.ui.confirmArchiveWorkspace', { name: archivingWorkspace.name })}
          titleId="agency-arch-ws-title"
          message={t('agency.ui.archiveWorkspaceWarning')}
          warning={archiveWorkspaceHasRunning ? t('agency.ui.activeProcessesWarning') : undefined}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('agency.ui.archiveWorkspace')}
          anchorRect={anchorRect}
          onClose={onCloseArchiveWorkspace}
          onConfirm={() => {
            onConfirmArchiveWorkspace(archivingWorkspace);
            onCloseArchiveWorkspace();
          }}
        />
      )}

      {deletingWorkspace && (
        <DeleteWorkspaceDialog
          workspace={deletingWorkspace}
          sessions={sessions}
          webTabs={webTabs}
          editorTabs={editorTabs}
          anchorRect={anchorRect}
          onConfirm={onConfirmDeleteWorkspace}
          onClose={onCloseDeleteWorkspace}
        />
      )}
    </>
  );
}

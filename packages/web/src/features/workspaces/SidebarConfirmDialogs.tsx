import type { AgencyProject, AgencyRuntimeSession, AgencyWorkspace, WebTab } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog.js';
import { DeleteWorkspaceDialog } from './DeleteWorkspaceDialog.js';

export interface SidebarConfirmDialogsProps {
  archivingProject: AgencyProject | null;
  deletingProject: AgencyProject | null;
  projectDeleteBlocked: AgencyProject | null;
  archivingWorkspace: AgencyWorkspace | null;
  deletingWorkspace: AgencyWorkspace | null;
  sessions: readonly AgencyRuntimeSession[];
  webTabs: readonly WebTab[];
  onCloseArchiveProject: () => void;
  onConfirmArchiveProject: (project: AgencyProject) => void;
  onCloseProjectDeleteBlocked: () => void;
  onCloseDeleteProject: () => void;
  onConfirmDeleteProject: (project: AgencyProject) => void;
  onCloseArchiveWorkspace: () => void;
  onConfirmArchiveWorkspace: (workspace: AgencyWorkspace) => void;
  onCloseDeleteWorkspace: () => void;
  onConfirmDeleteWorkspace: (workspace: AgencyWorkspace) => Promise<void> | void;
}

export function SidebarConfirmDialogs({
  archivingProject,
  deletingProject,
  projectDeleteBlocked,
  archivingWorkspace,
  deletingWorkspace,
  sessions,
  webTabs,
  onCloseArchiveProject,
  onConfirmArchiveProject,
  onCloseProjectDeleteBlocked,
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
          onClose={onCloseArchiveProject}
          onConfirm={() => {
            onConfirmArchiveProject(archivingProject);
            onCloseArchiveProject();
          }}
        />
      )}

      {projectDeleteBlocked && (
        <ConfirmDialog
          title={t('agency.ui.deleteProject')}
          titleId="agency-del-proj-blocked"
          confirmOnly
          confirmLabel={t('common.close')}
          onClose={onCloseProjectDeleteBlocked}
          onConfirm={onCloseProjectDeleteBlocked}
        >
          <p className="agency-error">{t('agency.ui.cannotDeleteProjectNonEmpty')}</p>
        </ConfirmDialog>
      )}

      {deletingProject && (
        <ConfirmDialog
          title={t('agency.ui.confirmDeleteProject', { name: deletingProject.name })}
          titleId="agency-del-proj-title"
          message={t('agency.ui.deleteProjectWarning')}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('agency.ui.deleteProject')}
          danger
          onClose={onCloseDeleteProject}
          onConfirm={() => {
            onConfirmDeleteProject(deletingProject);
            onCloseDeleteProject();
          }}
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
          onConfirm={onConfirmDeleteWorkspace}
          onClose={onCloseDeleteWorkspace}
        />
      )}
    </>
  );
}

import { useState, useMemo, type JSX } from 'react';
import type { AgencyProject, AgencyWorkspace, ProjectId, WorkspaceId } from '@anvilary/workbench-shared';
import { ModalDialog } from '../../shared/ui/ModalDialog.js';
import { t } from '../../i18n/index.js';

export interface ArchivedItemsDialogProps {
  projects: readonly AgencyProject[];
  workspaces: readonly AgencyWorkspace[];
  onUnarchiveProject: (projectId: ProjectId) => Promise<unknown> | unknown;
  onRestoreWorkspace: (workspaceId: WorkspaceId) => Promise<unknown> | unknown;
  onClose: () => void;
  online?: boolean;
}

function formatArchiveDate(isoString?: string | null): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

export function ArchivedItemsDialog({
  projects,
  workspaces,
  onUnarchiveProject,
  onRestoreWorkspace,
  onClose,
  online = true,
}: ArchivedItemsDialogProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<'projects' | 'workspaces'>('projects');
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [parentPrompt, setParentPrompt] = useState<{ workspace: AgencyWorkspace; parentProject: AgencyProject } | null>(null);

  const archivedProjects = useMemo(() => {
    return projects
      .filter((p) => p.status === 'archived')
      .sort((a, b) => (b.archivedAt ?? b.updatedAt ?? '').localeCompare(a.archivedAt ?? a.updatedAt ?? ''));
  }, [projects]);

  const archivedWorkspaces = useMemo(() => {
    return workspaces
      .filter((w) => w.status === 'archived')
      .sort((a, b) => (b.archivedAt ?? b.updatedAt ?? '').localeCompare(a.archivedAt ?? a.updatedAt ?? ''));
  }, [workspaces]);

  const projectMap = useMemo(() => {
    return new Map(projects.map((p) => [p.id, p]));
  }, [projects]);

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return archivedProjects;
    return archivedProjects.filter((p) => p.name.toLowerCase().includes(q));
  }, [archivedProjects, searchQuery]);

  const filteredWorkspaces = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return archivedWorkspaces;
    return archivedWorkspaces.filter((w) => {
      const parentName = projectMap.get(w.projectId)?.name ?? '';
      return w.name.toLowerCase().includes(q) || parentName.toLowerCase().includes(q);
    });
  }, [archivedWorkspaces, projectMap, searchQuery]);

  const handleRestoreProject = async (projectId: ProjectId) => {
    if (pendingIds.has(projectId) || !online) return;
    setError(null);
    setPendingIds((prev) => new Set(prev).add(projectId));
    try {
      await onUnarchiveProject(projectId);
    } catch (err) {
      setError(t('agency.archive.restoreFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(projectId);
        return next;
      });
    }
  };

  const handleRestoreWorkspace = async (workspace: AgencyWorkspace) => {
    if (pendingIds.has(workspace.id) || !online) return;
    const parent = projectMap.get(workspace.projectId);
    if (parent && parent.status === 'archived') {
      setParentPrompt({ workspace, parentProject: parent });
      return;
    }

    setError(null);
    setPendingIds((prev) => new Set(prev).add(workspace.id));
    try {
      await onRestoreWorkspace(workspace.id);
    } catch (err) {
      setError(t('agency.archive.restoreFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(workspace.id);
        return next;
      });
    }
  };

  const handleConfirmParentAndWorkspace = async () => {
    if (!parentPrompt || !online) return;
    const { workspace, parentProject } = parentPrompt;
    setParentPrompt(null);
    setError(null);
    setPendingIds((prev) => new Set(prev).add(workspace.id).add(parentProject.id));
    try {
      await onUnarchiveProject(parentProject.id);
      await onRestoreWorkspace(workspace.id);
    } catch (err) {
      setError(t('agency.archive.restoreFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(workspace.id);
        next.delete(parentProject.id);
        return next;
      });
    }
  };

  return (
    <ModalDialog
      title={t('agency.archive.title')}
      onClose={onClose}
      closeLabel={t('common.close')}
      className="wb-archived-dialog"
    >
      <div className="wb-archived-container">
        {error && (
          <div role="alert" className="agency-error-bar" style={{ marginBottom: '12px' }}>
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label={t('agency.ui.dismissError')}>
              ×
            </button>
          </div>
        )}

        {parentPrompt ? (
          <div className="wb-archived-parent-prompt" role="alertdialog" aria-modal="true">
            <p className="wb-archived-prompt-text">
              {t('agency.archive.parentArchivedPrompt', { project: parentPrompt.parentProject.name })}
            </p>
            <div className="agency-dialog-actions" style={{ marginTop: '16px' }}>
              <button
                type="button"
                className="agency-secondary-button"
                onClick={() => setParentPrompt(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="agency-primary-button"
                onClick={handleConfirmParentAndWorkspace}
                disabled={!online}
              >
                {t('agency.archive.restoreBoth')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="wb-archived-tabs" role="tablist" aria-label={t('agency.archive.title')}>
              <button
                type="button"
                role="tab"
                id="archived-tab-projects"
                aria-selected={activeTab === 'projects'}
                aria-controls="archived-panel-projects"
                className={`agency-secondary-button wb-archived-tab ${activeTab === 'projects' ? 'selected' : ''}`}
                onClick={() => setActiveTab('projects')}
              >
                {`${t('agency.archive.projects')} (${archivedProjects.length})`}
              </button>
              <button
                type="button"
                role="tab"
                id="archived-tab-workspaces"
                aria-selected={activeTab === 'workspaces'}
                aria-controls="archived-panel-workspaces"
                className={`agency-secondary-button wb-archived-tab ${activeTab === 'workspaces' ? 'selected' : ''}`}
                onClick={() => setActiveTab('workspaces')}
              >
                {`${t('agency.archive.workspaces')} (${archivedWorkspaces.length})`}
              </button>
            </div>

            <div className="maw-archived-search-wrap" style={{ margin: '14px 0 16px' }}>
              <input
                id="archived-search-input"
                type="search"
                className="wb-settings-search-input maw-archived-search-input"
                placeholder={t('agency.archive.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ width: '100%' }}
                aria-label={t('agency.archive.searchPlaceholder')}
              />
            </div>

            <div
              id={activeTab === 'projects' ? 'archived-panel-projects' : 'archived-panel-workspaces'}
              role="tabpanel"
              aria-labelledby={activeTab === 'projects' ? 'archived-tab-projects' : 'archived-tab-workspaces'}
              className="wb-archived-list"
            >
              {activeTab === 'projects' ? (
                filteredProjects.length === 0 ? (
                  <div className="agency-empty-state" style={{ padding: '24px 0', textAlign: 'center' }}>
                    {archivedProjects.length === 0
                      ? t('agency.archive.noArchivedProjects')
                      : t('agency.archive.noSearchResults')}
                  </div>
                ) : (
                  filteredProjects.map((p) => {
                    const isPending = pendingIds.has(p.id);
                    const formattedDate = formatArchiveDate(p.archivedAt ?? p.updatedAt);
                    return (
                      <article key={p.id} className="wb-archived-row">
                        <div className="wb-archived-row-info">
                          <strong className="wb-archived-row-title">{p.name}</strong>
                          {formattedDate && (
                            <span className="agency-muted wb-archived-row-date">
                              {t('agency.archive.archivedOn', { date: formattedDate })}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="agency-primary-button wb-archived-restore-btn"
                          disabled={isPending || !online}
                          onClick={() => handleRestoreProject(p.id)}
                          aria-label={`${t('agency.archive.restore')} ${p.name}`}
                        >
                          {isPending ? t('agency.archive.restoring') : t('agency.archive.restore')}
                        </button>
                      </article>
                    );
                  })
                )
              ) : (
                filteredWorkspaces.length === 0 ? (
                  <div className="agency-empty-state" style={{ padding: '24px 0', textAlign: 'center' }}>
                    {archivedWorkspaces.length === 0
                      ? t('agency.archive.noArchivedWorkspaces')
                      : t('agency.archive.noSearchResults')}
                  </div>
                ) : (
                  filteredWorkspaces.map((w) => {
                    const isPending = pendingIds.has(w.id);
                    const parent = projectMap.get(w.projectId);
                    const formattedDate = formatArchiveDate(w.archivedAt ?? w.updatedAt);
                    return (
                      <article key={w.id} className="wb-archived-row">
                        <div className="wb-archived-row-info">
                          <strong className="wb-archived-row-title">{w.name}</strong>
                          <div className="wb-archived-row-meta">
                            {parent && <span className="wb-archived-parent-tag">{parent.name}</span>}
                            {formattedDate && (
                              <span className="agency-muted wb-archived-row-date">
                                {t('agency.archive.archivedOn', { date: formattedDate })}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="agency-primary-button wb-archived-restore-btn"
                          disabled={isPending || !online}
                          onClick={() => handleRestoreWorkspace(w)}
                          aria-label={`${t('agency.archive.restore')} ${w.name}`}
                        >
                          {isPending ? t('agency.archive.restoring') : t('agency.archive.restore')}
                        </button>
                      </article>
                    );
                  })
                )
              )}
            </div>
          </>
        )}
      </div>
    </ModalDialog>
  );
}

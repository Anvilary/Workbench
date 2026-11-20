import { t } from '../../i18n/index.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgencyProject, CliProfileId, ProjectId } from '@agent-workbench/shared';
import type { AgentConnection } from '../../connection/connection.js';
import { FolderPicker } from '../files/FolderPicker.js';

export type WorkspaceCreationMode = 'terminal';

export interface WorkspaceCreationOptions {
  mode: WorkspaceCreationMode;
  profileId?: CliProfileId;
}

interface Props {
  projects: readonly AgencyProject[];
  profiles?: readonly unknown[];
  initialProject?: ProjectId;
  connection: AgentConnection;
  onCreate: (
    projectId: ProjectId,
    name: string,
    pickerId: string,
    options: WorkspaceCreationOptions,
  ) => Promise<void>;
  onClose: () => void;
}

export function WorkspaceCreator({
  projects, initialProject, connection, onCreate, onClose,
}: Props): JSX.Element {
  const activeProjects = projects.filter((project) => project.status !== 'archived');
  const defaultProjectId =
    (initialProject && activeProjects.some((project) => project.id === initialProject) ? initialProject : undefined) ??
    activeProjects[0]?.id ??
    '';
  const [projectId, setProjectId] = useState<ProjectId | ''>(defaultProjectId);
  const [name, setName] = useState('');
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creatingFlight = useRef(false);
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !picking && !creating) {
        onClose();
        return;
      }
      if (event.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey) {
          if (document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          }
        } else {
          if (document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [picking, creating, onClose]);

  function choose(pickerId: string): void {
    if (!projectId || !name.trim() || creatingFlight.current) return;
    creatingFlight.current = true;
    setCreating(true);
    // Keep the server-owned picker alive until creation is acknowledged, even if handlers are async.
    void onCreate(projectId, name.trim(), pickerId, {
      mode: 'terminal',
    }).then(() => {
      setPicking(false);
      onClose();
    }).catch((reason: unknown) => {
      setPicking(false);
      setError(reason instanceof Error ? reason.message : t('agency.ui.workspaceCreationFailed'));
      setCreating(false);
      creatingFlight.current = false;
    });
  }

  return (
    <>
      <div className="agency-modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !picking && !creating) onClose();
      }}>
        <section ref={dialogRef} className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-create-title">
          <div className="agency-dialog-head">
            <h2 id="agency-create-title">{t('agency.ui.newWorkspace')}</h2>
            <button type="button" className="agency-icon-button" onClick={onClose} disabled={creating}
              aria-label={t('agency.ui.closeWorkspaceCreator')}>×</button>
          </div>
          <p className="agency-muted">{t('agency.ui.chooseAnExistingFolderEachWorkspaceHasAn')}</p>
          <label className="agency-field">
            <span>{t('agency.ui.workspaceName')}</span>
            <input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && name.trim() && projectId) setPicking(true); }}
              placeholder={t('agency.ui.eGFixTerminalReconnect')} disabled={creating} />
          </label>
          <label className="agency-field">
            <span>{t('agency.ui.project')}</span>
            <select value={projectId} disabled={creating}
              onChange={(event) => setProjectId(event.target.value as ProjectId)}>
              {activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          {error && <p role="alert" className="agency-error">{error}</p>}
          <div className="agency-dialog-actions">
            <button type="button" className="agency-secondary-button" onClick={onClose} disabled={creating}>{t('common.cancel')}</button>
            <button type="button" className="agency-primary-button" disabled={!projectId || !name.trim() || creating}
              onClick={() => { setError(null); setPicking(true); }}>
              {creating ? t('agency.ui.creating') : t('agency.ui.selectExistingFolder')}
            </button>
          </div>
        </section>
      </div>
      {picking && <FolderPicker
        connection={connection}
        title={t('agency.ui.chooseWorkspaceDirectory')}
        confirmLabel={t('agency.ui.useThisDirectory')}
        confirmTitle={(path) => t('agency.ui.createWorkspaceInPath', { path })}
        onChoose={choose}
        onClose={() => { if (!creating) setPicking(false); }}
      />}
    </>
  );
}

export function AgencyProjectCreator({ onCreate, onClose }: {
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [saving, onClose]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    void onCreate(name.trim()).then(onClose).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : t('agency.ui.projectCreationFailed'));
      setSaving(false);
    });
  }
  return (
    <div className="agency-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <form className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-new-project" onSubmit={submit}>
        <div className="agency-dialog-head">
          <h2 id="agency-new-project">{t('agency.ui.newProject')}</h2>
          <button type="button" className="agency-icon-button" aria-label={t('common.close')} onClick={onClose}>×</button>
        </div>
        <p className="agency-muted">{t('agency.ui.projectsGroupTaskWorkspacesTheyDoNotDefine')}</p>
        <label className="agency-field"><span>{t('agency.ui.name')}</span><input autoFocus maxLength={120}
          value={name} onChange={(event) => setName(event.target.value)} placeholder={t('agency.ui.projectName')} /></label>
        {error && <p className="agency-error" role="alert">{error}</p>}
        <div className="agency-dialog-actions">
          <button type="button" className="agency-secondary-button" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="agency-primary-button" disabled={!name.trim() || saving}>{saving ? t('agency.ui.creating') : t('agency.ui.createProject')}</button>
        </div>
      </form>
    </div>
  );
}

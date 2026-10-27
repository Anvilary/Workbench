import { useEffect, useState, type FormEvent } from 'react';
import type { AgencyProject, ProjectId } from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import { FolderPicker } from '../FolderPicker.js';

interface Props {
  projects: readonly AgencyProject[];
  initialProject?: ProjectId;
  connection: AgentConnection;
  onCreate: (projectId: ProjectId, name: string, pickerId: string) => Promise<void>;
  onClose: () => void;
}

export function AgencyWorkspaceCreator({
  projects, initialProject, connection, onCreate, onClose,
}: Props): JSX.Element {
  const [projectId, setProjectId] = useState<ProjectId | ''>(initialProject ?? projects[0]?.id ?? '');
  const [name, setName] = useState('');
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !picking && !creating) onClose();
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [picking, creating, onClose]);

  function choose(pickerId: string): void {
    if (!projectId || !name.trim() || creating) return;
    setPicking(false);
    setCreating(true);
    // Submit before FolderPicker unmounts and closes its socket-scoped picker ID.
    void onCreate(projectId, name.trim(), pickerId).then(onClose).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Workspace creation failed');
      setCreating(false);
    });
  }

  return (
    <>
      <div className="agency-modal-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !picking && !creating) onClose();
      }}>
        <section className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-create-title">
          <div className="agency-dialog-head">
            <h2 id="agency-create-title">New workspace</h2>
            <button type="button" className="agency-icon-button" onClick={onClose} disabled={creating}
              aria-label="Close workspace creator">×</button>
          </div>
          <p className="agency-muted">Choose an existing folder. Each workspace has an independent directory and may start without an agent.</p>
          <label className="agency-field">
            <span>Workspace name</span>
            <input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && name.trim() && projectId) setPicking(true); }}
              placeholder="e.g. Fix terminal reconnect" disabled={creating} />
          </label>
          <label className="agency-field">
            <span>Project</span>
            <select value={projectId} disabled={creating}
              onChange={(event) => setProjectId(event.target.value as ProjectId)}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          {error && <p role="alert" className="agency-error">{error}</p>}
          <div className="agency-dialog-actions">
            <button type="button" className="agency-secondary-button" onClick={onClose} disabled={creating}>Cancel</button>
            <button type="button" className="agency-primary-button" disabled={!projectId || !name.trim() || creating}
              onClick={() => { setError(null); setPicking(true); }}>
              {creating ? 'Creating…' : 'Select existing folder'}
            </button>
          </div>
        </section>
      </div>
      {picking && <FolderPicker
        connection={connection}
        title="Choose workspace directory"
        confirmLabel="Use this directory"
        confirmTitle={(path) => 'Create workspace in ' + path}
        onChoose={choose}
        onClose={() => setPicking(false)}
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
      setError(reason instanceof Error ? reason.message : 'Project creation failed');
      setSaving(false);
    });
  }
  return (
    <div className="agency-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <form className="agency-dialog" role="dialog" aria-modal="true" aria-labelledby="agency-new-project" onSubmit={submit}>
        <div className="agency-dialog-head">
          <h2 id="agency-new-project">New project</h2>
          <button type="button" className="agency-icon-button" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <p className="agency-muted">Projects group task workspaces. They do not define a filesystem root.</p>
        <label className="agency-field"><span>Name</span><input autoFocus maxLength={120}
          value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" /></label>
        {error && <p className="agency-error" role="alert">{error}</p>}
        <div className="agency-dialog-actions">
          <button type="button" className="agency-secondary-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="agency-primary-button" disabled={!name.trim() || saving}>{saving ? 'Creating…' : 'Create project'}</button>
        </div>
      </form>
    </div>
  );
}

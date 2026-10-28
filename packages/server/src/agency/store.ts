/**
 * Agency project/workspace metadata. Independent of upstream browser tabs and CLI auth.
 *
 * This store owns a single versioned snapshot. All mutations use one in-process
 * serial queue and write a recovery copy before atomically replacing the primary.
 * A corrupt primary is never silently treated as an empty state.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgencyErrorCode, AgencyProject, AgencyWorkspace, ProjectId, WorkspaceId,
} from '@agent-workbench/shared';
import { appConfigDir } from '../paths.js';
import { writeAtomically } from '../atomic-write.js';

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

interface Snapshot {
  version: typeof VERSION;
  projects: AgencyProject[];
  workspaces: AgencyWorkspace[];
}

const empty = (): Snapshot => ({ version: VERSION, projects: [], workspaces: [] });
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const validTime = (v: unknown): v is string =>
  typeof v === 'string' && UTC.test(v) && !Number.isNaN(Date.parse(v));
const validName = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 120 &&
  v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const validCwd = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && !v.includes('\0') &&
  path.isAbsolute(v) && path.normalize(v) === v;

export class AgencyStoreError extends Error {
  constructor(public readonly code: AgencyErrorCode, message: string) {
    super(message);
    this.name = 'AgencyStoreError';
  }
}

/** Reject corruption instead of erasing a user's existing metadata. */
export function parseAgencySnapshot(value: unknown): Snapshot {
  if (!record(value) || value['version'] !== VERSION ||
      !Array.isArray(value['projects']) || !Array.isArray(value['workspaces'])) {
    throw new AgencyStoreError('internal-error', 'Unsupported or corrupt Agency state');
  }
  const projects: AgencyProject[] = [];
  const workspaces: AgencyWorkspace[] = [];
  const projectIds = new Set<string>();
  const workspaceIds = new Set<string>();
  for (const valueProject of value['projects']) {
    if (!record(valueProject) || !validId(valueProject['id']) ||
        !validName(valueProject['name']) ||
        !validTime(valueProject['createdAt']) || !validTime(valueProject['updatedAt']) ||
        projectIds.has(valueProject['id'])) {
      throw new AgencyStoreError('internal-error', 'Invalid or duplicate Agency project');
    }
    const status = valueProject['status'] === undefined ? 'active' : valueProject['status'];
    if (status !== 'active' && status !== 'archived') {
      throw new AgencyStoreError('internal-error', 'Invalid project status');
    }
    const archivedAt = valueProject['archivedAt'] === undefined || valueProject['archivedAt'] === null
      ? null : valueProject['archivedAt'];
    if (archivedAt !== null && !validTime(archivedAt)) {
      throw new AgencyStoreError('internal-error', 'Invalid project archivedAt');
    }
    projectIds.add(valueProject['id']);
    projects.push({
      id: valueProject['id'] as ProjectId,
      name: valueProject['name'],
      status,
      createdAt: valueProject['createdAt'],
      updatedAt: valueProject['updatedAt'],
      archivedAt,
    });
  }
  for (const valueWorkspace of value['workspaces']) {
    const wStatus = valueWorkspace['status'];
    if (!record(valueWorkspace) || !validId(valueWorkspace['id']) ||
        !validId(valueWorkspace['projectId']) ||
        !projectIds.has(valueWorkspace['projectId']) ||
        !validName(valueWorkspace['name']) || !validCwd(valueWorkspace['cwd']) ||
        (wStatus !== 'active' && wStatus !== 'done' && wStatus !== 'archived') ||
        !validTime(valueWorkspace['createdAt']) || !validTime(valueWorkspace['updatedAt']) ||
        !(valueWorkspace['doneAt'] === null || validTime(valueWorkspace['doneAt'])) ||
        (wStatus === 'active' && valueWorkspace['doneAt'] !== null) ||
        (wStatus === 'done' && valueWorkspace['doneAt'] === null) ||
        workspaceIds.has(valueWorkspace['id'])) {
      throw new AgencyStoreError('internal-error', 'Invalid or duplicate Agency workspace');
    }
    const archivedAt = valueWorkspace['archivedAt'] === undefined || valueWorkspace['archivedAt'] === null
      ? null : valueWorkspace['archivedAt'];
    if (archivedAt !== null && !validTime(archivedAt)) {
      throw new AgencyStoreError('internal-error', 'Invalid workspace archivedAt');
    }
    workspaceIds.add(valueWorkspace['id']);
    workspaces.push({
      id: valueWorkspace['id'] as WorkspaceId,
      projectId: valueWorkspace['projectId'] as ProjectId,
      name: valueWorkspace['name'],
      cwd: valueWorkspace['cwd'],
      status: wStatus,
      createdAt: valueWorkspace['createdAt'],
      updatedAt: valueWorkspace['updatedAt'],
      doneAt: valueWorkspace['doneAt'],
      archivedAt,
    });
  }
  return { version: VERSION, projects, workspaces };
}

/**
 * A deletion veto MUST inspect both live registry sessions and unresolved
 * persisted Agency session references. Failure/uncertainty must throw or return
 * true. Do not pass a guard that checks only process liveness.
 */
export type HasBlockingWorkspaceSessions = (workspaceId: WorkspaceId) => boolean | Promise<boolean>;

export class AgencyWorkspaceStore {
  private state: Snapshot = empty();
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();
  readonly filePath: string;

  constructor(filePath: string = path.join(appConfigDir(), 'agency-state.json')) {
    this.filePath = filePath;
  }

  /**
   * Call once at server startup, before serving Agency messages. If the
   * primary is corrupt, restore a valid backup while quarantining the broken
   * primary. If both are bad, refuse to start instead of overwriting evidence.
   */
  async load(): Promise<void> {
    if (this.initialized) throw new AgencyStoreError('conflict', 'Agency store already loaded');
    let primary: string | null;
    try {
      primary = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      primary = null;
    }
    if (primary === null) {
      let backup: string | null;
      try {
        backup = await readFile(this.filePath + '.bak', 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        backup = null;
      }
      if (backup !== null) {
        this.state = parseAgencySnapshot(JSON.parse(backup) as unknown);
        await writeAtomically(this.filePath, Buffer.from(backup, 'utf8'), { mode: 0o600 });
      } else {
        this.state = empty();
      }
    } else {
      let decoded: unknown;
      try {
        decoded = JSON.parse(primary) as unknown;
      } catch {
        decoded = null;
      }
      // Do not downgrade a file written by a newer implementation. A v1
      // backup must never replace an otherwise valid future schema.
      if (record(decoded) && decoded['version'] !== VERSION) {
        throw new AgencyStoreError('internal-error', 'Unsupported Agency state version; migration is required');
      }
      try {
        this.state = parseAgencySnapshot(decoded);
      } catch {
        let recovered: Snapshot;
        let backup: string;
        try {
          backup = await readFile(this.filePath + '.bak', 'utf8');
          recovered = parseAgencySnapshot(JSON.parse(backup) as unknown);
        } catch {
          throw new AgencyStoreError('internal-error', 'Agency state is corrupt; recovery backup unavailable');
        }
        // Preserve forensic evidence. Never delete the original, even on failure.
        const quarantine = this.filePath + '.corrupt-' + Date.now() + '-' + randomUUID();
        await rename(this.filePath, quarantine);
        await writeAtomically(this.filePath, Buffer.from(JSON.stringify(recovered, null, 2) + '\n'), { mode: 0o600 });
        this.state = recovered;
      }
    }
    this.initialized = true;
  }

  private ready(): void {
    if (!this.initialized) throw new AgencyStoreError('internal-error', 'Agency store not loaded');
  }

  listProjects(): AgencyProject[] {
    this.ready();
    return this.state.projects.map((p) => ({ ...p }));
  }

  listWorkspaces(projectId?: ProjectId): AgencyWorkspace[] {
    this.ready();
    return this.state.workspaces
      .filter((w) => projectId === undefined || w.projectId === projectId)
      .map((w) => ({ ...w }));
  }

  getWorkspace(id: WorkspaceId): AgencyWorkspace | null {
    this.ready();
    const item = this.state.workspaces.find((w) => w.id === id);
    return item === undefined ? null : { ...item };
  }

  private transact<T>(fn: (state: Snapshot) => Promise<[Snapshot, T]> | [Snapshot, T]): Promise<T> {
    const job = this.queue.then(async () => {
      this.ready();
      const [next, value] = await fn(this.state);
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const serialized = Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8');
      await writeAtomically(this.filePath + '.bak', serialized, { mode: 0o600 });
      await writeAtomically(this.filePath, serialized, { mode: 0o600 });
      this.state = next;
      return value;
    });
    this.queue = job.then(() => undefined, () => undefined);
    return job;
  }

  async createProject(name: string): Promise<AgencyProject> {
    const clean = checkedName(name);
    return this.transact((state) => {
      const now = new Date().toISOString();
      const project: AgencyProject = {
        id: randomUUID() as ProjectId,
        name: clean,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      return [{ ...state, projects: [...state.projects, project] }, { ...project }];
    });
  }

  async renameProject(id: ProjectId, name: string): Promise<AgencyProject> {
    const clean = checkedName(name);
    return this.transact((state) => {
      const original = state.projects.find((p) => p.id === id);
      if (!original) throw new AgencyStoreError('not-found', 'Project not found');
      const project = { ...original, name: clean, updatedAt: new Date().toISOString() };
      return [{ ...state, projects: state.projects.map((p) => p.id === id ? project : p) }, { ...project }];
    });
  }

  async archiveProject(id: ProjectId): Promise<AgencyProject> {
    return this.transact((state) => {
      const original = state.projects.find((p) => p.id === id);
      if (!original) throw new AgencyStoreError('not-found', 'Project not found');
      const now = new Date().toISOString();
      const project: AgencyProject = {
        ...original,
        status: 'archived',
        archivedAt: now,
        updatedAt: now,
      };
      return [{ ...state, projects: state.projects.map((p) => p.id === id ? project : p) }, { ...project }];
    });
  }

  async unarchiveProject(id: ProjectId): Promise<AgencyProject> {
    return this.transact((state) => {
      const original = state.projects.find((p) => p.id === id);
      if (!original) throw new AgencyStoreError('not-found', 'Project not found');
      const now = new Date().toISOString();
      const project: AgencyProject = {
        ...original,
        status: 'active',
        archivedAt: null,
        updatedAt: now,
      };
      return [{ ...state, projects: state.projects.map((p) => p.id === id ? project : p) }, { ...project }];
    });
  }

  async deleteProject(id: ProjectId): Promise<void> {
    return this.transact((state) => {
      if (!state.projects.some((p) => p.id === id)) throw new AgencyStoreError('not-found', 'Project not found');
      if (state.workspaces.some((w) => w.projectId === id)) {
        throw new AgencyStoreError('conflict', 'Project still has workspaces (including Done)');
      }
      return [{ ...state, projects: state.projects.filter((p) => p.id !== id) }, undefined];
    });
  }

  /**
   * cwd must come from DirectoryPickers.selectedDirectory() on the CALLING
   * authenticated socket, never from a client request. The server integration
   * should resolve the picker before invoking this operation.
   */
  async createWorkspace(projectId: ProjectId, name: string, canonicalCwd: string): Promise<AgencyWorkspace> {
    const clean = checkedName(name);
    if (!validCwd(canonicalCwd)) throw new AgencyStoreError('invalid-directory', 'Directory is not canonical and absolute');
    return this.transact(async (state) => {
      if (!state.projects.some((p) => p.id === projectId)) {
        throw new AgencyStoreError('not-found', 'Project not found');
      }
      // Guard even direct server callers against nonexistent paths and symlinks.
      // Protected-home enforcement remains the socket picker's responsibility.
      try {
        if (await realpath(canonicalCwd) !== canonicalCwd ||
            !(await stat(canonicalCwd)).isDirectory()) {
          throw new Error('Not an existing canonical directory');
        }
      } catch {
        throw new AgencyStoreError('invalid-directory', 'Directory no longer exists or is not canonical');
      }
      const now = new Date().toISOString();
      const workspace: AgencyWorkspace = {
        id: randomUUID() as WorkspaceId, projectId, name: clean, cwd: canonicalCwd,
        status: 'active', createdAt: now, updatedAt: now, doneAt: null, archivedAt: null,
      };
      return [{ ...state, workspaces: [...state.workspaces, workspace] }, { ...workspace }];
    });
  }

  async renameWorkspace(id: WorkspaceId, name: string): Promise<AgencyWorkspace> {
    return this.updateWorkspace(id, (w) => ({ ...w, name: checkedName(name), updatedAt: new Date().toISOString() }));
  }

  async markDone(id: WorkspaceId): Promise<AgencyWorkspace> {
    return this.updateWorkspace(id, (w) =>
      w.status === 'done' ? w : { ...w, status: 'done', doneAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }

  async archiveWorkspace(id: WorkspaceId): Promise<AgencyWorkspace> {
    return this.updateWorkspace(id, (w) =>
      w.status === 'archived' ? w : {
        ...w,
        status: 'archived',
        archivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
  }

  async restore(id: WorkspaceId): Promise<AgencyWorkspace> {
    return this.updateWorkspace(id, (w) =>
      w.status === 'active' ? w : {
        ...w,
        status: 'active',
        doneAt: null,
        archivedAt: null,
        updatedAt: new Date().toISOString(),
      });
  }

  private updateWorkspace(id: WorkspaceId, fn: (w: AgencyWorkspace) => AgencyWorkspace): Promise<AgencyWorkspace> {
    return this.transact((state) => {
      const previous = state.workspaces.find((w) => w.id === id);
      if (!previous) throw new AgencyStoreError('not-found', 'Workspace not found');
      const workspace = fn(previous);
      return [{ ...state, workspaces: state.workspaces.map((w) => w.id === id ? workspace : w) }, { ...workspace }];
    });
  }

  /**
   * A missing guard is a hard refusal. Deletion modifies ONLY this JSON
   * snapshot, not a directory, PTY, native CLI history, or upstream tabs.
   * Session reservation and this guard must be coordinated by Lane C at merge.
   */
  async deleteWorkspace(id: WorkspaceId, hasBlockingSessions: HasBlockingWorkspaceSessions): Promise<void> {
    if (typeof hasBlockingSessions !== 'function') {
      throw new AgencyStoreError('session-unavailable', 'Session deletion guard is required');
    }
    return this.transact(async (state) => {
      if (!state.workspaces.some((w) => w.id === id)) throw new AgencyStoreError('not-found', 'Workspace not found');
      let blocked: boolean;
      try {
        const answer: unknown = await hasBlockingSessions(id);
        if (typeof answer !== 'boolean') throw new Error('Session guard returned an unknown answer');
        blocked = answer;
      } catch {
        throw new AgencyStoreError('session-unavailable', 'Cannot verify sessions; refusing workspace deletion');
      }
      if (blocked) throw new AgencyStoreError('conflict', 'Workspace still references runtime sessions');
      return [{ ...state, workspaces: state.workspaces.filter((w) => w.id !== id) }, undefined];
    });
  }
}

function checkedName(name: unknown): string {
  if (typeof name !== 'string') throw new AgencyStoreError('invalid-request', 'Name must be a string');
  const clean = name.trim();
  if (!validName(clean)) throw new AgencyStoreError('invalid-request', 'Name must contain 1-120 printable characters');
  return clean;
}

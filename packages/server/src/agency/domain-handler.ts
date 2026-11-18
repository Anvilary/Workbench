/**
 * Lane A integration surface for the existing authenticated /ws dispatcher.
 *
 * Call only after upstream authentication/Host/Origin enforcement. Keep this
 * parser isolated until the integration owner adds it to the shared runtime
 * protocol validator. A client-supplied cwd is always an invalid request.
 */
import type {
  AgencyClientMessage, AgencyServerMessage, AgencyErrorCode, ProjectId, WorkspaceId,
} from '@agent-workbench/shared';
import { isValidBrowserProfileId } from '@agent-workbench/shared';
import { DirectoryPickers, DirectoryPickerError } from '../directory-picker.js';
import { AgencyWorkspaceStore, AgencyStoreError, type HasBlockingWorkspaceSessions } from './store.js';
import type { BrowserProfileStore } from './browser-profiles/store.js';
import { AgencyRuntimeError } from './agency-session-runtime.js';
import { BrowserTabStoreError } from './browser-tabs/browser-tab-store.js';
import { EditorTabStoreError } from './editor-tabs/editor-tab-store.js';
import { DomainError } from '../shared/index.js';

type DomainType =
  | 'agency.projects.list' | 'agency.project.create' | 'agency.project.update' | 'agency.project.delete'
  | 'agency.project.archive' | 'agency.project.unarchive' | 'agency.projects.order'
  | 'agency.workspaces.list' | 'agency.workspace.create' | 'agency.workspace.update'
  | 'agency.workspace.archive' | 'agency.workspace.done' | 'agency.workspace.restore' | 'agency.workspace.delete'
  | 'agency.workspaces.order';
export type AgencyDomainRequest = Extract<AgencyClientMessage, { type: DomainType }>;
type DomainBroadcast = Extract<AgencyServerMessage, { type: 'agency.project.changed' | 'agency.workspace.changed' }>;

const fields: Record<DomainType, readonly string[]> = {
  'agency.projects.list': [],
  'agency.project.create': ['name'],
  'agency.project.update': ['projectId', 'name', 'browserProfileId'],
  'agency.project.archive': ['projectId'],
  'agency.project.unarchive': ['projectId'],
  'agency.project.delete': ['projectId', 'cascade'],
  'agency.projects.order': ['projectIds'],
  'agency.workspaces.list': ['projectId'],
  'agency.workspace.create': ['projectId', 'name', 'pickerId'],
  'agency.workspace.update': ['workspaceId', 'name', 'browserProfileId'],
  'agency.workspace.archive': ['workspaceId'],
  'agency.workspace.done': ['workspaceId'],
  'agency.workspace.restore': ['workspaceId'],
  'agency.workspace.delete': ['workspaceId'],
  'agency.workspaces.order': ['projectId', 'workspaceIds'],
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const bad = (message: string): never => {
  throw new AgencyStoreError('invalid-request', message);
};

/** Returns null for non-Lane-A messages; rejects malformed Lane-A messages. */
export function parseAgencyDomainRequest(value: unknown): AgencyDomainRequest | null {
  if (!isRecord(value) || typeof value['type'] !== 'string') return null;
  const type = value['type'] as DomainType;
  if (!Object.prototype.hasOwnProperty.call(fields, type)) return null;
  if (typeof value['requestId'] !== 'string' || value['requestId'].length < 1 ||
      value['requestId'].length > 128 || /[\u0000-\u001f\u007f]/.test(value['requestId'])) {
    bad('Invalid Agency requestId');
  }
  const allowed = new Set(['type', 'requestId', ...fields[type]]);
  if (Object.keys(value).some((key) => !allowed.has(key))) bad('Unexpected Agency request field');
  for (const key of fields[type]) {
    if (key === 'projectId' && type === 'agency.workspaces.list' && value[key] === undefined) continue;
    if (key === 'cascade' && type === 'agency.project.delete') {
      if (value[key] !== undefined && typeof value[key] !== 'boolean') bad('Invalid cascade flag');
      continue;
    }
    if ((key === 'name' || key === 'browserProfileId') &&
        (type === 'agency.project.update' || type === 'agency.workspace.update')) {
      continue;
    }
    if (key === 'projectId' || key === 'workspaceId') {
      if (typeof value[key] !== 'string' || !uuid.test(value[key])) bad('Invalid Agency object ID');
    } else if (key === 'name') {
      if (typeof value[key] !== 'string') bad('Invalid Agency name');
    } else if (key === 'pickerId') {
      if (typeof value[key] !== 'string' || !uuid.test(value[key])) bad('Invalid directory picker ID');
    } else if (key === 'projectIds' || key === 'workspaceIds') {
      const arr = value[key];
      if (!Array.isArray(arr) || arr.length > 10000 || !arr.every((id) => typeof id === 'string' && uuid.test(id)) || new Set(arr).size !== arr.length) {
        bad(`Invalid Agency ${key} list`);
      }
    }
  }
  if (type === 'agency.project.update' || type === 'agency.workspace.update') {
    const hasName = value['name'] !== undefined;
    const hasProfile = value['browserProfileId'] !== undefined;
    if (!hasName && !hasProfile) bad('Update requires name or browserProfileId');
    if (hasName && typeof value['name'] !== 'string') bad('Invalid Agency name');
    if (hasProfile && value['browserProfileId'] !== null && !isValidBrowserProfileId(value['browserProfileId'])) {
      bad('Invalid browserProfileId');
    }
  }
  return value as unknown as AgencyDomainRequest;
}

export interface AgencyDomainContext {
  store: AgencyWorkspaceStore;
  browserProfiles?: BrowserProfileStore;
  /** The DirectoryPickers instance must belong to the requesting /ws socket. */
  pickers: DirectoryPickers;
  /**
   * Mandatory for deletes. Must check persisted unresolved references and
   * live/in-flight PTYs, coordinated with Lane C's session reservation lock.
   */
  hasBlockingSessions?: HasBlockingWorkspaceSessions;
  /**
   * The SAME per-workspace critical section used by Lane C to reserve new
   * sessions. It must hold the lock until the metadata deletion commits.
   *
   * Session creation must acquire this lock before checking the workspace,
   * and keep it through reserving/persisting the session. The session guard
   * must include starting, running, stopping and unresolved persisted
   * references, not only currently alive PTYs. Unknown state refuses delete.
   */
  withSessionReservationLock?: (workspaceId: WorkspaceId, action: () => Promise<void>) => Promise<void>;
  /** Serializes coordinator tab/layout mutations alongside workspace deletion. */
  runWorkspaceExclusive?: (workspaceId: WorkspaceId, action: () => Promise<void>) => Promise<void>;
  /** Broadcast after a committed write, never to implement the write itself. */
  publish?: (message: DomainBroadcast) => void;
  /** Explicit coordinated shutdown of active workspace sessions and tabs before deletion. */
  shutdownWorkspace?: (workspaceId: WorkspaceId) => Promise<void>;
}

async function deleteWorkspaceWithCleanup(
  workspaceId: WorkspaceId,
  context: AgencyDomainContext,
): Promise<boolean> {
  if (typeof context.hasBlockingSessions !== 'function' ||
      typeof context.withSessionReservationLock !== 'function') {
    throw new AgencyStoreError('session-unavailable', 'Session guard and shared reservation lock are required');
  }
  let deleted = false;
  const runDelete = async (): Promise<void> => {
    if (!context.store.getWorkspace(workspaceId)) return;
    if (typeof context.shutdownWorkspace === 'function') {
      await context.shutdownWorkspace(workspaceId);
    }
    await context.withSessionReservationLock!(workspaceId, () =>
      context.store.deleteWorkspace(workspaceId, context.hasBlockingSessions!));
    deleted = true;
  };
  if (typeof context.runWorkspaceExclusive === 'function') {
    await context.runWorkspaceExclusive(workspaceId, runDelete);
  } else {
    await runDelete();
  }
  return deleted;
}

function publishSafely(context: AgencyDomainContext, message: DomainBroadcast): void {
  try {
    context.publish?.(message);
  } catch {
    // A notification failure cannot turn an already-committed write into
    // a request failure. Integration owner should log transport failures.
  }
}

/**
 * Returns null for requests outside Lane A; otherwise one protocol reply.
 * The caller sends the reply on its authenticated /ws socket.
 */
export async function handleAgencyDomainRequest(
  input: unknown,
  context: AgencyDomainContext,
): Promise<AgencyServerMessage | null> {
  const requestId = isRecord(input) && typeof input['requestId'] === 'string'
    ? input['requestId'].slice(0, 128) : '';
  try {
    const request = parseAgencyDomainRequest(input);
    if (request === null) return null;
    switch (request.type) {
      case 'agency.projects.list':
        return { type: 'agency.projects.snapshot', requestId, projects: context.store.listProjects() };
      case 'agency.project.create': {
        const project = await context.store.createProject(request.name);
        publishSafely(context, { type: 'agency.project.changed', change: 'created', projectId: project.id, project });
        return { type: 'agency.project.created', requestId, project };
      }
      case 'agency.project.update': {
        if (request.browserProfileId !== undefined && request.browserProfileId !== null && context.browserProfiles) {
          if (!context.browserProfiles.getProfile(request.browserProfileId)) {
            throw new AgencyStoreError('not-found', `Browser profile ${request.browserProfileId} not found`);
          }
        }
        const project = await context.store.updateProject(request.projectId, {
          ...(request.name !== undefined ? { name: request.name } : {}),
          ...(request.browserProfileId !== undefined ? { browserProfileId: request.browserProfileId } : {}),
        });
        publishSafely(context, { type: 'agency.project.changed', change: 'updated', projectId: project.id, project });
        return { type: 'agency.project.updated', requestId, project };
      }
      case 'agency.project.archive': {
        const project = await context.store.archiveProject(request.projectId);
        publishSafely(context, { type: 'agency.project.changed', change: 'archived', projectId: project.id, project });
        return { type: 'agency.project.archived', requestId, project };
      }
      case 'agency.project.unarchive': {
        const project = await context.store.unarchiveProject(request.projectId);
        publishSafely(context, { type: 'agency.project.changed', change: 'unarchived', projectId: project.id, project });
        return { type: 'agency.project.unarchived', requestId, project };
      }
      case 'agency.project.delete': {
        if (request.cascade) {
          if (!context.store.listProjects().some((p) => p.id === request.projectId)) {
            return { type: 'agency.project.deleted', requestId, projectId: request.projectId };
          }
          const children = context.store.listWorkspaces(request.projectId);
          for (const ws of children) {
            const deleted = await deleteWorkspaceWithCleanup(ws.id, context);
            if (deleted) {
              publishSafely(context, { type: 'agency.workspace.changed', change: 'deleted', workspaceId: ws.id });
            }
          }
        }
        await context.store.deleteProject(request.projectId);
        publishSafely(context, { type: 'agency.project.changed', change: 'deleted', projectId: request.projectId });
        return { type: 'agency.project.deleted', requestId, projectId: request.projectId };
      }
      case 'agency.projects.order': {
        const projects = await context.store.orderProjects(request.projectIds);
        publishSafely(context, {
          type: 'agency.project.changed',
          change: 'reordered',
          projectId: request.projectIds[0] ?? ('' as ProjectId),
          projects,
        });
        return { type: 'agency.projects.snapshot', requestId, projects };
      }
      case 'agency.workspaces.list':
        return { type: 'agency.workspaces.snapshot', requestId, workspaces: context.store.listWorkspaces(request.projectId) };
      case 'agency.workspace.create': {
        // No request.cwd fallback, even when a picker has gone missing.
        const cwd = await context.pickers.selectedDirectory(request.pickerId);
        const workspace = await context.store.createWorkspace(request.projectId, request.name, cwd);
        publishSafely(context, { type: 'agency.workspace.changed', change: 'created', workspaceId: workspace.id, workspace });
        return { type: 'agency.workspace.created', requestId, workspace };
      }
      case 'agency.workspace.update': {
        if (request.browserProfileId !== undefined && request.browserProfileId !== null && context.browserProfiles) {
          if (!context.browserProfiles.getProfile(request.browserProfileId)) {
            throw new AgencyStoreError('not-found', `Browser profile ${request.browserProfileId} not found`);
          }
        }
        const workspace = await context.store.updateWorkspaceFields(request.workspaceId, {
          ...(request.name !== undefined ? { name: request.name } : {}),
          ...(request.browserProfileId !== undefined ? { browserProfileId: request.browserProfileId } : {}),
        });
        publishSafely(context, { type: 'agency.workspace.changed', change: 'updated', workspaceId: workspace.id, workspace });
        return { type: 'agency.workspace.updated', requestId, workspace };
      }
      case 'agency.workspace.archive': {
        const workspace = await context.store.archiveWorkspace(request.workspaceId);
        publishSafely(context, { type: 'agency.workspace.changed', change: 'archived', workspaceId: workspace.id, workspace });
        return { type: 'agency.workspace.archived', requestId, workspace };
      }
      case 'agency.workspace.done': {
        const workspace = await context.store.markDone(request.workspaceId);
        publishSafely(context, { type: 'agency.workspace.changed', change: 'done', workspaceId: workspace.id, workspace });
        return { type: 'agency.workspace.done', requestId, workspace };
      }
      case 'agency.workspace.restore': {
        const workspace = await context.store.restore(request.workspaceId);
        publishSafely(context, { type: 'agency.workspace.changed', change: 'restored', workspaceId: workspace.id, workspace });
        return { type: 'agency.workspace.restored', requestId, workspace };
      }
      case 'agency.workspace.delete': {
        const deleted = await deleteWorkspaceWithCleanup(request.workspaceId, context);
        if (deleted) {
          publishSafely(context, { type: 'agency.workspace.changed', change: 'deleted', workspaceId: request.workspaceId });
        }
        return { type: 'agency.workspace.deleted', requestId, workspaceId: request.workspaceId };
      }
      case 'agency.workspaces.order': {
        await context.store.orderWorkspaces(request.projectId, request.workspaceIds);
        const workspaces = context.store.listWorkspaces();
        publishSafely(context, {
          type: 'agency.workspace.changed',
          change: 'reordered',
          workspaceId: request.workspaceIds[0] ?? ('' as WorkspaceId),
          workspaces,
        });
        return { type: 'agency.workspaces.snapshot', requestId, workspaces };
      }
    }
  } catch (error) {
    let code: AgencyErrorCode = 'internal-error';
    let message = 'Agency operation failed';
    if (error instanceof DomainError) {
      code = error.code as AgencyErrorCode;
      message = error.message;
    } else if (error instanceof AgencyStoreError) {
      code = error.code;
      message = error.message;
    } else if (error instanceof AgencyRuntimeError) {
      code = error.code;
      message = error.message;
    } else if (error instanceof BrowserTabStoreError) {
      code = error.code;
      message = error.message;
    } else if (error instanceof EditorTabStoreError) {
      code = error.code;
      message = error.message;
    } else if (error instanceof DirectoryPickerError) {
      code = 'invalid-directory';
      message = 'Directory selection is no longer valid or is protected';
    }
    return { type: 'agency.error', requestId, code, message };
  }
}

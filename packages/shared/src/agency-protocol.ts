/**
 * Agency-UI additive domain and wire contract.
 *
 * Pinned foundation: cvelasquez/agent-workbench@5d804f5c5151677b03fceb4a7a2dc20b8ac117ef
 * This module introduces no second WebSocket or PTY transport.
 * The server must validate all inbound messages at runtime before using them.
 */

export const AGENCY_CONTRACT_VERSION = 2 as const;

import {
  type WebTabClientMessage, type WebTabServerMessage,
  parseWebTabClientMessage, parseWebTabServerMessage, validateWebTabTitle,
} from './browser-tabs.js';

import {
  type NotificationClientMessage,
  type NotificationServerMessage,
  isMawNotificationItem,
  isTabActivityRecord,
} from './notification-protocol.js';

import {
  type LayoutClientMessage,
  type LayoutServerMessage,
  isWorkspacePaneLayout,
} from './split-layout.js';

/** IDs are deliberately distinct from native CLI sessions and Workbench terminal IDs. */
export type ProjectId = string & { readonly __agencyProjectId: unique symbol };
export type WorkspaceId = string & { readonly __agencyWorkspaceId: unique symbol };
export type CliProfileId = string & { readonly __agencyCliProfileId: unique symbol };
export type RuntimeSessionId = string & { readonly __agencyRuntimeSessionId: unique symbol };

export type IsoTimestamp = string;
export type RequestId = string;

export type ProjectStatus = 'active' | 'archived';

export interface AgencyProject {
  id: ProjectId;
  name: string;
  status?: ProjectStatus;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  archivedAt?: IsoTimestamp | null;
}

export type WorkspaceStatus = 'active' | 'done' | 'archived';

export interface AgencyWorkspace {
  id: WorkspaceId;
  projectId: ProjectId;
  name: string;
  /** Absolute canonical realpath of an existing directory, assigned by the server. */
  cwd: string;
  status: WorkspaceStatus;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  doneAt: IsoTimestamp | null;
  archivedAt?: IsoTimestamp | null;
}

export type CliProvider = 'codex' | 'antigravity' | 'claude-code';
export type ProfileStatus = 'available' | 'not-installed' | 'needs-authentication' | 'disabled' | 'error';
export type SessionLifecycle = 'starting' | 'running' | 'stopping' | 'exited' | 'failed';
export type SessionActivity = 'idle' | 'working' | 'awaiting-user' | 'awaiting-permission' | 'unknown' | 'offline';

export interface AgencyModelOption {
  id: string;
  label: string;
  /** Report only effort values the original installed CLI actually supports. */
  effortOptions: readonly string[];
  isDefault: boolean;
}

export interface AgencyProfileCapabilities {
  canLaunch: boolean;
  canResumeNativeSession: boolean;
  canInterrupt: boolean;
  canReportActivity: boolean;
  canSelectModel: boolean;
  canSelectEffort: boolean;
  canRequestPermissions: boolean;
  /** A catalog may be unavailable; absence never means support. */
  models: readonly AgencyModelOption[];
  discovery: 'native' | 'configured' | 'unavailable';
}

export interface AgencyCliProfile {
  id: CliProfileId;
  label: string;
  provider: CliProvider;
  /** Resolved executable path or installed binary name; never a shell command string. */
  executable: string;
  /** An argument vector passed directly to spawn, with no shell interpolation. */
  args: readonly string[];
  /** Only server-approved, non-secret overrides. Never copy or persist provider tokens. */
  environmentOverrides: Readonly<Record<string, string>>;
  capabilities: AgencyProfileCapabilities;
  configurationStatus: ProfileStatus;
  configurationMessage: string | null;
}

export interface AgencyTab {
  terminalNumber?: number;
  id: string;
  name: string | null;
  order: number;
  selected: boolean;
  closedAt: IsoTimestamp | null;
  current: boolean;
}

export function isAgencyTab(value: unknown): value is AgencyTab {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Record<string, unknown>;
  return (tab.terminalNumber === undefined || (Number.isSafeInteger(tab.terminalNumber) && (tab.terminalNumber as number) > 0)) && typeof tab.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tab.id) &&
    (tab.name === null || (typeof tab.name === 'string' && tab.name.length <= 120)) &&
    Number.isSafeInteger(tab.order) && (tab.order as number) >= 0 && typeof tab.selected === 'boolean' &&
    typeof tab.current === 'boolean' && (tab.closedAt === null || (typeof tab.closedAt === 'string' && Number.isFinite(Date.parse(tab.closedAt))));
}

export interface AgencySessionBase {
  tab?: AgencyTab;
  launchId?: string;
  id: RuntimeSessionId;
  workspaceId: WorkspaceId;
  /** The existing server registry owns the process behind this ID. */
  terminalId: string | null;
  lifecycle: SessionLifecycle;
  activity: SessionActivity;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
  stoppedAt: IsoTimestamp | null;
  exitCode: number | null;
  stoppedByUser?: boolean;
  recovery?: { status: 'pending' | 'resuming' | 'resumed' | 'manual' | 'failed' | 'superseded'; message: string | null };
}

export interface AgencyAgentSession extends AgencySessionBase {
  kind: 'agent';
  /** Non-secret argv and context reference; never persist the complete native environment. */
  launchDefinition?: { executable: string; args: readonly string[]; contextRef: string | null };
  /** Immutable identity captured at launch; absent in legacy rows. */
  nativeIdentity?: Readonly<{ provider: CliProvider; home: string; bindingId?: string }> | null;
  historyAvailability?: 'available' | 'unavailable';
  profileId: CliProfileId;
  nativeSessionId: string | null;
  selectedModel: string | null;
  selectedEffort: string | null;
}

export interface AgencyTerminalSession extends AgencySessionBase {
  kind: 'terminal';
  profileId: null;
  nativeSessionId: null;
  selectedModel: null;
  selectedEffort: null;
}

export type AgencyRuntimeSession = AgencyAgentSession | AgencyTerminalSession;

export interface AgencyClientRequest<T extends string> {
  type: T;
  requestId: RequestId;
}

export type AgencyClientMessage =
  | AgencyClientRequest<'agency.projects.list'>
  | (AgencyClientRequest<'agency.project.create'> & { name: string })
  | (AgencyClientRequest<'agency.project.update'> & { projectId: ProjectId; name: string })
  | (AgencyClientRequest<'agency.project.archive'> & { projectId: ProjectId })
  | (AgencyClientRequest<'agency.project.unarchive'> & { projectId: ProjectId })
  | (AgencyClientRequest<'agency.project.delete'> & { projectId: ProjectId })
  | (AgencyClientRequest<'agency.workspaces.list'> & { projectId?: ProjectId })
  | (AgencyClientRequest<'agency.workspace.create'> & {
      projectId: ProjectId;
      name: string;
      /** Existing picker ID bound to this socket; the server resolves its current directory. */
      pickerId: string;
    })
  | (AgencyClientRequest<'agency.workspace.update'> & { workspaceId: WorkspaceId; name: string })
  | (AgencyClientRequest<'agency.workspace.archive'> & { workspaceId: WorkspaceId })
  | (AgencyClientRequest<'agency.workspace.done'> & { workspaceId: WorkspaceId })
  | (AgencyClientRequest<'agency.workspace.restore'> & { workspaceId: WorkspaceId })
  | (AgencyClientRequest<'agency.workspace.delete'> & { workspaceId: WorkspaceId })
  | AgencyClientRequest<'agency.profiles.list'>
  | (AgencyClientRequest<'agency.profile.configure'> & {
      profileId: CliProfileId;
      label?: string;
      executable?: string;
      args?: readonly string[];
      environmentOverrides?: Readonly<Record<string, string>>;
      disabled?: boolean;
    })
  | (AgencyClientRequest<'agency.profile.capabilities.get'> & { profileId: CliProfileId })
  | (AgencyClientRequest<'agency.sessions.list'> & { workspaceId?: WorkspaceId })
  /** Closed tabs and superseded attempts, newest first; not part of live snapshots. */
  | (AgencyClientRequest<'agency.sessions.history'> & { workspaceId?: WorkspaceId; offset?: number; limit?: number })
  | (AgencyClientRequest<'agency.session.create'> & {
      workspaceId: WorkspaceId;
      kind: 'agent';
      launchId?: string;
      targetPaneId?: string;
      profileId: CliProfileId;
      resumeNativeSessionId?: string;
      cols: number;
      rows: number;
      model?: string;
      effort?: string;
    })
  | (AgencyClientRequest<'agency.session.create'> & {
      workspaceId: WorkspaceId;
      kind: 'terminal';
      launchId?: string;
      targetPaneId?: string;
      cols: number;
      rows: number;
    })
  | (AgencyClientRequest<'agency.tab.action'> & { workspaceId: WorkspaceId; tabId: string; action: 'select' | 'close' | 'resume' })
  | (AgencyClientRequest<'agency.tab.rename'> & { workspaceId: WorkspaceId; tabId: string; name: string })
  | (AgencyClientRequest<'agency.tabs.order'> & { workspaceId: WorkspaceId; tabIds: readonly string[] })
  | (AgencyClientRequest<'agency.session.selection.set'> & {
      sessionId: RuntimeSessionId;
      model: string | null;
      effort: string | null;
    })
  | NotificationClientMessage
  | WebTabClientMessage
  | LayoutClientMessage;

export type AgencyErrorCode =
  | 'invalid-request'
  | 'not-found'
  | 'conflict'
  | 'invalid-directory'
  | 'profile-unavailable'
  | 'unsupported-capability'
  | 'session-unavailable'
  | 'permission-denied'
  | 'internal-error';

/** A request receives one success response or an agency.error. */
export type AgencyServerMessage =
  | { type: 'agency.projects.snapshot'; requestId: RequestId; projects: readonly AgencyProject[] }
  | { type: 'agency.project.created'; requestId: RequestId; project: AgencyProject }
  | { type: 'agency.project.updated'; requestId: RequestId; project: AgencyProject }
  | { type: 'agency.project.archived'; requestId: RequestId; project: AgencyProject }
  | { type: 'agency.project.unarchived'; requestId: RequestId; project: AgencyProject }
  | { type: 'agency.project.deleted'; requestId: RequestId; projectId: ProjectId }
  | { type: 'agency.workspaces.snapshot'; requestId: RequestId; workspaces: readonly AgencyWorkspace[] }
  | { type: 'agency.workspace.created'; requestId: RequestId; workspace: AgencyWorkspace }
  | { type: 'agency.workspace.updated'; requestId: RequestId; workspace: AgencyWorkspace }
  | { type: 'agency.workspace.archived'; requestId: RequestId; workspace: AgencyWorkspace }
  | { type: 'agency.workspace.done'; requestId: RequestId; workspace: AgencyWorkspace }
  | { type: 'agency.workspace.restored'; requestId: RequestId; workspace: AgencyWorkspace }
  | { type: 'agency.workspace.deleted'; requestId: RequestId; workspaceId: WorkspaceId }
  | { type: 'agency.profiles.snapshot'; requestId: RequestId; profiles: readonly AgencyCliProfile[] }
  | { type: 'agency.profile.configured'; requestId: RequestId; profile: AgencyCliProfile }
  | { type: 'agency.profile.capabilities'; requestId: RequestId; profileId: CliProfileId; capabilities: AgencyProfileCapabilities }
  /** `workspaceId` is present only when the snapshot is scoped to one workspace (a scoped list request). */
  | { type: 'agency.sessions.snapshot'; requestId: RequestId; sessions: readonly AgencyRuntimeSession[]; workspaceId?: WorkspaceId }
  | { type: 'agency.sessions.history'; requestId: RequestId; sessions: readonly AgencyRuntimeSession[]; total: number; offset: number }
  | { type: 'agency.session.created'; requestId: RequestId; session: AgencyRuntimeSession }
  | { type: 'agency.session.selection'; requestId: RequestId; session: AgencyAgentSession }
  | { type: 'agency.error'; requestId: RequestId; code: AgencyErrorCode; message: string; workspaceId?: WorkspaceId; tabId?: string }
  /** Broadcasts are emitted to every authorized connected browser, not only the caller. */
  | { type: 'agency.project.changed'; change: 'created' | 'updated' | 'archived' | 'unarchived' | 'deleted'; projectId: ProjectId; project?: AgencyProject }
  | { type: 'agency.workspace.changed'; change: 'created' | 'updated' | 'done' | 'restored' | 'archived' | 'deleted'; workspaceId: WorkspaceId; workspace?: AgencyWorkspace }
  | { type: 'agency.profile.changed'; profileId: CliProfileId; profile: AgencyCliProfile }
  | { type: 'agency.session.changed'; sessionId: RuntimeSessionId; session: AgencyRuntimeSession }
  | { type: 'agency.session.activity'; sessionId: RuntimeSessionId; workspaceId: WorkspaceId; activity: SessionActivity; lifecycle: SessionLifecycle }
  | NotificationServerMessage
  | WebTabServerMessage
  | LayoutServerMessage;

/**
 * Existing upstream PTY messages are NOT redefined here:
 * input, resize, terminal.attach, terminal.detach, terminal.close,
 * terminal.opened, terminal.replay, terminal.activity.
 * These are imported from protocol.ts when server implementation is added.
 */

// ---------------------------------------------------------------------------
// Strict Runtime Validation & Parsing
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_ARG_RE = /(?:^|[-_])(?:api[-_]?key|auth[-_]?token|access[-_]?token|token|oauth|secret|password|credential)(?:$|[-_=])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isValidId(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((k) => allowedSet.has(k));
}

function isValidName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const clean = value.trim();
  return clean.length >= 1 && clean.length <= 120 && !/[\u0000-\u001f\u007f]/.test(clean);
}

export function parseAgencyClientMessage(raw: unknown): AgencyClientMessage | null {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') return null;
  if (raw.type.startsWith('agency.webTab')) return parseWebTabClientMessage(raw);
  const requestId = raw['requestId'];
  if (!isValidRequestId(requestId)) return null;

  switch (raw['type']) {
    case 'agency.projects.list': {
      if (!hasOnlyKeys(raw, ['type', 'requestId'])) return null;
      return { type: 'agency.projects.list', requestId };
    }
    case 'agency.project.create': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'name']) || !isValidName(raw['name'])) return null;
      return { type: 'agency.project.create', requestId, name: raw['name'] };
    }
    case 'agency.project.update': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'projectId', 'name']) ||
          !isValidId(raw['projectId']) || !isValidName(raw['name'])) return null;
      return { type: 'agency.project.update', requestId, projectId: raw['projectId'] as ProjectId, name: raw['name'] };
    }
    case 'agency.project.archive': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'projectId']) || !isValidId(raw['projectId'])) return null;
      return { type: 'agency.project.archive', requestId, projectId: raw['projectId'] as ProjectId };
    }
    case 'agency.project.unarchive': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'projectId']) || !isValidId(raw['projectId'])) return null;
      return { type: 'agency.project.unarchive', requestId, projectId: raw['projectId'] as ProjectId };
    }
    case 'agency.project.delete': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'projectId']) || !isValidId(raw['projectId'])) return null;
      return { type: 'agency.project.delete', requestId, projectId: raw['projectId'] as ProjectId };
    }
    case 'agency.workspaces.list': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'projectId'])) return null;
      if (raw['projectId'] !== undefined && !isValidId(raw['projectId'])) return null;
      return {
        type: 'agency.workspaces.list',
        requestId,
        ...(raw['projectId'] !== undefined ? { projectId: raw['projectId'] as ProjectId } : {}),
      };
    }
    case 'agency.workspace.create': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'projectId', 'name', 'pickerId']) ||
          !isValidId(raw['projectId']) || !isValidName(raw['name']) || !isValidId(raw['pickerId'])) return null;
      return {
        type: 'agency.workspace.create',
        requestId,
        projectId: raw['projectId'] as ProjectId,
        name: raw['name'],
        pickerId: raw['pickerId'] as string,
      };
    }
    case 'agency.workspace.update': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId', 'name']) ||
          !isValidId(raw['workspaceId']) || !isValidName(raw['name'])) return null;
      return {
        type: 'agency.workspace.update',
        requestId,
        workspaceId: raw['workspaceId'] as WorkspaceId,
        name: raw['name'],
      };
    }
    case 'agency.workspace.archive': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId']) || !isValidId(raw['workspaceId'])) return null;
      return { type: 'agency.workspace.archive', requestId, workspaceId: raw['workspaceId'] as WorkspaceId };
    }
    case 'agency.workspace.done': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId']) || !isValidId(raw['workspaceId'])) return null;
      return { type: 'agency.workspace.done', requestId, workspaceId: raw['workspaceId'] as WorkspaceId };
    }
    case 'agency.workspace.restore': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId']) || !isValidId(raw['workspaceId'])) return null;
      return { type: 'agency.workspace.restore', requestId, workspaceId: raw['workspaceId'] as WorkspaceId };
    }
    case 'agency.workspace.delete': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId']) || !isValidId(raw['workspaceId'])) return null;
      return { type: 'agency.workspace.delete', requestId, workspaceId: raw['workspaceId'] as WorkspaceId };
    }
    case 'agency.profiles.list': {
      if (!hasOnlyKeys(raw, ['type', 'requestId'])) return null;
      return { type: 'agency.profiles.list', requestId };
    }
    case 'agency.profile.configure': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'profileId', 'label', 'executable', 'args', 'environmentOverrides', 'disabled'])) return null;
      if (typeof raw['profileId'] !== 'string' || raw['profileId'].length < 1 || raw['profileId'].length > 64) return null;
      const result: AgencyClientMessage = {
        type: 'agency.profile.configure',
        requestId,
        profileId: raw['profileId'] as CliProfileId,
      };
      if (raw['label'] !== undefined) {
        if (typeof raw['label'] !== 'string' || raw['label'].trim().length < 1 || raw['label'].length > 80 || /[\u0000-\u001f\u007f]/.test(raw['label'])) return null;
        result.label = raw['label'].trim();
      }
      if (raw['executable'] !== undefined) {
        if (typeof raw['executable'] !== 'string' || raw['executable'].length > 4096 || /[\u0000-\u001f\u007f]/.test(raw['executable'])) return null;
        result.executable = raw['executable'];
      }
      if (raw['args'] !== undefined) {
        if (!Array.isArray(raw['args']) || raw['args'].length > 64) return null;
        for (const arg of raw['args']) {
          if (typeof arg !== 'string' || arg.length > 4096 || /[\u0000-\u001f\u007f]/.test(arg)) return null;
          if (CREDENTIAL_ARG_RE.test(arg)) return null;
        }
        result.args = [...raw['args']];
      }
      if (raw['environmentOverrides'] !== undefined) {
        if (!isRecord(raw['environmentOverrides'])) return null;
        const overrides: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw['environmentOverrides'])) {
          if (typeof v !== 'string' || v.length > 1024 || /[\u0000-\u001f\u007f]/.test(k) || /[\u0000-\u001f\u007f]/.test(v)) return null;
          overrides[k] = v;
        }
        result.environmentOverrides = overrides;
      }
      if (raw['disabled'] !== undefined) {
        if (typeof raw['disabled'] !== 'boolean') return null;
        result.disabled = raw['disabled'];
      }
      return result;
    }
    case 'agency.profile.capabilities.get': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'profileId']) ||
          typeof raw['profileId'] !== 'string' || raw['profileId'].length < 1 || raw['profileId'].length > 64) return null;
      return { type: 'agency.profile.capabilities.get', requestId, profileId: raw['profileId'] as CliProfileId };
    }
    case 'agency.sessions.list': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId'])) return null;
      if (raw['workspaceId'] !== undefined && !isValidId(raw['workspaceId'])) return null;
      return {
        type: 'agency.sessions.list',
        requestId,
        ...(raw['workspaceId'] !== undefined ? { workspaceId: raw['workspaceId'] as WorkspaceId } : {}),
      };
    }
    case 'agency.sessions.history': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId', 'offset', 'limit'])) return null;
      if (raw['workspaceId'] !== undefined && !isValidId(raw['workspaceId'])) return null;
      const offset = raw['offset'] ?? 0, limit = raw['limit'] ?? 50;
      if (!Number.isInteger(offset) || (offset as number) < 0 || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) return null;
      return {
        type: 'agency.sessions.history', requestId, offset: offset as number, limit: limit as number,
        ...(raw['workspaceId'] !== undefined ? { workspaceId: raw['workspaceId'] as WorkspaceId } : {}),
      };
    }
    case 'agency.tab.action': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId', 'tabId', 'action']) || !isValidId(raw.workspaceId) || !isValidId(raw.tabId) || !['select', 'close', 'resume'].includes(raw.action as string)) return null;
      return { type: 'agency.tab.action', requestId, workspaceId: raw.workspaceId as WorkspaceId, tabId: raw.tabId as string, action: raw.action as 'select' | 'close' | 'resume' };
    }
    case 'agency.tab.rename': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId', 'tabId', 'name']) || !isValidId(raw.workspaceId) || !isValidId(raw.tabId) || !validateWebTabTitle(raw.name)) return null;
      return { type: 'agency.tab.rename', requestId, workspaceId: raw.workspaceId as WorkspaceId, tabId: raw.tabId as string, name: (raw.name as string).trim() };
    }
    case 'agency.tabs.order': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId', 'tabIds']) || !isValidId(raw.workspaceId) || !Array.isArray(raw.tabIds) || raw.tabIds.length > 10000 || !raw.tabIds.every(isValidId) || new Set(raw.tabIds).size !== raw.tabIds.length) return null;
      return { type: 'agency.tabs.order', requestId, workspaceId: raw.workspaceId as WorkspaceId, tabIds: raw.tabIds as string[] };
    }
    case 'agency.session.create': {
      if (!isValidId(raw['workspaceId'])) return null;
      if (raw.launchId !== undefined && !isValidId(raw.launchId)) return null;
      if (raw.targetPaneId !== undefined && !isValidId(raw.targetPaneId)) return null;
      const cols = raw['cols'];
      const rows = raw['rows'];
      if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 2 || cols > 500) return null;
      if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > 200) return null;
      if (raw['kind'] === 'terminal') {
        if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId', 'kind', 'cols', 'rows', 'launchId', 'targetPaneId'])) return null;
        return {
          type: 'agency.session.create',
          requestId,
          workspaceId: raw['workspaceId'] as WorkspaceId,
          kind: 'terminal',
          ...(raw.launchId !== undefined ? { launchId: raw.launchId as string } : {}),
          ...(raw.targetPaneId !== undefined ? { targetPaneId: raw.targetPaneId as string } : {}),
          cols,
          rows,
        };
      }
      if (raw['kind'] === 'agent') {
        if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId', 'kind', 'profileId', 'cols', 'rows', 'resumeNativeSessionId', 'model', 'effort', 'launchId', 'targetPaneId'])) return null;
        if (typeof raw['profileId'] !== 'string' || raw['profileId'].trim().length === 0 || raw['profileId'].length > 64) return null;
        const result: AgencyClientMessage = {
          type: 'agency.session.create',
          requestId,
          workspaceId: raw['workspaceId'] as WorkspaceId,
          kind: 'agent',
          ...(raw.launchId !== undefined ? { launchId: raw.launchId as string } : {}),
          ...(raw.targetPaneId !== undefined ? { targetPaneId: raw.targetPaneId as string } : {}),
          profileId: raw['profileId'] as CliProfileId,
          cols,
          rows,
        };
        if (raw['resumeNativeSessionId'] !== undefined) {
          if (typeof raw['resumeNativeSessionId'] !== 'string' || raw['resumeNativeSessionId'].length === 0 || raw['resumeNativeSessionId'].length > 512) return null;
          result.resumeNativeSessionId = raw['resumeNativeSessionId'];
        }
        if (raw['model'] !== undefined) {
          if (typeof raw['model'] !== 'string' || raw['model'].length === 0 || raw['model'].length > 128) return null;
          result.model = raw['model'];
        }
        if (raw['effort'] !== undefined) {
          if (typeof raw['effort'] !== 'string' || raw['effort'].length === 0 || raw['effort'].length > 64) return null;
          result.effort = raw['effort'];
        }
        return result;
      }
      return null;
    }
    case 'agency.session.selection.set': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'sessionId', 'model', 'effort']) || !isValidId(raw['sessionId'])) return null;
      if (raw['model'] !== null && typeof raw['model'] !== 'string') return null;
      if (raw['effort'] !== null && typeof raw['effort'] !== 'string') return null;
      return {
        type: 'agency.session.selection.set',
        requestId,
        sessionId: raw['sessionId'] as RuntimeSessionId,
        model: raw['model'],
        effort: raw['effort'],
      };
    }
    case 'agency.notifications.list': {
      if (!hasOnlyKeys(raw, ['type', 'requestId'])) return null;
      return { type: 'agency.notifications.list', requestId };
    }
    case 'agency.notification.markRead': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'notificationId']) || !isValidId(raw['notificationId'])) return null;
      return { type: 'agency.notification.markRead', requestId, notificationId: raw['notificationId'] as string };
    }
    case 'agency.notification.markAllRead': {
      if (!hasOnlyKeys(raw, ['type', 'requestId'])) return null;
      return { type: 'agency.notification.markAllRead', requestId };
    }
    case 'agency.notification.dismiss': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'notificationId']) || !isValidId(raw['notificationId'])) return null;
      return { type: 'agency.notification.dismiss', requestId, notificationId: raw['notificationId'] as string };
    }
    case 'agency.notification.done': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'notificationId']) || !isValidId(raw['notificationId'])) return null;
      return { type: 'agency.notification.done', requestId, notificationId: raw['notificationId'] as string };
    }
    case 'agency.tab.acknowledge': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId', 'tabId']) || !isValidId(raw['workspaceId']) || !isValidId(raw['tabId'])) return null;
      return { type: 'agency.tab.acknowledge', requestId, workspaceId: raw['workspaceId'] as WorkspaceId, tabId: raw['tabId'] as string };
    }
    case 'agency.layout.save': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId', 'layout']) || !isValidId(raw['workspaceId']) || !isWorkspacePaneLayout(raw['layout'])) return null;
      return { type: 'agency.layout.save', requestId, workspaceId: raw['workspaceId'] as WorkspaceId, layout: raw['layout'] };
    }
    case 'agency.layout.get': {
      if (!hasOnlyKeys(raw, ['type', 'requestId', 'workspaceId']) || !isValidId(raw['workspaceId'])) return null;
      return { type: 'agency.layout.get', requestId, workspaceId: raw['workspaceId'] as WorkspaceId };
    }
    default:
      return null;
  }
}

function isValidIsoTimestamp(value: unknown): value is IsoTimestamp {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value);
}

function isAgencyProject(value: unknown): value is AgencyProject {
  return isRecord(value) && isValidId(value['id']) && typeof value['name'] === 'string' &&
    isValidIsoTimestamp(value['createdAt']) && isValidIsoTimestamp(value['updatedAt']);
}

function isAgencyWorkspace(value: unknown): value is AgencyWorkspace {
  return isRecord(value) && isValidId(value['id']) && isValidId(value['projectId']) &&
    typeof value['name'] === 'string' && typeof value['cwd'] === 'string' &&
    (value['status'] === 'active' || value['status'] === 'done' || value['status'] === 'archived') &&
    isValidIsoTimestamp(value['createdAt']) && isValidIsoTimestamp(value['updatedAt']) &&
    (value['doneAt'] === null || isValidIsoTimestamp(value['doneAt']));
}

function isAgencyCliProfile(value: unknown): value is AgencyCliProfile {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['label'] === 'string' &&
    typeof value['provider'] === 'string' && typeof value['executable'] === 'string' &&
    Array.isArray(value['args']) && isRecord(value['environmentOverrides']) &&
    isRecord(value['capabilities']) && typeof value['configurationStatus'] === 'string';
}

function isAgencyRuntimeSession(value: unknown): value is AgencyRuntimeSession {
  if (!isRecord(value) || !isValidId(value['id']) || !isValidId(value['workspaceId'])) return false;
  if (value.tab !== undefined && !isAgencyTab(value.tab)) return false;
  if (value['terminalId'] !== null && typeof value['terminalId'] !== 'string') return false;
  if (!['starting', 'running', 'stopping', 'exited', 'failed'].includes(value['lifecycle'] as string)) return false;
  if (!['idle', 'working', 'awaiting-user', 'awaiting-permission', 'unknown', 'offline'].includes(value['activity'] as string)) return false;
  if (!isValidIsoTimestamp(value['createdAt']) || !isValidIsoTimestamp(value['updatedAt'])) return false;
  if (value['kind'] === 'terminal') {
    return value['profileId'] === null && value['nativeSessionId'] === null;
  }
  if (value['kind'] === 'agent') {
    return typeof value['profileId'] === 'string' && (value['nativeSessionId'] === null || typeof value['nativeSessionId'] === 'string');
  }
  return false;
}

const ERROR_CODES = new Set<AgencyErrorCode>([
  'invalid-request', 'not-found', 'conflict', 'invalid-directory',
  'profile-unavailable', 'unsupported-capability', 'session-unavailable',
  'permission-denied', 'internal-error',
]);

export function parseAgencyServerMessage(raw: unknown): AgencyServerMessage | null {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') return null;
  if (raw.type.startsWith('agency.webTab')) return parseWebTabServerMessage(raw);

  switch (raw['type']) {
    case 'agency.projects.snapshot': {
      if (typeof raw['requestId'] !== 'string' || !Array.isArray(raw['projects']) || !raw['projects'].every(isAgencyProject)) return null;
      return { type: 'agency.projects.snapshot', requestId: raw['requestId'], projects: raw['projects'] };
    }
    case 'agency.project.created': {
      if (typeof raw['requestId'] !== 'string' || !isAgencyProject(raw['project'])) return null;
      return { type: 'agency.project.created', requestId: raw['requestId'], project: raw['project'] };
    }
    case 'agency.project.updated': {
      if (typeof raw['requestId'] !== 'string' || !isAgencyProject(raw['project'])) return null;
      return { type: 'agency.project.updated', requestId: raw['requestId'], project: raw['project'] };
    }
    case 'agency.project.deleted': {
      if (typeof raw['requestId'] !== 'string' || !isValidId(raw['projectId'])) return null;
      return { type: 'agency.project.deleted', requestId: raw['requestId'], projectId: raw['projectId'] as ProjectId };
    }
    case 'agency.workspaces.snapshot': {
      if (typeof raw['requestId'] !== 'string' || !Array.isArray(raw['workspaces']) || !raw['workspaces'].every(isAgencyWorkspace)) return null;
      return { type: 'agency.workspaces.snapshot', requestId: raw['requestId'], workspaces: raw['workspaces'] };
    }
    case 'agency.workspace.created': {
      if (typeof raw['requestId'] !== 'string' || !isAgencyWorkspace(raw['workspace'])) return null;
      return { type: 'agency.workspace.created', requestId: raw['requestId'], workspace: raw['workspace'] };
    }
    case 'agency.workspace.updated': {
      if (typeof raw['requestId'] !== 'string' || !isAgencyWorkspace(raw['workspace'])) return null;
      return { type: 'agency.workspace.updated', requestId: raw['requestId'], workspace: raw['workspace'] };
    }
    case 'agency.workspace.done': {
      if (typeof raw['requestId'] !== 'string' || !isAgencyWorkspace(raw['workspace'])) return null;
      return { type: 'agency.workspace.done', requestId: raw['requestId'], workspace: raw['workspace'] };
    }
    case 'agency.workspace.restored': {
      if (typeof raw['requestId'] !== 'string' || !isAgencyWorkspace(raw['workspace'])) return null;
      return { type: 'agency.workspace.restored', requestId: raw['requestId'], workspace: raw['workspace'] };
    }
    case 'agency.workspace.deleted': {
      if (typeof raw['requestId'] !== 'string' || !isValidId(raw['workspaceId'])) return null;
      return { type: 'agency.workspace.deleted', requestId: raw['requestId'], workspaceId: raw['workspaceId'] as WorkspaceId };
    }
    case 'agency.profiles.snapshot': {
      if (typeof raw['requestId'] !== 'string' || !Array.isArray(raw['profiles']) || !raw['profiles'].every(isAgencyCliProfile)) return null;
      return { type: 'agency.profiles.snapshot', requestId: raw['requestId'], profiles: raw['profiles'] };
    }
    case 'agency.profile.configured': {
      if (typeof raw['requestId'] !== 'string' || !isAgencyCliProfile(raw['profile'])) return null;
      return { type: 'agency.profile.configured', requestId: raw['requestId'], profile: raw['profile'] };
    }
    case 'agency.profile.capabilities': {
      if (typeof raw['requestId'] !== 'string' || typeof raw['profileId'] !== 'string' || !isRecord(raw['capabilities'])) return null;
      return {
        type: 'agency.profile.capabilities',
        requestId: raw['requestId'],
        profileId: raw['profileId'] as CliProfileId,
        capabilities: raw['capabilities'] as unknown as AgencyProfileCapabilities,
      };
    }
    case 'agency.sessions.snapshot': {
      if (typeof raw['requestId'] !== 'string' || !Array.isArray(raw['sessions']) || !raw['sessions'].every(isAgencyRuntimeSession)) return null;
      if (raw['workspaceId'] !== undefined && typeof raw['workspaceId'] !== 'string') return null;
      return { type: 'agency.sessions.snapshot', requestId: raw['requestId'], sessions: raw['sessions'],
        ...(typeof raw['workspaceId'] === 'string' ? { workspaceId: raw['workspaceId'] as WorkspaceId } : {}) };
    }
    case 'agency.sessions.history': {
      if (typeof raw['requestId'] !== 'string' || !Array.isArray(raw['sessions']) || !raw['sessions'].every(isAgencyRuntimeSession) ||
          !Number.isInteger(raw['total']) || !Number.isInteger(raw['offset'])) return null;
      return { type: 'agency.sessions.history', requestId: raw['requestId'], sessions: raw['sessions'], total: raw['total'] as number, offset: raw['offset'] as number };
    }
    case 'agency.session.created': {
      if (typeof raw['requestId'] !== 'string' || !isAgencyRuntimeSession(raw['session'])) return null;
      return { type: 'agency.session.created', requestId: raw['requestId'], session: raw['session'] };
    }
    case 'agency.session.selection': {
      if (typeof raw['requestId'] !== 'string' || !isAgencyRuntimeSession(raw['session']) || raw['session'].kind !== 'agent') return null;
      return { type: 'agency.session.selection', requestId: raw['requestId'], session: raw['session'] as AgencyAgentSession };
    }
    case 'agency.error': {
      if (typeof raw['requestId'] !== 'string' || !ERROR_CODES.has(raw['code'] as AgencyErrorCode) || typeof raw['message'] !== 'string') return null;
      return {
        type: 'agency.error',
        requestId: raw['requestId'],
        code: raw['code'] as AgencyErrorCode,
        message: raw['message'],
        ...(typeof raw['workspaceId'] === 'string' && isValidId(raw['workspaceId']) ? { workspaceId: raw['workspaceId'] as WorkspaceId } : {}),
        ...(typeof raw['tabId'] === 'string' && isValidId(raw['tabId']) ? { tabId: raw['tabId'] } : {}),
      };
    }
    case 'agency.project.changed': {
      if (!['created', 'updated', 'deleted'].includes(raw['change'] as string) || !isValidId(raw['projectId'])) return null;
      return {
        type: 'agency.project.changed',
        change: raw['change'] as 'created' | 'updated' | 'deleted',
        projectId: raw['projectId'] as ProjectId,
        ...(raw['project'] && isAgencyProject(raw['project']) ? { project: raw['project'] } : {}),
      };
    }
    case 'agency.workspace.changed': {
      if (!['created', 'updated', 'done', 'restored', 'deleted'].includes(raw['change'] as string) || !isValidId(raw['workspaceId'])) return null;
      return {
        type: 'agency.workspace.changed',
        change: raw['change'] as 'created' | 'updated' | 'done' | 'restored' | 'deleted',
        workspaceId: raw['workspaceId'] as WorkspaceId,
        ...(raw['workspace'] && isAgencyWorkspace(raw['workspace']) ? { workspace: raw['workspace'] } : {}),
      };
    }
    case 'agency.profile.changed': {
      if (typeof raw['profileId'] !== 'string' || !isAgencyCliProfile(raw['profile'])) return null;
      return { type: 'agency.profile.changed', profileId: raw['profileId'] as CliProfileId, profile: raw['profile'] };
    }
    case 'agency.session.changed': {
      if (!isValidId(raw['sessionId']) || !isAgencyRuntimeSession(raw['session'])) return null;
      return { type: 'agency.session.changed', sessionId: raw['sessionId'] as RuntimeSessionId, session: raw['session'] };
    }
    case 'agency.session.activity': {
      if (!isValidId(raw['sessionId']) || !isValidId(raw['workspaceId']) ||
          !['idle', 'working', 'awaiting-user', 'awaiting-permission', 'unknown', 'offline'].includes(raw['activity'] as string) ||
          !['starting', 'running', 'stopping', 'exited', 'failed'].includes(raw['lifecycle'] as string)) return null;
      return {
        type: 'agency.session.activity',
        sessionId: raw['sessionId'] as RuntimeSessionId,
        workspaceId: raw['workspaceId'] as WorkspaceId,
        activity: raw['activity'] as SessionActivity,
        lifecycle: raw['lifecycle'] as SessionLifecycle,
      };
    }
    case 'agency.notifications.snapshot': {
      if (typeof raw['requestId'] !== 'string' || !Array.isArray(raw['notifications']) || !raw['notifications'].every(isMawNotificationItem)) return null;
      if (raw['activityStates'] !== undefined && (!Array.isArray(raw['activityStates']) || !raw['activityStates'].every(isTabActivityRecord))) return null;
      return {
        type: 'agency.notifications.snapshot',
        requestId: raw['requestId'],
        notifications: raw['notifications'],
        ...(raw['activityStates'] ? { activityStates: raw['activityStates'] } : {}),
      };
    }
    case 'agency.notification.created': {
      if (!isMawNotificationItem(raw['notification'])) return null;
      return {
        type: 'agency.notification.created',
        notification: raw['notification'],
        ...(isValidRequestId(raw['requestId']) ? { requestId: raw['requestId'] } : {}),
      };
    }
    case 'agency.notification.changed': {
      if (!isMawNotificationItem(raw['notification'])) return null;
      return {
        type: 'agency.notification.changed',
        notification: raw['notification'],
        ...(isValidRequestId(raw['requestId']) ? { requestId: raw['requestId'] } : {}),
      };
    }
    case 'agency.tab.activity': {
      if (!isTabActivityRecord(raw['activity'])) return null;
      return {
        type: 'agency.tab.activity',
        activity: raw['activity'],
        ...(isValidRequestId(raw['requestId']) ? { requestId: raw['requestId'] } : {}),
      };
    }
    case 'agency.layout.saved': {
      if (!isValidRequestId(raw['requestId']) || !isValidId(raw['workspaceId'])) return null;
      return {
        type: 'agency.layout.saved',
        requestId: raw['requestId'],
        workspaceId: raw['workspaceId'] as WorkspaceId,
      };
    }
    case 'agency.layouts.snapshot': {
      if (typeof raw['requestId'] !== 'string' || !Array.isArray(raw['layouts']) || !raw['layouts'].every(isWorkspacePaneLayout)) return null;
      return {
        type: 'agency.layouts.snapshot',
        requestId: raw['requestId'],
        layouts: raw['layouts'],
      };
    }
    case 'agency.layout.changed': {
      if (!isValidId(raw['workspaceId']) || !isWorkspacePaneLayout(raw['layout'])) return null;
      return {
        type: 'agency.layout.changed',
        workspaceId: raw['workspaceId'] as WorkspaceId,
        layout: raw['layout'],
      };
    }
    default:
      return null;
  }
}

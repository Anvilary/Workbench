/**
 * Agency-UI additive domain and wire contract.
 *
 * Pinned foundation: cvelasquez/agent-workbench@5d804f5c5151677b03fceb4a7a2dc20b8ac117ef
 * This module introduces no second WebSocket or PTY transport.
 * The server must validate all inbound messages at runtime before using them.
 */

export const AGENCY_CONTRACT_VERSION = 1 as const;

/** IDs are deliberately distinct from native CLI sessions and Workbench terminal IDs. */
export type ProjectId = string & { readonly __agencyProjectId: unique symbol };
export type WorkspaceId = string & { readonly __agencyWorkspaceId: unique symbol };
export type CliProfileId = string & { readonly __agencyCliProfileId: unique symbol };
export type RuntimeSessionId = string & { readonly __agencyRuntimeSessionId: unique symbol };

export type IsoTimestamp = string;
export type RequestId = string;

export interface AgencyProject {
  id: ProjectId;
  name: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type WorkspaceStatus = 'active' | 'done';

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

export interface AgencySessionBase {
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
}

export interface AgencyAgentSession extends AgencySessionBase {
  kind: 'agent';
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
  | (AgencyClientRequest<'agency.project.delete'> & { projectId: ProjectId })
  | (AgencyClientRequest<'agency.workspaces.list'> & { projectId?: ProjectId })
  | (AgencyClientRequest<'agency.workspace.create'> & {
      projectId: ProjectId;
      name: string;
      /** Existing picker ID bound to this socket; the server resolves its current directory. */
      pickerId: string;
    })
  | (AgencyClientRequest<'agency.workspace.update'> & { workspaceId: WorkspaceId; name: string })
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
  | (AgencyClientRequest<'agency.session.create'> & {
      workspaceId: WorkspaceId;
      kind: 'agent';
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
      cols: number;
      rows: number;
    })
  | (AgencyClientRequest<'agency.session.selection.set'> & {
      sessionId: RuntimeSessionId;
      model: string | null;
      effort: string | null;
    });

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
  | { type: 'agency.project.deleted'; requestId: RequestId; projectId: ProjectId }
  | { type: 'agency.workspaces.snapshot'; requestId: RequestId; workspaces: readonly AgencyWorkspace[] }
  | { type: 'agency.workspace.created'; requestId: RequestId; workspace: AgencyWorkspace }
  | { type: 'agency.workspace.updated'; requestId: RequestId; workspace: AgencyWorkspace }
  | { type: 'agency.workspace.done'; requestId: RequestId; workspace: AgencyWorkspace }
  | { type: 'agency.workspace.restored'; requestId: RequestId; workspace: AgencyWorkspace }
  | { type: 'agency.workspace.deleted'; requestId: RequestId; workspaceId: WorkspaceId }
  | { type: 'agency.profiles.snapshot'; requestId: RequestId; profiles: readonly AgencyCliProfile[] }
  | { type: 'agency.profile.configured'; requestId: RequestId; profile: AgencyCliProfile }
  | { type: 'agency.profile.capabilities'; requestId: RequestId; profileId: CliProfileId; capabilities: AgencyProfileCapabilities }
  | { type: 'agency.sessions.snapshot'; requestId: RequestId; sessions: readonly AgencyRuntimeSession[] }
  | { type: 'agency.session.created'; requestId: RequestId; session: AgencyRuntimeSession }
  | { type: 'agency.session.selection'; requestId: RequestId; session: AgencyAgentSession }
  | { type: 'agency.error'; requestId: RequestId; code: AgencyErrorCode; message: string }
  /** Broadcasts are emitted to every authorized connected browser, not only the caller. */
  | { type: 'agency.project.changed'; change: 'created' | 'updated' | 'deleted'; projectId: ProjectId; project?: AgencyProject }
  | { type: 'agency.workspace.changed'; change: 'created' | 'updated' | 'done' | 'restored' | 'deleted'; workspaceId: WorkspaceId; workspace?: AgencyWorkspace }
  | { type: 'agency.profile.changed'; profileId: CliProfileId; profile: AgencyCliProfile }
  | { type: 'agency.session.changed'; sessionId: RuntimeSessionId; session: AgencyRuntimeSession }
  | { type: 'agency.session.activity'; sessionId: RuntimeSessionId; workspaceId: WorkspaceId; activity: SessionActivity; lifecycle: SessionLifecycle };

/**
 * Existing upstream PTY messages are NOT redefined here:
 * input, resize, terminal.attach, terminal.detach, terminal.close,
 * terminal.opened, terminal.replay, terminal.activity.
 * These are imported from protocol.ts when server implementation is added.
 */

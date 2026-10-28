import type { AgentConnection } from '../connection.js';
import type {
  AgencyCliProfile, AgencyProject, AgencyRuntimeSession, AgencyServerMessage,
  AgencyClientMessage, AgencyWorkspace, AgencyAgentSession, AgencyProfileCapabilities,
  ClientMessage,
  SessionActivity, SessionLifecycle, WorkspaceId, CliProfileId,
} from '@agent-workbench/shared';

export interface AgencyTransport {
  /** Implemented by the integration owner on the existing authenticated /ws. */
  /**
   * MUST bypass AgentConnection.send(), whose offline queue replays mutations.
   * Integration owner implements this with the existing socket's direct
   * readyState === WebSocket.OPEN check and encodeClientMessage.
   * Never enqueue on failure, including races between status check and send.
   */
  sendImmediate(message: AgencyClientMessage | ClientMessage): boolean;
  onMessage(handler: (message: AgencyServerMessage) => void): () => void;
}

export interface AgencySnapshot {
  projects: readonly AgencyProject[];
  workspaces: readonly AgencyWorkspace[];
  profiles: readonly AgencyCliProfile[];
  sessions: readonly AgencyRuntimeSession[];
}

export const EMPTY_AGENCY_SNAPSHOT: AgencySnapshot = {
  projects: [], workspaces: [], profiles: [], sessions: [],
};

export function workspaceTabs(sessions: readonly AgencyRuntimeSession[], workspaceId: WorkspaceId): AgencyRuntimeSession[] {
  return sessions.filter(session => session.workspaceId === workspaceId && session.tab?.current && !session.tab.closedAt)
    .sort((a,b) => a.tab!.order - b.tab!.order || a.tab!.id.localeCompare(b.tab!.id));
}

export function profileForSession(
  session: AgencyRuntimeSession | undefined, profiles: readonly AgencyCliProfile[],
): AgencyCliProfile | undefined {
  return session?.kind === 'agent' ? profiles.find((profile) => profile.id === session.profileId) : undefined;
}

export function selectableModels(capabilities: AgencyProfileCapabilities | undefined) {
  return capabilities?.canSelectModel && capabilities.discovery !== 'unavailable'
    ? capabilities.models : [];
}

export function selectableEfforts(
  capabilities: AgencyProfileCapabilities | undefined, selectedModel: string | null,
): readonly string[] {
  if (!capabilities?.canSelectEffort || !selectedModel) return [];
  return selectableModels(capabilities).find((model) => model.id === selectedModel)?.effortOptions ?? [];
}

export function canLaunchAgent(profile: AgencyCliProfile | undefined): boolean {
  return !!profile && profile.configurationStatus === 'available' && profile.capabilities.canLaunch;
}

export type AgencyNoticeKind = 'completed' | 'attention';

/** Only a real state transition reported by the server may produce a browser notification. */
export function transitionNotice(
  previous: Pick<AgencyRuntimeSession, 'kind' | 'lifecycle' | 'activity'> | null,
  next: Pick<AgencyRuntimeSession, 'kind' | 'lifecycle' | 'activity'>,
): AgencyNoticeKind | null {
  if (!previous || next.kind !== 'agent') return null;
  if (previous.activity !== next.activity &&
      (next.activity === 'awaiting-user' || next.activity === 'awaiting-permission')) return 'attention';
  if (previous.activity === 'working' && next.activity === 'idle') return 'completed';
  return null;
}

export function activityLabel(activity: SessionActivity, lifecycle: SessionLifecycle): string {
  if (lifecycle === 'exited') return 'Exited';
  if (lifecycle === 'failed') return 'Failed';
  if (lifecycle === 'starting') return 'Starting';
  if (lifecycle === 'stopping') return 'Stopping';
  switch (activity) {
    case 'working': return 'Running';
    case 'idle': return 'Idle';
    case 'awaiting-user': return 'Needs input';
    case 'awaiting-permission': return 'Permission required';
    case 'offline': return 'Offline';
    default: return 'Activity unknown';
  }
}

export function isAttention(activity: SessionActivity): boolean {
  return activity === 'awaiting-user' || activity === 'awaiting-permission';
}

export function replaceById<T extends { id: string }>(values: readonly T[], incoming: T): T[] {
  const existing = values.findIndex((item) => item.id === incoming.id);
  if (existing < 0) return [...values, incoming];
  return values.map((item, index) => index === existing ? incoming : item);
}

export function agentSession(session: AgencyRuntimeSession | undefined): AgencyAgentSession | undefined {
  return session?.kind === 'agent' ? session : undefined;
}

export type AgencySelectId = CliProfileId | '';
export type WorkspaceSelection = WorkspaceId | null;

export function activeByProject(
  projects: readonly AgencyProject[], workspaces: readonly AgencyWorkspace[],
): { project: AgencyProject; items: AgencyWorkspace[] }[] {
  return projects.map((project) => ({
    project,
    items: workspaces.filter((ws) => ws.projectId === project.id && ws.status === 'active')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }));
}

/** Keep drafts keyed to stable workspace IDs instead of component mount identity. */
export function putWorkspaceDraft(
  drafts: Readonly<Record<string, string>>, workspaceId: WorkspaceId, text: string,
): Record<string, string> {
  return { ...drafts, [workspaceId]: text };
}

/** A late server acknowledgement cannot erase text edited after submission. */
export function acknowledgeWorkspaceDraft(
  drafts: Readonly<Record<string, string>>, workspaceId: WorkspaceId, deliveredText: string,
): Record<string, string> {
  return drafts[workspaceId] === deliveredText ? { ...drafts, [workspaceId]: '' } : { ...drafts };
}

/**
 * Integration bridge on the ONE existing authenticated WebSocket.
 * Fail closed if Lane D's required non-queueing patch is not installed.
 * Never fall back to AgentConnection.send(), which queues offline mutations.
 */
export function createAgencyTransport(connection: AgentConnection): AgencyTransport {
  const candidate = connection as AgentConnection & {
    sendImmediate?: AgencyTransport['sendImmediate'];
  };
  if (typeof candidate.sendImmediate !== 'function') {
    throw new Error('Agency requires the non-queueing AgentConnection.sendImmediate integration patch');
  }
  return {
    sendImmediate: (message) => candidate.sendImmediate!.call(connection, message),
    onMessage: (handler) => connection.onMessage((message) => {
      // The integration owner must add Agency types to the existing validated parser.
      if (message.type.startsWith('agency.')) handler(message as unknown as AgencyServerMessage);
    }),
  };
}

/** Exact argv boundaries, no shell tokenization or whitespace splitting. */
export function parseProfileArgv(value: string): string[] | null {
  try {
    const result: unknown = JSON.parse(value);
    return Array.isArray(result) && result.every((entry) => typeof entry === 'string')
      ? result as string[] : null;
  } catch {
    return null;
  }
}

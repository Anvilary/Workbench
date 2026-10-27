import type {
  AgencyCliProfile, AgencyProject, AgencyRuntimeSession, AgencyServerMessage,
  AgencyClientMessage, AgencyWorkspace, AgencyAgentSession, AgencyProfileCapabilities,
  SessionActivity, SessionLifecycle, WorkspaceId, CliProfileId,
} from '@agent-workbench/shared';

export interface AgencyTransport {
  /** Implemented by the integration owner on the existing authenticated /ws. */
  send(message: AgencyClientMessage): boolean;
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

export function currentSession(
  sessions: readonly AgencyRuntimeSession[], workspaceId: WorkspaceId, kind: 'agent' | 'terminal',
): AgencyRuntimeSession | undefined {
  return sessions.find((session) =>
    session.workspaceId === workspaceId && session.kind === kind &&
    (session.lifecycle === 'starting' || session.lifecycle === 'running' || session.lifecycle === 'stopping'),
  );
}

export function latestSession(
  sessions: readonly AgencyRuntimeSession[], workspaceId: WorkspaceId, kind: 'agent' | 'terminal',
): AgencyRuntimeSession | undefined {
  return sessions.filter((session) => session.workspaceId === workspaceId && session.kind === kind)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
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
  if (previous.lifecycle !== 'exited' && next.lifecycle === 'exited') return 'completed';
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

export type AgencyLayout = 'empty' | 'agent-only' | 'terminal-only' | 'combined';

export function workspaceLayout(hasAgent: boolean, hasShell: boolean): AgencyLayout {
  if (hasAgent && hasShell) return 'combined';
  if (hasAgent) return 'agent-only';
  if (hasShell) return 'terminal-only';
  return 'empty';
}

import type { AgentConnection } from '../../connection/connection.js';
import type {
  AgencyCliProfile, AgencyProject, AgencyRuntimeSession, AgencyServerMessage,
  AgencyClientMessage, AgencyWorkspace, AgencyAgentSession, AgencyProfileCapabilities,
  BrowserProfile, ClientMessage,
  SessionActivity, SessionLifecycle, WorkspaceId, ProjectId, CliProfileId, WebTab, EditorTab,
} from '@anvilary/workbench-shared';

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
  browserProfiles: readonly BrowserProfile[];
  sessions: readonly AgencyRuntimeSession[];
  webTabs: readonly WebTab[];
  editorTabs: readonly EditorTab[];
  layouts: Record<WorkspaceId, import('@anvilary/workbench-shared').WorkspacePaneLayout>;
  layoutWarnings?: Record<WorkspaceId, string>;
}

export const EMPTY_AGENCY_SNAPSHOT: AgencySnapshot = {
  projects: [], workspaces: [], profiles: [], browserProfiles: [], sessions: [], webTabs: [], editorTabs: [], layouts: {}, layoutWarnings: {},
};

export function workspaceTabs(sessions: readonly AgencyRuntimeSession[], workspaceId: WorkspaceId): AgencyRuntimeSession[] {
  return sessions.filter(session => session.workspaceId === workspaceId && session.tab?.current && !session.tab.closedAt)
    .sort((a,b) => a.tab!.order - b.tab!.order || a.tab!.id.localeCompare(b.tab!.id));
}

/** Stable identities from native sessions, web tabs, and editor tabs share one server-owned selection and order. */
export type WorkspaceTab = {
  id: string; order: number; selected: boolean;
} & (
  | { kind: 'native'; session: AgencyRuntimeSession }
  | { kind: 'web'; web: WebTab }
  | { kind: 'editor'; editor: EditorTab }
);

export function allWorkspaceTabs(
  sessions: readonly AgencyRuntimeSession[],
  webTabs: readonly WebTab[],
  workspaceId: WorkspaceId,
  editorTabs: readonly EditorTab[] = [],
): WorkspaceTab[] {
  const native: WorkspaceTab[] = workspaceTabs(sessions, workspaceId).map(session => ({
    id: session.tab!.id, order: session.tab!.order, selected: session.tab!.selected, kind: 'native', session,
  }));
  const web: WorkspaceTab[] = webTabs.filter(tab => tab.workspaceId === workspaceId && !tab.closedAt).map(tab => ({
    id: tab.id, order: tab.order, selected: tab.selected, kind: 'web', web: tab,
  }));
  const editor: WorkspaceTab[] = editorTabs.filter(tab => tab.workspaceId === workspaceId && !tab.closedAt).map(tab => ({
    id: tab.id, order: tab.order, selected: tab.selected, kind: 'editor', editor: tab,
  }));
  return [...native, ...web, ...editor].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Conflicting or absent selection during reconciliation never displays an arbitrary target. */
export function selectedWorkspaceTab(tabs: readonly WorkspaceTab[]): WorkspaceTab | undefined {
  const selected = tabs.filter(tab => tab.selected);
  return selected.length === 1 ? selected[0] : undefined;
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

/**
 * Apply an `agency.sessions.snapshot`. A snapshot scoped to one workspace (server sets `workspaceId`)
 * replaces only that workspace's sessions; an unscoped snapshot is authoritative for all of them.
 */
export function applySessionsSnapshot(
  current: readonly AgencyRuntimeSession[],
  incoming: readonly AgencyRuntimeSession[],
  workspaceId?: WorkspaceId,
): AgencyRuntimeSession[] {
  if (workspaceId === undefined) return [...incoming];
  return [...current.filter(session => session.workspaceId !== workspaceId), ...incoming.filter(session => session.workspaceId === workspaceId)];
}

/** Apply an `agency.session.activity` update to the latest state (pure: safe inside a React updater). */
export function applySessionActivity(
  current: readonly AgencyRuntimeSession[],
  fallback: AgencyRuntimeSession | undefined,
  update: { sessionId: string; activity: SessionActivity; lifecycle: SessionLifecycle },
): AgencyRuntimeSession[] {
  const base = current.find(session => session.id === update.sessionId) ?? fallback;
  if (!base) return [...current];
  return replaceById(current, { ...base, activity: update.activity, lifecycle: update.lifecycle });
}

export function agentSession(session: AgencyRuntimeSession | undefined): AgencyAgentSession | undefined {
  return session?.kind === 'agent' ? session : undefined;
}

export type AgencySelectId = CliProfileId | '';
export type WorkspaceSelection = WorkspaceId | null;

/** Remove all client-cached records associated with a deleted workspace. */
export function pruneWorkspaceData(snapshot: AgencySnapshot, workspaceId: WorkspaceId): AgencySnapshot {
  const nextLayouts = snapshot.layouts ? { ...snapshot.layouts } : {};
  delete nextLayouts[workspaceId];
  const nextWarnings = snapshot.layoutWarnings ? { ...snapshot.layoutWarnings } : undefined;
  if (nextWarnings && workspaceId in nextWarnings) {
    delete nextWarnings[workspaceId];
  }
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.filter((w) => w.id !== workspaceId),
    sessions: snapshot.sessions.filter((s) => s.workspaceId !== workspaceId),
    webTabs: snapshot.webTabs.filter((t) => t.workspaceId !== workspaceId),
    editorTabs: snapshot.editorTabs.filter((t) => t.workspaceId !== workspaceId),
    layouts: nextLayouts,
    layoutWarnings: nextWarnings,
  };
}

/** Remove a deleted project and any client-cached workspace resources belonging to it. */
export function pruneProjectData(snapshot: AgencySnapshot, projectId: ProjectId): AgencySnapshot {
  const targetWorkspaceIds = new Set(
    snapshot.workspaces.filter((w) => w.projectId === projectId).map((w) => w.id),
  );
  const nextLayouts = snapshot.layouts ? { ...snapshot.layouts } : {};
  const nextWarnings = snapshot.layoutWarnings ? { ...snapshot.layoutWarnings } : undefined;
  for (const wsId of targetWorkspaceIds) {
    delete nextLayouts[wsId];
    if (nextWarnings && wsId in nextWarnings) delete nextWarnings[wsId];
  }
  return {
    ...snapshot,
    projects: snapshot.projects.filter((p) => p.id !== projectId),
    workspaces: snapshot.workspaces.filter((w) => w.projectId !== projectId),
    sessions: snapshot.sessions.filter((s) => !targetWorkspaceIds.has(s.workspaceId)),
    webTabs: snapshot.webTabs.filter((t) => !targetWorkspaceIds.has(t.workspaceId)),
    editorTabs: snapshot.editorTabs.filter((t) => !targetWorkspaceIds.has(t.workspaceId)),
    layouts: nextLayouts,
    layoutWarnings: nextWarnings,
  };
}

export function activeByProject(
  projects: readonly AgencyProject[], workspaces: readonly AgencyWorkspace[],
): { project: AgencyProject; items: AgencyWorkspace[] }[] {
  return projects
    .filter((project) => project.status !== 'archived')
    .map((project) => ({
      project,
      items: workspaces.filter((ws) => ws.projectId === project.id && ws.status === 'active'),
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

/** A creation reply may overtake a list snapshot that was taken before the launch. */
export function retainUnconfirmedCreations<T extends { id: string; updatedAt: string }>(
  snapshot: readonly T[], unconfirmed: Map<string, T>,
): T[] {
  const next = [...snapshot];
  for (const [id, created] of unconfirmed) {
    const observed = next.find(row => row.id === id);
    if (observed && observed.updatedAt >= created.updatedAt) {
      unconfirmed.delete(id);
    } else if (!observed) next.push(created);
    else next[next.indexOf(observed)] = created;
  }
  return next;
}

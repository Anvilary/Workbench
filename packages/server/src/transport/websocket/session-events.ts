/**
 * Live session and notification events fanned out to every socket, and the
 * glue that keeps tab activity in step with them.
 *
 * Shell tabs publish their activity through OSC 133 sequences read from the
 * terminal output, agent tabs through the CLI status and native turn events.
 * This module registers each tab with the activity manager, feeds it, and
 * broadcasts the resulting protocol messages.
 */

import type { OutputListener } from '../../features/terminals/terminal-registry.js';
import type { WorkbenchServices } from './services.js';
import type { SocketHub } from './socket-hub.js';
import type { TerminalHistoryAccess } from './terminal-history-access.js';

export interface SessionEventDeps {
  services: Pick<
    WorkbenchServices,
    | 'registry'
    | 'agencyRuntime'
    | 'agencyWorkspaceStore'
    | 'agencyActivityManager'
    | 'agencyNotificationStore'
    | 'tabReady'
  >;
  hub: Pick<SocketHub, 'broadcast'>;
  history: Pick<TerminalHistoryAccess, 'refreshHistoryBindings'>;
}

/** Subscribe to session, notification and tab activity events. Returns the function that removes them. */
export function wireSessionEvents(deps: SessionEventDeps): () => void {
  const { registry, agencyRuntime, agencyWorkspaceStore, agencyActivityManager, agencyNotificationStore, tabReady } =
    deps.services;
  const { broadcast } = deps.hub;
  const { refreshHistoryBindings } = deps.history;

  const attachedShellTerminals = new Set<string>();

  const shellOutputListener: OutputListener = (terminalId, chunk) => {
    const session = agencyRuntime.list().find((s) => s.terminalId === terminalId);
    if (session?.kind === 'terminal' && session.tab?.current && !session.tab.closedAt) {
      agencyActivityManager.feedShellOutput(session.tab.id, chunk);
    }
  };

  const syncShellTerminal = (session: any) => {
    if (session.kind === 'terminal' && session.terminalId && session.tab && ['starting', 'running'].includes(session.lifecycle)) {
      if (!attachedShellTerminals.has(session.terminalId)) {
        attachedShellTerminals.add(session.terminalId);
        agencyActivityManager.getOrCreateShellParser(session.workspaceId, session.tab.id, {
          tabName: session.tab.name,
          sessionId: session.id,
          projectId: agencyWorkspaceStore.getWorkspace(session.workspaceId)?.projectId,
        });
        const output = registry.attach(session.terminalId, shellOutputListener);
        if (output?.replay) agencyActivityManager.feedShellOutput(session.tab.id, output.replay);
      }
    } else if (session.terminalId && attachedShellTerminals.has(session.terminalId)) {
      attachedShellTerminals.delete(session.terminalId);
      registry.detach(session.terminalId, shellOutputListener);
    }
  };

  void tabReady.then(() => {
    for (const session of agencyRuntime.list()) syncShellTerminal(session);
  }).catch(() => undefined);

  const onAgencySessionChanged = (session: any): void => {
    refreshHistoryBindings();
    broadcast({ type: 'agency.session.changed', sessionId: session.id, session });
    void tabReady.then(async () => {
      const current = agencyRuntime.get(session.id);
      if (!current?.tab?.current) return;
      if (current.tab.closedAt) await agencyActivityManager.closeTab(current.workspaceId, current.tab.id);
      else {
        await agencyActivityManager.ensureTab({ workspaceId: current.workspaceId, tabId: current.tab.id,
          sessionId: current.id, source: current.kind === 'agent' ? 'cli' : 'shell' });
        syncShellTerminal(current);
      }
    }).catch(error => console.error('[agency] activity registration failed:', String(error)));
  };

  const onAgencySessionActivity = (activity: any): void => {
    broadcast({ type: 'agency.session.activity', ...activity });
    const session = agencyRuntime.get(activity.sessionId);
    if (session?.kind === 'agent' && session.tab?.current && !session.tab.closedAt && agencyWorkspaceStore.getWorkspace(session.workspaceId)) {
      const ws = agencyWorkspaceStore.getWorkspace(session.workspaceId);
      void agencyActivityManager.handleCliActivity({
        workspaceId: session.workspaceId,
        projectId: ws?.projectId,
        tabId: session.tab.id,
        sessionId: session.id,
        provider: session.nativeIdentity?.provider ?? null,
        tabName: session.tab.name,
        nextActivity: activity.activity,
        lifecycle: activity.lifecycle,
        exitCode: session.exitCode,
        completionEvidence: 'status-transition',
      }).catch(error => console.error('[agency] activity persistence failed:', String(error)));
    }
  };

  const onNativeTurn = (event: { sessionId: import('@agent-workbench/shared').RuntimeSessionId; workspaceId: import('@agent-workbench/shared').WorkspaceId; provider: string; taskId: string; phase: 'working' | 'finished' | 'failed' | 'unknown' }): void => {
    const session = agencyRuntime.get(event.sessionId);
    const workspace = agencyWorkspaceStore.getWorkspace(event.workspaceId);
    if (!workspace || !session || session.workspaceId !== event.workspaceId || !session.tab?.current || session.tab.closedAt) return;
    void agencyActivityManager.handleCliActivity({ workspaceId: event.workspaceId, projectId: workspace.projectId,
      tabId: session.tab.id, sessionId: session.id, provider: event.provider, tabName: session.tab.name,
      nextActivity: event.phase, lifecycle: session.lifecycle, taskId: event.taskId, completionEvidence: 'native-turn',
    }).catch(error => console.error('[agency] native activity persistence failed:', String(error)));
  };

  agencyRuntime.on('nativeTurn', onNativeTurn);

  agencyRuntime.on('changed', onAgencySessionChanged);

  agencyRuntime.on('activity', onAgencySessionActivity);

  const onNotificationCreated = (notification: any): void => {
    broadcast({ type: 'agency.notification.created', notification });
  };

  const onNotificationChanged = (notification: any): void => {
    broadcast({ type: 'agency.notification.changed', notification });
  };

  const onTabActivity = (record: any): void => {
    broadcast({ type: 'agency.tab.activity', activity: record });
  };

  agencyNotificationStore.on('created', onNotificationCreated);

  agencyNotificationStore.on('changed', onNotificationChanged);

  agencyActivityManager.on('tabActivity', onTabActivity);

  return () => {
    agencyRuntime.off('changed', onAgencySessionChanged);
    agencyRuntime.off('activity', onAgencySessionActivity);
    agencyRuntime.off('nativeTurn', onNativeTurn);
    registry.detachAll(shellOutputListener);
    agencyNotificationStore.off('created', onNotificationCreated);
    agencyNotificationStore.off('changed', onNotificationChanged);
    agencyActivityManager.off('tabActivity', onTabActivity);
  };
}

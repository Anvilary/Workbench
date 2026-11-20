/**
 * What a socket is told as soon as it connects.
 *
 * The first message is `hello`, followed by a snapshot of everything the page
 * needs to draw itself: terminals and their activity, the session index,
 * notes, drafts, settings and every workspace collection. Later changes arrive
 * as events.
 */

import { PROTOCOL_VERSION } from '@agent-workbench/shared';
import type { WebSocket } from 'ws';
import { draftEntriesOf } from '../../features/composer/draft-store.js';
import { listAgencyProfiles } from '../../features/profiles/profile-capabilities.js';
import type { WorkbenchServices } from './services.js';
import type { SocketHub } from './socket-hub.js';
import type { TerminalCommands } from './terminal-commands.js';

export interface InitialSnapshotDeps {
  socket: WebSocket;
  deviceId: string | null;
  services: Pick<
    WorkbenchServices,
    | 'agents'
    | 'defaultCwd'
    | 'appSettings'
    | 'registry'
    | 'index'
    | 'notes'
    | 'drafts'
    | 'vault'
    | 'remote'
    | 'agencyWorkspaceStore'
    | 'agencyProfileStore'
    | 'agencyIdentities'
    | 'agencyRuntime'
    | 'agencyNotificationStore'
    | 'agencyActivityManager'
    | 'tabCoordinator'
    | 'tabReady'
    | 'agencyBrowserTabs'
    | 'agencyEditorTabs'
    | 'planLimits'
  >;
  hub: Pick<SocketHub, 'send'>;
  commands: Pick<TerminalCommands, 'terminalListMessage'>;
}

export function sendInitialSnapshot(deps: InitialSnapshotDeps): void {
  const { socket, deviceId } = deps;
  const { agents, defaultCwd, appSettings, registry, index, notes, drafts, vault, remote, agencyWorkspaceStore, agencyProfileStore, agencyIdentities, agencyRuntime, agencyNotificationStore, agencyActivityManager, tabCoordinator, tabReady, agencyBrowserTabs, agencyEditorTabs, planLimits } =
    deps.services;
  const { send } = deps.hub;
  const { terminalListMessage } = deps.commands;

  send(socket, {
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    agents: agents.list(),
    defaultAgent: agents.defaultAgent(),
    platform: process.platform,
    defaultCwd,
    shellName: appSettings.currentShell()?.name ?? null,
    remoteClient: deviceId !== null,
    fileCheck: true,
    fileWrite: true,
  });

  send(socket, terminalListMessage());

  /*
    Lo que ya se sabe de cada pestana. La actividad viaja por evento, y sin
    esto una recarga dejaba sin punto a toda pestana que no cambiara de estado
    despues —con una CLI que no publica su estado, para siempre—.
  */
  for (const entry of registry.activitySnapshot()) {
    send(socket, { type: 'terminal.activity', ...entry });
  }

  send(socket, { type: 'index.status', status: index.getStatus() });

  send(socket, { type: 'index.projects', projects: index.getProjects(), replace: true });

  send(socket, { type: 'notes.list', notes: notes.list() });

  /*
    Los borradores del cuadro de cada pestana (§6.29), vacios incluidos: es la
    foto con la que la pagina sabe si se perdio algo mientras estuvo sin
    conexion. Va aunque no haya pestanas: tambien le dice que este servidor
    los guarda, y solo desde ahi manda los suyos.
  */
  send(socket, { type: 'composer.drafts', drafts: draftEntriesOf(registry.list(), drafts) });

  send(socket, { type: 'vault.status', status: vault.status() });

  if (deviceId === null) send(socket, { type: 'remote.status', status: remote.status() });

  send(socket, { type: 'settings.status', settings: appSettings.status() });

  send(socket, {
    type: 'agency.projects.snapshot',
    requestId: '',
    projects: agencyWorkspaceStore.listProjects(),
  });

  send(socket, {
    type: 'agency.workspaces.snapshot',
    requestId: '',
    workspaces: agencyWorkspaceStore.listWorkspaces(),
  });

  void listAgencyProfiles(agencyProfileStore, agents, { identities: agencyIdentities }).then((profiles) => {
    send(socket, {
      type: 'agency.profiles.snapshot',
      requestId: '',
      profiles,
    });
  }).catch(() => undefined);

  send(socket, {
    type: 'agency.sessions.snapshot',
    requestId: '',
    sessions: agencyRuntime.liveList(),
  });

  send(socket, {
    type: 'agency.notifications.snapshot',
    requestId: '',
    notifications: agencyNotificationStore.list(),
    activityStates: agencyActivityManager.snapshot(),
  });

  send(socket, {
    type: 'agency.layouts.snapshot',
    requestId: '',
    layouts: tabCoordinator.reconcileAllLayouts(),
  });

  void tabReady.then(() => {
    send(socket, { type: 'agency.webTabs.snapshot', requestId: '', tabs: agencyBrowserTabs.listTabs() });
    send(socket, { type: 'agency.editorTabs.snapshot', requestId: '', tabs: agencyEditorTabs.listTabs() });
    send(socket, { type: 'agency.notifications.snapshot', requestId: '', notifications: agencyNotificationStore.list(), activityStates: agencyActivityManager.snapshot() });
    send(socket, { type: 'agency.layouts.snapshot', requestId: '', layouts: tabCoordinator.reconcileAllLayouts() });
  }).catch(() => undefined);

  // Lo que ya se sabe del plan de cada CLI; lo que llegue despues va por `onChange`.
  planLimits.retain();

  const knownLimits = planLimits.snapshot();

  if (knownLimits.length > 0) send(socket, { type: 'plan.limits', limits: knownLimits });
}

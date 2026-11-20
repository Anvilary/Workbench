/**
 * Projects and workspaces.
 */

import type { ClientMessage } from '@agent-workbench/shared';
import {
  handleAgencyDomainRequest,
  type AgencyDomainContext,
} from '../../../features/workspaces/workspace-request-handler.js';
import type { HandlerContext } from '../handler-context.js';

export const workspaceMessageTypes = [
  'agency.projects.list',
  'agency.project.create',
  'agency.project.update',
  'agency.project.delete',
  'agency.project.archive',
  'agency.project.unarchive',
  'agency.projects.order',
  'agency.workspaces.list',
  'agency.workspace.create',
  'agency.workspace.update',
  'agency.workspace.done',
  'agency.workspace.restore',
  'agency.workspace.delete',
  'agency.workspace.archive',
  'agency.workspaces.order',
] as const;

type WorkspaceMessage = Extract<ClientMessage, { type: (typeof workspaceMessageTypes)[number] }>;

export async function handleWorkspaceMessage(
  message: WorkspaceMessage,
  ctx: HandlerContext<'agencyActivityManager' | 'agencyBrowserProfileStore' | 'agencyNotificationStore' | 'agencyRuntime' | 'agencyWorkspaceStore' | 'broadcast' | 'browserProfileMutations' | 'pickers' | 'projectMutations' | 'send' | 'socket' | 'tabCoordinator' | 'workspaceLock'>,
): Promise<void> {
  const { agencyActivityManager, agencyBrowserProfileStore, agencyNotificationStore, agencyRuntime, agencyWorkspaceStore, broadcast, browserProfileMutations, pickers, projectMutations, send, socket, tabCoordinator, workspaceLock } = ctx;
  switch (message.type) {
    case 'agency.projects.list':
    case 'agency.project.create':
    case 'agency.project.update':
    case 'agency.project.delete':
    case 'agency.project.archive':
    case 'agency.project.unarchive':
    case 'agency.projects.order':
    case 'agency.workspaces.list':
    case 'agency.workspace.create':
    case 'agency.workspace.update':
    case 'agency.workspace.done':
    case 'agency.workspace.restore':
    case 'agency.workspace.delete':
    case 'agency.workspace.archive':
    case 'agency.workspaces.order': {
      const domainContext: AgencyDomainContext = {
        store: agencyWorkspaceStore,
        browserProfiles: agencyBrowserProfileStore,
        pickers,
        withSessionReservationLock: (id, op) => workspaceLock.runExclusive(id, op),
        runWorkspaceExclusive: (id, op) => tabCoordinator.mutations.runExclusive(id, op),
        hasBlockingSessions: async (id) => agencyRuntime.hasWorkspaceReferences(id) || tabCoordinator.hasBrowserReferences(id) || tabCoordinator.hasEditorReferences(id),
        publish: (broadcastMsg) => broadcast(broadcastMsg),
        shutdownWorkspace: (id) => tabCoordinator.shutdownWorkspace(id),
      };
      const handle = () => handleAgencyDomainRequest(message, domainContext);
      const handleOrdered = () => {
        if (message.type === 'agency.project.delete' || message.type === 'agency.workspace.create') {
          return projectMutations.runExclusive(message.projectId, handle);
        }
        if ('workspaceId' in message && message.type !== 'agency.workspace.delete') {
          return tabCoordinator.mutations.runExclusive(message.workspaceId, handle);
        }
        return handle();
      };
      const profileId = (message.type === 'agency.workspace.update' || message.type === 'agency.project.update')
        ? message.browserProfileId : undefined;
      const domainResponse = profileId
        ? await browserProfileMutations.runExclusive(profileId, handleOrdered)
        : await handleOrdered();
      if (message.type === 'agency.project.delete' && domainResponse?.type === 'agency.project.deleted') {
        const removed = await agencyNotificationStore.purgeProject(message.projectId).catch(() => 0);
        if (removed > 0) {
          broadcast({
            type: 'agency.notifications.snapshot',
            requestId: '',
            notifications: agencyNotificationStore.list(),
            activityStates: agencyActivityManager.snapshot(),
          });
        }
      }
      if (domainResponse !== null) {
        send(socket, domainResponse);
      }
      break;
    }
  }
}

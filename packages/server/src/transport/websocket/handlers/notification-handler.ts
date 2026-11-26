/**
 * Notifications and tab activity acknowledgement.
 */

import type { RequestId, ServerMessage } from '@anvilary/workbench-shared';
import type { ClientMessage } from '@anvilary/workbench-shared';
import type { WebSocket } from 'ws';
import { AgencyNotificationStore } from '../../../features/notifications/notification-store.js';
import { TabActivityManager } from '../../../features/notifications/tab-activity-manager.js';
import { AgencyWorkspaceStore } from '../../../features/workspaces/workspace-store.js';
import type { HandlerContext } from '../handler-context.js';

export interface DoneHandlerContext {
  agencyNotificationStore: AgencyNotificationStore;
  agencyActivityManager: TabActivityManager;
  agencyWorkspaceStore: Pick<AgencyWorkspaceStore, 'getWorkspace'>;
  send: (socket: WebSocket, message: ServerMessage) => void;
}

export async function handleAgencyNotificationDone(
  message: { type: 'agency.notification.done'; requestId: RequestId; notificationId: string },
  socket: WebSocket,
  context: DoneHandlerContext,
): Promise<void> {
  const item = context.agencyNotificationStore.get(message.notificationId);
  if (!item) {
    context.send(socket, { type: 'agency.error', requestId: message.requestId, code: 'not-found', message: 'Notification not found' });
    return;
  }
  const workspace = context.agencyWorkspaceStore.getWorkspace(item.workspaceId);

  try {
    // Durably acknowledge the notification item even if its workspace was already deleted,
    // so orphaned notifications are never permanently undismissable.
    const updated = await context.agencyNotificationStore.acknowledge(message.notificationId);
    if (!updated) {
      context.send(socket, { type: 'agency.error', requestId: message.requestId, code: 'not-found', message: 'Notification not found' });
      return;
    }

    // Atomic turn-specific acknowledgement before reporting success:
    // When old/legacy notifications lack identity, fail safely by completing only the inbox item,
    // not guessing the current turn. Skip tab activity update if the workspace was deleted.
    const notifTaskId = (item.metadata?.taskId as string | undefined) ?? (item.deduplicationKey?.split(':').slice(3).join(':') || undefined);
    const notifTurnSeq = item.metadata?.turnSequence as number | undefined;

    if (workspace && item.tabId && (notifTaskId || notifTurnSeq !== undefined)) {
      await context.agencyActivityManager.acknowledgeMatchingTurn(item.workspaceId, item.tabId, {
        taskId: notifTaskId,
        turnSequence: notifTurnSeq,
      });
    }

    // Send success to caller only after intended acknowledgement has been durably processed
    context.send(socket, { type: 'agency.notification.changed', requestId: message.requestId, notification: updated });
  } catch (error) {
    context.send(socket, {
      type: 'agency.error',
      requestId: message.requestId,
      code: 'internal-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export const notificationMessageTypes = [
  'agency.notifications.list',
  'agency.notification.markRead',
  'agency.notification.markAllRead',
  'agency.notification.dismiss',
  'agency.notification.done',
  'agency.tab.acknowledge',
] as const;

type NotificationMessage = Extract<ClientMessage, { type: (typeof notificationMessageTypes)[number] }>;

export async function handleNotificationMessage(
  message: NotificationMessage,
  ctx: HandlerContext<'agencyActivityManager' | 'agencyNotificationStore' | 'agencyWorkspaceStore' | 'broadcast' | 'send' | 'socket' | 'tabCoordinator'>,
): Promise<void> {
  const { agencyActivityManager, agencyNotificationStore, agencyWorkspaceStore, broadcast, send, socket, tabCoordinator } = ctx;
  switch (message.type) {
    case 'agency.notifications.list': {
      send(socket, {
        type: 'agency.notifications.snapshot',
        requestId: message.requestId,
        notifications: agencyNotificationStore.list(),
        activityStates: agencyActivityManager.snapshot(),
      });
      break;
    }
    case 'agency.notification.markRead': {
      const item = await agencyNotificationStore.markRead(message.notificationId);
      if (item) {
        send(socket, { type: 'agency.notification.changed', requestId: message.requestId, notification: item });
      } else {
        send(socket, { type: 'agency.error', requestId: message.requestId, code: 'not-found', message: 'Notification not found' });
      }
      break;
    }
    case 'agency.notification.markAllRead': {
      await agencyNotificationStore.markAllRead();
      send(socket, {
        type: 'agency.notifications.snapshot',
        requestId: message.requestId,
        notifications: agencyNotificationStore.list(),
      });
      break;
    }
    case 'agency.notification.dismiss': {
      const item = await agencyNotificationStore.dismiss(message.notificationId);
      if (item) {
        send(socket, { type: 'agency.notification.changed', requestId: message.requestId, notification: item });
      } else {
        send(socket, { type: 'agency.error', requestId: message.requestId, code: 'not-found', message: 'Notification not found' });
      }
      break;
    }
    case 'agency.notification.done': {
      await handleAgencyNotificationDone(message, socket, {
        agencyNotificationStore,
        agencyActivityManager,
        agencyWorkspaceStore,
        send,
      });
      break;
    }
    case 'agency.tab.acknowledge': {
      const record = await tabCoordinator.inspect(message.workspaceId, message.tabId,
        () => agencyActivityManager.acknowledgeTab(message.workspaceId, message.tabId));
      if (record) {
        send(socket, { type: 'agency.tab.activity', requestId: message.requestId, activity: record });
        broadcast({ type: 'agency.tab.activity', activity: record });
      } else {
        send(socket, { type: 'agency.error', requestId: message.requestId, code: 'not-found', message: 'Tab activity not found or already acknowledged' });
      }
      break;
    }
  }
}

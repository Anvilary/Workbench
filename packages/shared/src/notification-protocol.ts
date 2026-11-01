/**
 * MAW Lane C - Notification & Activity State Protocol.
 *
 * State model:
 *   - idle
 *   - working
 *   - needs-input
 *   - finished (shown as completed)
 *   - unknown
 *   - failed
 *
 * Rules:
 *   - A task enters 'finished' only when a reliable completion signal exists.
 *   - The 'finished' state persists until the user opens the corresponding tab
 *     and inspects/acknowledges its result, then returns to 'idle'.
 *   - Reading a notification in the inbox and acknowledging task completion on the
 *     tab are related but distinct operations.
 */

import type { IsoTimestamp, ProjectId, RequestId, RuntimeSessionId, WorkspaceId } from './agency-protocol.js';

export type MawActivityState = 'idle' | 'working' | 'needs-input' | 'finished' | 'unknown' | 'failed';

export function isMawActivityState(value: unknown): value is MawActivityState {
  return typeof value === 'string' && ['idle', 'working', 'needs-input', 'finished', 'unknown', 'failed'].includes(value);
}

export type NotificationSourceKind = 'cli' | 'shell' | 'browser' | 'manual';

export interface MawNotificationItem {
  id: string;
  workspaceId: WorkspaceId;
  projectId?: ProjectId;
  tabId: string;
  sessionId?: RuntimeSessionId;
  title: string;
  body: string;
  state: MawActivityState;
  read: boolean;
  createdAt: IsoTimestamp;
  readAt?: IsoTimestamp | null;
  dismissedAt?: IsoTimestamp | null;
  acknowledgedAt?: IsoTimestamp | null;
  deduplicationKey?: string;
  metadata?: Record<string, unknown>;
}

export interface TabActivityRecord {
  workspaceId: WorkspaceId;
  tabId: string;
  sessionId?: RuntimeSessionId;
  taskId?: string;
  turnSequence?: number;
  state: MawActivityState;
  updatedAt: IsoTimestamp;
  reliableSignal: boolean;
  acknowledgedAt?: IsoTimestamp | null;
  source: NotificationSourceKind;
  detail?: string;
  closed?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isValidIsoTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function isMawNotificationItem(value: unknown): value is MawNotificationItem {
  if (!isRecord(value)) return false;
  if (!isValidId(value.id)) return false;
  if (!isValidId(value.workspaceId)) return false;
  if (value.projectId !== undefined && !isValidId(value.projectId)) return false;
  if (typeof value.tabId !== 'string' || value.tabId.length === 0) return false;
  if (value.sessionId !== undefined && value.sessionId !== null && !isValidId(value.sessionId)) return false;
  if (typeof value.title !== 'string' || typeof value.body !== 'string') return false;
  if (!isMawActivityState(value.state)) return false;
  if (typeof value.read !== 'boolean') return false;
  if (!isValidIsoTimestamp(value.createdAt)) return false;
  if (value.readAt !== undefined && value.readAt !== null && !isValidIsoTimestamp(value.readAt)) return false;
  if (value.dismissedAt !== undefined && value.dismissedAt !== null && !isValidIsoTimestamp(value.dismissedAt)) return false;
  if (value.acknowledgedAt !== undefined && value.acknowledgedAt !== null && !isValidIsoTimestamp(value.acknowledgedAt)) return false;
  if (value.deduplicationKey !== undefined && typeof value.deduplicationKey !== 'string') return false;
  return true;
}

export function isTabActivityRecord(value: unknown): value is TabActivityRecord {
  if (!isRecord(value)) return false;
  if (!isValidId(value.workspaceId)) return false;
  if (typeof value.tabId !== 'string' || value.tabId.length === 0) return false;
  if (value.sessionId !== undefined && value.sessionId !== null && !isValidId(value.sessionId)) return false;
  if (value.taskId !== undefined && value.taskId !== null && typeof value.taskId !== 'string') return false;
  if (value.turnSequence !== undefined && value.turnSequence !== null && typeof value.turnSequence !== 'number') return false;
  if (!isMawActivityState(value.state)) return false;
  if (!isValidIsoTimestamp(value.updatedAt)) return false;
  if (typeof value.reliableSignal !== 'boolean') return false;
  if (value.acknowledgedAt !== undefined && value.acknowledgedAt !== null && !isValidIsoTimestamp(value.acknowledgedAt)) return false;
  if (!['cli', 'shell', 'browser', 'manual'].includes(value.source as string)) return false;
  if (value.detail !== undefined && typeof value.detail !== 'string') return false;
  if (value.closed !== undefined && typeof value.closed !== 'boolean') return false;
  return true;
}

export type NotificationClientMessage =
  | { type: 'agency.notifications.list'; requestId: RequestId }
  | { type: 'agency.notification.markRead'; requestId: RequestId; notificationId: string }
  | { type: 'agency.notification.markAllRead'; requestId: RequestId }
  | { type: 'agency.notification.dismiss'; requestId: RequestId; notificationId: string }
  | { type: 'agency.notification.done'; requestId: RequestId; notificationId: string }
  | { type: 'agency.tab.acknowledge'; requestId: RequestId; workspaceId: WorkspaceId; tabId: string };

export type NotificationServerMessage =
  | {
      type: 'agency.notifications.snapshot';
      requestId: RequestId;
      notifications: readonly MawNotificationItem[];
      activityStates?: readonly TabActivityRecord[];
    }
  | {
      type: 'agency.notification.created';
      requestId?: RequestId;
      notification: MawNotificationItem;
    }
  | {
      type: 'agency.notification.changed';
      requestId?: RequestId;
      notification: MawNotificationItem;
    }
  | {
      type: 'agency.tab.activity';
      requestId?: RequestId;
      activity: TabActivityRecord;
    };

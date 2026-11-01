/**
 * MAW Lane C - Client Notification & Activity State Store.
 *
 * Responsibilities:
 *   - Manages notifications inbox, unread counts, and top-right toasts.
 *   - Tracks tab activity states: idle, working, finished, unknown, failed.
 *   - Enforces invariant: 'finished' state persists until user opens/inspects tab.
 *   - Enforces invariant: Reading notification inbox != acknowledging tab completion.
 *   - Toast dismissal does not delete inbox history.
 *   - Deduplicates repeated completion events.
 *   - Preserves state across browser refresh (localStorage cache + server snapshot).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { nativeLayoutCoordinator } from './native-layout-coordinator.js';
import type {
  MawActivityState,
  MawNotificationItem,
  TabActivityRecord,
  WorkspaceId,
} from '@agent-workbench/shared';
import { isMawNotificationItem } from '@agent-workbench/shared';
import type { AgencyTransport } from './model.js';
import type { useAgencyStore } from './useAgencyStore.js';

const CACHE_KEY = 'maw.notifications.cache.v1';

export interface ToastItem {
  id: string;
  notificationId: string;
  workspaceId: WorkspaceId;
  tabId: string;
  title: string;
  body: string;
  state: MawActivityState;
  createdAt: string;
  metadata?: Record<string, unknown>;
  deduplicationKey?: string;
}

function loadCachedNotifications(): MawNotificationItem[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(isMawNotificationItem).filter(item => !item.acknowledgedAt);
    }
  } catch {}
  return [];
}

function saveCachedNotifications(items: readonly MawNotificationItem[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(items.filter(item => !item.acknowledgedAt).slice(0, 100)));
  } catch {}
}

export function useNotificationStore(
  transport: AgencyTransport,
  request: ReturnType<typeof useAgencyStore>['request'],
  enabled: boolean = true,
) {
  const [notifications, setNotifications] = useState<MawNotificationItem[]>(loadCachedNotifications);
  const [activityStates, setActivityStates] = useState<Map<string, TabActivityRecord>>(new Map());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seenNotificationIds = useRef(new Set(notifications.map(item => item.id)));
  const completedNotificationIds = useRef(new Set<string>());
  const toastTimeouts = useRef(new Map<string, number>());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) {
      for (const timer of toastTimeouts.current.values()) window.clearTimeout(timer);
      toastTimeouts.current.clear();
      setToasts([]);
    }
  }, [enabled]);

  useEffect(() => () => {
    for (const timer of toastTimeouts.current.values()) window.clearTimeout(timer);
    toastTimeouts.current.clear();
  }, []);

  // Sync cache
  useEffect(() => {
    saveCachedNotifications(notifications);
  }, [notifications]);

  const dismissToast = useCallback((toastId: string) => {
    const timer = toastTimeouts.current.get(toastId);
    if (timer) {
      window.clearTimeout(timer);
      toastTimeouts.current.delete(toastId);
    }
    setToasts((prev) => prev.filter((t) => t.id !== toastId));
  }, []);

  const pushToast = useCallback((item: MawNotificationItem) => {
    const toastId = crypto.randomUUID();
    const toast: ToastItem = {
      id: toastId,
      notificationId: item.id,
      workspaceId: item.workspaceId,
      tabId: item.tabId,
      title: item.title,
      body: item.body,
      state: item.state,
      createdAt: item.createdAt,
      metadata: item.metadata,
      deduplicationKey: item.deduplicationKey,
    };

    setToasts((prev) => [...prev, toast]);

    // Auto-dismiss after 6.5s
    const timer = window.setTimeout(() => {
      dismissToast(toastId);
    }, 6500);
    toastTimeouts.current.set(toastId, timer);
  }, [dismissToast]);

  // Inbound WebSocket message handling
  useEffect(() => {
    return transport.onMessage((message) => {
      if (message.type === 'agency.notifications.snapshot') {
        const seenInSnapshot = new Set<string>();
        const incoming = message.notifications.filter(
          item => {
            if (item.state !== 'finished' && item.state !== 'failed') return false;
            if (item.acknowledgedAt || completedNotificationIds.current.has(item.id)) return false;
            if (seenInSnapshot.has(item.id)) return false;
            seenInSnapshot.add(item.id);
            return true;
          },
        );
        setNotifications(incoming);

        for (const item of incoming) {
          seenNotificationIds.current.add(item.id);
        }

        if (message.activityStates && Array.isArray(message.activityStates)) {
          setActivityStates(new Map(message.activityStates.map(record => [
            `${record.workspaceId}::${record.tabId}`, record,
          ])));
        }
      } else if (message.type === 'agency.notification.created') {
        const item: MawNotificationItem = message.notification;
        if (!item) return;

        // Decision 2: Only verified completion or failure.
        // No notifications for task started, working, unknown activity, or unverified completion.
        const isVerifiedCompletion = item.state === 'finished' || item.state === 'failed';
        if (!isVerifiedCompletion) return;

        if (seenNotificationIds.current.has(item.id) || item.acknowledgedAt || completedNotificationIds.current.has(item.id)) return;
        seenNotificationIds.current.add(item.id);

        setNotifications((prev) => {
          if (prev.some((n) => n.id === item.id)) return prev;
          return [item, ...prev];
        });

        // Decision 2: Suppress the transient toast only when:
        // 1. The application window is focused.
        // 2. The completed tab is actually visible and active.
        // When focus or visibility cannot be determined reliably, do not silently discard an otherwise valid completion toast.
        const hasReliableFocusAndVisibility =
          typeof document !== 'undefined' &&
          typeof document.hasFocus === 'function' &&
          !document.hidden &&
          document.hasFocus();

        const isActivelyViewed = hasReliableFocusAndVisibility && nativeLayoutCoordinator.isViewing(item.tabId);

        if (enabledRef.current && !isActivelyViewed) {
          pushToast(item);
        }
      } else if (message.type === 'agency.notification.changed') {
        const item: MawNotificationItem = message.notification;
        if (!item) return;

        if (item.acknowledgedAt) {
          completedNotificationIds.current.add(item.id);
          setToasts((prev) => prev.filter((t) => t.notificationId !== item.id));
          setNotifications((prev) => prev.filter((existing) => existing.id !== item.id));
        } else {
          setNotifications((prev) =>
            prev.map((existing) => (existing.id === item.id ? item : existing)),
          );
        }
      } else if (message.type === 'agency.tab.activity') {
        const record: TabActivityRecord = message.activity;
        if (!record) return;

        setActivityStates((prev) => {
          const next = new Map(prev);
          next.set(`${record.workspaceId}::${record.tabId}`, record);
          return next;
        });
      }
    });
  }, [transport, pushToast]);

  // Server events are authoritative. A failed mutation cannot erase a concurrent completion.
  const markRead = useCallback(async (notificationId: string) => {
    await request({ type: 'agency.notification.markRead', notificationId });
  }, [request]);

  const markAllRead = useCallback(async () => {
    await request({ type: 'agency.notification.markAllRead' });
  }, [request]);

  const markDone = useCallback(async (notificationId: string) => {
    let removedNotification: MawNotificationItem | undefined;
    let removedToasts: ToastItem[] = [];

    // Optimistically remove from visible lists
    setNotifications((prev) => {
      removedNotification = prev.find((n) => n.id === notificationId);
      return prev.filter((n) => n.id !== notificationId);
    });
    setToasts((prev) => {
      removedToasts = prev.filter((t) => t.notificationId === notificationId);
      return prev.filter((t) => t.notificationId !== notificationId);
    });

    try {
      await request({ type: 'agency.notification.done', notificationId });
      // Only commit permanent suppression against snapshots on confirmed success
      completedNotificationIds.current.add(notificationId);
    } catch (error) {
      // Explicit rollback on failure: restore state and ensure ID is never suppressed
      completedNotificationIds.current.delete(notificationId);
      if (removedNotification) {
        setNotifications((prev) => {
          if (prev.some((n) => n.id === notificationId)) return prev;
          return [removedNotification!, ...prev];
        });
      }
      if (removedToasts.length > 0) {
        setToasts((prev) => [...prev, ...removedToasts]);
      }
      throw error;
    }
  }, [request]);

  const acknowledgeTab = useCallback(async (workspaceId: WorkspaceId, tabId: string) => {
    await request({ type: 'agency.tab.acknowledge', workspaceId, tabId });
  }, [request]);

  const getTabActivity = useCallback((workspaceId: WorkspaceId, tabId: string): MawActivityState => {
    const key = `${workspaceId}::${tabId}`;
    return activityStates.get(key)?.state ?? 'unknown';
  }, [activityStates]);

  const unreadCount = notifications.filter((n) => !n.read && !n.acknowledgedAt).length;

  return {
    notifications,
    unreadCount,
    toasts,
    activityStates,
    markRead,
    markAllRead,
    markDone,
    dismissToast,
    acknowledgeTab,
    getTabActivity,
  };
}

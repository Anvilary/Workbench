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
import type {
  MawActivityState,
  MawNotificationItem,
  TabActivityRecord,
  WorkspaceId,
} from '@agent-workbench/shared';
import type { AgencyTransport } from './model.js';

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
}

function loadCachedNotifications(): MawNotificationItem[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return [];
}

function saveCachedNotifications(items: readonly MawNotificationItem[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(items.slice(0, 100)));
  } catch {}
}

export function useNotificationStore(
  transport: AgencyTransport,
  request: (payload: any) => Promise<any>,
) {
  const [notifications, setNotifications] = useState<MawNotificationItem[]>(loadCachedNotifications);
  const [activityStates, setActivityStates] = useState<Map<string, TabActivityRecord>>(new Map());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seenNotificationIds = useRef(new Set<string>());
  const toastTimeouts = useRef(new Map<string, number>());

  // Sync cache
  useEffect(() => {
    saveCachedNotifications(notifications);
  }, [notifications]);

  // Request notifications snapshot once on mount
  useEffect(() => {
    void request({ type: 'agency.notifications.list' }).catch(() => undefined);
  }, [request]);

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
    return transport.onMessage((message: any) => {
      if (message.type === 'agency.notifications.snapshot') {
        const incoming: MawNotificationItem[] = message.notifications || [];
        setNotifications(incoming);

        for (const item of incoming) {
          seenNotificationIds.current.add(item.id);
        }

        if (message.activityStates && Array.isArray(message.activityStates)) {
          setActivityStates((prev) => {
            const next = new Map(prev);
            for (const record of message.activityStates) {
              next.set(`${record.workspaceId}::${record.tabId}`, record);
            }
            return next;
          });
        }
      } else if (message.type === 'agency.notification.created') {
        const item: MawNotificationItem = message.notification;
        if (!item || seenNotificationIds.current.has(item.id)) return;
        seenNotificationIds.current.add(item.id);

        setNotifications((prev) => {
          if (prev.some((n) => n.id === item.id)) return prev;
          return [item, ...prev];
        });

        pushToast(item);
      } else if (message.type === 'agency.notification.changed') {
        const item: MawNotificationItem = message.notification;
        if (!item) return;

        setNotifications((prev) =>
          prev.map((existing) => (existing.id === item.id ? item : existing)),
        );
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

  const markRead = useCallback(async (notificationId: string) => {
    let previousList: MawNotificationItem[] = [];
    setNotifications((prev) => {
      previousList = prev;
      return prev.map((item) =>
        item.id === notificationId
          ? { ...item, read: true, readAt: new Date().toISOString() }
          : item,
      );
    });
    try {
      const res = await request({ type: 'agency.notification.markRead', notificationId });
      if (res && res.type === 'agency.error') {
        throw new Error(res.message);
      }
    } catch (err) {
      setNotifications(previousList);
      throw err;
    }
  }, [request]);

  const markAllRead = useCallback(async () => {
    let previousList: MawNotificationItem[] = [];
    const now = new Date().toISOString();
    setNotifications((prev) => {
      previousList = prev;
      return prev.map((item) => (!item.read ? { ...item, read: true, readAt: now } : item));
    });
    try {
      const res = await request({ type: 'agency.notification.markAllRead' });
      if (res && res.type === 'agency.error') {
        throw new Error(res.message);
      }
    } catch (err) {
      setNotifications(previousList);
      throw err;
    }
  }, [request]);

  const acknowledgeTab = useCallback(async (workspaceId: WorkspaceId, tabId: string) => {
    const key = `${workspaceId}::${tabId}`;
    let previousStates: Map<string, TabActivityRecord> = new Map();
    setActivityStates((prev) => {
      previousStates = prev;
      const current = prev.get(key);
      if (current && current.state === 'finished') {
        const next = new Map(prev);
        next.set(key, { ...current, state: 'idle', updatedAt: new Date().toISOString() });
        return next;
      }
      return prev;
    });

    try {
      const res = await request({ type: 'agency.tab.acknowledge', workspaceId, tabId });
      if (res && res.type === 'agency.error') {
        throw new Error(res.message);
      }
    } catch (err) {
      setActivityStates(previousStates);
      throw err;
    }
  }, [request]);

  const getTabActivity = useCallback((workspaceId: WorkspaceId, tabId: string): MawActivityState => {
    const key = `${workspaceId}::${tabId}`;
    return activityStates.get(key)?.state ?? 'unknown';
  }, [activityStates]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return {
    notifications,
    unreadCount,
    toasts,
    activityStates,
    markRead,
    markAllRead,
    dismissToast,
    acknowledgeTab,
    getTabActivity,
  };
}

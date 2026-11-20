/**
 * MAW Lane C - Client Notification & Activity State Store.
 *
 * Responsibilities:
 *   - Manages notifications inbox, unread counts, and top-right toasts.
 *   - Tracks tab activity states: idle, working, needs-input, finished, unknown, failed.
 *   - Enforces invariant: 'finished' state persists until user opens/inspects tab.
 *   - Enforces invariant: Reading notification inbox != acknowledging tab completion.
 *   - Focus-aware suppression: suppresses redundant alerts for actively viewed sessions.
 *   - Dual-channel routing: In-app toasts when focused on another tab; OS desktop alert when unfocused/minimized.
 *   - Anti-storm protection: coalesces rapid burst notifications into grouped summary.
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
import { isMawNotificationItem } from '@agent-workbench/shared';
import type { AgencyTransport } from '../workspaces/workspace-model.js';
import type { useWorkbenchStore } from '../workspaces/useWorkbenchStore.js';
import { focusTracker, type FocusContext } from '../panes/focus-tracker.js';

const CACHE_KEY = 'maw.notifications.cache.v1';
const MAX_TOASTS = 4;

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

export interface NotificationStoreOptions {
  activeWorkspaceId?: WorkspaceId | null;
  showingDone?: boolean;
  activeTabId?: string | null;
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
  request: ReturnType<typeof useWorkbenchStore>['request'],
  enabled: boolean = true,
  options?: NotificationStoreOptions,
) {
  const [notifications, setNotifications] = useState<MawNotificationItem[]>(loadCachedNotifications);
  const [activityStates, setActivityStates] = useState<Map<string, TabActivityRecord>>(new Map());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seenNotificationIds = useRef(new Set(notifications.map(item => item.id)));
  const completedNotificationIds = useRef(new Set<string>());
  const toastTimeouts = useRef(new Map<string, number>());
  const recentOsNotifications = useRef<number[]>([]);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const optionsRef = useRef(options);
  optionsRef.current = options;

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

    setToasts((prev) => {
      // Bound visible toasts to prevent overflowing the view
      const trimmed = prev.length >= MAX_TOASTS ? prev.slice(prev.length - (MAX_TOASTS - 1)) : prev;
      return [...trimmed, toast];
    });

    // Auto-dismiss after 6.5s
    const timer = window.setTimeout(() => {
      dismissToast(toastId);
    }, 6500);
    toastTimeouts.current.set(toastId, timer);
  }, [dismissToast]);

  const dispatchOsNotification = useCallback((item: { workspaceId: WorkspaceId; tabId: string; id: string; title: string; body: string }) => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    const now = Date.now();
    // Prune entries older than 2000 ms
    recentOsNotifications.current = recentOsNotifications.current.filter((t) => now - t < 2000);

    try {
      // Anti-storm: when 3 or more alerts fire within 2s, coalesce into a grouped alert
      if (recentOsNotifications.current.length >= 2) {
        const count = recentOsNotifications.current.length + 1;
        const groupNotif = new Notification('MAW', {
          body: `${count} coding agents completed tasks`,
          tag: 'maw-burst-summary',
        });
        groupNotif.onclick = () => {
          if (typeof window !== 'undefined') {
            window.focus();
            window.dispatchEvent(
              new CustomEvent('maw:select-tab', {
                detail: { workspaceId: item.workspaceId, tabId: item.tabId, notificationId: item.id },
              }),
            );
          }
        };
        recentOsNotifications.current.push(now);
        return;
      }

      recentOsNotifications.current.push(now);
      const osNotif = new Notification(item.title, {
        body: item.body,
        tag: 'maw-' + item.id,
      });
      osNotif.onclick = () => {
        if (typeof window !== 'undefined') {
          window.focus();
          window.dispatchEvent(
            new CustomEvent('maw:select-tab', {
              detail: { workspaceId: item.workspaceId, tabId: item.tabId, notificationId: item.id },
            }),
          );
        }
      };
    } catch {
      // Notification constructor safe fallback
    }
  }, []);

  // Inbound WebSocket message handling
  useEffect(() => {
    return transport.onMessage((message) => {
      if (message.type === 'agency.notifications.snapshot') {
        const seenInSnapshot = new Set<string>();
        const incoming = message.notifications.filter(
          item => {
            if (item.state !== 'finished' && item.state !== 'failed' && item.state !== 'needs-input') return false;
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

        // Relevant states: verified completion, failure, or needs-input
        const isAlertableState = item.state === 'finished' || item.state === 'failed' || item.state === 'needs-input';
        if (!isAlertableState) return;

        if (seenNotificationIds.current.has(item.id) || item.acknowledgedAt || completedNotificationIds.current.has(item.id)) return;
        seenNotificationIds.current.add(item.id);

        setNotifications((prev) => {
          if (prev.some((n) => n.id === item.id)) return prev;
          return [item, ...prev];
        });

        if (!enabledRef.current) return;

        const context: FocusContext = {
          activeWorkspaceId: optionsRef.current?.activeWorkspaceId ?? null,
          showingDone: Boolean(optionsRef.current?.showingDone),
          activeTabId: optionsRef.current?.activeTabId ?? null,
        };

        const channel = focusTracker.determineDeliveryChannel(item, context);

        if (channel === 'suppress') {
          // Suppress redundant alert: user is actively viewing this tab
          return;
        }

        if (channel === 'os') {
          dispatchOsNotification(item);
          if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
            pushToast(item);
          }
        } else {
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
  }, [transport, pushToast, dispatchOsNotification]);

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

  /**
   * Helper for client-side attention/input requests (e.g. from session transitions).
   * Routes cleanly through focus-aware suppression and click navigation.
   */
  const notifySessionAttention = useCallback((input: {
    workspaceId: WorkspaceId;
    tabId: string;
    sessionId?: string;
    title: string;
    body: string;
  }) => {
    if (!enabledRef.current) return;

    const context: FocusContext = {
      activeWorkspaceId: optionsRef.current?.activeWorkspaceId ?? null,
      showingDone: Boolean(optionsRef.current?.showingDone),
      activeTabId: optionsRef.current?.activeTabId ?? null,
    };

    const channel = focusTracker.determineDeliveryChannel(input, context);
    if (channel === 'suppress') return;

    const fakeItem: MawNotificationItem = {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      tabId: input.tabId,
      title: input.title,
      body: input.body,
      state: 'needs-input',
      read: false,
      createdAt: new Date().toISOString(),
    };

    if (channel === 'os') {
      dispatchOsNotification(fakeItem);
    } else {
      pushToast(fakeItem);
    }
  }, [dispatchOsNotification, pushToast]);

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
    notifySessionAttention,
  };
}

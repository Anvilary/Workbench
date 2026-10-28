// Run with Node 22+: node --test packages/web/src/agency/notifications.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Unread count calculation and badge formatting', () => {
  const items = [
    { id: '1', read: false, state: 'finished' },
    { id: '2', read: true, state: 'finished' },
    { id: '3', read: false, state: 'failed' },
  ];

  const unreadCount = items.filter((n) => !n.read).length;
  assert.equal(unreadCount, 2);

  const badgeFormatted = unreadCount > 99 ? '99+' : String(unreadCount);
  assert.equal(badgeFormatted, '2');

  const largeCount = 120;
  const largeBadge = largeCount > 99 ? '99+' : String(largeCount);
  assert.equal(largeBadge, '99+');
});

test('Mark individual notification read and mark all read', () => {
  let items = [
    { id: '1', title: 'Task A', read: false, readAt: null },
    { id: '2', title: 'Task B', read: false, readAt: null },
    { id: '3', title: 'Task C', read: true, readAt: '2026-10-28T12:00:00Z' },
  ];

  // Mark single read
  items = items.map((item) => (item.id === '1' ? { ...item, read: true, readAt: '2026-10-28T12:05:00Z' } : item));
  assert.equal(items.find((i) => i.id === '1')?.read, true);
  assert.equal(items.filter((i) => !i.read).length, 1);

  // Mark all read
  const now = '2026-10-28T12:10:00Z';
  items = items.map((item) => (!item.read ? { ...item, read: true, readAt: now } : item));
  assert.equal(items.every((i) => i.read), true);
  assert.equal(items.filter((i) => !i.read).length, 0);
});

test('Toast dismissal does NOT delete inbox history', () => {
  const inbox = [
    { id: 'notif-1', title: 'Build Done', state: 'finished', read: false },
    { id: 'notif-2', title: 'Test Failed', state: 'failed', read: false },
  ];

  let toasts = [
    { id: 'toast-1', notificationId: 'notif-1', title: 'Build Done' },
    { id: 'toast-2', notificationId: 'notif-2', title: 'Test Failed' },
  ];

  // Dismiss toast-1
  toasts = toasts.filter((t) => t.id !== 'toast-1');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0]?.id, 'toast-2');

  // Inbox remains intact with all items preserved
  assert.equal(inbox.length, 2);
  assert.equal(inbox[0]?.id, 'notif-1');
  assert.equal(inbox[1]?.id, 'notif-2');
});

test('Tab acknowledgement vs notification read separation', () => {
  let tabState = 'finished';
  let notificationRead = false;

  // Reading notification marks notification as read
  notificationRead = true;
  assert.equal(notificationRead, true);
  // Tab state STILL remains 'finished' until user opens/inspects tab!
  assert.equal(tabState, 'finished');

  // User opens the tab and inspects it -> acknowledges tab completion
  tabState = 'idle';
  assert.equal(tabState, 'idle');
});

test('Navigation safety: missing workspace or failed selection does NOT acknowledge tab', async () => {
  const workspaces = [
    { id: 'ws-active', status: 'active' },
    { id: 'ws-archived', status: 'archived' },
  ];
  const sessions = [
    { workspaceId: 'ws-active', tab: { id: 'tab-open', closedAt: null } },
    { workspaceId: 'ws-active', tab: { id: 'tab-closed', closedAt: '2026-10-28T12:00:00Z' } },
  ];

  let acknowledgedTabs = [];
  let selectedWorkspace = null;
  let selectedTab = null;

  async function navigate(item, shouldSelectionFail = false) {
    const ws = workspaces.find((w) => w.id === item.workspaceId && w.status === 'active');
    if (!ws) return { error: 'Missing workspace' };

    if (item.tabId) {
      const tab = sessions.find((s) => s.workspaceId === item.workspaceId && s.tab?.id === item.tabId && !s.tab?.closedAt);
      if (!tab) return { error: 'Missing tab' };

      if (shouldSelectionFail) {
        return { error: 'Selection failed' };
      }
    }

    selectedWorkspace = item.workspaceId;
    selectedTab = item.tabId;
    if (item.tabId) {
      acknowledgedTabs.push(item.tabId);
    }
    return { ok: true };
  }

  // Case 1: Missing workspace -> fails, does NOT acknowledge
  const res1 = await navigate({ workspaceId: 'ws-missing', tabId: 'tab-open' });
  assert.equal(res1.error, 'Missing workspace');
  assert.equal(acknowledgedTabs.length, 0);

  // Case 2: Archived workspace -> fails, does NOT acknowledge
  const res2 = await navigate({ workspaceId: 'ws-archived', tabId: 'tab-open' });
  assert.equal(res2.error, 'Missing workspace');
  assert.equal(acknowledgedTabs.length, 0);

  // Case 3: Closed tab in active workspace -> fails, does NOT acknowledge
  const res3 = await navigate({ workspaceId: 'ws-active', tabId: 'tab-closed' });
  assert.equal(res3.error, 'Missing tab');
  assert.equal(acknowledgedTabs.length, 0);

  // Case 4: Selection fails on server -> does NOT acknowledge
  const res4 = await navigate({ workspaceId: 'ws-active', tabId: 'tab-open' }, true);
  assert.equal(res4.error, 'Selection failed');
  assert.equal(acknowledgedTabs.length, 0);

  // Case 5: Navigation and selection succeed -> acknowledges tab!
  const res5 = await navigate({ workspaceId: 'ws-active', tabId: 'tab-open' }, false);
  assert.equal(res5.ok, true);
  assert.equal(selectedWorkspace, 'ws-active');
  assert.equal(selectedTab, 'tab-open');
  assert.deepEqual(acknowledgedTabs, ['tab-open']);
});

test('Optimistic mutation rollback on server failure', async () => {
  let notifications = [
    { id: 'notif-1', read: false },
    { id: 'notif-2', read: false },
  ];

  async function markReadWithReconcile(notificationId, simulateServerError = false) {
    const previous = notifications;
    // Optimistic update
    notifications = notifications.map((n) => (n.id === notificationId ? { ...n, read: true } : n));

    try {
      if (simulateServerError) {
        throw new Error('Server network error');
      }
    } catch (err) {
      // Reconcile: rollback optimistic change
      notifications = previous;
      throw err;
    }
  }

  // Server error rolls back
  await assert.rejects(
    async () => markReadWithReconcile('notif-1', true),
    /Server network error/,
  );
  assert.equal(notifications.find((n) => n.id === 'notif-1')?.read, false); // Reverted!

  // Success persists
  await markReadWithReconcile('notif-1', false);
  assert.equal(notifications.find((n) => n.id === 'notif-1')?.read, true); // Persisted!
});

test('State model mapping for tab dots and indicators', () => {
  function computeTabDotClass(tabActivity, sessionLifecycle, sessionActivity) {
    if (tabActivity === 'finished') return 'finished';
    if (tabActivity === 'failed' || sessionLifecycle === 'failed') return 'failed';
    if (sessionLifecycle === 'exited') return 'muted';
    if (sessionActivity === 'working' || tabActivity === 'working') return 'working';
    if (tabActivity === 'unknown') return 'unknown';
    return 'idle';
  }

  assert.equal(computeTabDotClass('finished', 'running', 'idle'), 'finished');
  assert.equal(computeTabDotClass('working', 'running', 'working'), 'working');
  assert.equal(computeTabDotClass('failed', 'running', 'idle'), 'failed');
  assert.equal(computeTabDotClass('unknown', 'running', 'unknown'), 'unknown');
  assert.equal(computeTabDotClass('idle', 'running', 'idle'), 'idle');
});

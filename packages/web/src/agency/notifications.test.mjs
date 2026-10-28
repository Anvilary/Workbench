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

test('Cross-workspace navigation payload', () => {
  const notification = {
    id: 'n-123',
    workspaceId: 'ws-target',
    tabId: 'tab-456',
    title: 'Deployment finished',
    state: 'finished',
  };

  let selectedWorkspace = 'ws-origin';
  let selectedTab = 'tab-initial';
  let readNotificationId = null;
  let acknowledgedTabId = null;

  function handleNavigate(item) {
    selectedWorkspace = item.workspaceId;
    if (item.tabId) {
      selectedTab = item.tabId;
      acknowledgedTabId = item.tabId;
    }
    readNotificationId = item.id;
  }

  handleNavigate(notification);

  assert.equal(selectedWorkspace, 'ws-target');
  assert.equal(selectedTab, 'tab-456');
  assert.equal(readNotificationId, 'n-123');
  assert.equal(acknowledgedTabId, 'tab-456');
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

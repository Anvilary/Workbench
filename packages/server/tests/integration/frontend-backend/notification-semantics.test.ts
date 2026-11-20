/**
 * Checkpoint 5 — notification semantics that the audit left unexamined:
 * read vs acknowledgement, consecutive turns, duplicate and out-of-order provider events, durability across
 * restart, closed tabs, and workspace isolation of notifications.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RuntimeSessionId, WorkspaceId } from '@agent-workbench/shared';
import { AgencyNotificationStore } from '../../../src/features/notifications/notification-store.js';
import { TabActivityManager } from '../../../src/features/notifications/tab-activity-manager.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-notify-sem-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AgencyNotificationStore(path.join(root, 'notifications.json'));
  await store.initialize();
  const manager = new TabActivityManager({ notificationStore: store, storageDir: root });
  await manager.initialize();
  return { root, store, manager };
}

const turn = (workspaceId: WorkspaceId, tabId: string, taskId: string) => ({
  workspaceId, tabId, sessionId: randomUUID() as RuntimeSessionId, provider: 'codex', lifecycle: 'running',
  taskId, completionEvidence: 'native-turn' as const,
});

test('read and acknowledgement are independent: reading never clears the finished tab, acknowledging never marks read', async t => {
  const { store, manager } = await fixture(t);
  const ws = randomUUID() as WorkspaceId, tab = randomUUID();
  await manager.handleCliActivity({ ...turn(ws, tab, 'native:t1'), nextActivity: 'working' });
  await manager.handleCliActivity({ ...turn(ws, tab, 'native:t1'), nextActivity: 'finished' });
  const [item] = store.list(ws);
  assert.ok(item && !item.read);
  await store.markRead(item.id);
  assert.equal(store.get(item.id)!.read, true);
  assert.equal(manager.getTabState(ws, tab), 'finished', 'reading the inbox is not inspecting the tab');
  await manager.acknowledgeTab(ws, tab);
  assert.equal(manager.getTabState(ws, tab), 'idle');

  await manager.handleCliActivity({ ...turn(ws, tab, 'native:t2'), nextActivity: 'working' });
  await manager.handleCliActivity({ ...turn(ws, tab, 'native:t2'), nextActivity: 'finished' });
  const second = store.list(ws).find(n => n.id !== item.id)!;
  await manager.acknowledgeTab(ws, tab);
  assert.equal(store.get(second.id)!.read, false, 'inspecting the tab does not silently mark the inbox entry read');
  assert.equal(store.unreadCount(ws), 1);
});

test('duplicate and out-of-order provider events: one alert per turn, stale turns cannot regress a newer one', async t => {
  const { store, manager } = await fixture(t);
  const ws = randomUUID() as WorkspaceId, tab = randomUUID();
  const a = turn(ws, tab, 'native:a'), b = turn(ws, tab, 'native:b');
  await manager.handleCliActivity({ ...a, nextActivity: 'working' });
  await manager.handleCliActivity({ ...a, nextActivity: 'finished' });
  await manager.handleCliActivity({ ...a, nextActivity: 'finished' });            // duplicate delivery
  await manager.handleCliActivity({ ...a, nextActivity: 'working' });             // replayed older event
  assert.equal(store.list(ws).length, 1);
  assert.equal(manager.getTabState(ws, tab), 'finished', 'a replayed "working" of the finished turn does not reopen it');
  await manager.acknowledgeTab(ws, tab);
  await manager.handleCliActivity({ ...b, nextActivity: 'working' });
  await manager.handleCliActivity({ ...a, nextActivity: 'finished' });            // late event of the OLD turn
  assert.equal(manager.getTabState(ws, tab), 'working', 'old turn cannot overwrite the newer running turn');
  assert.equal(store.list(ws).length, 1, 'no duplicate alert for the old turn');
  await manager.handleCliActivity({ ...b, nextActivity: 'finished' });
  assert.equal(store.list(ws).length, 2);
  // Finish arriving without a preceding "working" (lost event) still produces exactly one alert.
  const c = turn(ws, tab, 'native:c');
  await manager.acknowledgeTab(ws, tab);
  await manager.handleCliActivity({ ...c, nextActivity: 'finished' });
  await manager.handleCliActivity({ ...c, nextActivity: 'finished' });
  assert.equal(store.list(ws).length, 3, 'a finish without a seen start still alerts exactly once');
});

test('finished state and alerts are durable across restart; restart creates no duplicate alert', async t => {
  const { root, store, manager } = await fixture(t);
  const ws = randomUUID() as WorkspaceId, tab = randomUUID();
  await manager.handleCliActivity({ ...turn(ws, tab, 'native:r'), nextActivity: 'working' });
  await manager.handleCliActivity({ ...turn(ws, tab, 'native:r'), nextActivity: 'finished' });
  await manager.flush(); await store.flush();
  manager.dispose(); store.dispose();
  const store2 = new AgencyNotificationStore(path.join(root, 'notifications.json'));
  await store2.initialize();
  const manager2 = new TabActivityManager({ notificationStore: store2, storageDir: root });
  await manager2.initialize();
  assert.equal(manager2.getTabState(ws, tab), 'finished');
  await manager2.handleCliActivity({ ...turn(ws, tab, 'native:r'), nextActivity: 'finished' });   // provider replays history
  assert.equal(store2.list(ws).length, 1);
});

test('closed tabs never alert again; another workspace and sibling tab are unaffected', async t => {
  const { store, manager } = await fixture(t);
  const wsA = randomUUID() as WorkspaceId, wsB = randomUUID() as WorkspaceId;
  const tabA = randomUUID(), tabA2 = randomUUID(), tabB = randomUUID();
  await manager.handleCliActivity({ ...turn(wsA, tabA, 'native:x'), nextActivity: 'working' });
  await manager.closeTab(wsA, tabA);
  await manager.handleCliActivity({ ...turn(wsA, tabA, 'native:x'), nextActivity: 'finished' });  // completes after close
  await manager.handleCliActivity({ ...turn(wsA, tabA, 'native:y'), nextActivity: 'finished' });
  assert.equal(store.list(wsA).length, 0, 'closed tab produces no alert');
  // Same tab id in another workspace is a different tab.
  await manager.handleCliActivity({ ...turn(wsB, tabA, 'native:x'), nextActivity: 'working' });
  await manager.handleCliActivity({ ...turn(wsB, tabA, 'native:x'), nextActivity: 'finished' });
  await manager.handleCliActivity({ ...turn(wsA, tabA2, 'native:z'), nextActivity: 'working' });
  await manager.handleCliActivity({ ...turn(wsA, tabA2, 'native:z'), nextActivity: 'finished' });
  await manager.handleCliActivity({ ...turn(wsB, tabB, 'native:w'), nextActivity: 'working' });
  assert.equal(store.list(wsB).length, 1);
  assert.equal(store.list(wsA).length, 1);
  assert.equal(store.list(wsA)[0]!.tabId, tabA2);
  assert.equal(manager.getTabState(wsB, tabB), 'working');
  await manager.acknowledgeTab(wsA, tabA2);
  assert.equal(manager.getTabState(wsB, tabA), 'finished', 'acknowledging in A never acknowledges B');
});

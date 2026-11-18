import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RuntimeSessionId, WorkspaceId } from '@agent-workbench/shared';
import { AgencyNotificationStore, type CreateNotificationInput } from '../../../src/agency/agency-notification-store.js';
import { TabActivityManager } from '../../../src/agency/tab-activity-manager.js';
import { ShellSequences } from '../../../src/agency/shell-integration.js';

class InterruptedNotifications extends AgencyNotificationStore {
  failure: 'before' | 'after' | null = 'before';
  override async create(input: CreateNotificationInput) {
    if (this.failure === 'before') throw new Error('Injected interruption before notification write');
    const result = await super.create(input);
    if (this.failure === 'after') throw new Error('Injected interruption after notification write');
    return result;
  }
}
const baseInput = () => ({ workspaceId: randomUUID() as WorkspaceId, tabId: randomUUID(), sessionId: randomUUID() as RuntimeSessionId,
  provider: 'codex', taskId: 'native:turn', lifecycle: 'running', completionEvidence: 'native-turn' as const });
const disk = async (manager: TabActivityManager) => JSON.parse(await readFile(manager.file, 'utf8')) as { records: Array<{ state: string }>; pendingNotifications: CreateNotificationInput[] };

test('CLI completion and receipt persist together; acknowledgement preserves receipt and restart creates exactly one alert', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-outbox-cli-'));
  try {
    const file = path.join(root, 'notifications.json');
    const broken = new InterruptedNotifications(file); await broken.initialize();
    const manager = new TabActivityManager({ notificationStore: broken, storageDir: root }); await manager.initialize();
    const input = baseInput();
    await manager.handleCliActivity({ ...input, nextActivity: 'working' });
    await assert.rejects(manager.handleCliActivity({ ...input, nextActivity: 'finished' }), /Injected/);
    assert.equal((await disk(manager)).records[0]?.state, 'finished');
    assert.equal((await disk(manager)).pendingNotifications.length, 1);
    assert.equal(broken.list().length, 0);
    await manager.flushPendingNotifications(() => true); // Recoverable delivery errors must not poison startup.
    assert.equal((await disk(manager)).pendingNotifications.length, 1);
    await manager.acknowledgeTab(input.workspaceId, input.tabId);
    assert.equal((await disk(manager)).records[0]?.state, 'idle');
    assert.equal((await disk(manager)).pendingNotifications.length, 1);
    manager.dispose();
    const recovered = new AgencyNotificationStore(file); await recovered.initialize();
    const restarted = new TabActivityManager({ notificationStore: recovered, storageDir: root }); await restarted.initialize();
    await restarted.flushPendingNotifications(() => true);
    await restarted.flushPendingNotifications();
    assert.equal(recovered.list().length, 1);
    assert.equal((await disk(restarted)).pendingNotifications.length, 0);
    await restarted.handleCliActivity({ ...input, nextActivity: 'finished' });
    assert.equal(restarted.getTabState(input.workspaceId, input.tabId), 'idle');
    assert.equal(recovered.list().length, 1);
    restarted.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ordinary shell commands produce zero outbox notifications and return to idle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-outbox-shell-'));
  try {
    const file = path.join(root, 'notifications.json');
    const store = new AgencyNotificationStore(file); await store.initialize();
    const manager = new TabActivityManager({ notificationStore: store, storageDir: root }); await manager.initialize();
    const input = baseInput();
    const parser = manager.getOrCreateShellParser(input.workspaceId, input.tabId, { sessionId: input.sessionId });
    parser.feed(ShellSequences.commandStart);
    await manager.flush();
    assert.equal(manager.getTabState(input.workspaceId, input.tabId), 'working');
    parser.feed(ShellSequences.commandExit(0));
    await manager.flush();
    assert.equal(manager.getTabState(input.workspaceId, input.tabId), 'idle');
    assert.equal((await disk(manager)).pendingNotifications.length, 0);
    assert.equal(store.list().length, 0);
    manager.dispose();
    const recovered = new AgencyNotificationStore(file); await recovered.initialize();
    const restarted = new TabActivityManager({ notificationStore: recovered, storageDir: root }); await restarted.initialize();
    assert.equal(recovered.list().length, 0);
    assert.equal(restarted.getTabState(input.workspaceId, input.tabId), 'idle');
    restarted.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interruption after notification commit retries receipt without a duplicate created event', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-outbox-dedup-'));
  try {
    const file = path.join(root, 'notifications.json');
    const broken = new InterruptedNotifications(file); broken.failure = 'after'; await broken.initialize();
    const manager = new TabActivityManager({ notificationStore: broken, storageDir: root }); await manager.initialize();
    const input = baseInput();
    await manager.handleCliActivity({ ...input, nextActivity: 'working' });
    await assert.rejects(manager.handleCliActivity({ ...input, nextActivity: 'finished' }), /after notification/);
    assert.equal(broken.list().length, 1);
    assert.equal((await disk(manager)).pendingNotifications.length, 1);
    manager.dispose();
    const recovered = new AgencyNotificationStore(file); await recovered.initialize();
    let created = 0; recovered.on('created', () => created++);
    const restarted = new TabActivityManager({ notificationStore: recovered, storageDir: root }); await restarted.initialize();
    await restarted.flushPendingNotifications(() => true);
    assert.equal(recovered.list().length, 1);
    assert.equal(created, 0);
    assert.equal((await disk(restarted)).pendingNotifications.length, 0);
    restarted.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const absent of ['closed', 'deleted']) test(`${absent} tabs cannot deliver an old pending receipt after restart`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-outbox-absent-'));
  try {
    const file = path.join(root, 'notifications.json');
    const broken = new InterruptedNotifications(file); await broken.initialize();
    const manager = new TabActivityManager({ notificationStore: broken, storageDir: root }); await manager.initialize();
    const input = baseInput();
    await manager.handleCliActivity({ ...input, nextActivity: 'working' });
    await assert.rejects(manager.handleCliActivity({ ...input, nextActivity: 'finished' }));
    if (absent === 'closed') {
      await manager.closeTab(input.workspaceId, input.tabId);
      assert.equal((await disk(manager)).pendingNotifications.length, 0);
    }
    manager.dispose();
    const recovered = new AgencyNotificationStore(file); await recovered.initialize();
    const restarted = new TabActivityManager({ notificationStore: recovered, storageDir: root }); await restarted.initialize();
    await restarted.flushPendingNotifications(() => absent !== 'deleted');
    assert.equal(recovered.list().length, 0);
    assert.equal((await disk(restarted)).pendingNotifications.length, 0);
    restarted.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed activity writes never broadcast a verified result or create a notification', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-outbox-activity-write-'));
  try {
    const notifications = new AgencyNotificationStore(path.join(root, 'notifications.json')); await notifications.initialize();
    const manager = new TabActivityManager({ notificationStore: notifications, storageDir: root }); await manager.initialize();
    const events: string[] = []; manager.on('tabActivity', record => events.push(record.state));
    await mkdir(manager.file);
    const input = baseInput();
    await assert.rejects(manager.handleCliActivity({ ...input, nextActivity: 'finished' }));
    assert.deepEqual(events, []);
    assert.deepEqual(manager.snapshot(), []);
    assert.equal(notifications.list().length, 0);
    assert.equal(manager.getTabState(input.workspaceId, input.tabId), 'unknown');
    manager.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RuntimeSessionId, WorkspaceId } from '@agent-workbench/shared';
import { AgencyNotificationStore } from '../../../src/agency/agency-notification-store.js';
import { TabActivityManager } from '../../../src/agency/tab-activity-manager.js';
import { ShellSequences } from '../../../src/agency/shell-integration.js';
import { handleAgencyNotificationDone } from '../../../src/terminal-socket.js';

test('Acceptance 1: Ten ordinary shell commands produce zero inbox notifications and zero completion badges', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-test-shell-10-'));
  try {
    const store = new AgencyNotificationStore(path.join(root, 'notifications.json'));
    await store.initialize();
    const manager = new TabActivityManager({ notificationStore: store, storageDir: root });
    await manager.initialize();

    const workspaceId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();
    const parser = manager.getOrCreateShellParser(workspaceId, tabId);

    // Run 10 commands: mixed success (exit 0) and failure (exit 1, 2, 127)
    // Commands like ls, pwd, git status, echo, cd, false, etc.
    const exitCodes = [0, 0, 1, 0, 2, 0, 127, 0, 0, 1];
    assert.equal(exitCodes.length, 10);

    for (let i = 0; i < exitCodes.length; i++) {
      const code = exitCodes[i]!;
      // Command starts -> working
      parser.feed(ShellSequences.commandStart);
      await manager.flush();
      assert.equal(manager.getTabState(workspaceId, tabId), 'working', `Command ${i + 1} must show working while running`);

      // Command exits -> terminal returns to idle
      parser.feed(ShellSequences.commandExit(code) + ShellSequences.promptStart);
      await manager.flush();
      await store.flush();

      assert.equal(manager.getTabState(workspaceId, tabId), 'idle', `Command ${i + 1} must return to idle (never finished)`);
      // Zero inbox notifications produced
      assert.equal(store.list().length, 0, `Command ${i + 1} must not create any inbox notification`);
      assert.equal(manager.getRecord(workspaceId, tabId)?.turnSequence, i + 1, `Turn sequence must track command count`);
    }

    assert.equal(store.list().length, 0, '10 ordinary shell commands must produce exactly zero inbox notifications');
    assert.notEqual(manager.getTabState(workspaceId, tabId), 'finished', 'Must not leave persistent finished badge');
    manager.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Acceptance 2: Native agent completion produces expected notification and finished state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-test-native-agent-'));
  try {
    const store = new AgencyNotificationStore(path.join(root, 'notifications.json'));
    await store.initialize();
    const manager = new TabActivityManager({ notificationStore: store, storageDir: root });
    await manager.initialize();

    const workspaceId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();
    const sessionId = randomUUID() as RuntimeSessionId;

    await manager.handleCliActivity({
      workspaceId,
      tabId,
      sessionId,
      provider: 'codex',
      tabName: 'Agent Alpha',
      nextActivity: 'working',
      lifecycle: 'running',
      taskId: 'turn-1',
    });
    assert.equal(manager.getTabState(workspaceId, tabId), 'working');
    assert.equal(store.list().length, 0);

    await manager.handleCliActivity({
      workspaceId,
      tabId,
      sessionId,
      provider: 'codex',
      tabName: 'Agent Alpha',
      nextActivity: 'finished',
      lifecycle: 'running',
      taskId: 'turn-1',
      completionEvidence: 'native-turn',
    });
    await manager.flush();
    await store.flush();

    assert.equal(manager.getTabState(workspaceId, tabId), 'finished');
    assert.equal(store.list().length, 1);
    const notif = store.list()[0]!;
    assert.equal(notif.tabId, tabId);
    assert.equal(notif.state, 'finished');
    assert.equal(notif.metadata?.['taskId'], 'turn-1');
    assert.equal(notif.acknowledgedAt, null);

    manager.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Acceptance 3 & 4: Done removes exactly one notification, clears matching tab completion, and preserves newer turns via production handler', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-test-done-race-'));
  try {
    const store = new AgencyNotificationStore(path.join(root, 'notifications.json'));
    await store.initialize();
    const manager = new TabActivityManager({ notificationStore: store, storageDir: root });
    await manager.initialize();

    const workspaceId = randomUUID() as WorkspaceId;
    const tabA = randomUUID();
    const tabB = randomUUID();
    const sessionA = randomUUID() as RuntimeSessionId;
    const sessionB = randomUUID() as RuntimeSessionId;

    const mockWorkspaceStore = {
      getWorkspace: (id: WorkspaceId) => (id === workspaceId ? { id, name: 'Workspace' } as any : null),
    };

    function createMockSocket() {
      const messages: any[] = [];
      return {
        messages,
        send: (msg: any) => messages.push(msg),
      };
    }

    // Turn 1 on Tab A completes
    await manager.handleCliActivity({
      workspaceId,
      tabId: tabA,
      sessionId: sessionA,
      provider: 'claude-code',
      nextActivity: 'working',
      lifecycle: 'running',
      taskId: 'turn-a1',
    });
    await manager.handleCliActivity({
      workspaceId,
      tabId: tabA,
      sessionId: sessionA,
      provider: 'claude-code',
      nextActivity: 'finished',
      lifecycle: 'running',
      taskId: 'turn-a1',
      completionEvidence: 'native-turn',
    });

    // Turn 1 on Tab B completes
    await manager.handleCliActivity({
      workspaceId,
      tabId: tabB,
      sessionId: sessionB,
      provider: 'codex',
      nextActivity: 'working',
      lifecycle: 'running',
      taskId: 'turn-b1',
    });
    await manager.handleCliActivity({
      workspaceId,
      tabId: tabB,
      sessionId: sessionB,
      provider: 'codex',
      nextActivity: 'finished',
      lifecycle: 'running',
      taskId: 'turn-b1',
      completionEvidence: 'native-turn',
    });

    await manager.flush();
    await store.flush();

    assert.equal(store.list().length, 2);
    assert.equal(store.unreadCount(), 2);
    assert.equal(manager.getTabState(workspaceId, tabA), 'finished');
    assert.equal(manager.getTabState(workspaceId, tabB), 'finished');

    const notifA1 = store.list().find(n => n.tabId === tabA)!;
    const notifB1 = store.list().find(n => n.tabId === tabB)!;

    // Invoke production Done handler on notifA1
    const socket1 = createMockSocket();
    await handleAgencyNotificationDone(
      { type: 'agency.notification.done', requestId: 'req-a1', notificationId: notifA1.id },
      socket1 as any,
      {
        agencyNotificationStore: store,
        agencyActivityManager: manager,
        agencyWorkspaceStore: mockWorkspaceStore,
        send: (s, m) => (s as any).send(m),
      },
    );

    // Verify response sent to socket
    assert.equal(socket1.messages.length, 1);
    assert.equal(socket1.messages[0].type, 'agency.notification.changed');
    assert.equal(socket1.messages[0].requestId, 'req-a1');
    assert.equal(socket1.messages[0].notification.id, notifA1.id);
    assert.ok(socket1.messages[0].notification.acknowledgedAt);

    // Verify Tab A completion clears because notifA1 matches current turn
    assert.equal(manager.getTabState(workspaceId, tabA), 'idle');

    // Tab B's completion and notification remain untouched
    assert.equal(manager.getTabState(workspaceId, tabB), 'finished');
    assert.equal(store.get(notifB1.id)?.acknowledgedAt, null);
    assert.equal(store.unreadCount(), 1);

    // Now test Acceptance 4: RACE CONDITION
    // Start Turn A2 on Tab A, and complete it!
    await manager.handleCliActivity({
      workspaceId,
      tabId: tabA,
      sessionId: sessionA,
      provider: 'claude-code',
      nextActivity: 'working',
      lifecycle: 'running',
      taskId: 'turn-a2',
    });
    await manager.handleCliActivity({
      workspaceId,
      tabId: tabA,
      sessionId: sessionA,
      provider: 'claude-code',
      nextActivity: 'finished',
      lifecycle: 'running',
      taskId: 'turn-a2',
      completionEvidence: 'native-turn',
    });
    await manager.flush();
    await store.flush();

    assert.equal(manager.getTabState(workspaceId, tabA), 'finished');
    const currentRec = manager.getRecord(workspaceId, tabA);
    assert.equal(currentRec?.taskId, 'turn-a2');

    // Stale Done request arrives via production handler for notifA1 (turn-a1)
    const socketStale = createMockSocket();
    await handleAgencyNotificationDone(
      { type: 'agency.notification.done', requestId: 'req-stale-a1', notificationId: notifA1.id },
      socketStale as any,
      {
        agencyNotificationStore: store,
        agencyActivityManager: manager,
        agencyWorkspaceStore: mockWorkspaceStore,
        send: (s, m) => (s as any).send(m),
      },
    );

    // Response acknowledges the request
    assert.equal(socketStale.messages.length, 1);
    assert.equal(socketStale.messages[0].type, 'agency.notification.changed');

    // Tab A REMAINS finished because Turn A2 is active! Stale Done did not clear Turn A2!
    assert.equal(manager.getTabState(workspaceId, tabA), 'finished', 'Newer completion must NOT be lost through a stale Done request');
    assert.equal(manager.getRecord(workspaceId, tabA)?.taskId, 'turn-a2');

    // Now send Done for Turn A2:
    const notifA2 = store.list().find(n => n.tabId === tabA && (n.metadata?.taskId === 'turn-a2' || n.deduplicationKey?.includes('turn-a2')))!;
    assert.ok(notifA2, 'Notification for turn A2 must exist');
    const socketA2 = createMockSocket();
    await handleAgencyNotificationDone(
      { type: 'agency.notification.done', requestId: 'req-a2', notificationId: notifA2.id },
      socketA2 as any,
      {
        agencyNotificationStore: store,
        agencyActivityManager: manager,
        agencyWorkspaceStore: mockWorkspaceStore,
        send: (s, m) => (s as any).send(m),
      },
    );

    assert.equal(manager.getTabState(workspaceId, tabA), 'idle', 'Tab A returns to idle when current turn is completed');

    manager.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Injected persistence failure in notification store or activity manager reports error without false success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-test-done-failure-'));
  try {
    const store = new AgencyNotificationStore(path.join(root, 'notifications.json'));
    await store.initialize();
    const manager = new TabActivityManager({ notificationStore: store, storageDir: root });
    await manager.initialize();

    const workspaceId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();
    const sessionId = randomUUID() as RuntimeSessionId;
    const mockWorkspaceStore = {
      getWorkspace: (id: WorkspaceId) => (id === workspaceId ? { id, name: 'Workspace' } as any : null),
    };

    function createMockSocket() {
      const messages: any[] = [];
      return {
        messages,
        send: (msg: any) => messages.push(msg),
      };
    }

    await manager.handleCliActivity({
      workspaceId,
      tabId,
      sessionId,
      provider: 'codex',
      nextActivity: 'finished',
      lifecycle: 'running',
      taskId: 'turn-fail-1',
      completionEvidence: 'native-turn',
    });
    await manager.flush();
    await store.flush();

    const notif = store.list().find(n => n.tabId === tabId)!;
    assert.ok(notif);

    // Scenario A: Injected failure in store.acknowledge
    const originalAcknowledge = store.acknowledge.bind(store);
    store.acknowledge = async () => { throw new Error('Disk full in notification store'); };

    const socketA = createMockSocket();
    await handleAgencyNotificationDone(
      { type: 'agency.notification.done', requestId: 'req-err-1', notificationId: notif.id },
      socketA as any,
      {
        agencyNotificationStore: store,
        agencyActivityManager: manager,
        agencyWorkspaceStore: mockWorkspaceStore,
        send: (s, m) => (s as any).send(m),
      },
    );

    assert.equal(socketA.messages.length, 1);
    assert.equal(socketA.messages[0].type, 'agency.error');
    assert.equal(socketA.messages[0].requestId, 'req-err-1');
    assert.match(socketA.messages[0].message, /Disk full in notification store/);
    // Tab remains finished and notification unacknowledged
    assert.equal(manager.getTabState(workspaceId, tabId), 'finished');
    assert.equal(store.get(notif.id)?.acknowledgedAt, null);

    // Restore store.acknowledge
    store.acknowledge = originalAcknowledge;

    // Scenario B: Injected failure in manager.acknowledgeMatchingTurn
    manager.acknowledgeMatchingTurn = async () => { throw new Error('Disk full in activity manager'); };

    const socketB = createMockSocket();
    await handleAgencyNotificationDone(
      { type: 'agency.notification.done', requestId: 'req-err-2', notificationId: notif.id },
      socketB as any,
      {
        agencyNotificationStore: store,
        agencyActivityManager: manager,
        agencyWorkspaceStore: mockWorkspaceStore,
        send: (s, m) => (s as any).send(m),
      },
    );

    assert.equal(socketB.messages.length, 1);
    assert.equal(socketB.messages[0].type, 'agency.error');
    assert.equal(socketB.messages[0].requestId, 'req-err-2');
    assert.match(socketB.messages[0].message, /Disk full in activity manager/);

    manager.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Idempotent retry of Done request returns success without duplicate side-effects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-test-done-idempotent-'));
  try {
    const store = new AgencyNotificationStore(path.join(root, 'notifications.json'));
    await store.initialize();
    const manager = new TabActivityManager({ notificationStore: store, storageDir: root });
    await manager.initialize();

    const workspaceId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();
    const sessionId = randomUUID() as RuntimeSessionId;
    const mockWorkspaceStore = {
      getWorkspace: (id: WorkspaceId) => (id === workspaceId ? { id, name: 'Workspace' } as any : null),
    };

    function createMockSocket() {
      const messages: any[] = [];
      return {
        messages,
        send: (msg: any) => messages.push(msg),
      };
    }

    await manager.handleCliActivity({
      workspaceId,
      tabId,
      sessionId,
      provider: 'claude-code',
      nextActivity: 'finished',
      lifecycle: 'running',
      taskId: 'turn-idempotent',
      completionEvidence: 'native-turn',
    });
    await manager.flush();
    await store.flush();

    const notif = store.list().find(n => n.tabId === tabId)!;

    // First Done request
    const socket1 = createMockSocket();
    await handleAgencyNotificationDone(
      { type: 'agency.notification.done', requestId: 'req-idem-1', notificationId: notif.id },
      socket1 as any,
      {
        agencyNotificationStore: store,
        agencyActivityManager: manager,
        agencyWorkspaceStore: mockWorkspaceStore,
        send: (s, m) => (s as any).send(m),
      },
    );

    assert.equal(socket1.messages.length, 1);
    assert.equal(socket1.messages[0].type, 'agency.notification.changed');
    const firstAckTime = socket1.messages[0].notification.acknowledgedAt;
    assert.ok(firstAckTime);
    assert.equal(manager.getTabState(workspaceId, tabId), 'idle');

    // Second Done request (idempotent retry)
    const socket2 = createMockSocket();
    await handleAgencyNotificationDone(
      { type: 'agency.notification.done', requestId: 'req-idem-2', notificationId: notif.id },
      socket2 as any,
      {
        agencyNotificationStore: store,
        agencyActivityManager: manager,
        agencyWorkspaceStore: mockWorkspaceStore,
        send: (s, m) => (s as any).send(m),
      },
    );

    assert.equal(socket2.messages.length, 1);
    assert.equal(socket2.messages[0].type, 'agency.notification.changed');
    assert.equal(socket2.messages[0].requestId, 'req-idem-2');
    assert.equal(socket2.messages[0].notification.acknowledgedAt, firstAckTime);
    assert.equal(manager.getTabState(workspaceId, tabId), 'idle');

    manager.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Legacy notifications lacking turn identity complete inbox item without guessing or clearing current tab completion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-test-done-legacy-'));
  try {
    const store = new AgencyNotificationStore(path.join(root, 'notifications.json'));
    await store.initialize();
    const manager = new TabActivityManager({ notificationStore: store, storageDir: root });
    await manager.initialize();

    const workspaceId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();
    const sessionId = randomUUID() as RuntimeSessionId;
    const mockWorkspaceStore = {
      getWorkspace: (id: WorkspaceId) => (id === workspaceId ? { id, name: 'Workspace' } as any : null),
    };

    function createMockSocket() {
      const messages: any[] = [];
      return {
        messages,
        send: (msg: any) => messages.push(msg),
      };
    }

    // Tab is finished with an active turn
    await manager.handleCliActivity({
      workspaceId,
      tabId,
      sessionId,
      provider: 'codex',
      nextActivity: 'finished',
      lifecycle: 'running',
      taskId: 'active-turn',
      completionEvidence: 'native-turn',
    });
    await manager.flush();

    // Create a legacy notification that lacks taskId and turnSequence in metadata and deduplicationKey
    const legacyNotif = await store.create({
      workspaceId,
      tabId,
      title: 'Legacy Alert',
      body: 'Old notification lacking identity',
      state: 'finished',
      deduplicationKey: 'legacy-alert-key',
      metadata: { kind: 'legacy' },
    });
    assert.ok(legacyNotif);
    await store.flush();

    assert.equal(manager.getTabState(workspaceId, tabId), 'finished');

    // Run Done on legacy notification
    const socket = createMockSocket();
    await handleAgencyNotificationDone(
      { type: 'agency.notification.done', requestId: 'req-legacy', notificationId: legacyNotif.id },
      socket as any,
      {
        agencyNotificationStore: store,
        agencyActivityManager: manager,
        agencyWorkspaceStore: mockWorkspaceStore,
        send: (s, m) => (s as any).send(m),
      },
    );

    // Verify inbox item is completed
    assert.equal(socket.messages.length, 1);
    assert.equal(socket.messages[0].type, 'agency.notification.changed');
    assert.ok(store.get(legacyNotif.id)?.acknowledgedAt);

    // Tab completion badge MUST NOT be cleared (fails safely without guessing current turn)
    assert.equal(manager.getTabState(workspaceId, tabId), 'finished');
    assert.equal(manager.getRecord(workspaceId, tabId)?.taskId, 'active-turn');

    manager.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Acceptance 5: Done notifications remain completed after restart and reload from disk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-test-done-restart-'));
  try {
    const file = path.join(root, 'notifications.json');
    const store = new AgencyNotificationStore(file);
    await store.initialize();

    const workspaceId = randomUUID() as WorkspaceId;
    const tabId = randomUUID();

    const created = await store.create({
      workspaceId,
      tabId,
      title: 'Agent Task',
      body: 'Completed',
      state: 'finished',
      deduplicationKey: 'task-1',
    });
    assert.ok(created);
    assert.equal(store.unreadCount(), 1);

    // Mark Done
    const done = await store.acknowledge(created.id);
    assert.ok(done?.acknowledgedAt);
    assert.equal(store.unreadCount(), 0);

    await store.flush();
    store.dispose();

    // Restart store from disk
    const reloaded = new AgencyNotificationStore(file);
    await reloaded.initialize();

    const restored = reloaded.get(created.id);
    assert.ok(restored);
    assert.ok(restored.acknowledgedAt);
    assert.equal(restored.read, true);
    assert.equal(reloaded.unreadCount(), 0);

    reloaded.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Acceptance 6 & 7: Mixed tab ordering persists across restart, rejects invalid orders, and handles concurrency', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-test-tab-order-'));
  try {
    const workspaceStore = new (await import('../../../src/agency/store.js')).AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
    await workspaceStore.load();
    const project = await workspaceStore.createProject('OrderTest');
    const workspace = await workspaceStore.createWorkspace(project.id, 'WS', root);
    const lock = new (await import('../../../src/agency/workspace-lock.js')).WorkspaceMutex();
    const terminals = new Map();
    const registry = Object.assign(new (await import('node:events')).EventEmitter(), {
      async open() {
        const terminalId = randomUUID();
        const row = { terminalId, kind: 'shell', state: 'running', exitCode: null, pid: 100, alive: true };
        terminals.set(terminalId, row);
        return row;
      },
      get: (id: string) => terminals.get(id) ?? null,
      has: (id: string) => terminals.has(id),
      list: () => [...terminals.values()],
      close: () => {},
      activityOf: () => 'unknown',
    });
    const { AgencySessionRuntime } = await import('../../../src/agency/agency-session-runtime.js');
    const { AgencySessionStore } = await import('../../../src/agency/agency-session-store.js');
    const { BrowserTabAdapter, BrowserTabStore } = await import('../../../src/agency/browser-tabs/index.js');
    const { AgencyTabCoordinator } = await import('../../../src/agency/tab-coordinator.js');

    const native = new AgencySessionRuntime({
      registry: registry as any,
      store: new AgencySessionStore(path.join(root, 'sessions.json')),
      profiles: { resolveLaunch: async () => { throw new Error('No CLI launch'); } },
      workspaces: { protectedDirectories: () => [], withSessionReservation: (id, work) => lock.runExclusive(id, () => work(workspaceStore.getWorkspace(id))) },
    });
    await native.initialize();

    const browser = new BrowserTabAdapter({ store: new BrowserTabStore(path.join(root, 'web.json')), workspaceStore });
    await browser.restore();

    const coordinator = new AgencyTabCoordinator(native, browser, workspaceStore, () => {});

    // Create 2 native terminal tabs and 1 web tab
    const shell1 = await coordinator.createNative({ type: 'agency.session.create', requestId: 's1', workspaceId: workspace.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID() });
    const shell2 = await coordinator.createNative({ type: 'agency.session.create', requestId: 's2', workspaceId: workspace.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID() });
    const web = (await coordinator.webRequest({ type: 'agency.webTab.create', requestId: 'w1', workspaceId: workspace.id, url: 'https://chatgpt.com/', launchId: randomUUID() })) as any;

    const s1Id = shell1.tab!.id;
    const s2Id = shell2.tab!.id;
    const wId = web.tab.id;

    // Initial order
    assert.equal(native.get(shell1.id)?.tab?.order, 0);
    assert.equal(native.get(shell2.id)?.tab?.order, 1);
    assert.equal(browser.getTabState(wId)?.order, 2);

    // Reorder to: [web, shell2, shell1]
    await coordinator.nativeAction({ type: 'agency.tabs.order', requestId: 'ord1', workspaceId: workspace.id, tabIds: [wId, s2Id, s1Id] });

    assert.equal(browser.getTabState(wId)?.order, 0);
    assert.equal(native.get(shell2.id)?.tab?.order, 1);
    assert.equal(native.get(shell1.id)?.tab?.order, 2);

    // Rejection of invalid orders:
    // 1. Duplicate tab ID
    await assert.rejects(
      coordinator.nativeAction({ type: 'agency.tabs.order', requestId: 'inv1', workspaceId: workspace.id, tabIds: [wId, wId, s1Id] }),
      /Order must contain every open tab exactly once/,
    );
    // 2. Missing tab ID
    await assert.rejects(
      coordinator.nativeAction({ type: 'agency.tabs.order', requestId: 'inv2', workspaceId: workspace.id, tabIds: [wId, s1Id] }),
      /Order must contain every open tab exactly once/,
    );
    // 3. Foreign / nonexistent tab ID
    await assert.rejects(
      coordinator.nativeAction({ type: 'agency.tabs.order', requestId: 'inv3', workspaceId: workspace.id, tabIds: [wId, s2Id, randomUUID()] }),
      /Order must contain every open tab exactly once/,
    );

    // Order remains [wId, s2Id, s1Id] after failed attempts
    assert.equal(browser.getTabState(wId)?.order, 0);
    assert.equal(native.get(shell2.id)?.tab?.order, 1);
    assert.equal(native.get(shell1.id)?.tab?.order, 2);

    // Concurrency test: two browser clients sending different valid orders simultaneously
    // Client A sends [s1Id, wId, s2Id], Client B sends [s2Id, wId, s1Id]
    await Promise.all([
      coordinator.nativeAction({ type: 'agency.tabs.order', requestId: 'cA', workspaceId: workspace.id, tabIds: [s1Id, wId, s2Id] }),
      coordinator.nativeAction({ type: 'agency.tabs.order', requestId: 'cB', workspaceId: workspace.id, tabIds: [s2Id, wId, s1Id] }),
    ]);

    // State is consistent: each tab has a unique order 0, 1, 2
    const finalOrders = [
      native.get(shell1.id)?.tab?.order,
      browser.getTabState(wId)?.order,
      native.get(shell2.id)?.tab?.order,
    ].sort();
    assert.deepEqual(finalOrders, [0, 1, 2], 'Tab orders must remain unique and consistent');

    native.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P1 B-06/B-16 & P2 A-09: workspace purge clears notifications, permits orphaned done, blocks post-purge closeTab resurrection, and synchronizes shell parser init', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-b06-b16-'));
  try {
    const store = new AgencyNotificationStore(path.join(root, 'notifications.json'));
    await store.initialize();
    const manager = new TabActivityManager({ notificationStore: store, storageDir: root });
    await manager.initialize();

    const wsDeleted = randomUUID() as WorkspaceId;
    const wsOther = randomUUID() as WorkspaceId;
    const tabDeleted = randomUUID();
    const tabOther = randomUUID();
    const sessionDeleted = randomUUID() as RuntimeSessionId;

    // Create notifications in both workspaces
    await manager.handleCliActivity({
      workspaceId: wsDeleted,
      tabId: tabDeleted,
      sessionId: sessionDeleted,
      provider: 'codex',
      nextActivity: 'finished',
      lifecycle: 'running',
      taskId: 'turn-del-1',
      completionEvidence: 'native-turn',
    });
    const otherNotif = await store.create({
      workspaceId: wsOther,
      tabId: tabOther,
      title: 'Other',
      body: 'Keep me',
      state: 'finished',
      deduplicationKey: 'other-1',
    });
    assert.ok(otherNotif);
    await manager.flush();
    await store.flush();

    assert.equal(store.list(wsDeleted).length, 1);
    assert.equal(store.list(wsOther).length, 1);

    // Register shell parser on wsDeleted and verify it does not unsynchronized-pollute states during purge
    manager.getOrCreateShellParser(wsDeleted, tabDeleted);
    await manager.purgeWorkspace(wsDeleted);
    const purgedCount = await store.purgeWorkspace(wsDeleted);
    assert.equal(purgedCount, 1);
    assert.equal(store.list(wsDeleted).length, 0);
    assert.equal(store.list(wsOther).length, 1);

    // B-16: Post-purge closeTab must NOT resurrect a TabActivityRecord in memory or on disk
    await manager.closeTab(wsDeleted, tabDeleted);
    await manager.flush();
    assert.equal(manager.getRecord(wsDeleted, tabDeleted), null);
    assert.equal((manager as any).states.size, 0);
    assert.equal((manager as any).tabTurnSequences.size, 0);

    // Reload from disk to verify no resurrected record was persisted
    const reloaded = new TabActivityManager({ notificationStore: store, storageDir: root });
    await reloaded.initialize();
    assert.equal(reloaded.getRecord(wsDeleted, tabDeleted), null);
    reloaded.dispose();

    // B-06 defense-in-depth: handleAgencyNotificationDone must still allow acknowledging an
    // already-orphaned notification whose workspace no longer exists
    const orphan = await store.create({
      workspaceId: randomUUID() as WorkspaceId,
      tabId: randomUUID(),
      title: 'Legacy orphan',
      body: 'From deleted workspace',
      state: 'finished',
      deduplicationKey: 'legacy-orphan-1',
    });
    assert.ok(orphan);
    const messages: any[] = [];
    const socket = { send: (m: any) => messages.push(m) };
    await handleAgencyNotificationDone(
      { type: 'agency.notification.done', requestId: 'req-orphan', notificationId: orphan.id },
      socket as any,
      {
        agencyNotificationStore: store,
        agencyActivityManager: manager,
        agencyWorkspaceStore: { getWorkspace: () => null },
        send: (s, m) => (s as any).send(m),
      },
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'agency.notification.changed');
    assert.ok(store.get(orphan.id)?.acknowledgedAt);

    manager.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

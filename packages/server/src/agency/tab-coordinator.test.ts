import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AgencyServerMessage, TerminalId } from '@agent-workbench/shared';
import { parseClientMessage, parseServerMessage } from '@agent-workbench/shared';
import { AgencySessionRuntime } from './agency-session-runtime.js';
import { AgencySessionStore } from './agency-session-store.js';
import { AgencyWorkspaceStore } from './store.js';
import { WorkspaceMutex } from './workspace-lock.js';
import { BrowserTabAdapter, BrowserTabStore } from './browser-tabs/index.js';
import { AgencyLayoutStore } from './agency-layout-store.js';
import { createDefaultLayout, splitPane, findPaneNode, closePane, swapPanes } from '@agent-workbench/shared';
import { AgencyTabCoordinator } from './tab-coordinator.js';
import { AgencyNotificationStore } from './agency-notification-store.js';
import { TabActivityManager } from './tab-activity-manager.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-coordination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceStore = new AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
  await workspaceStore.load();
  const project = await workspaceStore.createProject('Integration');
  const workspace = await workspaceStore.createWorkspace(project.id, 'A', root);
  const lock = new WorkspaceMutex();
  const terminals = new Map<string, { terminalId: TerminalId; kind: string; state: string; exitCode: null; pid: number; alive: boolean }>();
  const registry = Object.assign(new EventEmitter(), {
    async open() {
      const terminalId = randomUUID() as TerminalId;
      const row = { terminalId, kind: 'shell', state: 'running', exitCode: null, pid: 123, alive: true };
      terminals.set(terminalId, row); return row;
    },
    get: (id: string) => terminals.get(id) ?? null,
    has: (id: string) => terminals.has(id), list: () => [...terminals.values()],
    close: () => { throw new Error('Selection must never close a PTY'); }, activityOf: () => 'unknown',
  });
  const native = new AgencySessionRuntime({ registry: registry as unknown as ConstructorParameters<typeof AgencySessionRuntime>[0]['registry'],
    store: new AgencySessionStore(path.join(root, 'sessions.json')),
    profiles: { resolveLaunch: async () => { throw new Error('No CLI launch requested'); } },
    workspaces: { protectedDirectories: () => [], withSessionReservation: (id, work) => lock.runExclusive(id, () => work(workspaceStore.getWorkspace(id))) },
  });
  await native.initialize(); t.after(() => native.dispose());

  const browser = new BrowserTabAdapter({ store: new BrowserTabStore(path.join(root, 'web.json')), workspaceStore });
  await browser.restore();
  const messages: AgencyServerMessage[] = [];
  const layouts = new AgencyLayoutStore(path.join(root, 'layouts.json'));
  await layouts.initialize();
  const coordinator = new AgencyTabCoordinator(native, browser, workspaceStore, message => messages.push(message), layouts);
  return { root, workspaceStore, workspace, terminals, native, browser, messages, coordinator, layouts, registry };
}

test('real domain coordinator serializes mixed selection and order without closing browser targets', async t => {
  const { workspaceStore, workspace, terminals, native, browser, messages, coordinator } = await fixture(t);
  const shell = await coordinator.createNative({ type: 'agency.session.create', requestId: 'shell', workspaceId: workspace.id,
    kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID() });
  assert.ok(shell.tab);
  const create = { type: 'agency.webTab.create' as const, requestId: 'browser', workspaceId: workspace.id,
    url: 'https://chatgpt.com/', launchId: 'web-once' };
  const results = await Promise.all([coordinator.webRequest(create), coordinator.webRequest(create)]);
  assert.equal(browser.listTabs().length, 1);
  assert.equal(results[0]?.type, 'agency.webTab.created');
  const web = browser.listTabs()[0]!;
  assert.equal(native.get(shell.id)?.tab?.selected, false);
  assert.equal(web.selected, true);
  await coordinator.nativeAction({ type: 'agency.tab.action', requestId: 'select', workspaceId: workspace.id, tabId: shell.tab.id, action: 'select' });
  assert.equal(browser.getTabState(web.id)?.selected, false);
  assert.equal(native.get(shell.id)?.tab?.selected, true);
  await coordinator.nativeAction({ type: 'agency.tabs.order', requestId: 'order', workspaceId: workspace.id, tabIds: [web.id, shell.tab.id] });
  assert.equal(browser.getTabState(web.id)?.order, 0);
  assert.equal(native.get(shell.id)?.tab?.order, 1);
  await Promise.all([
    coordinator.webRequest({ type: 'agency.webTab.select', requestId: 'w', workspaceId: workspace.id, tabId: web.id }),
    coordinator.nativeAction({ type: 'agency.tab.action', requestId: 'n', workspaceId: workspace.id, tabId: shell.tab.id, action: 'select' }),
  ]);
  assert.equal(Number(browser.getTabState(web.id)?.selected) + Number(native.get(shell.id)?.tab?.selected), 1);
  assert.equal(terminals.size, 1);
  for (const message of messages) assert.ok(parseServerMessage(JSON.stringify(message)), message.type);
  assert.equal(coordinator.canInspect(workspace.id, web.id), false);
  assert.equal(coordinator.canInspect(workspace.id, shell.tab.id), true);
  coordinator.snapshot(); messages.length = 0;
  await coordinator.nativeAction({ type: 'agency.tab.action', requestId: 'duplicate', workspaceId: workspace.id, tabId: shell.tab.id, action: 'select' });
  coordinator.snapshot();
  assert.equal(messages.length, 0, 'unchanged domains are not rebroadcast');
  await assert.rejects(coordinator.nativeAction({ type: 'agency.tab.action', requestId: 'foreign', workspaceId: workspace.id, tabId: randomUUID(), action: 'select' }));
  assert.equal(messages.length, 0, 'failed no-op is not a global refresh');
  await coordinator.nativeAction({ type: 'agency.tab.rename', requestId: 'rename', workspaceId: workspace.id, tabId: shell.tab.id, name: 'Changed' });
  assert.deepEqual(messages.map(m => m.type), ['agency.sessions.snapshot'], 'native changes do not resend browser state');
  messages.length = 0;
  await coordinator.webRequest({ type: 'agency.webTab.select', requestId: 'web-again', workspaceId: workspace.id, tabId: web.id });
  assert.ok(messages.some(m => m.type === 'agency.sessions.snapshot'));
  assert.ok(messages.some(m => m.type === 'agency.webTabs.snapshot'), 'mixed selection still synchronizes both domains');
  messages.length = 0;
  await workspaceStore.markDone(workspace.id);
  assert.equal(coordinator.canInspect(workspace.id, shell.tab.id), false);
});

test('inspection requires selected ownership, serializes with focus selection and persists only the inspected completion', async t => {
  const { root, workspaceStore, workspace, native, coordinator, terminals } = await fixture(t);
  const first = await coordinator.createNative({ type: 'agency.session.create', requestId: 'a', workspaceId: workspace.id,
    kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID() });
  const second = await coordinator.createNative({ type: 'agency.session.create', requestId: 'b', workspaceId: workspace.id,
    kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID() });
  const notificationsFile = path.join(root, 'notifications.json');
  const notifications = new AgencyNotificationStore(notificationsFile);
  await notifications.initialize();
  const activity = new TabActivityManager({ notificationStore: notifications, storageDir: root });
  await activity.initialize(); t.after(() => activity.dispose());
  for (const session of [first, second]) {
    const turn = { workspaceId: workspace.id, tabId: session.tab!.id, sessionId: session.id,
      provider: 'codex', lifecycle: 'running', taskId: session.id + ':turn', completionEvidence: 'native-turn' as const };
    await activity.handleCliActivity({ ...turn, nextActivity: 'working' });
    await activity.handleCliActivity({ ...turn, nextActivity: 'finished' });
  }
  let inspected = 0;
  await assert.rejects(coordinator.inspect(workspace.id, first.tab!.id, async () => { inspected++; }), /open and selected/);
  await assert.rejects(coordinator.inspect(randomUUID() as typeof workspace.id, second.tab!.id, async () => { inspected++; }), /open and selected/);
  assert.equal(inspected, 0);
  assert.equal(activity.getTabState(workspace.id, first.tab!.id), 'finished');
  assert.equal(activity.getTabState(workspace.id, second.tab!.id), 'finished');

  await coordinator.nativeAction({ type: 'agency.tab.action', requestId: 'focus-a', workspaceId: workspace.id, tabId: first.tab!.id, action: 'select' });
  let release!: () => void;
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const delay = new Promise<void>(resolve => { release = resolve; });
  const inspection = coordinator.inspect(workspace.id, first.tab!.id, async () => {
    started(); await delay;
    assert.equal(coordinator.canInspect(workspace.id, first.tab!.id), true, 'selection cannot overtake the pending acknowledgement');
    return activity.acknowledgeTab(workspace.id, first.tab!.id);
  });
  await start;
  const select = coordinator.nativeAction({ type: 'agency.tab.action', requestId: 'focus-b', workspaceId: workspace.id, tabId: second.tab!.id, action: 'select' });
  assert.equal(native.get(first.id)?.tab?.selected, true);
  release(); await Promise.all([inspection, select]);
  assert.equal(coordinator.canInspect(workspace.id, second.tab!.id), true);
  assert.equal(activity.getTabState(workspace.id, first.tab!.id), 'idle');
  assert.equal(activity.getTabState(workspace.id, second.tab!.id), 'finished');
  assert.equal(terminals.size, 2, 'focus and inspection keep the same live terminals');
  const originalNotifications = notifications.list();
  assert.ok(originalNotifications.every(item => !item.read), 'inspection does not mark inbox items read');
  await activity.flush(); await notifications.flush();
  const restoredNotifications = new AgencyNotificationStore(notificationsFile);
  await restoredNotifications.initialize();
  const restored = new TabActivityManager({ notificationStore: restoredNotifications, storageDir: root });
  await restored.initialize(); t.after(() => restored.dispose());
  assert.equal(restored.getTabState(workspace.id, first.tab!.id), 'idle');
  assert.equal(restored.getTabState(workspace.id, second.tab!.id), 'finished');
  assert.deepEqual(restoredNotifications.list(), originalNotifications);
  await workspaceStore.markDone(workspace.id);
  await assert.rejects(coordinator.inspect(workspace.id, second.tab!.id, async () => { inspected++; }), /open and selected/);
  assert.equal(inspected, 0);
});

test('main authenticated protocol validates browser contracts and rejects foreign fields and malformed snapshots', () => {
  const workspaceId = randomUUID();
  const input = { type: 'agency.webTab.create', requestId: 'integration', workspaceId,
    url: 'https://chatgpt.com/', launchId: 'once', unloaded: true };
  assert.deepEqual(parseClientMessage(JSON.stringify(input)), input);
  assert.equal(parseClientMessage(JSON.stringify({ ...input, cdp: 'http://localhost:9222' })), null);
  assert.equal(parseClientMessage(JSON.stringify({ ...input, url: 'http://127.0.0.1/' })), null);
  assert.equal(parseServerMessage(JSON.stringify({ type: 'agency.webTabs.snapshot', requestId: '', tabs: [{ id: 'fake' }] })), null);
});


test('creation commits a stable pane destination and swapped layout survives store restart', async t => {
  const { root, workspace, coordinator, layouts, terminals } = await fixture(t);
  let initial = createDefaultLayout(workspace.id, []);
  initial = { ...initial, tree: splitPane(initial.tree, 'pane-1', 'row', 'pane-2')! };
  await layouts.save(initial);
  for (const kind of ['terminal', 'web'] as const) {
    const result = kind === 'terminal'
      ? await coordinator.createNative({ type: 'agency.session.create', requestId: 'create-native', workspaceId: workspace.id, kind, cols: 80, rows: 24, launchId: randomUUID(), targetPaneId: 'pane-2' })
      : await coordinator.webRequest({ type: 'agency.webTab.create', requestId: 'create-web', workspaceId: workspace.id, url: 'https://chatgpt.com/', launchId: randomUUID(), targetPaneId: 'pane-2' });
    assert.ok(result);
    const saved = layouts.get(workspace.id)!;
    assert.equal(saved.focusedPaneId, 'pane-2');
    assert.equal(findPaneNode(saved.tree, 'pane-1')!.tabIds.length, 0);
    assert.equal(findPaneNode(saved.tree, 'pane-2')!.tabIds.length, kind === 'terminal' ? 1 : 2);
  }
  const before = layouts.get(workspace.id)!;
  const swapped = { ...before, tree: swapPanes(before.tree, 'pane-1', 'pane-2')! };
  await layouts.save(swapped);
  const restarted = new AgencyLayoutStore(path.join(root, 'layouts.json'));
  await restarted.initialize();
  assert.deepEqual(restarted.get(workspace.id), swapped);
  assert.equal(terminals.size, 1);
  assert.ok([...terminals.values()].every(terminal => terminal.alive));
  // A late completion reads the current tree inside the store's mutation queue.
  await layouts.save({ ...swapped, tree: closePane(swapped.tree, 'pane-2')!.tree, focusedPaneId: 'pane-1' });
  await coordinator.createNative({ type: 'agency.session.create', requestId: 'late', workspaceId: workspace.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(), targetPaneId: 'pane-2' });
  assert.equal(findPaneNode(layouts.get(workspace.id)!.tree, 'pane-1')!.tabIds.length, 3);
});


test('in-flight creation keeps its destination through focus changes and deletion', async t => {
  for (const removeTarget of [false, true]) {
    const { workspace, coordinator, layouts, registry, terminals } = await fixture(t);
    const initial = createDefaultLayout(workspace.id, []);
    const split = { ...initial, tree: splitPane(initial.tree, 'pane-1', 'row', 'pane-2')! };
    await layouts.save(split);
    const open = registry.open;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    registry.open = async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return open();
    };
    const creating = coordinator.createNative({ type: 'agency.session.create', requestId: 'delayed', workspaceId: workspace.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(), targetPaneId: 'pane-2' });
    await entered;
    await layouts.save({ ...split, focusedPaneId: 'pane-1', ...(removeTarget ? { tree: closePane(split.tree, 'pane-2')!.tree } : {}) });
    release();
    const created = await creating;
    const saved = layouts.get(workspace.id)!;
    const expected = removeTarget ? 'pane-1' : 'pane-2';
    assert.equal(saved.focusedPaneId, expected);
    assert.deepEqual(findPaneNode(saved.tree, expected)!.tabIds, [created.tab!.id]);
    assert.equal(terminals.size, 1);
  }
});

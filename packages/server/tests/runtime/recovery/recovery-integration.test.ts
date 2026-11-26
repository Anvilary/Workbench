import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type {
  AgencyServerMessage,
  AgencyRuntimeSession,
  AgencyWorkspace,
  CliProfileId,
  TerminalId,
  WebTab,
  WorkspacePaneLayout,
} from '@anvilary/workbench-shared';
import {
  createDefaultLayout,
  splitPane,
  findPaneNode,
  getPaneNodes,
  swapPanes,
  isWorkspacePaneLayout,
} from '@anvilary/workbench-shared';
import { AgencySessionRuntime } from '../../../src/features/sessions/session-runtime.js';
import { AgencySessionStore } from '../../../src/features/sessions/session-store.js';
import { AgencyWorkspaceStore } from '../../../src/features/workspaces/workspace-store.js';
import { WorkspaceMutex } from '../../../src/features/workspaces/workspace-lock.js';
import { BrowserTabAdapter } from '../../../src/features/browser/browser-tab-adapter.js';
import { BrowserTabStore } from '../../../src/features/browser/browser-tab-store.js';
import { AgencyLayoutStore } from '../../../src/features/workspaces/layout-store.js';
import { AgencyTabCoordinator } from '../../../src/features/workspaces/tab-coordinator.js';
import { writeAtomically } from '../../../src/shared/persistence/atomic-write.js';

interface ClientStoreState {
  workspaces: AgencyWorkspace[];
  sessions: AgencyRuntimeSession[];
  webTabs: WebTab[];
  layouts: Record<string, WorkspacePaneLayout>;
  layoutWarnings: Record<string, string>;
}

function createClientStore() {
  const state: ClientStoreState = {
    workspaces: [],
    sessions: [],
    webTabs: [],
    layouts: {},
    layoutWarnings: {},
  };

  const pending = new Map<string, { resolve: (msg: any) => void; reject: (err: Error) => void }>();

  function receiveServerMessage(message: AgencyServerMessage) {
    if (message.type === 'agency.sessions.snapshot') {
      state.sessions = [...message.sessions];
    } else if (message.type === 'agency.webTabs.snapshot') {
      state.webTabs = [...message.tabs];
    } else if (message.type === 'agency.layouts.snapshot') {
      const map: Record<string, WorkspacePaneLayout> = {};
      for (const l of message.layouts) map[l.workspaceId] = l;
      state.layouts = { ...state.layouts, ...map };
    } else if (message.type === 'agency.layout.changed') {
      delete state.layoutWarnings[message.workspaceId];
      state.layouts[message.workspaceId] = message.layout;
    } else if (message.type === 'agency.workspace.deleted') {
      delete state.layoutWarnings[message.workspaceId];
      state.workspaces = state.workspaces.filter(w => w.id !== message.workspaceId);
    } else if (message.type === 'agency.session.created') {
      const idx = state.sessions.findIndex(s => s.id === message.session.id);
      if (idx >= 0) state.sessions[idx] = message.session;
      else state.sessions.push(message.session);
    } else if (message.type === 'agency.webTab.created') {
      const idx = state.webTabs.findIndex(t => t.id === message.tab.id);
      if (idx >= 0) state.webTabs[idx] = message.tab;
      else state.webTabs.push(message.tab);
    } else if (message.type === 'agency.error') {
      if (!message.requestId || !pending.has(message.requestId)) {
        if (message.workspaceId) {
          state.layoutWarnings[message.workspaceId] = message.message;
        }
      }
    }

    if ('requestId' in message && message.requestId) {
      const p = pending.get(message.requestId);
      if (p) {
        pending.delete(message.requestId);
        if (message.type === 'agency.error') p.reject(new Error(message.message));
        else p.resolve(message);
      }
    }
  }

  return {
    state,
    pending,
    receiveServerMessage,
    clearWarning(wsId: string) {
      delete state.layoutWarnings[wsId];
    },
  };
}

async function setupIntegrationHarness(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-recovery-int-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspaceStore = new AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
  await workspaceStore.load();
  const project = await workspaceStore.createProject('Recovery Integration Project');
  const workspace = await workspaceStore.createWorkspace(project.id, 'Workspace 1', root);

  const terminals = new Map<string, { terminalId: TerminalId; kind: string; state: string; exitCode: null; pid: number; alive: boolean }>();
  const registry = Object.assign(new EventEmitter(), {
    async open() {
      const terminalId = randomUUID() as TerminalId;
      const row = { terminalId, kind: 'shell', state: 'running', exitCode: null, pid: 1234, alive: true };
      terminals.set(terminalId, row);
      return row;
    },
    get: (id: string) => terminals.get(id) ?? null,
    has: (id: string) => terminals.has(id),
    list: () => [...terminals.values()],
    close: () => {},
    activityOf: () => 'unknown',
  });

  const lock = new WorkspaceMutex();
  const native = new AgencySessionRuntime({
    registry: registry as unknown as ConstructorParameters<typeof AgencySessionRuntime>[0]['registry'],
    store: new AgencySessionStore(path.join(root, 'sessions.json')),
    profiles: {
      resolveLaunch: async (input) => ({
        profileId: input.profileId,
        provider: 'claude-code',
        file: '/bin/echo',
        args: ['hello'],
        env: { PATH: '/usr/bin' },
        session: { kind: 'discover' },
        launchToken: input.launchToken,
        proposedSessionId: input.proposedSessionId,
        cwd: input.cwd,
      }),
    },
    workspaces: {
      protectedDirectories: () => [],
      withSessionReservation: (id, work) => lock.runExclusive(id, () => work(workspaceStore.getWorkspace(id))),
    },
  });
  await native.initialize();
  t.after(() => native.dispose());

  const browser = new BrowserTabAdapter({
    store: new BrowserTabStore(path.join(root, 'browser-tabs.json')),
    workspaceStore,
  });
  await browser.restore();

  let shouldFailLayoutWrite = false;
  const layoutStore = new AgencyLayoutStore(
    path.join(root, 'agency-layouts.json'),
    async (target, content, options) => {
      if (shouldFailLayoutWrite) {
        throw new Error('Simulated disk persistence failure (EIO disk error / temporary lock)');
      }
      return writeAtomically(target, content, options);
    },
  );
  await layoutStore.initialize();

  const store = createClientStore();
  const broadcastMessages: AgencyServerMessage[] = [];

  const broadcast = (msg: AgencyServerMessage) => {
    broadcastMessages.push(msg);
    store.receiveServerMessage(msg);
  };

  const coordinator = new AgencyTabCoordinator(native, browser, workspaceStore, broadcast, layoutStore);

  // Initialize a 2-pane layout
  let initialLayout = createDefaultLayout(workspace.id, []);
  initialLayout = { ...initialLayout, tree: splitPane(initialLayout.tree, 'pane-1', 'row', 'pane-2')! };
  await layoutStore.save(initialLayout);
  store.state.layouts[workspace.id] = initialLayout;

  return {
    root,
    workspace,
    terminals,
    native,
    browser,
    layoutStore,
    coordinator,
    store,
    broadcast,
    broadcastMessages,
    setFailLayoutWrite: (fail: boolean) => { shouldFailLayoutWrite = fail; },
  };
}

test('PR #25 Integration: End-to-end recovery using real server message flow and frontend store', async t => {
  const { workspace, terminals, coordinator, layoutStore, store, broadcast, setFailLayoutWrite } = await setupIntegrationHarness(t);

  // --- 1. Create a terminal successfully, then fail layout persistence ---
  setFailLayoutWrite(true);
  const terminalLaunchId = randomUUID();
  const terminalSession = await coordinator.createNative({
    type: 'agency.session.create',
    requestId: 'req-term-create-1',
    workspaceId: workspace.id,
    kind: 'terminal',
    cols: 80,
    rows: 24,
    launchId: terminalLaunchId,
    targetPaneId: 'pane-2',
  });

  // --- 2. Confirm the creation response indicates success ---
  assert.ok(terminalSession, 'creation result must exist');
  assert.equal(terminalSession.kind, 'terminal');
  assert.equal(terminalSession.launchId, terminalLaunchId);
  assert.ok(terminalSession.id, 'session has a valid ID');
  assert.ok(terminalSession.tab?.id, 'session has a valid tab ID');
  assert.equal(terminals.size, 1, 'exactly one PTY process was created');

  // Server message flow delivered session and placement error to store
  store.receiveServerMessage({ type: 'agency.session.created', requestId: 'req-term-create-1', session: terminalSession });
  assert.equal(store.state.sessions.length, 1);
  assert.equal(store.state.sessions[0]?.id, terminalSession.id);

  // --- 3. Confirm the correct workspace displays a placement warning ---
  assert.ok(store.state.layoutWarnings[workspace.id], 'placement warning must be present in client store for this workspace');
  const termWarning = store.state.layoutWarnings[workspace.id]!;
  assert.match(termWarning, /Layout placement persistence failure for tab "Terminal/i);
  assert.ok(!termWarning.includes('/'), 'filesystem paths must NOT be exposed in warning');
  assert.ok(!termWarning.includes('EIO'), 'raw IO errors must NOT be exposed');

  // Verify idempotent retry using the original launchId while persistence still fails
  const termRetry = await coordinator.createNative({
    type: 'agency.session.create',
    requestId: 'req-term-retry-1',
    workspaceId: workspace.id,
    kind: 'terminal',
    cols: 80,
    rows: 24,
    launchId: terminalLaunchId,
    targetPaneId: 'pane-2',
  });
  assert.equal(termRetry.id, terminalSession.id, 'idempotent retry must return original session ID');
  assert.equal(termRetry.tab!.id, terminalSession.tab!.id, 'idempotent retry must return original tab ID');
  assert.equal(terminals.size, 1, 'idempotent retry must not spawn duplicate PTY');

  // --- 4. Repeat with a CLI and a ChatGPT tab ---
  // A: CLI session
  const cliLaunchId = randomUUID();
  const cliSession = await coordinator.createNative({
    type: 'agency.session.create',
    requestId: 'req-cli-create-1',
    workspaceId: workspace.id,
    kind: 'agent',
    profileId: 'claude-code' as CliProfileId,
    cols: 80,
    rows: 24,
    launchId: cliLaunchId,
    targetPaneId: 'pane-2',
  });
  assert.ok(cliSession);
  assert.equal(cliSession.kind, 'agent');
  assert.equal(cliSession.launchId, cliLaunchId);
  assert.equal(terminals.size, 2, 'exactly two PTY processes total (1 terminal + 1 CLI)');

  store.receiveServerMessage({ type: 'agency.session.created', requestId: 'req-cli-create-1', session: cliSession });
  assert.equal(store.state.sessions.length, 2);

  const cliWarning = store.state.layoutWarnings[workspace.id];
  assert.ok(cliWarning);
  assert.match(cliWarning, /Layout placement persistence failure for tab "(CLI|claude-code)/i);
  assert.ok(!cliWarning.includes('/'), 'filesystem paths must NOT be exposed');

  // Verify idempotent retry for CLI
  const cliRetry = await coordinator.createNative({
    type: 'agency.session.create',
    requestId: 'req-cli-retry-1',
    workspaceId: workspace.id,
    kind: 'agent',
    profileId: 'claude-code' as CliProfileId,
    cols: 80,
    rows: 24,
    launchId: cliLaunchId,
    targetPaneId: 'pane-2',
  });
  assert.equal(cliRetry.id, cliSession.id);
  assert.equal(terminals.size, 2, 'idempotent CLI retry must not spawn duplicate PTY');

  // B: ChatGPT tab
  const webLaunchId = randomUUID();
  const webResponse = await coordinator.webRequest({
    type: 'agency.webTab.create',
    requestId: 'req-web-create-1',
    workspaceId: workspace.id,
    url: 'https://chatgpt.com/',
    title: 'Research Analysis',
    launchId: webLaunchId,
    targetPaneId: 'pane-2',
  });
  assert.equal(webResponse?.type, 'agency.webTab.created');
  const webTab = (webResponse as any).tab as WebTab;
  assert.ok(webTab);
  assert.equal(webTab.launchId, webLaunchId);

  store.receiveServerMessage(webResponse as AgencyServerMessage);
  assert.equal(store.state.webTabs.length, 1);

  const webWarning = store.state.layoutWarnings[workspace.id];
  assert.ok(webWarning);
  assert.match(webWarning, /Layout placement persistence failure for tab "Research Analysis"/i);
  assert.ok(!webWarning.includes('/'), 'filesystem paths must NOT be exposed');

  // Verify idempotent retry for ChatGPT tab
  const webRetry = await coordinator.webRequest({
    type: 'agency.webTab.create',
    requestId: 'req-web-retry-1',
    workspaceId: workspace.id,
    url: 'https://chatgpt.com/',
    launchId: webLaunchId,
    targetPaneId: 'pane-2',
  });
  assert.equal(webRetry?.type, 'agency.webTab.created');
  assert.equal((webRetry as any).tab.id, webTab.id);

  // Layout in disk store was not modified because write failed
  const diskLayout = layoutStore.get(workspace.id)!;
  assert.equal(findPaneNode(diskLayout.tree, 'pane-2')!.tabIds.length, 0, 'disk layout was not updated during failures');

  // --- 5. Reconnect without requesting agency.layout.get manually ---
  // Ordinary reconnect pushes agency.layouts.snapshot with coordinator.reconcileAllLayouts()
  const reconnectedLayouts = coordinator.reconcileAllLayouts();
  assert.ok(reconnectedLayouts.length >= 1);
  const reconnectSnapshot: AgencyServerMessage = {
    type: 'agency.layouts.snapshot',
    requestId: '',
    layouts: reconnectedLayouts,
  };
  store.receiveServerMessage(reconnectSnapshot);

  // --- 6. Verify the created tabs appear in a valid pane ---
  const recoveredLayout = store.state.layouts[workspace.id];
  assert.ok(recoveredLayout);
  assert.equal(isWorkspacePaneLayout(recoveredLayout), true);
  const allRecoveredPaneTabs = getPaneNodes(recoveredLayout.tree).flatMap(p => p.tabIds);

  assert.ok(allRecoveredPaneTabs.includes(terminalSession.tab!.id), 'terminal tab assigned to pane');
  assert.ok(allRecoveredPaneTabs.includes(cliSession.tab!.id), 'CLI tab assigned to pane');
  assert.ok(allRecoveredPaneTabs.includes(webTab.id), 'ChatGPT tab assigned to pane');

  // --- 7. Verify no duplicate tab or PTY is created ---
  assert.equal(terminals.size, 2, 'PTYs remain exactly 2');
  assert.equal(store.state.sessions.length, 2, 'sessions remain exactly 2');
  assert.equal(store.state.webTabs.length, 1, 'web tabs remain exactly 1');

  // --- 8. Verify eventual durable layout recovery ---
  // Now disk persistence succeeds again
  setFailLayoutWrite(false);

  // Client or server persists the reconciled layout
  await layoutStore.save(recoveredLayout);
  broadcast({ type: 'agency.layout.changed', workspaceId: workspace.id, layout: recoveredLayout });

  // Placement warning is cleared upon successful layout save / change
  assert.equal(store.state.layoutWarnings[workspace.id], undefined, 'placement warning cleared on layout recovery');

  // Durable layout on disk now safely contains all open tabs
  const durablyRecovered = layoutStore.get(workspace.id)!;
  assert.ok(durablyRecovered);
  const durablyAssignedTabs = getPaneNodes(durablyRecovered.tree).flatMap(p => p.tabIds);
  assert.ok(durablyAssignedTabs.includes(terminalSession.tab!.id));
  assert.ok(durablyAssignedTabs.includes(cliSession.tab!.id));
  assert.ok(durablyAssignedTabs.includes(webTab.id));

  // --- 9. Confirm normal pane creation and swapping remain unchanged ---
  // Normal creation directly into pane-1
  const normalSession = await coordinator.createNative({
    type: 'agency.session.create',
    requestId: 'req-normal-create',
    workspaceId: workspace.id,
    kind: 'terminal',
    cols: 80,
    rows: 24,
    launchId: randomUUID(),
    targetPaneId: 'pane-1',
  });
  assert.ok(normalSession);
  assert.equal(terminals.size, 3);
  const layoutAfterNormal = layoutStore.get(workspace.id)!;
  assert.ok(findPaneNode(layoutAfterNormal.tree, 'pane-1')!.tabIds.includes(normalSession.tab!.id));

  // Swapping panes
  const currentTree = layoutAfterNormal.tree;
  const swappedTree = swapPanes(currentTree, 'pane-1', 'pane-2')!;
  assert.ok(swappedTree);
  const swappedLayout: WorkspacePaneLayout = { ...layoutAfterNormal, tree: swappedTree };
  await layoutStore.save(swappedLayout);
  broadcast({ type: 'agency.layout.changed', workspaceId: workspace.id, layout: swappedLayout });

  const diskSwapped = layoutStore.get(workspace.id)!;
  assert.deepEqual(diskSwapped.tree, swappedTree);
  assert.deepEqual(store.state.layouts[workspace.id]?.tree, swappedTree);
});

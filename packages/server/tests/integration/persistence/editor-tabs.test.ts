import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AgencyServerMessage, TerminalId } from '@agent-workbench/shared';
import { validateRelativeFilePath } from '@agent-workbench/shared';
import { EditorTabStore } from '../../../src/features/editor/editor-tab-store.js';
import { EditorTabAdapter, type EditorSelectionCoordinator } from '../../../src/features/editor/editor-tab-adapter.js';
import { AgencyWorkspaceStore } from '../../../src/features/workspaces/workspace-store.js';
import { AgencySessionRuntime } from '../../../src/features/sessions/session-runtime.js';
import { AgencySessionStore } from '../../../src/features/sessions/session-store.js';
import { BrowserTabAdapter } from '../../../src/features/browser/browser-tab-adapter.js';
import { BrowserTabStore } from '../../../src/features/browser/browser-tab-store.js';
import { AgencyLayoutStore } from '../../../src/features/workspaces/layout-store.js';
import { AgencyTabCoordinator } from '../../../src/features/workspaces/tab-coordinator.js';
import { WorkspaceMutex } from '../../../src/features/workspaces/workspace-lock.js';

test('validateRelativeFilePath enforces strict relative posix paths', () => {
  // Valid paths
  assert.equal(validateRelativeFilePath('index.ts').valid, true);
  assert.equal(validateRelativeFilePath('src/index.ts').normalizedPath, 'src/index.ts');
  assert.equal(validateRelativeFilePath('src\\nested\\file.js').normalizedPath, 'src/nested/file.js');
  assert.equal(validateRelativeFilePath('./docs/readme.md').normalizedPath, 'docs/readme.md');

  // Traversal rejected
  assert.equal(validateRelativeFilePath('../outside.txt').valid, false);
  assert.equal(validateRelativeFilePath('src/../../outside.txt').valid, false);
  assert.equal(validateRelativeFilePath('..').valid, false);

  // Absolute rejected
  assert.equal(validateRelativeFilePath('/etc/passwd').valid, false);
  assert.equal(validateRelativeFilePath('\\Windows\\System32').valid, false);
  assert.equal(validateRelativeFilePath('C:\\autoexec.bat').valid, false);

  // Null bytes & empty rejected
  assert.equal(validateRelativeFilePath('test\0.txt').valid, false);
  assert.equal(validateRelativeFilePath('').valid, false);
  assert.equal(validateRelativeFilePath('   ').valid, false);
  assert.equal(validateRelativeFilePath('.').valid, false);
});

test('EditorTabStore provides durable persistence, atomic write, backup fallback and corrupt quarantine', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-editor-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const storeFile = path.join(root, 'agency-editor-tabs.json');
  const store = new EditorTabStore(storeFile);

  // Initially empty
  const initial = await store.load();
  assert.deepEqual(initial, []);

  const wsId = randomUUID() as any;
  const tab1 = {
    id: randomUUID(),
    workspaceId: wsId,
    kind: 'editor' as const,
    filePath: 'src/main.ts',
    title: 'main.ts',
    order: 0,
    selected: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
  };
  const tab2 = {
    id: randomUUID(),
    workspaceId: wsId,
    kind: 'editor' as const,
    filePath: 'package.json',
    title: 'package.json',
    order: 1,
    selected: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
  };

  await store.save([tab1]);
  await store.save([tab1, tab2]);

  // Reload in new store instance (simulating app restart)
  const store2 = new EditorTabStore(storeFile);
  const loaded = await store2.load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0]!.filePath, 'src/main.ts');
  assert.equal(loaded[0]!.selected, true);
  assert.equal(loaded[1]!.filePath, 'package.json');
  assert.equal(loaded[1]!.selected, false);

  // Corrupt primary file: should recover from .bak (which had tab1) and quarantine primary
  await writeFile(storeFile, '{ corrupt-json !!!');
  const store3 = new EditorTabStore(storeFile);
  const recovered = await store3.load();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.filePath, 'src/main.ts');
});

test('EditorTabAdapter validates paths against workspace root, symlinks and protected dirs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-editor-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const outsideDir = await mkdtemp(path.join(tmpdir(), 'maw-outside-'));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  await writeFile(path.join(outsideDir, 'secret.txt'), 'secret');

  const wsDir = path.join(root, 'workspace');
  await mkdir(wsDir, { recursive: true });
  await writeFile(path.join(wsDir, 'valid.txt'), 'valid content');
  await mkdir(path.join(wsDir, '.claude'), { recursive: true });
  await writeFile(path.join(wsDir, '.claude', 'credentials.json'), '{}');

  // Symlink pointing outside workspace
  await symlink(path.join(outsideDir, 'secret.txt'), path.join(wsDir, 'symlink-outside.txt'));

  const workspaceStore = new AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
  await workspaceStore.load();
  const proj = await workspaceStore.createProject('Test Project');
  const ws = await workspaceStore.createWorkspace(proj.id, 'WS', wsDir);

  const store = new EditorTabStore(path.join(root, 'editor-tabs.json'));
  const adapter = new EditorTabAdapter({
    store,
    workspaceStore,
    protectedDirsProvider: () => [path.join(wsDir, '.claude')],
  });

  // 1. Valid file creates tab
  const tab = await adapter.createTab({
    workspaceId: ws.id,
    filePath: 'valid.txt',
    select: true,
  });
  assert.equal(tab.filePath, 'valid.txt');
  assert.equal(tab.title, 'valid.txt');
  assert.equal(tab.selected, true);

  // 2. Traversal rejected
  await assert.rejects(
    () => adapter.createTab({ workspaceId: ws.id, filePath: '../secret.txt' }),
    (err: any) => err.code === 'invalid-request',
  );

  // 3. Symlink pointing outside rejected
  await assert.rejects(
    () => adapter.createTab({ workspaceId: ws.id, filePath: 'symlink-outside.txt' }),
    (err: any) => err.code === 'invalid-request',
  );

  // 4. Protected CLI directory rejected
  await assert.rejects(
    () => adapter.createTab({ workspaceId: ws.id, filePath: '.claude/credentials.json' }),
    (err: any) => err.code === 'permission-denied',
  );

  // 5. Deduplication: opening same path again returns existing tab
  const tabDuplicate = await adapter.createTab({
    workspaceId: ws.id,
    filePath: 'valid.txt',
    select: true,
  });
  assert.equal(tabDuplicate.id, tab.id);
  assert.equal(adapter.listTabs(ws.id).length, 1);

  // 6. Select, rename, close
  const tab2 = await adapter.createTab({
    workspaceId: ws.id,
    filePath: 'valid.txt-renamed',
    select: false,
  });
  assert.equal(adapter.listTabs(ws.id).length, 2);

  // Select tab2 deselects tab1
  const selectedTab2 = await adapter.selectTab(ws.id, tab2.id);
  assert.equal(selectedTab2.selected, true);
  assert.equal(adapter.getTabState(tab.id)?.selected, false);

  // Rename tab2
  const renamed = await adapter.renameTab(ws.id, tab2.id, 'Custom Title.txt');
  assert.equal(renamed.title, 'Custom Title.txt');

  // Close tab2
  const closed = await adapter.closeTab(ws.id, tab2.id);
  assert.ok(closed.closedAt);
  assert.equal(closed.selected, false);
  assert.equal(adapter.listTabs(ws.id).length, 1);
});

test('AgencyTabCoordinator coordinates selection, order, layout and deletion with editor tabs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-coord-editor-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const wsDir = path.join(root, 'workspace');
  await mkdir(wsDir, { recursive: true });
  await writeFile(path.join(wsDir, 'file.ts'), 'export const x = 1;');

  const workspaceStore = new AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
  await workspaceStore.load();
  const proj = await workspaceStore.createProject('Integration');
  const ws = await workspaceStore.createWorkspace(proj.id, 'WS', wsDir);

  const lock = new WorkspaceMutex();
  const terminals = new Map<string, any>();
  const registry = Object.assign(new EventEmitter(), {
    async open() {
      const terminalId = randomUUID() as TerminalId;
      const row = { terminalId, kind: 'shell', state: 'running', exitCode: null, pid: 123, alive: true };
      terminals.set(terminalId, row);
      return row;
    },
    get: (id: string) => terminals.get(id) ?? null,
    has: (id: string) => terminals.has(id),
    list: () => [...terminals.values()],
    close: (id: string) => {
      const entry = terminals.get(id);
      if (entry) {
        entry.alive = false;
        entry.state = 'exited';
        entry.exitCode = 0;
        registry.emit('exit', id, 0);
      }
    },
    activityOf: () => 'unknown',
  });

  const native = new AgencySessionRuntime({
    registry: registry as any,
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
    store: new BrowserTabStore(path.join(root, 'web.json')),
    workspaceStore,
  });
  await browser.restore();

  const editor = new EditorTabAdapter({
    store: new EditorTabStore(path.join(root, 'editor.json')),
    workspaceStore,
  });
  await editor.restore();

  const messages: AgencyServerMessage[] = [];
  const layouts = new AgencyLayoutStore(path.join(root, 'layouts.json'));
  await layouts.initialize();

  const coordinator = new AgencyTabCoordinator(
    native,
    browser,
    workspaceStore,
    (msg) => messages.push(msg),
    layouts,
    editor,
  );

  // 1. Create a native terminal session (it becomes selected)
  const session = await coordinator.createNative({
    type: 'agency.session.create',
    requestId: 'r1',
    workspaceId: ws.id,
    kind: 'terminal',
    cols: 80,
    rows: 24,
  });
  assert.equal(session.tab?.selected, true);

  // 2. Open an editor tab: it should become selected and unselect native session
  const editorRes = await coordinator.editorRequest({
    type: 'agency.editorTab.open',
    requestId: 'r2',
    workspaceId: ws.id,
    filePath: 'file.ts',
    select: true,
  });
  assert.equal(editorRes?.type, 'agency.editorTab.opened');
  const editorTab = (editorRes as any).tab;
  assert.equal(editorTab.selected, true);

  // Native session must now be unselected
  const nativeUpdated = native.get(session.id);
  assert.equal(nativeUpdated?.tab?.selected, false);

  // 3. Create a web tab: it becomes selected and unselects editor tab
  const webRes = await coordinator.webRequest({
    type: 'agency.webTab.create',
    requestId: 'r3',
    workspaceId: ws.id,
    url: 'https://chatgpt.com/',
    select: true,
  });
  assert.equal(webRes?.type, 'agency.webTab.created');
  assert.equal(editor.getTabState(editorTab.id)?.selected, false);

  // 4. Order tabs across native, web and editor
  await coordinator.order(ws.id, [editorTab.id, session.tab!.id, (webRes as any).tab.id]);
  assert.equal(editor.getTabState(editorTab.id)?.order, 0);

  // 5. Layout reconciliation includes editor tab
  const layout = coordinator.reconcileLayout(ws.id);
  assert.ok(layout);
  const layoutTabIds = (layout.tree as any).tabIds ?? [];
  assert.ok(layoutTabIds.includes(editorTab.id));

  // 6. Fallback selection when web tab is closed falls back to editor or native
  await coordinator.webRequest({
    type: 'agency.webTab.close',
    requestId: 'r4',
    workspaceId: ws.id,
    tabId: (webRes as any).tab.id,
  });
  // One of the remaining open tabs must be selected
  const hasSelected =
    native.list(ws.id).some((s) => s.tab?.selected) ||
    editor.listTabs(ws.id).some((t) => t.selected);
  assert.equal(hasSelected, true);

  // 7. Workspace deletion shutdown closes editor tabs and cleans up layout
  await coordinator.shutdownWorkspace(ws.id);
  assert.equal(editor.listTabs(ws.id).length, 0);
  assert.equal(coordinator.hasEditorReferences(ws.id), false);
});

test('EditorTabAdapter rolls back in-memory metadata on persistence failure and recovers on restart', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-editor-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const wsDir = path.join(root, 'workspace');
  await mkdir(wsDir, { recursive: true });
  await writeFile(path.join(wsDir, 'file1.txt'), 'one');
  await writeFile(path.join(wsDir, 'file2.txt'), 'two');

  const workspaceStore = new AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
  await workspaceStore.load();
  const proj = await workspaceStore.createProject('Failures');
  const ws = await workspaceStore.createWorkspace(proj.id, 'WS', wsDir);

  const storeFile = path.join(root, 'editor-tabs.json');
  const store = new EditorTabStore(storeFile);
  const adapter = new EditorTabAdapter({
    store,
    workspaceStore,
  });

  // 1. Initially create one tab successfully
  const tab1 = await adapter.createTab({
    workspaceId: ws.id,
    filePath: 'file1.txt',
    select: true,
  });
  assert.equal(adapter.listTabs(ws.id).length, 1);
  assert.equal(tab1.title, 'file1.txt');

  // 2. Inject persistence failure into store.save
  let shouldFail = true;
  const originalSave = store.save.bind(store);
  store.save = async (tabs) => {
    if (shouldFail) {
      throw new Error('Injected disk full error');
    }
    return originalSave(tabs);
  };

  // Attempt to create second tab; must throw injected error
  await assert.rejects(
    () =>
      adapter.createTab({
        workspaceId: ws.id,
        filePath: 'file2.txt',
        select: true,
      }),
    /Injected disk full error/,
  );

  // In-memory state of adapter must have rolled back: file2 is NOT in the list
  assert.equal(adapter.listTabs(ws.id).length, 1);
  assert.equal(adapter.listTabs(ws.id)[0]!.filePath, 'file1.txt');
  assert.equal(adapter.listTabs(ws.id)[0]!.selected, true);

  // Attempt to rename tab1 with failure injected: must roll back title
  await assert.rejects(
    () => adapter.renameTab(ws.id, tab1.id, 'new-name.txt'),
    /Injected disk full error/,
  );
  assert.equal(adapter.getTabState(tab1.id)?.title, 'file1.txt');

  // Attempt to close tab1 with failure injected: must roll back closed state
  await assert.rejects(
    () => adapter.closeTab(ws.id, tab1.id),
    /Injected disk full error/,
  );
  assert.equal(adapter.getTabState(tab1.id)?.closedAt, null);

  // 3. Restart recovery: load into a fresh store & adapter instance
  shouldFail = false;
  const freshStore = new EditorTabStore(storeFile);
  const freshAdapter = new EditorTabAdapter({
    store: freshStore,
    workspaceStore,
  });
  await freshAdapter.restore();

  // Fresh adapter must see intact previous state (tab1 open, title file1.txt, no file2)
  const recoveredTabs = freshAdapter.listTabs(ws.id);
  assert.equal(recoveredTabs.length, 1);
  assert.equal(recoveredTabs[0]!.id, tab1.id);
  assert.equal(recoveredTabs[0]!.title, 'file1.txt');
  assert.equal(recoveredTabs[0]!.closedAt, null);
  assert.equal(recoveredTabs[0]!.selected, true);
});

test('Cross-store selection failure rolls back editor and restores native session selection and snapshot', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-coord-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const wsDir = path.join(root, 'workspace');
  await mkdir(wsDir, { recursive: true });
  await writeFile(path.join(wsDir, 'editor-file.ts'), 'export const y = 2;');

  const workspaceStore = new AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
  await workspaceStore.load();
  const proj = await workspaceStore.createProject('Coord Failures');
  const ws = await workspaceStore.createWorkspace(proj.id, 'WS', wsDir);

  const lock = new WorkspaceMutex();
  const terminals = new Map<string, any>();
  const registry = Object.assign(new EventEmitter(), {
    async open() {
      const terminalId = randomUUID() as TerminalId;
      const row = { terminalId, kind: 'shell', state: 'running', exitCode: null, pid: 456, alive: true };
      terminals.set(terminalId, row);
      return row;
    },
    get: (id: string) => terminals.get(id) ?? null,
    has: (id: string) => terminals.has(id),
    list: () => [...terminals.values()],
    close: () => {},
    activityOf: () => 'unknown',
  });

  const native = new AgencySessionRuntime({
    registry: registry as any,
    store: new AgencySessionStore(path.join(root, 'sessions.json')),
    profiles: {
      resolveLaunch: async (input) => ({
        profileId: input.profileId,
        provider: 'claude-code',
        file: '/bin/echo',
        args: ['test'],
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
    store: new BrowserTabStore(path.join(root, 'web.json')),
    workspaceStore,
  });
  await browser.restore();

  const editorStore = new EditorTabStore(path.join(root, 'editor.json'));
  const editor = new EditorTabAdapter({
    store: editorStore,
    workspaceStore,
  });
  await editor.restore();

  const publishedMessages: AgencyServerMessage[] = [];
  const coordinator = new AgencyTabCoordinator(
    native,
    browser,
    workspaceStore,
    (msg) => publishedMessages.push(msg),
    undefined,
    editor,
  );

  // 1. Create a native terminal session (it becomes selected)
  const session = await coordinator.createNative({
    type: 'agency.session.create',
    requestId: 'r1',
    workspaceId: ws.id,
    kind: 'terminal',
    cols: 80,
    rows: 24,
  });
  assert.equal(session.tab?.selected, true);

  // Clear messages from setup
  publishedMessages.length = 0;

  // 2. Inject failure into editorStore.save
  editorStore.save = async () => {
    throw new Error('Editor disk write error');
  };

  // Attempt to open editor tab with select: true via coordinator.editorRequest
  const errorRes = await coordinator.editorRequest({
    type: 'agency.editorTab.open',
    requestId: 'r2',
    workspaceId: ws.id,
    filePath: 'editor-file.ts',
    select: true,
  });

  // Must return an agency.error
  assert.equal(errorRes?.type, 'agency.error');

  // Verify editor tabs list is empty (rolled back)
  assert.equal(editor.listTabs(ws.id).length, 0);

  // Verify native session selection was RESTORED
  const restoredSession = native.get(session.id);
  assert.equal(restoredSession?.tab?.selected, true);

  // Verify snapshots: coordinator broadcasted sessions snapshot showing native session selected
  const sessionSnapshots = publishedMessages.filter(
    (m): m is Extract<AgencyServerMessage, { type: 'agency.sessions.snapshot' }> =>
      m.type === 'agency.sessions.snapshot',
  );
  assert.ok(sessionSnapshots.length > 0);
  const latestSnapshot = sessionSnapshots[sessionSnapshots.length - 1]!;
  const nativeTabInSnapshot = latestSnapshot.sessions.find((s) => s.id === session.id);
  assert.equal(nativeTabInSnapshot?.tab?.selected, true);
});

test('P1 regressions: cross-store deadlock removal, snapshot cleanup, and bounded recovery', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-p1-regressions-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const wsDirA = path.join(root, 'workspaceA');
  const wsDirB = path.join(root, 'workspaceB');
  await mkdir(wsDirA, { recursive: true });
  await mkdir(wsDirB, { recursive: true });
  await writeFile(path.join(wsDirA, 'fileA.ts'), 'export const a = 1;');
  await writeFile(path.join(wsDirB, 'fileB.ts'), 'export const b = 2;');

  const workspaceStore = new AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
  await workspaceStore.load();
  const proj = await workspaceStore.createProject('P1 Project');
  const wsA = await workspaceStore.createWorkspace(proj.id, 'WS-A', wsDirA);
  const wsB = await workspaceStore.createWorkspace(proj.id, 'WS-B', wsDirB);

  const lock = new WorkspaceMutex();
  const terminals = new Map<string, any>();
  const registry = Object.assign(new EventEmitter(), {
    async open() {
      const terminalId = randomUUID() as TerminalId;
      const row = { terminalId, kind: 'shell', state: 'running', exitCode: null, pid: 789, alive: true };
      terminals.set(terminalId, row);
      return row;
    },
    get: (id: string) => terminals.get(id) ?? null,
    has: (id: string) => terminals.has(id),
    list: () => [...terminals.values()],
    close: () => {},
    activityOf: () => 'unknown',
  });

  const native = new AgencySessionRuntime({
    registry: registry as any,
    store: new AgencySessionStore(path.join(root, 'sessions.json')),
    profiles: {
      resolveLaunch: async (input) => ({
        profileId: input.profileId,
        provider: 'claude-code',
        file: '/bin/echo',
        args: ['p1'],
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
    store: new BrowserTabStore(path.join(root, 'web.json')),
    workspaceStore,
  });
  await browser.restore();

  const editorStore = new EditorTabStore(path.join(root, 'editor.json'));
  const editor = new EditorTabAdapter({
    store: editorStore,
    workspaceStore,
  });
  await editor.restore();

  const publishedMessages: AgencyServerMessage[] = [];
  const coordinator = new AgencyTabCoordinator(
    native,
    browser,
    workspaceStore,
    (msg) => publishedMessages.push(msg),
    undefined,
    editor,
  );

  // 1. Browser selected, editor create fails to persist (Deadlock test)
  const webTabA = await browser.createTab({
    workspaceId: wsA.id,
    url: 'https://chatgpt.com/',
    title: 'ChatGPT A',
    select: true,
  });
  assert.equal(webTabA.selected, true);

  let injectEditorError = true;
  const originalSave = editorStore.save.bind(editorStore);
  editorStore.save = async (tabs) => {
    if (injectEditorError) {
      throw new Error('Injected persistence error');
    }
    return originalSave(tabs);
  };

  const startTime = Date.now();
  const createFailRes = await coordinator.editorRequest({
    type: 'agency.editorTab.open',
    requestId: 'p1-r1',
    workspaceId: wsA.id,
    filePath: 'fileA.ts',
    select: true,
  });
  const elapsed = Date.now() - startTime;

  // Must not deadlock, must return error within a short time (< 2000ms)
  assert.ok(elapsed < 2000, `Recovery must complete promptly without deadlock; elapsed: ${elapsed}ms`);
  assert.equal(createFailRes?.type, 'agency.error');
  // Browser tab must be restored to selected
  assert.equal(browser.getTabState(webTabA.id)?.selected, true);
  // Editor tab list must be empty
  assert.equal(editor.listTabs(wsA.id).length, 0);

  // 2. Browser selected, editor select fails to persist
  injectEditorError = false;
  const editorTabA = await editor.createTab({
    workspaceId: wsA.id,
    filePath: 'fileA.ts',
    select: false,
  });
  assert.equal(editorTabA.selected, false);
  // Re-select browser tab
  await browser.selectTab(wsA.id, webTabA.id);
  assert.equal(browser.getTabState(webTabA.id)?.selected, true);

  injectEditorError = true;
  const selectStartTime = Date.now();
  await assert.rejects(
    () => editor.selectTab(wsA.id, editorTabA.id),
    /Injected persistence error/,
  );
  const selectElapsed = Date.now() - selectStartTime;
  assert.ok(selectElapsed < 2000, `Select rollback must not deadlock; elapsed: ${selectElapsed}ms`);
  // Browser tab must be restored to selected
  assert.equal(browser.getTabState(webTabA.id)?.selected, true);
  // Editor tab A must not be selected
  assert.equal(editor.getTabState(editorTabA.id)?.selected, false);

  // 3. Successful editor selection followed by unrelated failed rename
  // Previous selection snapshots must not be retained after successful transactions!
  injectEditorError = false;
  // Select editor tab A successfully
  const selectedTab = await editor.selectTab(wsA.id, editorTabA.id);
  assert.equal(selectedTab.selected, true);
  assert.equal(browser.getTabState(webTabA.id)?.selected, false);

  // Now inject failure into store.save and rename editorTabA
  injectEditorError = true;
  await assert.rejects(
    () => editor.renameTab(wsA.id, editorTabA.id, 'Renamed File.ts'),
    /Injected persistence error/,
  );
  // Editor tab A must remain selected and not revert to the obsolete webTabA!
  assert.equal(editor.getTabState(editorTabA.id)?.selected, true);
  assert.equal(editor.getTabState(editorTabA.id)?.title, 'fileA.ts');
  assert.equal(browser.getTabState(webTabA.id)?.selected, false);

  // 4. Concurrent operations across workspaces
  injectEditorError = false;
  // In Workspace A: create selected native session
  const sessionA = await coordinator.createNative({
    type: 'agency.session.create',
    requestId: 'p1-r2',
    workspaceId: wsA.id,
    kind: 'terminal',
    cols: 80,
    rows: 24,
  });
  assert.equal(sessionA.tab?.selected, true);

  // In Workspace B: create selected browser tab
  const webTabB = await browser.createTab({
    workspaceId: wsB.id,
    url: 'https://chatgpt.com/',
    title: 'ChatGPT B',
    select: true,
  });
  assert.equal(webTabB.selected, true);

  // Configure editor save to fail ONLY for Workspace A
  editorStore.save = async (tabs) => {
    const wsATabs = (tabs ?? []).filter((t) => t.workspaceId === wsA.id);
    if (wsATabs.some((t) => t.filePath === 'fileA-fail.ts')) {
      throw new Error('Workspace A disk error');
    }
    return originalSave(tabs);
  };

  // Run concurrent editor requests across WS-A (failing) and WS-B (succeeding)
  const [resA, resB] = await Promise.all([
    coordinator.editorRequest({
      type: 'agency.editorTab.open',
      requestId: 'p1-wsA',
      workspaceId: wsA.id,
      filePath: 'fileA-fail.ts',
      select: true,
    }),
    coordinator.editorRequest({
      type: 'agency.editorTab.open',
      requestId: 'p1-wsB',
      workspaceId: wsB.id,
      filePath: 'fileB.ts',
      select: true,
    }),
  ]);

  assert.equal(resA?.type, 'agency.error');
  assert.equal(resB?.type, 'agency.editorTab.opened');

  // Workspace A: native session selection restored
  assert.equal(native.get(sessionA.id)?.tab?.selected, true);

  // Workspace B: editor tab opened and selected; browser tab unselected
  const editorTabB = (resB as any).tab;
  assert.equal(editor.getTabState(editorTabB.id)?.selected, true);
  assert.equal(browser.getTabState(webTabB.id)?.selected, false);

  // 5. Recovery completing within a bounded timeout
  // If restoreOtherTabs hangs, recovery must reject/settle within timeout (< 5500ms)
  const hangingCoordinator: EditorSelectionCoordinator = {
    unselectOtherTabs: async () => {},
    restoreOtherTabs: async () => {
      // Hang indefinitely
      await new Promise(() => {});
    },
  };
  editor.setSelectionCoordinator(hangingCoordinator);
  editorStore.save = async () => {
    throw new Error('Injected persistence error');
  };

  const hangStart = Date.now();
  await assert.rejects(
    () =>
      editor.createTab({
        workspaceId: wsA.id,
        filePath: 'fileA-hang.ts',
        select: true,
      }),
    /Injected persistence error/,
  );
  const hangElapsed = Date.now() - hangStart;
  assert.ok(
    hangElapsed >= 4900 && hangElapsed < 6000,
    `Hanging restoreOtherTabs must time out within bounded duration (5000ms); elapsed: ${hangElapsed}ms`,
  );
});

test('concurrent opposing browser and editor selections across workspaces never AB-BA deadlock', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-abba-deadlock-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const wsADir = path.join(root, 'wsA');
  const wsBDir = path.join(root, 'wsB');
  await mkdir(wsADir, { recursive: true });
  await mkdir(wsBDir, { recursive: true });
  await writeFile(path.join(wsADir, 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(wsBDir, 'b.ts'), 'export const b = 2;\n');

  const workspaceStore = new AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
  await workspaceStore.load();
  const project = await workspaceStore.createProject('AB-BA Project');
  const wsA = await workspaceStore.createWorkspace(project.id, 'Workspace A', wsADir);
  const wsB = await workspaceStore.createWorkspace(project.id, 'Workspace B', wsBDir);

  const lock = new WorkspaceMutex();
  const registry = Object.assign(new EventEmitter(), {
    async open() {
      const terminalId = randomUUID() as TerminalId;
      return { terminalId, kind: 'shell', state: 'running', exitCode: null, pid: 100, alive: true };
    },
    get: () => null,
    has: () => false,
    list: () => [],
    close: () => {},
    activityOf: () => 'unknown',
  });

  const native = new AgencySessionRuntime({
    registry: registry as unknown as ConstructorParameters<typeof AgencySessionRuntime>[0]['registry'],
    store: new AgencySessionStore(path.join(root, 'sessions.json')),
    profiles: { resolveLaunch: async () => { throw new Error('unused'); } },
    workspaces: {
      protectedDirectories: () => [],
      withSessionReservation: (id, work) => lock.runExclusive(id, () => work(workspaceStore.getWorkspace(id))),
    },
  });
  await native.initialize();
  t.after(() => native.dispose());

  const browserStore = new BrowserTabStore(path.join(root, 'browser-tabs.json'));
  const browser = new BrowserTabAdapter({ store: browserStore, workspaceStore });
  await browser.restore();

  const editorStore = new EditorTabStore(path.join(root, 'editor-tabs.json'));
  const editor = new EditorTabAdapter({ store: editorStore, workspaceStore });
  await editor.restore();

  const coordinator = new AgencyTabCoordinator(native, browser, workspaceStore, () => {}, undefined, editor);

  const webA = await browser.createTab({ workspaceId: wsA.id, url: 'https://chatgpt.com/', title: 'Web A', select: false });
  const edA = await editor.createTab({ workspaceId: wsA.id, filePath: 'a.ts', select: true });
  const webB = await browser.createTab({ workspaceId: wsB.id, url: 'https://chatgpt.com/', title: 'Web B', select: true });
  const edB = await editor.createTab({ workspaceId: wsB.id, filePath: 'b.ts', select: false });

  // Inject an async yield inside native.clearWorkspaceSelection so both opposing
  // operations overlap in the window where each previously held its global mutex
  // while waiting on the other adapter's global mutex.
  const origClear = native.clearWorkspaceSelection.bind(native);
  native.clearWorkspaceSelection = async (wsId) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return origClear(wsId);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Deadlock detected: concurrent opposing selections exceeded deadline')), 3000);
  });

  try {
    const [webRes, edRes] = await Promise.race([
      Promise.all([
        coordinator.webRequest({
          type: 'agency.webTab.select',
          requestId: 'abba-web',
          workspaceId: wsA.id,
          tabId: webA.id,
        }),
        coordinator.editorRequest({
          type: 'agency.editorTab.select',
          requestId: 'abba-ed',
          workspaceId: wsB.id,
          tabId: edB.id,
        }),
      ]),
      deadline,
    ]);

    assert.equal(webRes?.type, 'agency.webTab.updated');
    assert.equal(edRes?.type, 'agency.editorTab.updated');
    assert.equal(browser.getTabState(webA.id)?.selected, true);
    assert.equal(editor.getTabState(edA.id)?.selected, false);
    assert.equal(editor.getTabState(edB.id)?.selected, true);
    assert.equal(browser.getTabState(webB.id)?.selected, false);
  } finally {
    clearTimeout(timer);
  }
});

test('P2 A-05: agency.editorTab.order reorders open editor tabs, broadcasts ordered change, and rejects invalid orders', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-a05-editor-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'one.ts'), 'export const one = 1;\n');
  await writeFile(path.join(root, 'two.ts'), 'export const two = 2;\n');

  const workspaceStore = new AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
  await workspaceStore.load();
  const project = await workspaceStore.createProject('Order Project');
  const ws = await workspaceStore.createWorkspace(project.id, 'Order WS', root);

  const editor = new EditorTabAdapter({
    store: new EditorTabStore(path.join(root, 'editor-tabs.json')),
    workspaceStore,
  });
  await editor.restore();

  const tab1 = await editor.createTab({ workspaceId: ws.id, filePath: 'one.ts' });
  const tab2 = await editor.createTab({ workspaceId: ws.id, filePath: 'two.ts' });
  assert.deepEqual(editor.listTabs(ws.id).map((tab) => tab.id), [tab1.id, tab2.id]);

  const { handleEditorTabMessage } = await import('../../../src/features/editor/editor-tab-handler.js');
  const published: any[] = [];
  const res = await handleEditorTabMessage(
    {
      type: 'agency.editorTab.order',
      requestId: 'req-order-1',
      workspaceId: ws.id,
      tabIds: [tab2.id, tab1.id],
    },
    { adapter: editor, publish: (m) => published.push(m) },
  );

  assert.ok(res !== null, 'agency.editorTab.order must not be silently dropped');
  assert.equal(res.type, 'agency.editorTabs.snapshot');
  assert.equal(res.requestId, 'req-order-1');
  assert.deepEqual(res.tabs.map((tab) => tab.id), [tab2.id, tab1.id]);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'agency.editorTab.changed');
  assert.equal(published[0].change, 'ordered');

  const invalidRes = await handleEditorTabMessage(
    {
      type: 'agency.editorTab.order',
      requestId: 'req-order-bad',
      workspaceId: ws.id,
      tabIds: [tab1.id],
    },
    { adapter: editor },
  );
  assert.equal(invalidRes?.type, 'agency.error');
  assert.equal(invalidRes?.requestId, 'req-order-bad');
});

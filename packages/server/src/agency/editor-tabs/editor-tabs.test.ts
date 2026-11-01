import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AgencyServerMessage, TerminalId } from '@agent-workbench/shared';
import { validateRelativeFilePath } from '@agent-workbench/shared';
import { EditorTabStore } from './editor-tab-store.js';
import { EditorTabAdapter } from './editor-tab-adapter.js';
import { AgencyWorkspaceStore } from '../store.js';
import { AgencySessionRuntime } from '../agency-session-runtime.js';
import { AgencySessionStore } from '../agency-session-store.js';
import { BrowserTabAdapter, BrowserTabStore } from '../browser-tabs/index.js';
import { AgencyLayoutStore } from '../agency-layout-store.js';
import { AgencyTabCoordinator } from '../tab-coordinator.js';
import { WorkspaceMutex } from '../workspace-lock.js';

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

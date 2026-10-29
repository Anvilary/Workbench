import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkspaceId } from '@agent-workbench/shared';
import { BrowserTabAdapter } from './browser-tab-adapter.js';
import {
  BrowserEngineUnavailableError,
  MemoryBrowserControllerDriver,
  NullBrowserControllerDriver,
} from './browser-controller-driver.js';
import { BrowserTabStore, BrowserTabStoreError } from './browser-tab-store.js';
import { AgencyWorkspaceStore } from '../store.js';

class ObservedBrowserDriver extends MemoryBrowserControllerDriver {
  unavailable = false;
  async getTargetUrl(ref: string): Promise<string | null> {
    if (this.unavailable) throw new BrowserEngineUnavailableError();
    return this.targets.get(ref)?.url ?? null;
  }
  override async verifyTargetOwnership(ref: string, owner: import('./browser-controller-driver.js').TargetMetadata): Promise<boolean> {
    if (this.unavailable) throw new BrowserEngineUnavailableError();
    return super.verifyTargetOwnership(ref, owner);
  }
  async findOwnedTarget(owner: import('./browser-controller-driver.js').TargetMetadata): Promise<string | null> {
    if (this.unavailable) throw new BrowserEngineUnavailableError();
    return [...this.targets].find(([, target]) => !target.closed && target.metadata?.tabId === owner.tabId && target.metadata.workspaceId === owner.workspaceId)?.[0] ?? null;
  }
}

test('observed selected and background conversations survive restart, controller outage, and target loss', async t => {
  const { filePath, store } = await createFixture(t);
  const driver = new ObservedBrowserDriver();
  const options = { driver, allowUnvalidatedWorkspacesForTesting: true };
  const adapter = new BrowserTabAdapter({ ...options, store });
  const a = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/', title: 'A' });
  const b = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/', title: 'B' });
  const urls = ['https://chatgpt.com/c/11111111-2222-4333-8444-555555555555?model=auto', 'https://chatgpt.com/g/g-fixture/c/66666666-7777-4888-8999-000000000000'];
  driver.targets.get(a.targetRef!)!.url = urls[0]!;
  driver.targets.get(b.targetRef!)!.url = urls[1]!;
  await adapter.refreshLiveTabs();
  assert.deepEqual(adapter.listTabs().map(tab => tab.url), urls);
  const restored = new BrowserTabAdapter({ ...options, store: new BrowserTabStore(filePath) });
  await restored.restore();
  driver.unavailable = true;
  await restored.refreshLiveTabs();
  await assert.rejects(restored.selectTab(WS1, b.id), /browser/i);
  assert.deepEqual(restored.listTabs().map(tab => tab.url), urls);
  assert.equal(restored.getTabState(b.id)!.runtimeState, 'error');
  assert.equal(driver.getTargetCount(), 2);
  driver.unavailable = false;
  await restored.refreshLiveTabs();
  assert.equal(restored.getTabState(b.id)!.runtimeState, 'attached', 'polling clears recoverable outage state');
  const selected = await restored.selectTab(WS1, b.id);
  assert.equal(selected.targetRef, b.targetRef);
  assert.equal(driver.getTargetCount(), 2);
  // Transient homepage/auth redirects must not erase a committed conversation.
  driver.targets.get(b.targetRef!)!.url = 'https://chatgpt.com/';
  await restored.refreshLiveTabs();
  assert.equal(restored.getTabState(b.id)!.url, urls[1]);
  driver.targets.get(b.targetRef!)!.closed = true;
  await restored.selectTab(WS1, b.id);
  assert.equal(driver.targets.get(restored.getTabState(b.id)!.targetRef!)!.url, urls[1]);
  assert.equal(driver.getTargetCount(), 2);
  // Final capture observes a navigation that happened after the last poll.
  const final = 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  driver.targets.get(a.targetRef!)!.url = final;
  await restored.captureFinalUrls();
  const committed = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(committed.tabs.find((tab: { id: string }) => tab.id === a.id).url, final);
});

test('lost target hint reattaches only an owned receipt and commits live URL before selection', async t => {
  const { filePath, store } = await createFixture(t);
  const driver = new ObservedBrowserDriver();
  const adapter = new BrowserTabAdapter({ store, driver, allowUnvalidatedWorkspacesForTesting: true });
  const tab = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/' });
  const url = 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  driver.targets.get(tab.targetRef!)!.url = url;
  await store.save([{ ...tab, targetRef: null }]);
  const restored = new BrowserTabAdapter({ store: new BrowserTabStore(filePath), driver, allowUnvalidatedWorkspacesForTesting: true });
  await restored.restore();
  const selected = await restored.selectTab(WS1, tab.id);
  assert.equal(selected.targetRef, tab.targetRef);
  assert.equal(selected.url, url);
  assert.equal(driver.getTargetCount(), 1);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).tabs[0].url, url);
});

async function createFixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-reconciliation-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const filePath = path.join(dir, 'agency-web-tabs.json');
  const store = new BrowserTabStore(filePath);
  await store.load();
  const driver = new MemoryBrowserControllerDriver();
  const adapter = new BrowserTabAdapter({
    store,
    driver,
    allowUnvalidatedWorkspacesForTesting: true,
  });
  return { dir, filePath, store, driver, adapter };
}

const WS1 = '00000000-0000-4000-8000-000000000001' as WorkspaceId;
const WS2 = '00000000-0000-4000-8000-000000000002' as WorkspaceId;

test('regression 1: MAW restart while Neko tab remains alive reattaches without duplicate page', async (t) => {
  const { filePath, driver, adapter } = await createFixture(t);

  // 1. Create tab in MAW
  const tab = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/persistent-convo',
    title: 'Persistent Chat',
  });
  const initialTargetRef = tab.targetRef!;
  assert.equal(driver.getTargetCount(), 1);

  // 2. Simulate MAW server restart:
  // Browser driver remains alive inside Neko with targetRef!
  const newStore = new BrowserTabStore(filePath);
  await newStore.load();
  const newAdapter = new BrowserTabAdapter({
    store: newStore,
    driver,
    allowUnvalidatedWorkspacesForTesting: true,
  });
  await newAdapter.restore();

  // 3. Selection triggers reattachment
  const selected = await newAdapter.selectTab(WS1, tab.id);

  // Target ownership was verified; reattached to existing targetRef
  assert.equal(selected.targetRef, initialTargetRef);
  assert.equal(selected.runtimeState, 'ready');

  // Assert zero duplicate pages were opened in driver!
  assert.equal(driver.getTargetCount(), 1);
  const openCalls = driver.callLog.filter((c) => c.method === 'openTarget');
  assert.equal(openCalls.length, 1, 'openTarget should only have been called once initially');
});

test('regression 2: repeated reattachment calls never create duplicate browser pages', async (t) => {
  const { filePath, driver, adapter } = await createFixture(t);

  const tab = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/idempotent-attach',
  });
  assert.equal(driver.getTargetCount(), 1);

  // Multiple repeated selectTab calls
  await adapter.selectTab(WS1, tab.id);
  await adapter.selectTab(WS1, tab.id);

  // Simulate another restart
  const restartedStore = new BrowserTabStore(filePath);
  const restartedAdapter = new BrowserTabAdapter({
    store: restartedStore,
    driver,
    allowUnvalidatedWorkspacesForTesting: true,
  });
  await restartedAdapter.restore();
  await restartedAdapter.selectTab(WS1, tab.id);
  await restartedAdapter.selectTab(WS1, tab.id);

  assert.equal(driver.getTargetCount(), 1);
  const openCalls = driver.callLog.filter((c) => c.method === 'openTarget');
  assert.equal(openCalls.length, 1);
});

test('regression 3: background tab ongoing operation continues when another tab is selected', async (t) => {
  const { adapter, driver } = await createFixture(t);

  const tab1 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/tab-1' });
  const tab2 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/tab-2' });

  // Simulate an active streaming operation in tab2
  driver.setOngoingOperation(tab2.targetRef!, 'Assistant is generating response...');

  // User selects Tab 1
  await adapter.selectTab(WS1, tab1.id);
  assert.equal(driver.getActiveTarget(), tab1.targetRef);

  // Verify Tab 2 in background is untouched: not closed, ongoing operation preserved
  assert.equal(await driver.hasOngoingOperation(tab2.targetRef!), true);
  assert.equal(driver.targets.get(tab2.targetRef!)!.closed, false);

  // Switch back to Tab 2
  await adapter.selectTab(WS1, tab2.id);
  assert.equal(driver.getActiveTarget(), tab2.targetRef);
  assert.equal(await driver.hasOngoingOperation(tab2.targetRef!), true);
});

test('regression 4: concurrent operations are serialized and idempotent creation prevents duplicate pages', async (t) => {
  const { adapter, driver } = await createFixture(t);

  const launchId = 'client-launch-dedup-123';

  // Fire 5 simultaneous createTab calls with same launchId (e.g. rapid double click / network retry)
  const createPromises = Array.from({ length: 5 }, () =>
    adapter.createTab({
      workspaceId: WS1,
      url: 'https://chatgpt.com/c/concurrent-chat',
      launchId,
    }),
  );

  const results = await Promise.all(createPromises);

  // All promises must resolve to the identical tab ID
  const firstId = results[0]!.id;
  for (const tab of results) {
    assert.equal(tab.id, firstId);
  }

  // Only ONE browser target was created
  assert.equal(driver.getTargetCount(), 1);

  // Fire concurrent select, order, and rename
  const tab2 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/second' });

  await Promise.all([
    adapter.selectTab(WS1, firstId),
    adapter.renameTab(WS1, firstId, 'Renamed Alpha'),
    adapter.selectTab(WS1, tab2.id),
    adapter.orderTabs(WS1, [tab2.id, firstId]),
  ]);

  // Check state consistency
  const openTabs = adapter.listTabs(WS1);
  assert.equal(openTabs.length, 2);
  const selectedTabs = openTabs.filter((t) => t.selected);
  assert.equal(selectedTabs.length, 1, 'Exactly one tab must be selected');
  assert.equal(openTabs[0]!.order, 0);
  assert.equal(openTabs[1]!.order, 1);
});

test('regression 5: failed Chromium target destruction marks cleanupRequired and reconciles safely', async (t) => {
  const { adapter, driver } = await createFixture(t);

  const tab1 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/tab-to-close-fail' });
  const tab2 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/sibling-tab' });

  const ref1 = tab1.targetRef!;
  const ref2 = tab2.targetRef!;

  // Inject failure for target 1 close
  driver.failCloseTargets.add(ref1);

  // Close tab 1
  const closed = await adapter.closeTab(WS1, tab1.id);
  assert.ok(closed.closedAt);
  assert.equal(closed.cleanupRequired, true, 'cleanupRequired must be persisted when close fails');
  assert.equal(closed.runtimeState, 'error');
  assert.equal(closed.targetRef, ref1, 'targetRef must be preserved to allow cleanup reconciliation');

  // Verify sibling tab 2 is completely unharmed
  assert.equal(driver.targets.get(ref2)!.closed, false);

  // Now driver recovers
  driver.failCloseTargets.clear();

  // Reconcile cleanup
  await adapter.reconcileCleanup(WS1);

  const reconciled = adapter.getTabState(tab1.id)!;
  assert.equal(reconciled.cleanupRequired, false);
  assert.equal(reconciled.runtimeState, 'closed');
  assert.equal(reconciled.targetRef, null);
  assert.equal(driver.targets.get(ref1)!.closed, true);
});

test('regression 6: workspace validity validates lifecycle and rejects deleted/archived workspaces', async (t) => {
  const { store, driver } = await createFixture(t);

  const validWorkspaces = new Map<string, { status: string }>([
    [WS1, { status: 'active' }],
    [WS2, { status: 'archived' }],
  ]);

  const adapter = new BrowserTabAdapter({
    store,
    driver,
    workspaceValidator: (wsId) => {
      const ws = validWorkspaces.get(wsId);
      if (!ws) return { valid: false, error: 'Workspace not found' };
      if (ws.status === 'archived') return { valid: false, error: 'Workspace is archived' };
      return { valid: true };
    },
  });

  // Valid workspace works
  const tab = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/valid' });
  assert.ok(tab.id);

  // Unknown workspace rejected with not-found
  const unknownWS = '99999999-9999-4999-8999-999999999999' as WorkspaceId;
  await assert.rejects(
    adapter.createTab({ workspaceId: unknownWS, url: 'https://chatgpt.com/c/unknown' }),
    (err: unknown) => err instanceof BrowserTabStoreError && err.code === 'not-found',
  );

  // Archived workspace rejected with conflict
  await assert.rejects(
    adapter.createTab({ workspaceId: WS2, url: 'https://chatgpt.com/c/archived' }),
    (err: unknown) => err instanceof BrowserTabStoreError && err.code === 'conflict',
  );
});

test('regression 7: shared selection coordinator maintains single selection across native and web tabs', async (t) => {
  const { store, driver } = await createFixture(t);

  let nativeSelected = true;
  const adapter = new BrowserTabAdapter({
    store,
    driver,
    allowUnvalidatedWorkspacesForTesting: true,
    selectionCoordinator: {
      unselectNativeTabs: (_wsId) => {
        nativeSelected = false;
      },
    },
  });

  const tab = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/shared-sel' });

  // Selecting web tab unselects native tabs
  await adapter.selectTab(WS1, tab.id);
  assert.equal(adapter.getTabState(tab.id)!.selected, true);
  assert.equal(nativeSelected, false, 'Native tabs must be unselected when web tab is selected');

  // When a native tab is selected in UI, MAW calls clearWorkspaceSelection
  await adapter.clearWorkspaceSelection(WS1);
  assert.equal(adapter.getTabState(tab.id)!.selected, false, 'Web tabs must be unselected when native tab is selected');
});

test('regression 8: saved/unloaded tabs do not eagerly create Chromium targets until activated', async (t) => {
  const { adapter, driver } = await createFixture(t);

  // Create an unloaded tab
  const unloadedTab = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/unloaded-saved',
    unloaded: true,
  });

  assert.equal(unloadedTab.runtimeState, 'unloaded');
  assert.equal(unloadedTab.targetRef, null);
  assert.equal(driver.getTargetCount(), 0, 'Zero targets must be opened for unloaded tabs');

  // Explicit activation via selectTab opens the target lazily
  const activated = await adapter.selectTab(WS1, unloadedTab.id);
  assert.equal(activated.runtimeState, 'ready');
  assert.ok(activated.targetRef);
  assert.equal(driver.getTargetCount(), 1);
  assert.equal(driver.getActiveTarget(), activated.targetRef);
});

test('regression 9: restart with stale or foreign target IDs treats them as unavailable and never attaches to foreign targets', async (t) => {
  const { store, driver } = await createFixture(t);

  // Prepare store with tab having stale targetRef
  await store.save([
    {
      id: 'd0000000-0000-4000-8000-000000000001',
      workspaceId: WS1,
      kind: 'web',
      title: 'Stale Ref Chat',
      url: 'https://chatgpt.com/c/stale-chat',
      order: 0,
      selected: true,
      createdAt: '2026-10-28T19:00:00.000Z',
      updatedAt: '2026-10-28T19:00:00.000Z',
      closedAt: null,
      targetRef: 'target-foreign-owned',
    },
  ]);

  // Simulate a live foreign target belonging to another workspace / tab in driver
  driver.targets.set('target-foreign-owned', {
    url: 'https://chatgpt.com/c/different-user-chat',
    active: false,
    closed: false,
    metadata: {
      tabId: 'foreign-tab-id-999',
      workspaceId: WS2,
    },
  });

  const adapter = new BrowserTabAdapter({
    store,
    driver,
    allowUnvalidatedWorkspacesForTesting: true,
  });
  await adapter.restore();

  // Selecting tab must detect ownership mismatch and NOT attach to foreign target
  const selected = await adapter.selectTab(WS1, 'd0000000-0000-4000-8000-000000000001');

  assert.notEqual(selected.targetRef, 'target-foreign-owned', 'Must never attach to foreign target');
  assert.ok(selected.targetRef);
  assert.equal(selected.runtimeState, 'ready');

  // Foreign target in driver remains untouched
  const foreign = driver.targets.get('target-foreign-owned')!;
  assert.equal(foreign.metadata?.tabId, 'foreign-tab-id-999');
  assert.equal(foreign.metadata?.workspaceId, WS2);
});

test('acceptance 1: unconfigured Neko driver explicitly fails open/activate while safely persisting logical tab', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-unconfigured-driver-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const store = new BrowserTabStore(path.join(dir, 'agency-web-tabs.json'));
  await store.load();

  // NullBrowserControllerDriver represents unconfigured / offline Neko engine
  const nullDriver = new NullBrowserControllerDriver();

  // 0. Directly verify NullBrowserControllerDriver throws typed BrowserEngineUnavailableError
  await assert.rejects(
    nullDriver.openTarget('https://chatgpt.com/c/direct'),
    (err: unknown) => {
      assert.ok(err instanceof BrowserEngineUnavailableError);
      assert.match(err.message, /not configured or unavailable/i);
      return true;
    },
  );

  const adapter = new BrowserTabAdapter({
    store,
    driver: nullDriver,
    allowUnvalidatedWorkspacesForTesting: true,
  });

  // 1. Creating a tab with unconfigured driver must throw typed unavailable error
  await assert.rejects(
    adapter.createTab({
      workspaceId: WS1,
      url: 'https://chatgpt.com/c/unconfigured-test',
      title: 'Saved Conversation',
    }),
    (err: unknown) => {
      assert.ok(err instanceof BrowserTabStoreError);
      assert.equal(err.code, 'session-unavailable');
      assert.match(err.message, /browser engine is unavailable/i);
      return true;
    },
  );

  // 2. The logical web tab MUST still be persisted safely in storage
  const tabs = adapter.listTabs(WS1);
  assert.equal(tabs.length, 1);
  const savedTab = tabs[0]!;
  assert.equal(savedTab.url, 'https://chatgpt.com/c/unconfigured-test');
  assert.equal(savedTab.title, 'Saved Conversation');
  assert.equal(savedTab.targetRef, null, 'Must not invent fictional null-target');
  assert.equal(savedTab.runtimeState, 'error', 'Must be marked error, not attached or ready');

  // Verify it is safe on disk
  const diskStore = new BrowserTabStore(path.join(dir, 'agency-web-tabs.json'));
  const diskTabs = await diskStore.load();
  assert.equal(diskTabs.length, 1);
  assert.equal(diskTabs[0]!.id, savedTab.id);

  // 3. Attempting to select tab with unconfigured driver also throws explicitly
  await assert.rejects(
    adapter.selectTab(WS1, savedTab.id),
    (err: unknown) => err instanceof BrowserTabStoreError && err.code === 'session-unavailable',
  );
  assert.equal(adapter.getTabState(savedTab.id)!.runtimeState, 'error');
  assert.equal(adapter.getTabState(savedTab.id)!.selected, true);
});

test('acceptance 2: failed target activation never marks tab ready and leaves coherent error state', async (t) => {
  const { adapter, driver } = await createFixture(t);

  // Create an unloaded tab first
  const tab = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/failed-activate',
    unloaded: true,
    select: false,
  });
  assert.equal(tab.runtimeState, 'unloaded');
  assert.equal(tab.targetRef, null);

  // Pre-configure driver so opening succeeds but activateTarget fails
  driver.failActivateTargets.add('mem-target-1');

  await assert.rejects(
    adapter.selectTab(WS1, tab.id),
    (err: unknown) => {
      assert.ok(err instanceof BrowserTabStoreError);
      assert.equal(err.code, 'session-unavailable');
      assert.match(err.message, /failed to open or activate browser target/i);
      return true;
    },
  );

  // Tab must NEVER be marked 'ready'; must be marked 'error'
  const state = adapter.getTabState(tab.id)!;
  assert.equal(state.runtimeState, 'error');
  assert.notEqual(state.runtimeState, 'ready');
  // Selection state is coherently preserved
  assert.equal(state.selected, true);
});

test('acceptance 3: invalid workspace configuration rejects Done, archived, and unknown workspaces/projects', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-ws-config-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const tabStore = new BrowserTabStore(path.join(dir, 'agency-web-tabs.json'));
  await tabStore.load();
  const driver = new MemoryBrowserControllerDriver();

  // 1. Without workspaceStore, workspaceValidator, or testing flag: constructor fails explicitly
  assert.throws(
    () => new BrowserTabAdapter({ store: tabStore, driver }),
    (err: unknown) => {
      assert.ok(err instanceof BrowserTabStoreError);
      assert.equal(err.code, 'internal-error');
      assert.match(err.message, /requires an authoritative AgencyWorkspaceStore/i);
      return true;
    },
  );

  // 2. Instantiate authoritative AgencyWorkspaceStore
  const wsStore = new AgencyWorkspaceStore(path.join(dir, 'agency-state.json'));
  await wsStore.load();

  const project = await wsStore.createProject('Test Project Alpha');
  const activeWorkspace = await wsStore.createWorkspace(project.id, 'Active WS', '/tmp');

  const adapter = new BrowserTabAdapter({
    store: tabStore,
    driver,
    workspaceStore: wsStore,
  });

  // Valid workspace succeeds
  const created = await adapter.createTab({
    workspaceId: activeWorkspace.id,
    url: 'https://chatgpt.com/c/valid-ws',
  });
  assert.ok(created.id);

  // Unknown workspace rejected with not-found
  const unknownWS = '11111111-2222-4333-8444-555555555555' as WorkspaceId;
  await assert.rejects(
    adapter.createTab({ workspaceId: unknownWS, url: 'https://chatgpt.com/c/unknown' }),
    (err: unknown) => err instanceof BrowserTabStoreError && err.code === 'not-found',
  );

  // Workspace marked Done rejected with conflict
  await wsStore.markDone(activeWorkspace.id);
  await assert.rejects(
    adapter.createTab({ workspaceId: activeWorkspace.id, url: 'https://chatgpt.com/c/done-ws' }),
    (err: unknown) => {
      assert.ok(err instanceof BrowserTabStoreError);
      assert.equal(err.code, 'conflict');
      assert.match(err.message, /marked done/i);
      return true;
    },
  );
  await assert.rejects(
    adapter.selectTab(activeWorkspace.id, created.id),
    (err: unknown) => err instanceof BrowserTabStoreError && err.code === 'conflict',
  );

  // Archived workspace rejected with conflict
  const ws2 = await wsStore.createWorkspace(project.id, 'WS to Archive', '/tmp');
  await wsStore.archiveWorkspace(ws2.id);
  await assert.rejects(
    adapter.createTab({ workspaceId: ws2.id, url: 'https://chatgpt.com/c/archived-ws' }),
    (err: unknown) => {
      assert.ok(err instanceof BrowserTabStoreError);
      assert.equal(err.code, 'conflict');
      assert.match(err.message, /is archived/i);
      return true;
    },
  );

  // Archived parent project rejected with conflict
  const project2 = await wsStore.createProject('Project to Archive');
  const ws3 = await wsStore.createWorkspace(project2.id, 'WS in Archived Proj', '/tmp');
  await wsStore.archiveProject(project2.id);
  await assert.rejects(
    adapter.createTab({ workspaceId: ws3.id, url: 'https://chatgpt.com/c/archived-proj' }),
    (err: unknown) => {
      assert.ok(err instanceof BrowserTabStoreError);
      assert.equal(err.code, 'conflict');
      assert.match(err.message, /owning project.*archived/i);
      return true;
    },
  );
});

test('acceptance 4: cross-workspace duplicate launch IDs do not collide or interfere', async (t) => {
  const { adapter, driver } = await createFixture(t);
  const sharedLaunchId = 'client-generated-uuid-abc';

  // Issue tab creations in WS1 and WS2 with the identical launchId
  const [tab1, tab2] = await Promise.all([
    adapter.createTab({
      workspaceId: WS1,
      url: 'https://chatgpt.com/c/ws1-chat',
      launchId: sharedLaunchId,
    }),
    adapter.createTab({
      workspaceId: WS2,
      url: 'https://chatgpt.com/c/ws2-chat',
      launchId: sharedLaunchId,
    }),
  ]);

  // Both creations must succeed and have distinct IDs and targetRefs
  assert.notEqual(tab1.id, tab2.id);
  assert.notEqual(tab1.targetRef, tab2.targetRef);
  assert.equal(tab1.workspaceId, WS1);
  assert.equal(tab2.workspaceId, WS2);
  assert.equal(driver.getTargetCount(), 2);

  // Idempotent retry within WS1 reuses WS1 tab
  const tab1Retry = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/ws1-chat',
    launchId: sharedLaunchId,
  });
  assert.equal(tab1Retry.id, tab1.id);

  // Idempotent retry within WS2 reuses WS2 tab
  const tab2Retry = await adapter.createTab({
    workspaceId: WS2,
    url: 'https://chatgpt.com/c/ws2-chat',
    launchId: sharedLaunchId,
  });
  assert.equal(tab2Retry.id, tab2.id);

  assert.equal(driver.getTargetCount(), 2);
});

test('acceptance 5: failed creation with launchId produces zero unhandled promise rejections', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-unhandled-rejection-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const store = new BrowserTabStore(path.join(dir, 'agency-web-tabs.json'));
  await store.load();
  const nullDriver = new NullBrowserControllerDriver();
  const adapter = new BrowserTabAdapter({
    store,
    driver: nullDriver,
    allowUnvalidatedWorkspacesForTesting: true,
  });

  const unhandledRejections: unknown[] = [];
  const listener = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', listener);
  t.after(() => {
    process.removeListener('unhandledRejection', listener);
  });

  // Call createTab with launchId and failing driver
  const failLaunchId = 'failing-launch-123';
  await assert.rejects(
    adapter.createTab({
      workspaceId: WS1,
      url: 'https://chatgpt.com/c/unhandled-rejection-check',
      launchId: failLaunchId,
    }),
    (err: unknown) => err instanceof BrowserTabStoreError && err.code === 'session-unavailable',
  );

  // Wait a tick to ensure any unhandled rejection would have been emitted
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(
    unhandledRejections.length,
    0,
    `Expected zero unhandled rejections, but got: ${JSON.stringify(unhandledRejections)}`,
  );
});

test('acceptance 6: MAW restart with preserved, verified target identity reattaches cleanly', async (t) => {
  const { filePath, driver, adapter } = await createFixture(t);

  const tab = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/restart-identity-verify',
  });
  const initialTargetRef = tab.targetRef!;
  assert.ok(initialTargetRef);

  // Verify metadata was attached to target
  const targetData = driver.targets.get(initialTargetRef)!;
  assert.deepEqual(targetData.metadata, {
    tabId: tab.id,
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/restart-identity-verify',
  });

  // Simulate MAW restart
  const newStore = new BrowserTabStore(filePath);
  await newStore.load();
  const newAdapter = new BrowserTabAdapter({
    store: newStore,
    driver,
    allowUnvalidatedWorkspacesForTesting: true,
  });
  await newAdapter.restore();

  // Tab targetRef is preserved as reconciliation hint, runtimeState is detached
  const restoredState = newAdapter.getTabState(tab.id)!;
  assert.equal(restoredState.targetRef, initialTargetRef);
  assert.equal(restoredState.runtimeState, 'detached');

  // Spy on driver methods
  driver.callLog.length = 0;

  // On selection, adapter verifies ownership with driver.verifyTargetOwnership()
  const reattached = await newAdapter.selectTab(WS1, tab.id);

  assert.equal(reattached.targetRef, initialTargetRef);
  assert.equal(reattached.runtimeState, 'ready');

  // Verify driver calls: verifyTargetOwnership was called, activateTarget was called, openTarget was NOT called
  const openCalls = driver.callLog.filter((c) => c.method === 'openTarget');
  const activateCalls = driver.callLog.filter((c) => c.method === 'activateTarget');
  assert.equal(openCalls.length, 0, 'Must reattach to existing target without calling openTarget');
  assert.equal(activateCalls.length, 1);
});

test('acceptance 7: failed browser cleanup marks cleanupRequired, isolates siblings, and safely retries', async (t) => {
  const { adapter, driver } = await createFixture(t);

  const tab1 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/cleanup-1' });
  const tab2 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/cleanup-2' });

  const ref1 = tab1.targetRef!;
  const ref2 = tab2.targetRef!;

  // Configure driver so closeTarget fails for tab1
  driver.failCloseTargets.add(ref1);

  // Close tab1
  const closed = await adapter.closeTab(WS1, tab1.id);
  assert.equal(closed.cleanupRequired, true);
  assert.equal(closed.runtimeState, 'error');
  assert.equal(closed.targetRef, ref1);

  // Sibling tab2 must be completely unaffected
  assert.equal(driver.targets.get(ref2)!.closed, false);
  const tab2State = adapter.getTabState(tab2.id)!;
  assert.equal(tab2State.closedAt, null);

  // Driver recovers
  driver.failCloseTargets.delete(ref1);

  // Safe retry via reconcileCleanup
  await adapter.reconcileCleanup(WS1);

  const cleaned = adapter.getTabState(tab1.id)!;
  assert.equal(cleaned.cleanupRequired, false);
  assert.equal(cleaned.runtimeState, 'closed');
  assert.equal(cleaned.targetRef, null);
  assert.equal(driver.targets.get(ref1)!.closed, true);
});

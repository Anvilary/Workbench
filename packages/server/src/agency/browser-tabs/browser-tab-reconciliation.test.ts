import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkspaceId } from '@agent-workbench/shared';
import { BrowserTabAdapter } from './browser-tab-adapter.js';
import { MemoryBrowserControllerDriver } from './browser-controller-driver.js';
import { BrowserTabStore, BrowserTabStoreError } from './browser-tab-store.js';

async function createFixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-reconciliation-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const filePath = path.join(dir, 'agency-web-tabs.json');
  const store = new BrowserTabStore(filePath);
  await store.load();
  const driver = new MemoryBrowserControllerDriver();
  const adapter = new BrowserTabAdapter({ store, driver });
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
  const newAdapter = new BrowserTabAdapter({ store: newStore, driver });
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
  const restartedAdapter = new BrowserTabAdapter({ store: restartedStore, driver });
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

  const adapter = new BrowserTabAdapter({ store, driver });
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

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
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-adapter-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const store = new BrowserTabStore(path.join(dir, 'agency-web-tabs.json'));
  await store.load();
  const driver = new MemoryBrowserControllerDriver();
  const adapter = new BrowserTabAdapter({
    store,
    driver,
    allowUnvalidatedWorkspacesForTesting: true,
  });
  return { dir, store, driver, adapter };
}

const WS1 = '00000000-0000-4000-8000-000000000001' as WorkspaceId;
const WS2 = '00000000-0000-4000-8000-000000000002' as WorkspaceId;

test('adapter: creates tabs with valid UUID, sequential order, and driver target reference', async (t) => {
  const { adapter, driver } = await createFixture(t);

  const tab1 = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/first-conversation',
  });

  assert.ok(tab1.id);
  assert.equal(tab1.workspaceId, WS1);
  assert.equal(tab1.kind, 'web');
  assert.equal(tab1.title, 'ChatGPT');
  assert.equal(tab1.order, 0);
  assert.equal(tab1.selected, true);
  assert.equal(tab1.closedAt, null);
  assert.ok(tab1.targetRef);
  assert.equal(tab1.runtimeState, 'ready');

  // Check driver interaction
  assert.equal(driver.targets.size, 1);
  assert.equal(driver.getActiveTarget(), tab1.targetRef);

  // Create second tab with custom title
  const tab2 = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/second-conversation',
    title: 'Research Analysis',
  });

  assert.equal(tab2.order, 1);
  assert.equal(tab2.title, 'Research Analysis');
  assert.equal(tab2.selected, true);

  // Tab 1 should no longer be selected
  const updatedTab1 = adapter.getTabState(tab1.id)!;
  assert.equal(updatedTab1.selected, false);

  // Driver now has 2 open targets
  assert.equal(driver.targets.size, 2);
  assert.equal(driver.getActiveTarget(), tab2.targetRef);
});

test('adapter: switching between ChatGPT 1 and 2 activates targets without navigating away or closing', async (t) => {
  const { adapter, driver } = await createFixture(t);

  const tab1 = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/chat-1',
    title: 'ChatGPT 1',
  });
  const tab2 = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/chat-2',
    title: 'ChatGPT 2',
  });

  const ref1 = tab1.targetRef!;
  const ref2 = tab2.targetRef!;

  // Clear driver call log before switching
  driver.callLog.length = 0;

  // Switch back to ChatGPT 1
  const selectedTab1 = await adapter.selectTab(WS1, tab1.id);
  assert.equal(selectedTab1.selected, true);
  assert.equal(adapter.getTabState(tab2.id)!.selected, false);

  // Verify target 1 is active
  assert.equal(driver.getActiveTarget(), ref1);

  // Verify core requirement 7: ChatGPT 2's target was NOT terminated or navigated away!
  const target2 = driver.targets.get(ref2)!;
  assert.equal(target2.closed, false, 'Target 2 must remain open');
  assert.equal(target2.url, 'https://chatgpt.com/c/chat-2', 'Target 2 URL must remain untouched');

  // Verify driver calls: only activateTarget was invoked, no closeTarget or navigateTarget
  const methodsCalled = driver.callLog.map((c) => c.method);
  assert.deepEqual(methodsCalled, ['activateTarget']);
  assert.equal(driver.callLog[0]!.args[0], ref1);

  // Now switch back to ChatGPT 2
  driver.callLog.length = 0;
  await adapter.selectTab(WS1, tab2.id);

  assert.equal(driver.getActiveTarget(), ref2);
  const target1 = driver.targets.get(ref1)!;
  assert.equal(target1.closed, false, 'Target 1 must remain open');
  assert.equal(target1.url, 'https://chatgpt.com/c/chat-1', 'Target 1 URL must remain untouched');
  assert.deepEqual(driver.callLog.map((c) => c.method), ['activateTarget']);
});

test('adapter: conservative restore and lazy target attachment on select', async (t) => {
  const { store } = await createFixture(t);

  // Populate store directly as if restored from restart
  await store.save([
    {
      id: 'c0000000-0000-4000-8000-000000000001',
      workspaceId: WS1,
      kind: 'web',
      title: 'Restored Chat',
      url: 'https://chatgpt.com/c/saved-session',
      order: 0,
      selected: true,
      createdAt: '2026-10-28T19:00:00.000Z',
      updatedAt: '2026-10-28T19:00:00.000Z',
      closedAt: null,
    },
  ]);

  const newDriver = new MemoryBrowserControllerDriver();
  const freshAdapter = new BrowserTabAdapter({
    store,
    driver: newDriver,
    allowUnvalidatedWorkspacesForTesting: true,
  });
  await freshAdapter.restore();

  // Tab exists in memory with conversation reference intact
  const initial = freshAdapter.getTabState('c0000000-0000-4000-8000-000000000001')!;
  assert.equal(initial.title, 'Restored Chat');
  assert.equal(initial.url, 'https://chatgpt.com/c/saved-session');
  assert.equal(initial.targetRef, null, 'Conservative restore: targetRef starts null');
  assert.equal(initial.runtimeState, 'detached', 'Conservative restore: runtimeState starts detached');
  assert.equal(newDriver.targets.size, 0, 'No targets eagerly spawned on restart');

  // When tab is selected, it lazily attaches to the browser controller
  const selected = await freshAdapter.selectTab(WS1, initial.id);
  assert.ok(selected.targetRef);
  assert.equal(selected.runtimeState, 'ready');
  assert.equal(newDriver.targets.size, 1);
  assert.equal(newDriver.getActiveTarget(), selected.targetRef);
});

test('adapter: navigateTab updates URL and navigates target', async (t) => {
  const { adapter, driver } = await createFixture(t);

  const tab = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/orig',
  });

  const updated = await adapter.navigateTab(WS1, tab.id, 'https://chatgpt.com/c/navigated');
  assert.equal(updated.url, 'https://chatgpt.com/c/navigated');
  assert.equal(driver.targets.get(tab.targetRef!)!.url, 'https://chatgpt.com/c/navigated');

  // Reject malicious navigation to local service
  await assert.rejects(
    adapter.navigateTab(WS1, tab.id, 'http://localhost:3000/internal-api'),
    (err: unknown) => err instanceof BrowserTabStoreError && err.code === 'invalid-request',
  );

  // Tab URL must remain uncorrupted
  assert.equal(adapter.getTabState(tab.id)!.url, 'https://chatgpt.com/c/navigated');
});

test('adapter: renameTab updates title with validation', async (t) => {
  const { adapter } = await createFixture(t);

  const tab = await adapter.createTab({
    workspaceId: WS1,
    url: 'https://chatgpt.com/c/test',
  });

  const renamed = await adapter.renameTab(WS1, tab.id, 'New Title');
  assert.equal(renamed.title, 'New Title');

  // Empty or whitespace-only title rejected
  await assert.rejects(adapter.renameTab(WS1, tab.id, '   '), {
    name: 'BrowserTabStoreError',
    code: 'invalid-request',
  });

  // Excessively long title rejected
  await assert.rejects(adapter.renameTab(WS1, tab.id, 'a'.repeat(121)), {
    name: 'BrowserTabStoreError',
    code: 'invalid-request',
  });
});

test('adapter: orderTabs updates presentation order for workspace tabs', async (t) => {
  const { adapter } = await createFixture(t);

  const tab1 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/1' });
  const tab2 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/2' });
  const tab3 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/3' });

  assert.deepEqual(adapter.listTabs(WS1).map((t) => t.id), [tab1.id, tab2.id, tab3.id]);

  // Reverse order
  const reordered = await adapter.orderTabs(WS1, [tab3.id, tab2.id, tab1.id]);
  assert.deepEqual(reordered.map((t) => t.id), [tab3.id, tab2.id, tab1.id]);
  assert.equal(adapter.getTabState(tab3.id)!.order, 0);
  assert.equal(adapter.getTabState(tab2.id)!.order, 1);
  assert.equal(adapter.getTabState(tab1.id)!.order, 2);

  // Rejects invalid permutation (duplicate IDs)
  await assert.rejects(adapter.orderTabs(WS1, [tab3.id, tab3.id, tab1.id]), {
    name: 'BrowserTabStoreError',
    code: 'invalid-request',
  });

  // Rejects missing IDs
  await assert.rejects(adapter.orderTabs(WS1, [tab3.id, tab1.id]), {
    name: 'BrowserTabStoreError',
    code: 'invalid-request',
  });
});

test('adapter: closeTab closes target and automatically selects adjacent open tab', async (t) => {
  const { adapter, driver } = await createFixture(t);

  const tab1 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/1', order: 0 });
  const tab2 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/2', order: 1 });
  const tab3 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/3', order: 2 });

  // Select tab2
  await adapter.selectTab(WS1, tab2.id);
  assert.equal(adapter.getTabState(tab2.id)!.selected, true);

  const ref2 = tab2.targetRef!;

  // Close tab2 (currently selected)
  const closed = await adapter.closeTab(WS1, tab2.id);
  assert.ok(closed.closedAt);
  assert.equal(closed.selected, false);
  assert.equal(closed.runtimeState, 'closed');

  // Driver target for tab2 must be closed
  assert.equal(driver.targets.get(ref2)!.closed, true);

  // Tab 3 (adjacent next tab) should now be automatically selected
  const remaining = adapter.listTabs(WS1);
  assert.equal(remaining.length, 2);
  assert.ok(remaining.some((t) => t.id === tab1.id));
  assert.equal(adapter.getTabState(tab3.id)!.selected, true);
  assert.equal(driver.getActiveTarget(), tab3.targetRef);

  // Closed tab cannot be re-selected
  await assert.rejects(adapter.selectTab(WS1, tab2.id), {
    name: 'BrowserTabStoreError',
    code: 'not-found',
  });
});

test('adapter: cross-workspace isolation preserves independent tabs, ordering, and selection', async (t) => {
  const { adapter } = await createFixture(t);

  // Create 3 tabs in Workspace 1
  const ws1_tab1 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/ws1-1' });
  const ws1_tab2 = await adapter.createTab({ workspaceId: WS1, url: 'https://chatgpt.com/c/ws1-2' });

  // Create 2 tabs in Workspace 2
  const ws2_tab1 = await adapter.createTab({ workspaceId: WS2, url: 'https://chatgpt.com/c/ws2-1' });
  const ws2_tab2 = await adapter.createTab({ workspaceId: WS2, url: 'https://chatgpt.com/c/ws2-2' });

  // Check listings are isolated
  assert.deepEqual(adapter.listTabs(WS1).map((t) => t.id), [ws1_tab1.id, ws1_tab2.id]);
  assert.deepEqual(adapter.listTabs(WS2).map((t) => t.id), [ws2_tab1.id, ws2_tab2.id]);

  // Select tab in WS1
  await adapter.selectTab(WS1, ws1_tab1.id);
  assert.equal(adapter.getTabState(ws1_tab1.id)!.selected, true);
  assert.equal(adapter.getTabState(ws1_tab2.id)!.selected, false);

  // WS2's selected tab must be unaffected
  assert.equal(adapter.getTabState(ws2_tab2.id)!.selected, true);
  assert.equal(adapter.getTabState(ws2_tab1.id)!.selected, false);

  // Selecting WS2's tab while passing WS1 fails with not-found
  await assert.rejects(adapter.selectTab(WS1, ws2_tab1.id), {
    name: 'BrowserTabStoreError',
    code: 'not-found',
  });

  // Closing WS2's tab while passing WS1 fails with not-found
  await assert.rejects(adapter.closeTab(WS1, ws2_tab1.id), {
    name: 'BrowserTabStoreError',
    code: 'not-found',
  });
});

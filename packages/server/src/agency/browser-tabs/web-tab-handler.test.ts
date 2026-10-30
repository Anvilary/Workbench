import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WebTabServerMessage, WorkspaceId } from '@agent-workbench/shared';
import { BrowserTabAdapter } from './browser-tab-adapter.js';
import { MemoryBrowserControllerDriver } from './browser-controller-driver.js';
import { BrowserTabStore } from './browser-tab-store.js';
import { handleWebTabMessage } from './web-tab-handler.js';

async function createFixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-handler-test-'));
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
  const published: WebTabServerMessage[] = [];
  const publish = (msg: WebTabServerMessage) => {
    published.push(msg);
  };
  return { dir, store, driver, adapter, published, publish };
}

const WS1 = '00000000-0000-4000-8000-000000000001' as WorkspaceId;

test('web-tab-handler: creates, selects, renames, reorders, navigates, and closes tabs via protocol messages', async (t) => {
  const { adapter, published, publish } = await createFixture(t);

  // 1. Create tab
  const createRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.create',
      requestId: 'req-1',
      workspaceId: WS1,
      url: 'https://chatgpt.com/c/chat-alpha',
      title: 'Alpha',
    },
    { adapter, publish },
  );

  assert.ok(createRes);
  assert.equal(createRes.type, 'agency.webTab.created');
  assert.equal(createRes.requestId, 'req-1');
  const tab1 = createRes.tab;
  assert.equal(tab1.title, 'Alpha');
  assert.equal(published.length, 1);
  assert.equal(published[0]!.type, 'agency.webTab.changed');
  assert.equal(published[0]!.change, 'created');

  // Create second tab
  const createRes2 = await handleWebTabMessage(
    {
      type: 'agency.webTab.create',
      requestId: 'req-2',
      workspaceId: WS1,
      url: 'https://chatgpt.com/c/chat-beta',
      title: 'Beta',
    },
    { adapter, publish },
  );
  assert.equal(createRes2?.type, 'agency.webTab.created');
  const tab2 = createRes2.tab;

  // 2. Select tab1
  const selectRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.select',
      requestId: 'req-3',
      workspaceId: WS1,
      tabId: tab1.id,
    },
    { adapter, publish },
  );
  assert.equal(selectRes?.type, 'agency.webTab.updated');
  assert.equal(selectRes.tab.id, tab1.id);
  assert.equal(selectRes.tab.selected, true);

  // 3. Rename tab1
  const renameRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.rename',
      requestId: 'req-4',
      workspaceId: WS1,
      tabId: tab1.id,
      title: 'Alpha Renamed',
    },
    { adapter, publish },
  );
  assert.equal(renameRes?.type, 'agency.webTab.updated');
  assert.equal(renameRes.tab.title, 'Alpha Renamed');

  // 4. Navigate tab2
  const navRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.navigate',
      requestId: 'req-5',
      workspaceId: WS1,
      tabId: tab2.id,
      url: 'https://chatgpt.com/c/chat-beta-navigated',
    },
    { adapter, publish },
  );
  assert.equal(navRes?.type, 'agency.webTab.updated');
  assert.equal(navRes.tab.url, 'https://chatgpt.com/c/chat-beta-navigated');

  // 5. Order tabs
  const orderRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.order',
      requestId: 'req-6',
      workspaceId: WS1,
      tabIds: [tab2.id, tab1.id],
    },
    { adapter, publish },
  );
  assert.equal(orderRes?.type, 'agency.webTabs.snapshot');
  assert.deepEqual(orderRes.tabs.map((t) => t.id), [tab2.id, tab1.id]);

  // 6. List tabs
  const listRes = await handleWebTabMessage(
    {
      type: 'agency.webTabs.list',
      requestId: 'req-7',
      workspaceId: WS1,
    },
    { adapter, publish },
  );
  assert.equal(listRes?.type, 'agency.webTabs.snapshot');
  assert.equal(listRes.tabs.length, 2);

  // 7. Close tab
  const closeRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.close',
      requestId: 'req-8',
      workspaceId: WS1,
      tabId: tab1.id,
    },
    { adapter, publish },
  );
  assert.equal(closeRes?.type, 'agency.webTab.closed');
  assert.ok(closeRes.tab.closedAt);
});

test('web-tab-handler: returns null for non-web-tab messages and handles errors gracefully', async (t) => {
  const { adapter, publish } = await createFixture(t);

  // Unrelated native CLI message returns null
  const unrelated = await handleWebTabMessage(
    { type: 'agency.projects.list', requestId: 'req-unrelated' },
    { adapter, publish },
  );
  assert.equal(unrelated, null);

  // Invalid URL in create returns agency.error
  const badUrlRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.create',
      requestId: 'req-bad-url',
      workspaceId: WS1,
      url: 'http://localhost:3000',
    },
    { adapter, publish },
  );
  // parseWebTabClientMessage validates URL and returns null on invalid URL
  assert.equal(badUrlRes, null);

  // Invalid tab ID on select returns agency.error
  const notFoundRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.select',
      requestId: 'req-not-found',
      workspaceId: WS1,
      tabId: '99999999-9999-4999-8999-999999999999',
    },
    { adapter, publish },
  );
  assert.ok(notFoundRes);
  assert.equal(notFoundRes.type, 'agency.error');
  assert.equal(notFoundRes.code, 'not-found');
});

test('web-tab-handler: failed select broadcasts updated error state while preserving saved URL', async (t) => {
  const { adapter, driver, published, publish } = await createFixture(t);

  // Create a tab with saved URL
  const createRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.create',
      requestId: 'req-c1',
      workspaceId: WS1,
      url: 'https://chatgpt.com/c/chat-error-test',
      title: 'ChatGPT Error Test',
    },
    { adapter, publish },
  );
  assert.ok(createRes && createRes.type === 'agency.webTab.created');
  const tab = createRes.tab;
  assert.equal(tab.url, 'https://chatgpt.com/c/chat-error-test');

  // Configure driver to fail activation on target
  assert.ok(tab.targetRef);
  driver.failActivateTargets.add(tab.targetRef);

  // Clear published messages
  published.length = 0;

  // Attempt to select the tab
  const selectRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.select',
      requestId: 'req-s1',
      workspaceId: WS1,
      tabId: tab.id,
    },
    { adapter, publish },
  );

  // Response should be agency.error
  assert.ok(selectRes);
  assert.equal(selectRes.type, 'agency.error');
  assert.ok(selectRes.message.includes('Simulated failure activating target'));

  // Handler should have published agency.webTab.changed with error state
  const changedMsg = published.find((m) => m.type === 'agency.webTab.changed' && m.change === 'updated');
  assert.ok(changedMsg);
  if (!changedMsg || changedMsg.type !== 'agency.webTab.changed' || !changedMsg.tab) {
    assert.fail('Expected agency.webTab.changed message with tab');
  }
  assert.equal(changedMsg.tab.id, tab.id);
  assert.equal(changedMsg.tab.runtimeState, 'error');
  // Saved URL MUST be preserved
  assert.equal(changedMsg.tab.url, 'https://chatgpt.com/c/chat-error-test');
});


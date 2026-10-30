import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WebTabServerMessage, WorkspaceId } from '@agent-workbench/shared';
import { BrowserTabAdapter } from './browser-tab-adapter.js';
import { BrowserTabStore } from './browser-tab-store.js';
import { handleWebTabMessage } from './web-tab-handler.js';

async function createFixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-handler-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const store = new BrowserTabStore(path.join(dir, 'agency-web-tabs.json'));
  await store.load();
  const adapter = new BrowserTabAdapter({
    store,
    allowUnvalidatedWorkspacesForTesting: true,
  });
  const published: WebTabServerMessage[] = [];
  const publish = (msg: WebTabServerMessage) => {
    published.push(msg);
  };
  return { dir, store, adapter, published, publish };
}

const WS1 = '00000000-0000-4000-8000-000000000001' as WorkspaceId;
const WS2 = '00000000-0000-4000-8000-000000000002' as WorkspaceId;

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

test('web-tab-handler: cross-workspace select fails and never broadcasts tab under foreign workspace', async (t) => {
  const { adapter, published, publish } = await createFixture(t);

  // 1. Create Tab A in Workspace A (WS1)
  const createA = await handleWebTabMessage(
    {
      type: 'agency.webTab.create',
      requestId: 'req-ca',
      workspaceId: WS1,
      url: 'https://chatgpt.com/c/chat-ws1',
      title: 'Tab WS1',
    },
    { adapter, publish },
  );
  assert.ok(createA && createA.type === 'agency.webTab.created');
  const tabA = createA.tab;

  // 2. Create Tab B in Workspace B (WS2)
  const createB = await handleWebTabMessage(
    {
      type: 'agency.webTab.create',
      requestId: 'req-cb',
      workspaceId: WS2,
      url: 'https://chatgpt.com/c/chat-ws2',
      title: 'Tab WS2',
    },
    { adapter, publish },
  );
  assert.ok(createB && createB.type === 'agency.webTab.created');
  const tabB = createB.tab;

  // Clear published messages
  published.length = 0;

  // 3. Attempt to select Tab B using Workspace A (cross-workspace request)
  const crossSelectRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.select',
      requestId: 'req-cross',
      workspaceId: WS1,
      tabId: tabB.id,
    },
    { adapter, publish },
  );

  // The request must fail with not-found error
  assert.ok(crossSelectRes);
  assert.equal(crossSelectRes.type, 'agency.error');
  assert.equal(crossSelectRes.code, 'not-found');

  // The handler must not broadcast Tab B under Workspace A
  assert.equal(published.length, 0, 'No broadcast should occur for cross-workspace selection failure');

  // 4. Also verify closed tab selection does not broadcast failure state
  const closeRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.close',
      requestId: 'req-close-a',
      workspaceId: WS1,
      tabId: tabA.id,
    },
    { adapter, publish },
  );
  assert.ok(closeRes && closeRes.type === 'agency.webTab.closed');
  published.length = 0;

  const selectClosedRes = await handleWebTabMessage(
    {
      type: 'agency.webTab.select',
      requestId: 'req-select-closed',
      workspaceId: WS1,
      tabId: tabA.id,
    },
    { adapter, publish },
  );
  assert.ok(selectClosedRes);
  assert.equal(selectClosedRes.type, 'agency.error');
  assert.equal(selectClosedRes.code, 'not-found');
  assert.equal(published.length, 0, 'No broadcast should occur for closed tab selection failure');
});



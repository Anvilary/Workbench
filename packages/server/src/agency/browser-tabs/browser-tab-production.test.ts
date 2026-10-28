import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkspaceId } from '@agent-workbench/shared';
import { BrowserTabAdapter } from './browser-tab-adapter.js';
import { BrowserEngineUnavailableError, MemoryBrowserControllerDriver } from './browser-controller-driver.js';
import { BrowserTabStore } from './browser-tab-store.js';
import { handleWebTabMessage } from './web-tab-handler.js';

const WS = '00000000-0000-4000-8000-000000000001' as WorkspaceId;

async function fixture(t: import('node:test').TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'maw-production-tabs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'tabs.json');
  const driver = new MemoryBrowserControllerDriver();
  const store = new BrowserTabStore(filePath);
  await store.load();
  const adapter = new BrowserTabAdapter({ store, driver, allowUnvalidatedWorkspacesForTesting: true });
  return { filePath, driver, adapter, store };
}

test('production: logical identity is persisted before browser creation', async (t) => {
  const { filePath, driver, adapter } = await fixture(t);
  const original = driver.openTarget.bind(driver);
  driver.openTarget = async (url, metadata) => {
    const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(snapshot.tabs[0].id, metadata!.tabId);
    assert.equal(snapshot.tabs[0].targetRef, null);
    return original(url, metadata);
  };
  await adapter.createTab({ workspaceId: WS, url: 'https://chatgpt.com/' });
});

test('production: activation failure keeps newly opened handle and retry does not duplicate', async (t) => {
  const { driver, adapter } = await fixture(t);
  const tab = await adapter.createTab({ workspaceId: WS, url: 'https://chatgpt.com/', unloaded: true });
  driver.failActivateTargets.add('mem-target-1');
  await assert.rejects(adapter.selectTab(WS, tab.id));
  assert.equal(adapter.getTabState(tab.id)!.targetRef, 'mem-target-1');
  driver.failActivateTargets.clear();
  await adapter.selectTab(WS, tab.id);
  assert.equal(driver.getTargetCount(), 1);
});

test('production: ownership outage retains handle and creates no replacement', async (t) => {
  const { driver, adapter } = await fixture(t);
  const tab = await adapter.createTab({ workspaceId: WS, url: 'https://chatgpt.com/' });
  driver.verifyTargetOwnership = async () => { throw new BrowserEngineUnavailableError(); };
  await assert.rejects(adapter.selectTab(WS, tab.id));
  assert.equal(adapter.getTabState(tab.id)!.targetRef, tab.targetRef);
  assert.equal(driver.getTargetCount(), 1);
});

test('production: foreign persisted handles are never navigated or closed', async (t) => {
  const { driver, adapter, filePath } = await fixture(t);
  const tab = await adapter.createTab({ workspaceId: WS, url: 'https://chatgpt.com/' });
  driver.targets.get(tab.targetRef!)!.metadata!.tabId = '00000000-0000-4000-8000-000000000099';
  await adapter.navigateTab(WS, tab.id, 'https://chatgpt.com/c/new');
  assert.equal(driver.callLog.filter((call) => call.method === 'navigateTarget').length, 0);
  // A forged hint in a durable snapshot also cannot authorize destruction.
  const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
  snapshot.tabs[0].targetRef = tab.targetRef;
  const store = new BrowserTabStore(filePath);
  await store.save(snapshot.tabs);
  const restarted = new BrowserTabAdapter({ store, driver, allowUnvalidatedWorkspacesForTesting: true });
  await restarted.restore();
  await restarted.closeTab(WS, tab.id);
  assert.equal(await driver.isTargetAlive(tab.targetRef!), true);
});

test('production: failed cleanup tombstone survives restart and preserves siblings', async (t) => {
  const { driver, adapter, filePath } = await fixture(t);
  const first = await adapter.createTab({ workspaceId: WS, url: 'https://chatgpt.com/' });
  const sibling = await adapter.createTab({ workspaceId: WS, url: 'https://chatgpt.com/c/sibling' });
  driver.failCloseTargets.add(first.targetRef!);
  await adapter.closeTab(WS, first.id);
  const restarted = new BrowserTabAdapter({ store: new BrowserTabStore(filePath), driver, allowUnvalidatedWorkspacesForTesting: true });
  await restarted.restore();
  assert.equal(restarted.getTabState(first.id)!.cleanupRequired, true);
  driver.failCloseTargets.clear();
  await restarted.reconcileCleanup();
  assert.equal(restarted.getTabState(first.id)!.cleanupRequired, false);
  assert.equal(await driver.isTargetAlive(first.targetRef!), false);
  assert.equal(await driver.isTargetAlive(sibling.targetRef!), true);
});

test('production: close resolves a durable owner receipt after the create response was lost', async (t) => {
  const { driver, adapter } = await fixture(t);
  const open = driver.openTarget.bind(driver);
  driver.openTarget = async (url, metadata) => {
    await open(url, metadata);
    throw new Error('simulated lost create response');
  };
  Object.assign(driver, {
    findOwnedTarget: async (owner: { tabId: string; workspaceId: string }) => {
      for (const [reference, target] of driver.targets) {
        if (!target.closed && target.metadata?.tabId === owner.tabId && target.metadata.workspaceId === owner.workspaceId) return reference;
      }
      return null;
    },
  });
  await assert.rejects(adapter.createTab({ workspaceId: WS, url: 'https://chatgpt.com/' }));
  const logical = adapter.listTabs(WS)[0]!;
  assert.equal(logical.targetRef, null);
  assert.equal(driver.getTargetCount(), 1);
  const closed = await adapter.closeTab(WS, logical.id);
  assert.equal(closed.cleanupRequired, false);
  assert.equal(driver.getTargetCount(), 0);
});

test('production: failed navigation reports failure and preserves last confirmed URL', async (t) => {
  const { adapter, driver } = await fixture(t);
  const tab = await adapter.createTab({ workspaceId: WS, url: 'https://chatgpt.com/' });
  driver.navigateTarget = async () => { throw new Error('simulated navigation outage'); };
  await assert.rejects(adapter.navigateTab(WS, tab.id, 'https://chatgpt.com/c/new'));
  assert.equal(adapter.getTabState(tab.id)!.url, tab.url);
  assert.equal(adapter.getTabState(tab.id)!.runtimeState, 'error');
});

test('production: protocol forwards unloaded and workspace launch idempotency', async (t) => {
  const { adapter, driver } = await fixture(t);
  const message = { type: 'agency.webTab.create', requestId: 'create-1', workspaceId: WS, url: 'https://chatgpt.com/', launchId: 'launch-1', unloaded: true };
  await handleWebTabMessage(message, { adapter });
  await handleWebTabMessage({ ...message, requestId: 'create-2' }, { adapter });
  assert.equal(adapter.listTabs(WS).length, 1);
  assert.equal(adapter.listTabs(WS)[0]!.runtimeState, 'unloaded');
  assert.equal(driver.getTargetCount(), 0);
});

test('production: web subset ordering preserves global interleaved positions', async (t) => {
  const { adapter } = await fixture(t);
  const first = await adapter.createTab({ workspaceId: WS, url: 'https://chatgpt.com/', unloaded: true });
  const second = await adapter.createTab({ workspaceId: WS, url: 'https://chatgpt.com/', unloaded: true });
  await adapter.orderTabs(WS, [second.id, first.id], new Map([[second.id, 1], [first.id, 3]]));
  assert.deepEqual(adapter.listTabs(WS).map((tab) => tab.order), [1, 3]);
});

test('production: live URL refresh persists conversation address without page mutations', async (t) => {
  const { adapter, driver, filePath } = await fixture(t);
  const tab = await adapter.createTab({ workspaceId: WS, url: 'https://chatgpt.com/' });
  let observed = 'https://chatgpt.com/c/user-created-conversation';
  Object.assign(driver, { getTargetUrl: async () => observed });
  const opened = driver.getTargetCount();
  await adapter.refreshLiveTabs();
  assert.equal(adapter.getTabState(tab.id)!.url, observed);
  observed = 'https://accounts.google.com/redirect';
  await adapter.refreshLiveTabs();
  assert.equal(adapter.getTabState(tab.id)!.url, 'https://chatgpt.com/c/user-created-conversation');
  const restored = await new BrowserTabStore(filePath).load();
  assert.equal(restored[0]!.url, 'https://chatgpt.com/c/user-created-conversation');
  assert.equal(driver.getTargetCount(), opened);
});


test('failed browser rename preserves visible and durable title; retry persists stable ownership', async t => {
  const { adapter, store, filePath } = await fixture(t);
  const tab = await adapter.createTab({workspaceId:WS,url:'https://chatgpt.com/',title:'Original'});
  const save = store.save.bind(store);
  store.save = async () => { throw new Error('fixture disk full'); };
  await assert.rejects(adapter.renameTab(WS,tab.id,'Unsaved'),/fixture disk full/);
  assert.equal(adapter.getTabState(tab.id)!.title,'Original');
  assert.equal(JSON.parse(await readFile(filePath,'utf8')).tabs[0].title,'Original');
  store.save = save;
  await adapter.renameTab(WS,tab.id,'Retried');
  const restored = new BrowserTabAdapter({store:new BrowserTabStore(filePath),driver:new MemoryBrowserControllerDriver(),allowUnvalidatedWorkspacesForTesting:true});
  await restored.restore();
  assert.equal(restored.getTabState(tab.id)!.title,'Retried');
  assert.equal(restored.getTabState(tab.id)!.targetRef,tab.targetRef);
});

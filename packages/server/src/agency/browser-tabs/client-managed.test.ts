import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkspaceId } from '@agent-workbench/shared';
import { BrowserTabAdapter } from './browser-tab-adapter.js';
import { BrowserTabStore } from './browser-tab-store.js';
const workspaceId = '00000000-0000-4000-8000-000000000001' as WorkspaceId;

test('logical tabs persist UUIDs, titles, URLs, mixed positions and selection independently of native pages', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-client-tabs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tabs.json');
  const make = () => new BrowserTabAdapter({ store: new BrowserTabStore(file), allowUnvalidatedWorkspacesForTesting: true });
  const adapter = make(); await adapter.restore();
  const one = await adapter.createTab({ workspaceId, url: 'https://chatgpt.com/', title: 'One', launchId: 'first' });
  const two = await adapter.createTab({ workspaceId, url: 'https://chatgpt.com/c/two', title: 'Two' });
  assert.equal((await adapter.createTab({ workspaceId, url: 'https://chatgpt.com/', launchId: 'first' })).id, one.id);
  await adapter.selectTab(workspaceId, one.id);
  await adapter.renameTab(workspaceId, one.id, 'Renamed');
  await adapter.navigateTab(workspaceId, one.id, 'https://chatgpt.com/c/committed');
  await adapter.orderTabs(workspaceId, [two.id, one.id], new Map([[two.id, 0], [one.id, 2]]));
  await assert.rejects(adapter.navigateTab(workspaceId, one.id, 'http://127.0.0.1:3000/'));
  await assert.rejects(adapter.selectTab('00000000-0000-4000-8000-000000000002' as WorkspaceId, one.id));
  await adapter.flush();
  const restored = make(); await restored.restore();
  assert.deepEqual(restored.listTabs().map(tab => [tab.id, tab.title, tab.url, tab.order, tab.selected, tab.runtimeState, tab.targetRef]), [
    [two.id, 'Two', two.url, 0, false, 'client-managed', null],
    [one.id, 'Renamed', 'https://chatgpt.com/c/committed', 2, true, 'client-managed', null],
  ]);
  await restored.closeTab(workspaceId, one.id);
  assert.equal(restored.getTabState(two.id)?.selected, true);
  await restored.clearWorkspaceSelection(workspaceId);
  assert.equal(restored.getTabState(two.id)?.selected, false);
});

test('a failed disk commit rolls back logical changes and concurrent launch retries reuse one UUID', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-tab-commit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new BrowserTabStore(path.join(dir, 'tabs.json'));
  const adapter = new BrowserTabAdapter({ store, allowUnvalidatedWorkspacesForTesting: true });
  await adapter.restore();
  const create = () => adapter.createTab({ workspaceId, url: 'https://chatgpt.com/', title: 'Saved title', launchId: 'concurrent-retry' });
  const [one, retry] = await Promise.all([create(), create()]);
  assert.equal(one.id, retry.id);
  assert.equal(adapter.listTabs(workspaceId).length, 1);
  const save = store.save.bind(store);
  store.save = async () => { throw new Error('fixture disk failure'); };
  await assert.rejects(adapter.renameTab(workspaceId, one.id, 'Unsaved title'), /disk failure/);
  assert.equal(adapter.getTabState(one.id)?.title, 'Saved title');
  store.save = save;
  await adapter.restore();
  assert.equal(adapter.getTabState(one.id)?.title, 'Saved title');
});

test('legacy ownership metadata remains inert and survives logical closure', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-legacy-tabs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new BrowserTabStore(path.join(dir, 'tabs.json'));
  const adapter = new BrowserTabAdapter({ store, allowUnvalidatedWorkspacesForTesting: true });
  await adapter.restore();
  const tab = await adapter.createTab({ workspaceId, url: 'https://chatgpt.com/' });
  await store.save([{ ...tab, targetRef: 'legacy-ownership-receipt', cleanupRequired: true }]);
  await adapter.restore();
  await adapter.selectTab(workspaceId, tab.id);
  await adapter.navigateTab(workspaceId, tab.id, 'https://chatgpt.com/c/new');
  await adapter.closeTab(workspaceId, tab.id);
  const closed = adapter.getTabState(tab.id)!;
  assert.equal(closed.targetRef, 'legacy-ownership-receipt');
  assert.equal(closed.cleanupRequired, true);
  assert.equal(closed.runtimeState, 'closed');
});

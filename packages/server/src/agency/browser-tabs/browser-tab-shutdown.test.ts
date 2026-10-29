import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkspaceId } from '@agent-workbench/shared';
import { BrowserTabAdapter } from './browser-tab-adapter.js';
import { BrowserTabStore } from './browser-tab-store.js';
import { NekoBrowserControllerDriver } from './neko-browser-controller-driver.js';

test('shutdown cancels a stalled controller request, preserves committed URL, and drains writes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-browser-shutdown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer(() => { /* A controller that accepts connections but never responds. */ });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const store = new BrowserTabStore(path.join(root, 'agency-web-tabs.json'));
  const url = 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555';
  await store.save([{
    id: '22222222-2222-4222-8222-222222222222', workspaceId: '33333333-3333-4333-8333-333333333333' as WorkspaceId,
    kind: 'web', title: 'Committed conversation', url, order: 0, selected: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), closedAt: null, targetRef: 'owned-target',
  }]);
  const driver = new NekoBrowserControllerDriver({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'a'.repeat(64) });
  const adapter = new BrowserTabAdapter({ store, driver, allowUnvalidatedWorkspacesForTesting: true });
  await adapter.restore();
  const began = performance.now();
  await adapter.captureFinalUrls(100);
  assert.ok(performance.now() - began < 2000, 'capture is bounded even with a stalled controller');
  assert.equal(JSON.parse(await readFile(store.filePath, 'utf8')).tabs[0].url, url);
  const before = await stat(store.filePath);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await stat(store.filePath)).mtimeMs, before.mtimeMs, 'no late observer writes after capture returns');
});

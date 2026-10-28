#!/usr/bin/env -S pnpm --filter @agent-workbench/server exec tsx
/** Explicit isolated runtime acceptance; consumes a generated-only JSON config. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NekoBrowserControllerDriver } from '../../../packages/server/src/agency/browser-tabs/neko-browser-controller-driver.ts';
import { BrowserTabAdapter } from '../../../packages/server/src/agency/browser-tabs/browser-tab-adapter.ts';
import { BrowserTabStore } from '../../../packages/server/src/agency/browser-tabs/browser-tab-store.ts';

const [configPath, container] = process.argv.slice(2);
if (!configPath || !container || !/^maw-neko-integration-[a-z0-9_-]+$/.test(container) || path.basename(path.dirname(configPath)) !== container) {
  throw new Error('Use only a generated config inside its unique maw-neko-integration-* runtime directory');
}
const config = JSON.parse(await readFile(configPath, 'utf8'));
const options = { baseUrl: config.NEKO_CONTROLLER_URL, token: config.CONTROLLER_AUTH_TOKEN };
const headers = { Authorization: `Bearer ${options.token}` };
const directory = await mkdtemp(path.join(tmpdir(), 'maw-live-managed-tabs-'));
const filePath = path.join(directory, 'tabs.json');
const workspace = '00000000-0000-4000-8000-000000000091';
const results: Record<string, boolean> = {};

async function ready() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${options.baseUrl}/health`, { headers, signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Isolated controller did not become ready');
}

function restart(program: string) {
  execFileSync('docker', ['exec', container!, 'supervisorctl', '-c', '/etc/neko/supervisord.conf', 'restart', program], { stdio: 'pipe' });
}

await ready();
let driver = new NekoBrowserControllerDriver(options);
let adapter = new BrowserTabAdapter({ store: new BrowserTabStore(filePath), driver, allowUnvalidatedWorkspacesForTesting: true });
await adapter.restore();
try {
  const first = await adapter.createTab({ workspaceId: workspace, url: 'https://chatgpt.com/', launchId: 'live-first' });
  const second = await adapter.createTab({ workspaceId: workspace, url: 'https://chatgpt.com/', launchId: 'live-second' });
  const originalFirst = first.targetRef!;
  const originalSecond = second.targetRef!;
  const owner = { tabId: first.id, workspaceId: workspace };
  const reused = await driver.openTarget(first.url, owner);
  assert.equal(reused.targetRef, originalFirst);
  results.idempotentCreate = true;
  assert.equal(await driver.verifyTargetOwnership(originalFirst, { tabId: second.id, workspaceId: workspace }), false);
  results.foreignOwnershipRejected = true;

  // A fresh server adapter/driver must reattach, without navigating the pages.
  driver = new NekoBrowserControllerDriver(options);
  adapter = new BrowserTabAdapter({ store: new BrowserTabStore(filePath), driver, allowUnvalidatedWorkspacesForTesting: true });
  await adapter.restore();
  await adapter.selectTab(workspace, first.id);
  await adapter.selectTab(workspace, second.id);
  assert.equal(adapter.getTabState(first.id)!.targetRef, originalFirst);
  assert.equal(adapter.getTabState(second.id)!.targetRef, originalSecond);
  results.mawRestartReattaches = true;

  restart('tab-controller');
  await ready();
  assert.equal(await driver.verifyTargetOwnership(originalFirst, owner), true);
  const repeated = await driver.openTarget(first.url, owner);
  assert.equal(repeated.targetRef, originalFirst);
  results.controllerRestartPreservesReceipts = true;

  await adapter.refreshLiveTabs();
  results.inventoryObservesConversationUrl = adapter.getTabState(first.id)!.url === 'https://chatgpt.com/';
  restart('chromium');
  await ready();
  assert.equal(await driver.verifyTargetOwnership(originalFirst, owner), false);
  await adapter.selectTab(workspace, first.id);
  assert.notEqual(adapter.getTabState(first.id)!.targetRef, originalFirst);
  // The second tab stays detached until selected; no eager recreation.
  assert.equal(await driver.isTargetAlive(originalSecond), false);
  results.browserRestartInvalidatesOldReceipts = true;
  await adapter.closeTab(workspace, first.id);
  await adapter.closeTab(workspace, second.id);
  results.ownedCleanup = true;
  console.log(JSON.stringify({ managedRealBrowser: results }, null, 2));
} finally {
  for (const tab of adapter.listTabs(workspace)) await adapter.closeTab(workspace, tab.id).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}

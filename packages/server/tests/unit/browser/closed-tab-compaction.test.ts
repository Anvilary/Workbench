import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WebTab, WorkspaceId } from '@agent-workbench/shared';
import {
  BROWSER_TAB_STORE_VERSION,
  BrowserTabStore,
  CLOSED_TAB_DEDUPE_WINDOW_MS,
  CLOSED_TAB_MAX_PER_WORKSPACE,
  CLOSED_TAB_RETENTION_MS,
  compactClosedWebTabs,
} from '../../../src/features/browser/browser-tab-store.js';
import { BrowserTabAdapter } from '../../../src/features/browser/browser-tab-adapter.js';

const workspaceA = '00000000-0000-4000-8000-00000000000a' as WorkspaceId;
const workspaceB = '00000000-0000-4000-8000-00000000000b' as WorkspaceId;
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function closedTab(overrides: Partial<WebTab> & { id: string; closedAgoMs: number }): WebTab {
  const { closedAgoMs, ...rest } = overrides;
  const stamp = new Date(NOW - closedAgoMs).toISOString();
  return {
    id: rest.id,
    workspaceId: workspaceA,
    kind: 'web',
    title: 'ChatGPT',
    url: 'https://chatgpt.com/',
    provider: 'chatgpt',
    order: 0,
    selected: false,
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: stamp,
    runtimeState: 'closed',
    targetRef: null,
    cleanupRequired: false,
    ...rest,
  } as WebTab;
}

function openTab(id: string, workspaceId: WorkspaceId = workspaceA): WebTab {
  const stamp = new Date(NOW).toISOString();
  return {
    id,
    workspaceId,
    kind: 'web',
    title: 'ChatGPT',
    url: 'https://chatgpt.com/',
    provider: 'chatgpt',
    order: 0,
    selected: false,
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
    runtimeState: 'client-managed',
    targetRef: null,
    cleanupRequired: false,
  } as WebTab;
}

test('compaction keeps open tabs, pending cleanup, the dedupe window and bounded history', () => {
  const tabs: WebTab[] = [openTab('open-1'), openTab('open-2', workspaceB)];
  // 500 closed records per the production profile, spread over 100 days.
  for (let index = 0; index < 500; index += 1) {
    tabs.push(closedTab({ id: `closed-${index}`, closedAgoMs: Math.round(((index + 1) / 500) * 100 * DAY) }));
  }
  // Pending cleanup records, deliberately ancient.
  for (let index = 0; index < 7; index += 1) {
    tabs.push(closedTab({ id: `cleanup-${index}`, closedAgoMs: 400 * DAY, cleanupRequired: true, targetRef: 'legacy' as never }));
  }
  // A second workspace gets its own cap.
  for (let index = 0; index < 120; index += 1) {
    tabs.push(closedTab({ id: `b-closed-${index}`, workspaceId: workspaceB, closedAgoMs: 2 * DAY + index * 1000 }));
  }
  // Recently closed records stay for launchId idempotence even beyond the cap.
  for (let index = 0; index < 80; index += 1) {
    tabs.push(closedTab({ id: `fresh-${index}`, closedAgoMs: 60 * 1000 + index, launchId: `launch-${index}` }));
  }
  const unknownAge = closedTab({ id: 'unparsable', closedAgoMs: 0 });
  (unknownAge as { closedAt: string }).closedAt = 'not-a-date';
  tabs.push(unknownAge);

  const kept = compactClosedWebTabs(tabs, { now: NOW });
  const keptIds = new Set(kept.map((tab) => tab.id));

  assert.ok(keptIds.has('open-1') && keptIds.has('open-2'), 'open tabs are never removed');
  for (let index = 0; index < 7; index += 1) {
    assert.ok(keptIds.has(`cleanup-${index}`), 'cleanupRequired records are never removed');
  }
  for (let index = 0; index < 80; index += 1) {
    assert.ok(keptIds.has(`fresh-${index}`), 'records inside the dedupe window are never removed');
  }
  assert.ok(keptIds.has('unparsable'), 'a record with an unknown age is kept');

  // Workspace A: the 7 day retention window bites before the per-workspace cap does,
  // because the records are spread over 100 days (0.2 days apart).
  const prunableA = kept.filter((tab) => tab.id.startsWith('closed-'));
  assert.equal(prunableA.length, 35);
  const prunableB = kept.filter((tab) => tab.id.startsWith('b-closed-'));
  assert.equal(prunableB.length, CLOSED_TAB_MAX_PER_WORKSPACE, 'the cap is per workspace');

  for (const tab of [...prunableA, ...prunableB]) {
    assert.ok(NOW - Date.parse(tab.closedAt!) <= CLOSED_TAB_RETENTION_MS, 'nothing older than the retention window survives');
  }
  // The newest prunable records are the ones kept.
  const newestKept = prunableA.map((tab) => tab.id).sort();
  assert.deepEqual(newestKept, Array.from({ length: 35 }, (_, index) => `closed-${index}`).sort());

  assert.ok(kept.length < tabs.length / 2, 'the store shrinks substantially');
});

test('compaction removes nothing when every closed record is recent', () => {
  const tabs = [
    openTab('open-1'),
    closedTab({ id: 'closed-1', closedAgoMs: CLOSED_TAB_DEDUPE_WINDOW_MS - 1000 }),
    closedTab({ id: 'closed-2', closedAgoMs: 1000 }),
  ];
  assert.deepEqual(compactClosedWebTabs(tabs, { now: NOW }).map((tab) => tab.id), ['open-1', 'closed-1', 'closed-2']);
});

test('compaction preserves input order and never mutates its input', () => {
  const tabs = [
    closedTab({ id: 'old', closedAgoMs: 90 * DAY }),
    openTab('open-1'),
    closedTab({ id: 'recent', closedAgoMs: 2 * DAY }),
  ];
  const snapshot = JSON.stringify(tabs);
  assert.deepEqual(compactClosedWebTabs(tabs, { now: NOW }).map((tab) => tab.id), ['open-1', 'recent']);
  assert.equal(JSON.stringify(tabs), snapshot);
});

test('the store compacts a bloated file on load and on save, and the launchId contract survives', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-closed-tab-compaction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agency-web-tabs.json');

  const now = Date.now();
  const stored: WebTab[] = [openTab('11111111-1111-4111-8111-111111111111')];
  for (let index = 0; index < 500; index += 1) {
    const stamp = new Date(now - (index + 2) * DAY).toISOString();
    stored.push({
      ...closedTab({ id: `${index}`.padStart(8, '0') + '-0000-4000-8000-000000000000', closedAgoMs: 0 }),
      createdAt: stamp,
      updatedAt: stamp,
      closedAt: stamp,
      launchId: `launch-${index}`,
    });
  }
  const pendingStamp = new Date(now - 300 * DAY).toISOString();
  stored.push({
    ...closedTab({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', closedAgoMs: 0, cleanupRequired: true }),
    createdAt: pendingStamp,
    updatedAt: pendingStamp,
    closedAt: pendingStamp,
    targetRef: 'legacy-target' as never,
  });
  await writeFile(file, JSON.stringify({ version: BROWSER_TAB_STORE_VERSION, tabs: stored }, null, 2), 'utf8');

  const store = new BrowserTabStore(file);
  const loaded = await store.load();
  const closedLoaded = loaded.filter((tab) => tab.closedAt);
  assert.ok(closedLoaded.length <= CLOSED_TAB_MAX_PER_WORKSPACE + 1, `compacted on load, got ${closedLoaded.length}`);
  assert.ok(closedLoaded.some((tab) => tab.cleanupRequired === true), 'the pending-cleanup record survives load');
  assert.ok(loaded.some((tab) => tab.id === '11111111-1111-4111-8111-111111111111'), 'the open tab survives load');

  await store.save();
  await store.flush();
  const onDisk = JSON.parse(await readFile(file, 'utf8')) as { tabs: WebTab[] };
  assert.equal(onDisk.tabs.length, loaded.length);
  assert.ok(onDisk.tabs.some((tab) => tab.cleanupRequired === true));

  // The adapter still deduplicates a retried launch against a surviving closed record.
  const adapter = new BrowserTabAdapter({ store: new BrowserTabStore(file), allowUnvalidatedWorkspacesForTesting: true });
  await adapter.restore();
  const survivor = adapter.listTabs(undefined, { includeClosed: true }).find((tab) => tab.launchId);
  assert.ok(survivor?.launchId, 'a closed record with a launchId survived');
  const deduped = await adapter.createTab({
    workspaceId: survivor.workspaceId,
    url: 'https://chatgpt.com/',
    launchId: survivor.launchId,
  });
  assert.equal(deduped.id, survivor.id, 'launchId dedupe still resolves to the surviving record');
});

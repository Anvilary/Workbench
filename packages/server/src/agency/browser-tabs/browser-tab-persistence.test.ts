import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WebTab, WorkspaceId } from '@agent-workbench/shared';
import {
  BrowserTabStore,
  parseBrowserTabSnapshot,
  normalizeWorkspaceSelections,
} from './browser-tab-store.js';

async function createFixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-web-tabs-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const filePath = path.join(dir, 'agency-web-tabs.json');
  const store = new BrowserTabStore(filePath);
  return { dir, filePath, store };
}

function makeTab(id: string, wsId: string, order = 0, selected = false, closedAt: string | null = null): WebTab {
  return {
    id,
    workspaceId: wsId as WorkspaceId,
    kind: 'web',
    title: `Tab ${id}`,
    url: 'https://chatgpt.com/c/671fd123-4567-89ab-cdef-0123456789ab',
    order,
    selected,
    createdAt: '2026-10-28T19:00:00.000Z',
    updatedAt: '2026-10-28T19:00:00.000Z',
    closedAt,
    targetRef: 'ephemeral-target-123',
    runtimeState: 'ready',
  };
}

test('persistence: returns empty list when primary and backup do not exist', async (t) => {
  const { store } = await createFixture(t);
  const tabs = await store.load();
  assert.deepEqual(tabs, []);
  assert.equal(store.isLoaded, true);
});

test('persistence: atomic save and conservative restore preserves targetRef for reconciliation while resetting runtimeState', async (t) => {
  const { store, filePath } = await createFixture(t);
  const ws1 = 'a0000000-0000-4000-8000-000000000001' as WorkspaceId;
  const tab1 = makeTab('b0000000-0000-4000-8000-000000000001', ws1, 0, true);
  const tab2 = makeTab('b0000000-0000-4000-8000-000000000002', ws1, 1, false);

  await store.save([tab1, tab2]);

  // Check file mode (0o600)
  const st = await stat(filePath);
  assert.equal(st.mode & 0o777, 0o600);

  // Check raw contents store targetRef for controller reconciliation across restarts
  const raw = await readFile(filePath, 'utf8');
  assert.ok(raw.includes('ephemeral-target-123'), 'targetRef must be written to disk for reconciliation');

  // Load via new store instance
  const reopened = new BrowserTabStore(filePath);
  const restored = await reopened.load();

  assert.equal(restored.length, 2);
  const r1 = restored.find((t) => t.id === tab1.id)!;
  const r2 = restored.find((t) => t.id === tab2.id)!;

  assert.equal(r1.id, tab1.id);
  assert.equal(r1.workspaceId, ws1);
  assert.equal(r1.selected, true);
  assert.equal(r1.targetRef, 'ephemeral-target-123', 'Conservative restore retains targetRef for verification');
  assert.equal(r1.runtimeState, 'detached', 'Conservative restore initializes runtimeState as detached');

  assert.equal(r2.selected, false);
  assert.equal(r2.targetRef, 'ephemeral-target-123');
  assert.equal(r2.runtimeState, 'detached');
});

test('persistence: generates backup (.bak) on repeated save', async (t) => {
  const { store, filePath } = await createFixture(t);
  const ws1 = 'a0000000-0000-4000-8000-000000000001' as WorkspaceId;
  const tab1 = makeTab('b0000000-0000-4000-8000-000000000001', ws1, 0, true);

  await store.save([tab1]);

  // .bak does not exist on very first write since original was absent
  const tab2 = makeTab('b0000000-0000-4000-8000-000000000002', ws1, 1, false);
  await store.save([tab1, tab2]);

  // Now .bak must exist and contain the state before tab2
  const bak = await readFile(filePath + '.bak', 'utf8');
  assert.ok(bak.includes(tab1.id));
  assert.ok(!bak.includes(tab2.id));
});

test('persistence: recovers from backup and quarantines corrupt primary', async (t) => {
  const { dir, store, filePath } = await createFixture(t);
  const ws1 = 'a0000000-0000-4000-8000-000000000001' as WorkspaceId;
  const tab1 = makeTab('b0000000-0000-4000-8000-000000000001', ws1, 0, true);
  await store.save([tab1]);

  const tab2 = makeTab('b0000000-0000-4000-8000-000000000002', ws1, 1, false);
  await store.save([tab1, tab2]);

  // Corrupt primary file with garbage bytes
  await writeFile(filePath, '<<<TRUNCATED / INVALID JSON>>>');

  // Load from fresh store
  const recoveryStore = new BrowserTabStore(filePath);
  const recovered = await recoveryStore.load();

  // Must have recovered snapshot from .bak (which had tab1)
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.id, tab1.id);

  // Quarantine file must exist in directory
  const files = await readdir(dir);
  const corruptFile = files.find((f) => f.includes('.corrupt-'));
  assert.ok(corruptFile, 'Corrupted file must be quarantined');
  const corruptContent = await readFile(path.join(dir, corruptFile), 'utf8');
  assert.equal(corruptContent, '<<<TRUNCATED / INVALID JSON>>>');
});

test('persistence: fails closed when primary is corrupt and backup is missing', async (t) => {
  const { filePath } = await createFixture(t);
  await writeFile(filePath, 'CORRUPTED');

  const recoveryStore = new BrowserTabStore(filePath);
  await assert.rejects(recoveryStore.load(), (err: unknown) => {
    return err instanceof AggregateError && err.message.includes('Browser tab store corrupted');
  });
});

test('persistence: rejects duplicate tab IDs and invalid versions', () => {
  const ws1 = 'a0000000-0000-4000-8000-000000000001';
  const duplicateTabs = JSON.stringify({
    version: 1,
    tabs: [
      makeTab('b0000000-0000-4000-8000-000000000001', ws1, 0, true),
      makeTab('b0000000-0000-4000-8000-000000000001', ws1, 1, false),
    ],
  });

  assert.throws(() => parseBrowserTabSnapshot(duplicateTabs), {
    name: 'BrowserTabStoreError',
    message: /Duplicate tab ID/,
  });

  const badVersion = JSON.stringify({
    version: 99,
    tabs: [],
  });

  assert.throws(() => parseBrowserTabSnapshot(badVersion), {
    name: 'BrowserTabStoreError',
    message: /Unsupported browser tab store version/,
  });
});

test('persistence: migrates v1 snapshots to v2 without changing tab identity or order', async t => {
  const { store, filePath } = await createFixture(t);
  const ws = 'a0000000-0000-4000-8000-000000000001';
  const tab = makeTab('b0000000-0000-4000-8000-000000000001', ws, 3, true);
  await writeFile(filePath, JSON.stringify({ version: 1, tabs: [tab] }));
  const restored = await store.load();
  assert.equal(restored[0]?.id, tab.id);
  assert.equal(restored[0]?.order, 3);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 2);
});

test('persistence: normalizes multiple selections to lowest order', () => {
  const ws1 = 'a0000000-0000-4000-8000-000000000001';
  const t1 = makeTab('b0000000-0000-4000-8000-000000000001', ws1, 2, true);
  const t2 = makeTab('b0000000-0000-4000-8000-000000000002', ws1, 0, true);
  const t3 = makeTab('b0000000-0000-4000-8000-000000000003', ws1, 1, true);

  const normalized = normalizeWorkspaceSelections([t1, t2, t3]);
  const s1 = normalized.find((t) => t.id === t1.id)!;
  const s2 = normalized.find((t) => t.id === t2.id)!;
  const s3 = normalized.find((t) => t.id === t3.id)!;

  assert.equal(s2.selected, true, 't2 has order 0, so it remains selected');
  assert.equal(s1.selected, false);
  assert.equal(s3.selected, false);
});

test('persistence: future schema refuses fallback without quarantining or overwriting either file', async t => {
  const { store, filePath, dir } = await createFixture(t);
  const future = JSON.stringify({ version: 999, tabs: [], futureData: 'must retain' });
  const backup = JSON.stringify({ version: 1, tabs: [] });
  await writeFile(filePath, future);
  await writeFile(filePath + '.bak', backup);
  await assert.rejects(store.load(), /Unsupported browser tab store version/);
  assert.equal(store.isLoaded, false);
  assert.equal(await readFile(filePath, 'utf8'), future);
  assert.equal(await readFile(filePath + '.bak', 'utf8'), backup);
  assert.equal((await readdir(dir)).some(name => name.includes('.corrupt-')), false);
});

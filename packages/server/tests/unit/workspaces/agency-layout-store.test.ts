import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgencyLayoutStore } from '../../../src/features/workspaces/layout-store.js';
import { writeAtomically } from '../../../src/shared/persistence/atomic-write.js';
import { createDefaultLayout, splitPane, type WorkspaceId } from '@agent-workbench/shared';

test('AgencyLayoutStore: saves, loads, survives restart, recovers from backup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agency-layouts-test-'));
  const file = path.join(dir, 'agency-layouts.json');

  try {
    const store = new AgencyLayoutStore(file);
    await store.initialize();
    assert.equal(store.list().length, 0);

    const ws1 = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
    const layout1 = createDefaultLayout(ws1, ['tab-1', 'tab-2']);
    layout1.tree = splitPane(layout1.tree, 'pane-1', 'row', 'pane-2', 'tab-2')!;

    await store.save(layout1);
    assert.equal(store.get(ws1)?.workspaceId, ws1);
    assert.equal(store.list().length, 1);

    // Second save ensures .bak exists
    await store.save({ ...layout1, updatedAt: new Date().toISOString() });

    // Reopen store from disk (simulating restart)
    const store2 = new AgencyLayoutStore(file);
    await store2.initialize();
    const loaded = store2.get(ws1);
    assert.ok(loaded);
    assert.equal(loaded.workspaceId, ws1);
    assert.equal(loaded.tree.type, 'split');

    // Corrupt primary file, verify backup recovery
    await writeFile(file, 'corrupt json{{{');
    const store3 = new AgencyLayoutStore(file);
    await store3.initialize();
    assert.equal(store3.get(ws1)?.workspaceId, ws1, 'Must recover layout from .bak');

    // Delete workspace
    await store3.delete(ws1);
    assert.equal(store3.get(ws1), undefined);

    const store4 = new AgencyLayoutStore(file);
    await store4.initialize();
    assert.equal(store4.get(ws1), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AgencyLayoutStore: one disk failure is not authoritative and a later save persists', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agency-layouts-fail-'));
  const file = path.join(dir, 'agency-layouts.json');
  let failNext = false;
  const store = new AgencyLayoutStore(file, async (target, content, options) => {
    if (failNext) {
      failNext = false;
      throw new Error('injected disk write failure');
    }
    await writeAtomically(target, content, options);
  });

  try {
    const wsA = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
    const wsB = '22222222-2222-4222-8222-222222222222' as WorkspaceId;
    const layoutA = createDefaultLayout(wsA, ['tab-a']);
    layoutA.updatedAt = '2026-01-01T00:00:00.000Z';
    const layoutB = createDefaultLayout(wsB, ['tab-b']);
    layoutB.updatedAt = '2026-01-02T00:00:00.000Z';
    const failed = { ...layoutA, updatedAt: '2026-03-03T00:00:00.000Z' };
    const retried = { ...layoutA, updatedAt: '2026-04-04T00:00:00.000Z' };

    await store.initialize();
    await store.save(layoutA);
    await store.save(layoutB);

    failNext = true;
    await assert.rejects(store.save(failed), /injected disk write failure/);
    assert.equal(store.get(wsA)?.updatedAt, layoutA.updatedAt);
    assert.equal(store.get(wsB)?.updatedAt, layoutB.updatedAt);

    const reread = new AgencyLayoutStore(file);
    await reread.initialize();
    assert.equal(reread.get(wsA)?.updatedAt, layoutA.updatedAt);
    assert.equal(reread.get(wsB)?.updatedAt, layoutB.updatedAt);
    assert.equal(reread.list().some((layout) => layout.updatedAt === failed.updatedAt), false);

    await store.save(retried);
    assert.equal(store.get(wsA)?.updatedAt, retried.updatedAt);
    assert.equal(store.get(wsB)?.updatedAt, layoutB.updatedAt);

    const persisted = new AgencyLayoutStore(file);
    await persisted.initialize();
    assert.equal(persisted.get(wsA)?.updatedAt, retried.updatedAt);
    assert.equal(persisted.get(wsB)?.updatedAt, layoutB.updatedAt);
    assert.equal(persisted.get(wsB)?.workspaceId, wsB);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

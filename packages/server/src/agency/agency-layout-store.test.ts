import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgencyLayoutStore } from './agency-layout-store.js';
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

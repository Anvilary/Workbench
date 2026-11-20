import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLayout, type WorkspaceId } from '@agent-workbench/shared';
import { evaluateLayoutSave } from '../../../src/transport/websocket/socket-server.js';

const ws = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
const other = '22222222-2222-4222-8222-222222222222' as WorkspaceId;

test('layout save keeps the requested workspace and existing tab ids', () => {
  const openTabIds = ['tab-session-a', 'tab-session-b'];
  const layout = createDefaultLayout(ws, openTabIds, 'tab-session-a');
  const decision = evaluateLayoutSave(ws, layout, openTabIds);
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.layout, layout);
  assert.equal(decision.layout.workspaceId, ws);
  assert.deepEqual(
    decision.layout.tree.type === 'pane' ? decision.layout.tree.tabIds : [],
    openTabIds,
  );
});

test('layout save rejects a payload aimed at a different workspace or its sessions', () => {
  const ownTabs = ['tab-session-a'];
  const foreign = createDefaultLayout(other, ['tab-session-foreign'], 'tab-session-foreign');
  const mismatched = evaluateLayoutSave(ws, foreign, ownTabs);
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) {
    assert.match(mismatched.message, /workspace/i);
  }

  const stolen = createDefaultLayout(ws, ['tab-session-foreign']);
  const foreignTabs = evaluateLayoutSave(ws, stolen, ownTabs);
  assert.equal(foreignTabs.ok, false);
  if (!foreignTabs.ok) {
    assert.match(foreignTabs.message, /does not belong/);
  }

  const duplicate = createDefaultLayout(ws, ['tab-session-a', 'tab-session-a']);
  const duplicated = evaluateLayoutSave(ws, duplicate, ['tab-session-a']);
  assert.equal(duplicated.ok, false);
  if (!duplicated.ok) assert.match(duplicated.message, /Duplicate/);
});

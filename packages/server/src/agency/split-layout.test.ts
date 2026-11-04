import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countLeaves,
  getPaneNodes,
  findPaneNode,
  splitPane,
  closePane,
  moveTabBetweenPanes,
  reconcileLayout,
  createDefaultLayout,
  isWorkspacePaneLayout,
  layoutOwnershipError,
  updateSplitRatio,
  type WorkspaceId,
  type WorkspacePaneLayout,
} from '@agent-workbench/shared';

test('split layout: default single pane', () => {
  const wsId = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
  const layout = createDefaultLayout(wsId, ['tab-1', 'tab-2'], 'tab-1');
  assert.equal(isWorkspacePaneLayout(layout), true);
  assert.equal(countLeaves(layout.tree), 1);
  const panes = getPaneNodes(layout.tree);
  assert.equal(panes.length, 1);
  assert.equal(panes[0]!.id, 'pane-1');
  assert.deepEqual(panes[0]!.tabIds, ['tab-1', 'tab-2']);
  assert.equal(panes[0]!.selectedTabId, 'tab-1');
});

test('split layout: split right up to 4 panes maximum', () => {
  const wsId = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
  let layout = createDefaultLayout(wsId, ['t1', 't2', 't3', 't4']);

  // Split 1 -> 2 (side-by-side)
  const tree2 = splitPane(layout.tree, 'pane-1', 'row', 'pane-2', 't2');
  assert.ok(tree2);
  assert.equal(countLeaves(tree2), 2);
  const panes2 = getPaneNodes(tree2);
  assert.equal(panes2.length, 2);
  assert.deepEqual(findPaneNode(tree2, 'pane-2')?.tabIds, ['t2']);

  // Split 2 -> 3 (asymmetric: pane-2 split down)
  const tree3 = splitPane(tree2, 'pane-2', 'column', 'pane-3');
  assert.ok(tree3);
  assert.equal(countLeaves(tree3), 3);

  // Split 3 -> 4 (pane-1 split down -> 2x2 grid)
  const tree4 = splitPane(tree3, 'pane-1', 'column', 'pane-4');
  assert.ok(tree4);
  assert.equal(countLeaves(tree4), 4);

  // Attempting 5th pane must be rejected (max 4 leaves invariant)
  const tree5 = splitPane(tree4, 'pane-4', 'row', 'pane-5');
  assert.equal(tree5, null, 'Splitting beyond 4 panes must be rejected');
});

test('split layout: close pane merges tabs safely to remaining pane', () => {
  const wsId = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
  const layout = createDefaultLayout(wsId, ['t1', 't2']);
  const tree2 = splitPane(layout.tree, 'pane-1', 'row', 'pane-2', 't2')!;
  assert.equal(countLeaves(tree2), 2);

  const res = closePane(tree2, 'pane-2');
  assert.ok(res);
  assert.equal(countLeaves(res.tree), 1);
  const remaining = findPaneNode(res.tree, 'pane-1');
  assert.ok(remaining);
  // t2 was returned to pane-1
  assert.ok(remaining.tabIds.includes('t1'));
  assert.ok(remaining.tabIds.includes('t2'));
});

test('split layout: move tab between panes', () => {
  const wsId = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
  const layout = createDefaultLayout(wsId, ['t1', 't2', 't3']);
  const tree2 = splitPane(layout.tree, 'pane-1', 'row', 'pane-2')!;

  const movedTree = moveTabBetweenPanes(tree2, 't1', 'pane-2');
  const p1 = findPaneNode(movedTree, 'pane-1')!;
  const p2 = findPaneNode(movedTree, 'pane-2')!;
  assert.ok(!p1.tabIds.includes('t1'));
  assert.ok(p2.tabIds.includes('t1'));
  assert.equal(p2.selectedTabId, 't1');
});

test('split layout: update ratio clamps between 0.1 and 0.9', () => {
  const wsId = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
  const layout = createDefaultLayout(wsId, ['t1', 't2']);
  const tree2 = splitPane(layout.tree, 'pane-1', 'row', 'pane-2')!;
  assert.equal(tree2.type, 'split');

  const splitId = (tree2 as { id: string }).id;
  const updatedMin = updateSplitRatio(tree2, splitId, 0.01);
  assert.equal((updatedMin as { ratio: number }).ratio, 0.1);

  const updatedMax = updateSplitRatio(tree2, splitId, 0.99);
  assert.equal((updatedMax as { ratio: number }).ratio, 0.9);

  const updatedValid = updateSplitRatio(tree2, splitId, 0.65);
  assert.equal((updatedValid as { ratio: number }).ratio, 0.65);
});

test('split layout: ownership rejects mismatched workspace, foreign tabs and duplicates', () => {
  const ws = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
  const other = '22222222-2222-4222-8222-222222222222' as WorkspaceId;
  const owned = createDefaultLayout(ws, ['tab-1', 'tab-2'], 'tab-1');
  assert.equal(layoutOwnershipError(owned, ws, ['tab-1', 'tab-2']), null);

  const mismatched = createDefaultLayout(other, ['tab-1'], 'tab-1');
  assert.equal(
    layoutOwnershipError(mismatched, ws, ['tab-1']),
    'Layout workspace does not match the requested workspace',
  );

  const foreign = createDefaultLayout(ws, ['tab-from-other-workspace']);
  assert.equal(
    layoutOwnershipError(foreign, ws, ['tab-1']),
    'Layout tab does not belong to the requested workspace',
  );

  const duplicatedTabs: WorkspacePaneLayout = {
    ...owned,
    tree: {
      type: 'split',
      id: 'split-1',
      direction: 'row',
      ratio: 0.5,
      first: { type: 'pane', id: 'pane-1', tabIds: ['tab-1'], selectedTabId: 'tab-1' },
      second: { type: 'pane', id: 'pane-2', tabIds: ['tab-1'], selectedTabId: 'tab-1' },
    },
  };
  assert.equal(layoutOwnershipError(duplicatedTabs, ws, ['tab-1', 'tab-2']), 'Duplicate tab assignment');

  const duplicatedPanes: WorkspacePaneLayout = {
    ...owned,
    tree: {
      type: 'split',
      id: 'split-1',
      direction: 'row',
      ratio: 0.5,
      first: { type: 'pane', id: 'pane-1', tabIds: ['tab-1'], selectedTabId: 'tab-1' },
      second: { type: 'pane', id: 'pane-1', tabIds: ['tab-2'], selectedTabId: 'tab-2' },
    },
  };
  assert.equal(layoutOwnershipError(duplicatedPanes, ws, ['tab-1', 'tab-2']), 'Duplicate pane id');

  const repeatedInPane = createDefaultLayout(ws, ['tab-1', 'tab-1']);
  assert.equal(layoutOwnershipError(repeatedInPane, ws, ['tab-1']), 'Duplicate tab assignment');
});

test('split layout: reconcile handles deleted tabs, missing tabs, and malformed layouts', () => {
  const wsId = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
  const layout = createDefaultLayout(wsId, ['t1', 't2', 't3']);
  const tree2 = splitPane(layout.tree, 'pane-1', 'row', 'pane-2', 't2')!;

  // Tab t2 is deleted on server, and new tab t4 was created
  const reconciled = reconcileLayout(
    { ...layout, tree: tree2 },
    wsId,
    ['t1', 't3', 't4'],
  );

  const p1 = findPaneNode(reconciled.tree, 'pane-1')!;
  const p2 = findPaneNode(reconciled.tree, 'pane-2')!;

  // t2 is removed from pane-2
  assert.ok(!p2.tabIds.includes('t2'));
  // t4 was added to focused pane
  assert.ok(p1.tabIds.includes('t4') || p2.tabIds.includes('t4'));

  // Corrupted / malformed layout fallback
  const fallback = reconcileLayout(null, wsId, ['t1']);
  assert.equal(fallback.workspaceId, wsId);
  assert.equal(countLeaves(fallback.tree), 1);
  assert.deepEqual(getPaneNodes(fallback.tree)[0]!.tabIds, ['t1']);
});

test('pane swaps exchange leaf references without changing splits for every supported shape', async () => {
  const { swapPanes } = await import('@agent-workbench/shared');
  const pane = (id: string) => ({ type: 'pane' as const, id, tabIds: [id + '-tab'], selectedTabId: id + '-tab' });
  const split = (first: import('@agent-workbench/shared').LayoutNode, second: import('@agent-workbench/shared').LayoutNode, direction: 'row' | 'column' = 'row') =>
    ({ type: 'split' as const, id: `${first.id}-${second.id}`, first, second, direction, ratio: .37 });
  const a = pane('a'), b = pane('b'), c = pane('c'), d = pane('d');
  const shapes = [split(a, b), split(a, b, 'column'), split(a, split(b, c, 'column')), split(split(a, b, 'column'), split(c, d, 'column')), split(a, split(b, split(c, d, 'column')))];
  const skeleton = (node: import('@agent-workbench/shared').LayoutNode): unknown => node.type === 'pane' ? 'leaf' : ({ id: node.id, ratio: node.ratio, direction: node.direction, first: skeleton(node.first), second: skeleton(node.second) });
  for (const tree of shapes) {
    const before = structuredClone(tree);
    for (const source of getPaneNodes(tree)) for (const target of getPaneNodes(tree)) {
      const swapped = swapPanes(tree, source.id, target.id);
      if (source === target) { assert.equal(swapped, null); continue; }
      assert.ok(swapped);
      const original = getPaneNodes(tree), next = getPaneNodes(swapped);
      assert.equal(next[original.indexOf(source)], target);
      assert.equal(next[original.indexOf(target)], source);
      assert.deepEqual(skeleton(swapped), skeleton(tree));
      assert.deepEqual(swapPanes(swapped, source.id, target.id), tree);
      assert.equal(countLeaves(swapped), countLeaves(tree));
    }
    assert.equal(swapPanes(tree, 'a', 'foreign-pane'), null);
    assert.equal(swapPanes(tree, 'missing', 'b'), null);
    assert.deepEqual(tree, before, 'input stays immutable');
  }
});

test('created tabs retain their destination or use a live fallback without duplicate assignments', async () => {
  const { assignCreatedTab } = await import('@agent-workbench/shared');
  const ws = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
  const initial = createDefaultLayout(ws, ['existing', 'neighbor']);
  const tree = splitPane(initial.tree, 'pane-1', 'row', 'pane-2', 'neighbor')!;
  const current = { ...initial, tree, focusedPaneId: 'pane-1' };
  const created = assignCreatedTab(current, 'pane-2', 'new');
  assert.equal(created.focusedPaneId, 'pane-2');
  assert.deepEqual(findPaneNode(created.tree, 'pane-1'), findPaneNode(current.tree, 'pane-1'));
  assert.deepEqual(findPaneNode(created.tree, 'pane-2')?.tabIds, ['neighbor', 'new']);
  const repeated = assignCreatedTab(created, 'pane-2', 'new');
  assert.deepEqual(getPaneNodes(repeated.tree).flatMap(p => p.tabIds).sort(), ['existing', 'neighbor', 'new'].sort());
  const closed = closePane(created.tree, 'pane-2')!;
  const fallback = assignCreatedTab({ ...created, tree: closed.tree }, 'pane-2', 'late');
  assert.equal(fallback.focusedPaneId, 'pane-1');
  assert.equal(findPaneNode(fallback.tree, 'pane-1')?.selectedTabId, 'late');
  assert.equal(layoutOwnershipError(fallback, ws, ['existing', 'neighbor', 'new', 'late']), null);
});

test('split layout: layout ownership validates mixed native, browser, and editor tabs', () => {
  const ws = '11111111-1111-4111-8111-111111111111' as WorkspaceId;
  const terminalTabId = 'term-tab-1';
  const chatGptTabId = 'chatgpt-tab-2';
  const editorTabId = 'editor-tab-3';

  const mixedLayout: WorkspacePaneLayout = {
    version: 1,
    workspaceId: ws,
    focusedPaneId: 'pane-1',
    maximizedPaneId: null,
    updatedAt: new Date().toISOString(),
    tree: {
      type: 'split',
      id: 'split-1',
      direction: 'row',
      ratio: 0.5,
      first: {
        type: 'pane',
        id: 'pane-1',
        tabIds: [terminalTabId, chatGptTabId],
        selectedTabId: terminalTabId,
      },
      second: {
        type: 'pane',
        id: 'pane-2',
        tabIds: [editorTabId],
        selectedTabId: editorTabId,
      },
    },
  };

  // When all open tabs (native, browser, editor) are present, validation succeeds
  const allOpenTabs = [terminalTabId, chatGptTabId, editorTabId];
  assert.equal(layoutOwnershipError(mixedLayout, ws, allOpenTabs), null);

  // If editorTabId was omitted (the defect in terminal-socket.ts:3780), validation fails
  const omittedEditorTabs = [terminalTabId, chatGptTabId];
  assert.equal(
    layoutOwnershipError(mixedLayout, ws, omittedEditorTabs),
    'Layout tab does not belong to the requested workspace',
  );
});

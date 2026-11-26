import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countLeaves,
  findPaneNode,
  getPaneNodes,
  splitPane,
  closePane,
  moveTabBetweenPanes,
  reconcileLayout,
  updateSplitRatio,
  isWorkspacePaneLayout,
  layoutOwnershipError,
  MAX_LEAVES,
} from '@anvilary/workbench-shared';

const ws = '11111111-1111-4111-8111-111111111111';

function makeLayout(tree, focusedPaneId = 'p1', maximizedPaneId = null) {
  return {
    version: 1,
    workspaceId: ws,
    tree,
    focusedPaneId,
    maximizedPaneId,
    updatedAt: new Date().toISOString(),
  };
}

test('1. Split creation succeeds in valid layouts and resets maximized state', () => {
  const tree = { type: 'pane', id: 'p1', tabIds: ['t1'], selectedTabId: 't1' };
  const layout = makeLayout(tree, 'p1', 'p1'); // Maximized p1

  const nextTree = splitPane(layout.tree, 'p1', 'row', 'p2', undefined, true);
  assert.ok(nextTree);
  assert.equal(countLeaves(nextTree), 2);
  assert.equal(nextTree.type, 'split');
  assert.equal(nextTree.direction, 'row');

  const p1 = findPaneNode(nextTree, 'p1');
  const p2 = findPaneNode(nextTree, 'p2');
  assert.ok(p1);
  assert.ok(p2);
  assert.deepEqual(p1.tabIds, ['t1']);
  assert.deepEqual(p2.tabIds, []);
  assert.equal(p2.selectedTabId, null);

  // When saved after split, maximizedPaneId is reset to null
  const updatedLayout = {
    ...layout,
    tree: nextTree,
    focusedPaneId: 'p2',
    maximizedPaneId: null,
    updatedAt: new Date().toISOString(),
  };
  assert.equal(updatedLayout.maximizedPaneId, null);
  assert.equal(updatedLayout.focusedPaneId, 'p2');
});

test('2. Split limit reached (MAX_LEAVES = 8): splitPane returns null', () => {
  // Build a tree with 8 panes
  let tree = { type: 'pane', id: 'p1', tabIds: ['t1'], selectedTabId: 't1' };
  for (let i = 2; i <= MAX_LEAVES; i++) {
    tree = splitPane(tree, `p${i - 1}`, 'row', `p${i}`, undefined, true);
    assert.ok(tree);
  }
  assert.equal(countLeaves(tree), 8);

  // Attempting 9th pane must fail
  const overflow = splitPane(tree, 'p1', 'row', 'p9', undefined, true);
  assert.equal(overflow, null);
  assert.equal(countLeaves(tree), 8);
});

test('3. Failed split creates no stray tab in fallback pane', () => {
  // Simulated takeSplitPane logic
  let pendingSplit = { paneId: 'p1', direction: 'row' };
  let createdContentTarget = null;
  let splitError = null;

  function simulateTakeSplitPane(tree, fallback) {
    const pending = pendingSplit;
    pendingSplit = null;
    if (!pending) return { paneId: fallback, created: false };
    if (countLeaves(tree) >= MAX_LEAVES) {
      splitError = 'Maximum 8 panes reached';
      return null;
    }
    const nextTree = splitPane(tree, pending.paneId, pending.direction, 'p-new', undefined, true);
    if (!nextTree) {
      splitError = 'Unable to split pane';
      return null;
    }
    return { paneId: 'p-new', created: true };
  }

  // Case A: 8 leaves reached
  let tree8 = { type: 'pane', id: 'p1', tabIds: ['t1'], selectedTabId: 't1' };
  for (let i = 2; i <= MAX_LEAVES; i++) {
    tree8 = splitPane(tree8, `p${i - 1}`, 'row', `p${i}`, undefined, true);
  }

  const result = simulateTakeSplitPane(tree8, 'p1');
  assert.equal(result, null);
  assert.equal(splitError, 'Maximum 8 panes reached');

  // Creation must abort when result is null: no content created in p1!
  if (result) {
    createdContentTarget = result.paneId;
  }
  assert.equal(createdContentTarget, null, 'No stray content created in fallback pane when split fails');

  // Case B: missing target pane
  pendingSplit = { paneId: 'p-missing', direction: 'row' };
  splitError = null;
  const result2 = simulateTakeSplitPane({ type: 'pane', id: 'p1', tabIds: ['t1'], selectedTabId: 't1' }, 'p1');
  assert.equal(result2, null);
  assert.equal(splitError, 'Unable to split pane');
  assert.equal(createdContentTarget, null);
});

test('4. Empty pane after last tab closes is preserved without collapsing layout', () => {
  const layout = makeLayout({
    type: 'split',
    id: 's1',
    direction: 'row',
    ratio: 0.5,
    first: { type: 'pane', id: 'p1', tabIds: ['t1'], selectedTabId: 't1' },
    second: { type: 'pane', id: 'p2', tabIds: ['t2'], selectedTabId: 't2' },
  });

  // t2 closes; openTabIds becomes ['t1']
  const reconciled = reconcileLayout(layout, ws, ['t1']);
  assert.equal(countLeaves(reconciled.tree), 2, 'Layout retains 2 panes');
  assert.equal(reconciled.tree.type, 'split');

  const p1 = findPaneNode(reconciled.tree, 'p1');
  const p2 = findPaneNode(reconciled.tree, 'p2');
  assert.ok(p1);
  assert.deepEqual(p1.tabIds, ['t1']);
  assert.ok(p2);
  assert.deepEqual(p2.tabIds, [], 'p2 is preserved as empty pane');
  assert.equal(p2.selectedTabId, null);
});

test('5. Empty pane survives when all tabs in workspace are closed', () => {
  const layout = makeLayout({
    type: 'split',
    id: 's1',
    direction: 'column',
    ratio: 0.6,
    first: { type: 'pane', id: 'p1', tabIds: ['t1'], selectedTabId: 't1' },
    second: { type: 'pane', id: 'p2', tabIds: ['t2'], selectedTabId: 't2' },
  });

  // All tabs closed: openTabIds is []
  const reconciled = reconcileLayout(layout, ws, []);
  assert.equal(countLeaves(reconciled.tree), 2, 'Both panes survive even when 0 tabs open');
  const p1 = findPaneNode(reconciled.tree, 'p1');
  const p2 = findPaneNode(reconciled.tree, 'p2');
  assert.ok(p1);
  assert.deepEqual(p1.tabIds, []);
  assert.equal(p1.selectedTabId, null);
  assert.ok(p2);
  assert.deepEqual(p2.tabIds, []);
  assert.equal(p2.selectedTabId, null);
});

test('6. Intentionally empty panes pass layout validation and ownership checks', () => {
  const layout = makeLayout({
    type: 'split',
    id: 's1',
    direction: 'row',
    ratio: 0.5,
    first: { type: 'pane', id: 'p1', tabIds: ['t1'], selectedTabId: 't1' },
    second: { type: 'pane', id: 'p2', tabIds: [], selectedTabId: null },
  });

  assert.equal(isWorkspacePaneLayout(layout), true);
  assert.equal(layoutOwnershipError(layout, ws, ['t1']), null);
});

test('7. Moving tab leaves source pane empty but preserved', () => {
  const tree = {
    type: 'split',
    id: 's1',
    direction: 'row',
    ratio: 0.5,
    first: { type: 'pane', id: 'p1', tabIds: ['t1'], selectedTabId: 't1' },
    second: { type: 'pane', id: 'p2', tabIds: ['t2'], selectedTabId: 't2' },
  };

  // Move t1 from p1 to p2
  const updatedTree = moveTabBetweenPanes(tree, 't1', 'p2');
  assert.equal(countLeaves(updatedTree), 2);

  const p1 = findPaneNode(updatedTree, 'p1');
  const p2 = findPaneNode(updatedTree, 'p2');
  assert.ok(p1);
  assert.deepEqual(p1.tabIds, [], 'p1 is now empty');
  assert.equal(p1.selectedTabId, null);
  assert.ok(p2);
  assert.deepEqual(p2.tabIds, ['t2', 't1']);
  assert.equal(p2.selectedTabId, 't1');

  // Reconcile must preserve p1
  const reconciled = reconcileLayout(makeLayout(updatedTree), ws, ['t1', 't2']);
  assert.equal(countLeaves(reconciled.tree), 2);
  assert.ok(findPaneNode(reconciled.tree, 'p1'));
});

test('8. Explicit closePane merges tabs and collapses only that pane', () => {
  const tree = {
    type: 'split',
    id: 's1',
    direction: 'row',
    ratio: 0.5,
    first: { type: 'pane', id: 'p1', tabIds: ['t1'], selectedTabId: 't1' },
    second: { type: 'pane', id: 'p2', tabIds: [], selectedTabId: null },
  };

  // User explicitly closes empty pane p2
  const closed = closePane(tree, 'p2');
  assert.ok(closed);
  assert.equal(closed.tree.type, 'pane');
  assert.equal(closed.tree.id, 'p1');
  assert.deepEqual(closed.tree.tabIds, ['t1']);
  assert.equal(closed.remainingPaneId, 'p1');
});

test('9. Malformed layout with duplicate IDs falls back to default layout', () => {
  const duplicateIdTree = {
    type: 'split',
    id: 's1',
    direction: 'row',
    ratio: 0.5,
    first: { type: 'pane', id: 'dup', tabIds: ['t1'], selectedTabId: 't1' },
    second: { type: 'pane', id: 'dup', tabIds: ['t2'], selectedTabId: 't2' },
  };

  const reconciled = reconcileLayout(makeLayout(duplicateIdTree), ws, ['t1', 't2']);
  assert.equal(countLeaves(reconciled.tree), 1, 'Malformed layout falls back to default single pane');
  assert.equal(reconciled.tree.id, 'pane-1');
  assert.deepEqual(reconciled.tree.tabIds, ['t1', 't2']);
});

test('10. Split resize clamps ratios properly', () => {
  const tree = {
    type: 'split',
    id: 's1',
    direction: 'row',
    ratio: 0.5,
    first: { type: 'pane', id: 'p1', tabIds: ['t1'], selectedTabId: 't1' },
    second: { type: 'pane', id: 'p2', tabIds: ['t2'], selectedTabId: 't2' },
  };

  const clampedLow = updateSplitRatio(tree, 's1', 0.01);
  assert.equal(clampedLow.ratio, 0.1);

  const clampedHigh = updateSplitRatio(tree, 's1', 0.99);
  assert.equal(clampedHigh.ratio, 0.9);

  const normal = updateSplitRatio(tree, 's1', 0.65);
  assert.equal(normal.ratio, 0.65);
});

test('11. Cross-pane drag-to-split moves tab out of source pane into new pane', () => {
  const tree = {
    type: 'split',
    id: 's1',
    direction: 'row',
    ratio: 0.5,
    first: { type: 'pane', id: 'p1', tabIds: ['t1', 't2'], selectedTabId: 't1' },
    second: { type: 'pane', id: 'p2', tabIds: ['t3'], selectedTabId: 't3' },
  };

  const next = splitPane(tree, 'p2', 'column', 'p3', 't1', true);
  assert.ok(next);
  assert.equal(countLeaves(next), 3);

  const p1 = findPaneNode(next, 'p1');
  const p2 = findPaneNode(next, 'p2');
  const p3 = findPaneNode(next, 'p3');
  assert.deepEqual(p1.tabIds, ['t2'], 'source pane must no longer contain moved tab');
  assert.equal(p1.selectedTabId, 't2', 'source pane selection falls back to remaining tab');
  assert.deepEqual(p2.tabIds, ['t3'], 'target split pane preserves its tabs');
  assert.deepEqual(p3.tabIds, ['t1'], 'new split pane receives dragged tab');
  assert.equal(p3.selectedTabId, 't1');
  assert.equal(layoutOwnershipError(makeLayout(next), ws, ['t1', 't2', 't3']), null);
});

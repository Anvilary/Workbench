import type { WorkspaceId, IsoTimestamp } from './agency-protocol.js';

export type SplitDirection = 'row' | 'column';

export interface LayoutPaneNode {
  type: 'pane';
  id: string;
  tabIds: string[];
  selectedTabId: string | null;
}

export interface LayoutSplitNode {
  type: 'split';
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = LayoutPaneNode | LayoutSplitNode;

export interface WorkspacePaneLayout {
  version: 1;
  workspaceId: WorkspaceId;
  tree: LayoutNode;
  focusedPaneId: string;
  maximizedPaneId?: string | null;
  updatedAt: IsoTimestamp;
}

export type LayoutClientMessage =
  | { type: 'agency.layout.save'; requestId: string; workspaceId: WorkspaceId; layout: WorkspacePaneLayout }
  | { type: 'agency.layout.get'; requestId: string; workspaceId: WorkspaceId };

export type LayoutServerMessage =
  | { type: 'agency.layout.saved'; requestId: string; workspaceId: WorkspaceId }
  | { type: 'agency.layouts.snapshot'; requestId: string; layouts: readonly WorkspacePaneLayout[] }
  | { type: 'agency.layout.changed'; workspaceId: WorkspaceId; layout: WorkspacePaneLayout };

export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;
export const MAX_LEAVES = 4;

export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, Math.round(value * 1000) / 1000));
}

export function countLeaves(node: LayoutNode): number {
  if (node.type === 'pane') return 1;
  return countLeaves(node.first) + countLeaves(node.second);
}

export function getPaneNodes(node: LayoutNode): LayoutPaneNode[] {
  if (node.type === 'pane') return [node];
  return [...getPaneNodes(node.first), ...getPaneNodes(node.second)];
}

export function findPaneNode(node: LayoutNode, paneId: string): LayoutPaneNode | null {
  if (node.type === 'pane') {
    return node.id === paneId ? node : null;
  }
  return findPaneNode(node.first, paneId) ?? findPaneNode(node.second, paneId);
}

export function findParentSplit(node: LayoutNode, childId: string): LayoutSplitNode | null {
  if (node.type === 'pane') return null;
  if (node.first.id === childId || node.second.id === childId) return node;
  return findParentSplit(node.first, childId) ?? findParentSplit(node.second, childId);
}

export function updatePaneNode(
  node: LayoutNode,
  paneId: string,
  updater: (pane: LayoutPaneNode) => LayoutPaneNode,
): LayoutNode {
  if (node.type === 'pane') {
    return node.id === paneId ? updater(node) : node;
  }
  return {
    ...node,
    first: updatePaneNode(node.first, paneId, updater),
    second: updatePaneNode(node.second, paneId, updater),
  };
}

export function updateSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  const clamped = clampRatio(ratio);
  if (node.type === 'pane') return node;
  if (node.id === splitId) {
    return { ...node, ratio: clamped };
  }
  return {
    ...node,
    first: updateSplitRatio(node.first, splitId, ratio),
    second: updateSplitRatio(node.second, splitId, ratio),
  };
}

export function splitPane(
  tree: LayoutNode,
  targetPaneId: string,
  direction: SplitDirection,
  newPaneId: string,
  tabIdToMove?: string,
): LayoutNode | null {
  if (countLeaves(tree) >= MAX_LEAVES) return null;

  const targetPane = findPaneNode(tree, targetPaneId);
  if (!targetPane) return null;

  let remainingTabs = [...targetPane.tabIds];
  let newPaneTabs: string[] = [];

  if (tabIdToMove && remainingTabs.includes(tabIdToMove)) {
    remainingTabs = remainingTabs.filter((id) => id !== tabIdToMove);
    newPaneTabs = [tabIdToMove];
  } else if (remainingTabs.length > 1) {
    const half = Math.ceil(remainingTabs.length / 2);
    newPaneTabs = remainingTabs.slice(half);
    remainingTabs = remainingTabs.slice(0, half);
  }

  const newPane: LayoutPaneNode = {
    type: 'pane',
    id: newPaneId,
    tabIds: newPaneTabs,
    selectedTabId: newPaneTabs[0] ?? null,
  };

  const updatedTargetPane: LayoutPaneNode = {
    ...targetPane,
    tabIds: remainingTabs,
    selectedTabId: remainingTabs.includes(targetPane.selectedTabId ?? '')
      ? targetPane.selectedTabId
      : (remainingTabs[0] ?? null),
  };

  const newSplit: LayoutSplitNode = {
    type: 'split',
    id: `split-${targetPaneId}-${newPaneId}`,
    direction,
    ratio: 0.5,
    first: updatedTargetPane,
    second: newPane,
  };

  function replace(node: LayoutNode): LayoutNode {
    if (node.id === targetPaneId) return newSplit;
    if (node.type === 'pane') return node;
    return {
      ...node,
      first: replace(node.first),
      second: replace(node.second),
    };
  }

  return replace(tree);
}

export function closePane(
  tree: LayoutNode,
  paneIdToClose: string,
): { tree: LayoutNode; remainingPaneId: string; closedTabs: string[] } | null {
  if (tree.type === 'pane') return null; // Cannot close only pane

  const paneToClose = findPaneNode(tree, paneIdToClose);
  if (!paneToClose) return null;

  const closedTabs = [...paneToClose.tabIds];
  let remainingPaneId = '';

  function prune(node: LayoutNode): LayoutNode {
    if (node.type === 'pane') return node;

    if (node.first.id === paneIdToClose) {
      const siblingPanes = getPaneNodes(node.second);
      remainingPaneId = siblingPanes[0]?.id ?? '';
      return node.second;
    }
    if (node.second.id === paneIdToClose) {
      const siblingPanes = getPaneNodes(node.first);
      remainingPaneId = siblingPanes[siblingPanes.length - 1]?.id ?? '';
      return node.first;
    }

    return {
      ...node,
      first: prune(node.first),
      second: prune(node.second),
    };
  }

  let newTree = prune(tree);

  // Transfer closed tabs to remaining pane so no sessions are lost
  if (remainingPaneId && closedTabs.length > 0) {
    newTree = updatePaneNode(newTree, remainingPaneId, (pane) => {
      const combined = [...pane.tabIds];
      for (const t of closedTabs) {
        if (!combined.includes(t)) combined.push(t);
      }
      return {
        ...pane,
        tabIds: combined,
        selectedTabId: pane.selectedTabId ?? combined[0] ?? null,
      };
    });
  }

  return { tree: newTree, remainingPaneId, closedTabs };
}

export function moveTabBetweenPanes(
  tree: LayoutNode,
  tabId: string,
  targetPaneId: string,
  targetIndex?: number,
): LayoutNode {
  let updatedTree = tree;

  // Remove tab from source pane(s)
  const panes = getPaneNodes(tree);
  for (const pane of panes) {
    if (pane.tabIds.includes(tabId)) {
      updatedTree = updatePaneNode(updatedTree, pane.id, (p) => {
        const nextTabs = p.tabIds.filter((id) => id !== tabId);
        const nextSelected = p.selectedTabId === tabId ? (nextTabs[0] ?? null) : p.selectedTabId;
        return {
          ...p,
          tabIds: nextTabs,
          selectedTabId: nextSelected,
        };
      });
    }
  }

  // Insert tab into target pane
  updatedTree = updatePaneNode(updatedTree, targetPaneId, (p) => {
    const nextTabs = [...p.tabIds];
    if (targetIndex !== undefined && targetIndex >= 0 && targetIndex <= nextTabs.length) {
      nextTabs.splice(targetIndex, 0, tabId);
    } else {
      nextTabs.push(tabId);
    }
    return {
      ...p,
      tabIds: nextTabs,
      selectedTabId: tabId, // Select the moved tab in the target pane
    };
  });

  return updatedTree;
}

export function createDefaultLayout(
  workspaceId: WorkspaceId,
  openTabIds: readonly string[],
  selectedTabId?: string,
): WorkspacePaneLayout {
  const paneId = 'pane-1';
  const validSelected = selectedTabId && openTabIds.includes(selectedTabId) ? selectedTabId : (openTabIds[0] ?? null);
  return {
    version: 1,
    workspaceId,
    tree: {
      type: 'pane',
      id: paneId,
      tabIds: [...openTabIds],
      selectedTabId: validSelected,
    },
    focusedPaneId: paneId,
    maximizedPaneId: null,
    updatedAt: new Date().toISOString(),
  };
}

export function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  if (node.type === 'pane') {
    return (
      typeof node.id === 'string' &&
      node.id.length > 0 &&
      node.id.length <= 128 &&
      Array.isArray(node.tabIds) &&
      node.tabIds.every((id) => typeof id === 'string') &&
      (node.selectedTabId === null || typeof node.selectedTabId === 'string')
    );
  }
  if (node.type === 'split') {
    return (
      typeof node.id === 'string' &&
      node.id.length > 0 &&
      node.id.length <= 128 &&
      (node.direction === 'row' || node.direction === 'column') &&
      typeof node.ratio === 'number' &&
      Number.isFinite(node.ratio) &&
      isLayoutNode(node.first) &&
      isLayoutNode(node.second)
    );
  }
  return false;
}

/**
 * Why a layout must not be stored for `openTabIds`' workspace.
 * Returns null when the tree keeps this workspace's panes and existing tab ids.
 * Does not allocate session ids or rewrite the layout.
 */
export function layoutOwnershipError(
  layout: WorkspacePaneLayout,
  workspaceId: WorkspaceId,
  openTabIds: readonly string[],
): string | null {
  if (layout.workspaceId !== workspaceId) {
    return 'Layout workspace does not match the requested workspace';
  }
  const open = new Set(openTabIds);
  const seenNodeIds = new Set<string>();
  const seenTabs = new Set<string>();
  const paneIds = new Set<string>();

  const walk = (node: LayoutNode): string | null => {
    if (seenNodeIds.has(node.id)) return 'Duplicate pane id';
    seenNodeIds.add(node.id);
    if (node.type === 'split') {
      return walk(node.first) ?? walk(node.second);
    }
    paneIds.add(node.id);
    const local = new Set<string>();
    for (const tabId of node.tabIds) {
      if (local.has(tabId) || seenTabs.has(tabId)) return 'Duplicate tab assignment';
      if (!open.has(tabId)) return 'Layout tab does not belong to the requested workspace';
      local.add(tabId);
      seenTabs.add(tabId);
    }
    if (node.selectedTabId !== null && !local.has(node.selectedTabId)) {
      if (!open.has(node.selectedTabId)) return 'Layout tab does not belong to the requested workspace';
      return 'Selected tab is not assigned to its pane';
    }
    return null;
  };

  const treeError = walk(layout.tree);
  if (treeError) return treeError;
  if (!paneIds.has(layout.focusedPaneId)) return 'Focused pane is not part of this layout';
  if (layout.maximizedPaneId && !paneIds.has(layout.maximizedPaneId)) {
    return 'Maximized pane is not part of this layout';
  }
  return null;
}

export function isWorkspacePaneLayout(value: unknown): value is WorkspacePaneLayout {
  if (!value || typeof value !== 'object') return false;
  const layout = value as Record<string, unknown>;
  return (
    layout.version === 1 &&
    typeof layout.workspaceId === 'string' &&
    typeof layout.focusedPaneId === 'string' &&
    typeof layout.updatedAt === 'string' &&
    isLayoutNode(layout.tree) &&
    countLeaves(layout.tree as LayoutNode) <= MAX_LEAVES
  );
}

export function reconcileLayout(
  saved: WorkspacePaneLayout | null | undefined,
  workspaceId: WorkspaceId,
  openTabIds: readonly string[],
  defaultSelectedTabId?: string,
): WorkspacePaneLayout {
  if (!saved || !isWorkspacePaneLayout(saved) || saved.workspaceId !== workspaceId) {
    return createDefaultLayout(workspaceId, openTabIds, defaultSelectedTabId);
  }

  let tree = saved.tree;

  // If tree has more than MAX_LEAVES (corrupt/malformed), reset to default single pane
  if (countLeaves(tree) > MAX_LEAVES || countLeaves(tree) < 1) {
    return createDefaultLayout(workspaceId, openTabIds, defaultSelectedTabId);
  }

  const openSet = new Set(openTabIds);
  const assignedTabs = new Set<string>();

  // 1. Prune closed/stale tabs from each pane
  function cleanNode(node: LayoutNode): LayoutNode {
    if (node.type === 'pane') {
      const validTabs = node.tabIds.filter((id) => openSet.has(id));
      for (const t of validTabs) assignedTabs.add(t);
      const selected = validTabs.includes(node.selectedTabId ?? '')
        ? node.selectedTabId
        : (validTabs[0] ?? null);
      return {
        ...node,
        tabIds: validTabs,
        selectedTabId: selected,
      };
    }
    return {
      ...node,
      ratio: clampRatio(node.ratio),
      first: cleanNode(node.first),
      second: cleanNode(node.second),
    };
  }

  tree = cleanNode(tree);

  // 2. Determine target pane for unassigned tabs
  const panes = getPaneNodes(tree);
  let focusedPane = panes.find((p) => p.id === saved.focusedPaneId) ?? panes[0];
  if (!focusedPane) {
    return createDefaultLayout(workspaceId, openTabIds, defaultSelectedTabId);
  }

  // 3. Find any open tabs that are not assigned to any pane, and assign them
  const unassignedTabs = openTabIds.filter((id) => !assignedTabs.has(id));
  if (unassignedTabs.length > 0) {
    tree = updatePaneNode(tree, focusedPane.id, (p) => {
      const combined = [...p.tabIds, ...unassignedTabs];
      return {
        ...p,
        tabIds: combined,
        selectedTabId: p.selectedTabId ?? combined[0] ?? null,
      };
    });
  }

  // 4. Validate maximizedPaneId if set
  const maximizedPaneId = saved.maximizedPaneId && panes.some((p) => p.id === saved.maximizedPaneId)
    ? saved.maximizedPaneId
    : null;

  return {
    version: 1,
    workspaceId,
    tree,
    focusedPaneId: focusedPane.id,
    maximizedPaneId,
    updatedAt: saved.updatedAt,
  };
}

/** Exchange leaf positions, retaining the actual pane nodes and every split property. */
export function swapPanes(tree: LayoutNode, sourcePaneId: string, targetPaneId: string): LayoutNode | null {
  if (!sourcePaneId || sourcePaneId === targetPaneId || !isLayoutNode(tree) || countLeaves(tree) > MAX_LEAVES) return null;
  const panes = getPaneNodes(tree);
  const source = panes.find(pane => pane.id === sourcePaneId);
  const target = panes.find(pane => pane.id === targetPaneId);
  // Both IDs must be members of this tree; IDs from another workspace are never imported.
  if (!source || !target) return null;
  const nodeIds = new Set<string>(), tabIds = new Set<string>();
  const valid = (node: LayoutNode): boolean => {
    if (nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);
    if (node.type === 'split') {
      return node.ratio >= MIN_SPLIT_RATIO && node.ratio <= MAX_SPLIT_RATIO && valid(node.first) && valid(node.second);
    }
    if (node.selectedTabId !== null && !node.tabIds.includes(node.selectedTabId)) return false;
    for (const id of node.tabIds) {
      if (tabIds.has(id)) return false;
      tabIds.add(id);
    }
    return true;
  };
  if (!valid(tree)) return null;
  const replace = (node: LayoutNode): LayoutNode => {
    if (node === source) return target;
    if (node === target) return source;
    if (node.type === 'pane') return node;
    const first = replace(node.first), second = replace(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return replace(tree);
}

/** Complete a creation against the latest tree, even if its requested pane was closed. */
export function assignCreatedTab(layout: WorkspacePaneLayout, targetPaneId: string, tabId: string): WorkspacePaneLayout {
  const target = findPaneNode(layout.tree, targetPaneId) ?? getPaneNodes(layout.tree)[0]!;
  return {
    ...layout,
    tree: moveTabBetweenPanes(layout.tree, tabId, target.id),
    focusedPaneId: target.id,
    updatedAt: new Date(Math.max(Date.now(), Date.parse(layout.updatedAt) + 1)).toISOString(),
  };
}

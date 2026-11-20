/**
 * Validation of a pane layout a client asks to save.
 */

import {
  isWorkspacePaneLayout,
  layoutOwnershipError,
  type WorkspaceId,
  type WorkspacePaneLayout,
} from '@agent-workbench/shared';

/**
 * Accept a layout only when it belongs to the requested workspace and only
 * references that workspace's existing open tabs. The saved object is the
 * caller's layout unchanged: this does not mint session ids or retarget ownership.
 */
export function evaluateLayoutSave(
  workspaceId: WorkspaceId,
  layout: unknown,
  openTabIds: readonly string[],
): { ok: true; layout: WorkspacePaneLayout } | { ok: false; message: string } {
  if (!isWorkspacePaneLayout(layout)) {
    return { ok: false, message: 'Invalid workspace layout' };
  }
  const ownership = layoutOwnershipError(layout, workspaceId, openTabIds);
  if (ownership) return { ok: false, message: ownership };
  return { ok: true, layout };
}

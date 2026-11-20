/**
 * MAW Editor Tabs: First-class file viewing and editing tabs within Agency workspaces.
 *
 * Defines explicit editor tab identity, workspace ownership, safe path validation,
 * persistence, selection, and layout coordination.
 */

import type { WorkspaceId, IsoTimestamp, RequestId } from '../protocol/agency-messages.js';

export type EditorTabKind = 'editor';

/**
 * Durable editor tab associated with a workspace.
 */
export interface EditorTab {
  /** Stable UUID identifying this editor tab across restarts. */
  id: string;
  /** Owning Agency workspace ID. */
  workspaceId: WorkspaceId;
  /** Explicit discriminator separate from native CLI sessions and browser tabs. */
  kind: 'editor';
  /** Safe workspace-relative POSIX file path. */
  filePath: string;
  /** Human-readable tab title (usually file basename or user-customized label). */
  title: string;
  /** Presentation order in the tab strip (0-indexed). */
  order: number;
  /** Whether this tab is selected in its workspace. At most one open tab is selected per workspace. */
  selected: boolean;
  /** Creation timestamp. */
  createdAt: IsoTimestamp;
  /** Last update timestamp. */
  updatedAt: IsoTimestamp;
  /** Timestamp when the tab was intentionally closed, or null if open. */
  closedAt: IsoTimestamp | null;
  /** Optional client-supplied idempotent launch identifier. */
  launchId?: string;
}

export interface CreateEditorTabInput {
  workspaceId: WorkspaceId;
  filePath: string;
  title?: string;
  order?: number;
  select?: boolean;
  launchId?: string;
  targetPaneId?: string;
}

export interface RelativePathValidationResult {
  valid: boolean;
  normalizedPath?: string;
  error?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates and normalizes a relative file path for an editor tab:
 * - Must be non-empty and <= 2048 characters.
 * - Rejects null bytes and control characters.
 * - Rejects absolute paths (leading slash, backslash, or Windows drive letter / UNC).
 * - Rejects traversal segments ('..').
 * - Normalizes Windows backslashes to POSIX slashes ('/').
 * - Strips leading redundant './'.
 */
export function validateRelativeFilePath(rawPath: string): RelativePathValidationResult {
  if (typeof rawPath !== 'string') {
    return { valid: false, error: 'Path must be a string' };
  }
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Path cannot be empty' };
  }
  if (trimmed.length > 2048) {
    return { valid: false, error: 'Path exceeds maximum length of 2048 characters' };
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { valid: false, error: 'Path contains control characters or null bytes' };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    return { valid: false, error: 'Path must be relative to the workspace, not absolute' };
  }
  // Normalize backslashes to forward slashes
  const posix = trimmed.split('\\').join('/');
  // Strip leading redundant './'
  const normalized = posix.startsWith('./') ? posix.slice(2) : posix;
  if (normalized.length === 0 || normalized === '.') {
    return { valid: false, error: 'Path cannot refer to workspace root' };
  }
  const segments = normalized.split('/');
  if (segments.includes('..') || segments.includes('.')) {
    return { valid: false, error: 'Path traversal or relative dot segments are forbidden' };
  }
  if (segments.some((seg) => seg.length === 0)) {
    return { valid: false, error: 'Path contains invalid empty segments' };
  }
  return { valid: true, normalizedPath: normalized };
}

export function validateEditorTabTitle(rawTitle: string): boolean {
  if (typeof rawTitle !== 'string') return false;
  const trimmed = rawTitle.trim();
  return trimmed.length >= 1 && trimmed.length <= 128 && !/[\u0000-\u001f\u007f]/.test(trimmed);
}

export function isEditorTab(v: unknown): v is EditorTab {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const rec = v as Record<string, unknown>;
  return (
    typeof rec.id === 'string' &&
    UUID_RE.test(rec.id) &&
    typeof rec.workspaceId === 'string' &&
    UUID_RE.test(rec.workspaceId) &&
    rec.kind === 'editor' &&
    typeof rec.filePath === 'string' &&
    validateRelativeFilePath(rec.filePath).valid &&
    typeof rec.title === 'string' &&
    typeof rec.order === 'number' &&
    Number.isSafeInteger(rec.order) &&
    rec.order >= 0 &&
    typeof rec.selected === 'boolean' &&
    typeof rec.createdAt === 'string' &&
    typeof rec.updatedAt === 'string' &&
    (rec.closedAt === null || typeof rec.closedAt === 'string')
  );
}

// ---------------------------------------------------------------------------
// Client / Server Wire Protocol for Editor Tabs
// ---------------------------------------------------------------------------

export type EditorTabClientMessage =
  | {
      type: 'agency.editorTab.open';
      requestId: RequestId;
      workspaceId: WorkspaceId;
      filePath: string;
      title?: string;
      order?: number;
      select?: boolean;
      launchId?: string;
      targetPaneId?: string;
    }
  | { type: 'agency.editorTab.select'; requestId: RequestId; workspaceId: WorkspaceId; tabId: string }
  | { type: 'agency.editorTab.rename'; requestId: RequestId; workspaceId: WorkspaceId; tabId: string; title: string }
  | { type: 'agency.editorTab.order'; requestId: RequestId; workspaceId: WorkspaceId; tabIds: readonly string[] }
  | { type: 'agency.editorTab.close'; requestId: RequestId; workspaceId: WorkspaceId; tabId: string }
  | { type: 'agency.editorTabs.list'; requestId: RequestId; workspaceId?: WorkspaceId };

export type EditorTabServerMessage =
  | { type: 'agency.editorTabs.snapshot'; requestId: RequestId; tabs: readonly EditorTab[] }
  | { type: 'agency.editorTab.opened'; requestId: RequestId; tab: EditorTab }
  | { type: 'agency.editorTab.updated'; requestId: RequestId; tab: EditorTab }
  | { type: 'agency.editorTab.closed'; requestId: RequestId; tab: EditorTab }
  | {
      type: 'agency.editorTab.changed';
      change: 'created' | 'updated' | 'closed' | 'ordered';
      workspaceId: WorkspaceId;
      tab?: EditorTab;
      tabs?: readonly EditorTab[];
    };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidRequestId(v: unknown): v is RequestId {
  return typeof v === 'string' && v.length >= 1 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);
}

export function parseEditorTabClientMessage(raw: unknown): EditorTabClientMessage | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  const fields: Record<string, readonly string[]> = {
    'agency.editorTab.open': ['workspaceId', 'filePath', 'title', 'order', 'select', 'launchId', 'targetPaneId'],
    'agency.editorTab.select': ['workspaceId', 'tabId'],
    'agency.editorTab.rename': ['workspaceId', 'tabId', 'title'],
    'agency.editorTab.order': ['workspaceId', 'tabIds'],
    'agency.editorTab.close': ['workspaceId', 'tabId'],
    'agency.editorTabs.list': ['workspaceId'],
  };
  const allowed = fields[raw.type];
  if (!allowed || Object.keys(raw).some((key) => !['type', 'requestId', ...allowed].includes(key))) return null;
  const requestId = raw.requestId;
  if (!isValidRequestId(requestId)) return null;

  switch (raw.type) {
    case 'agency.editorTab.open': {
      if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) return null;
      if (typeof raw.filePath !== 'string') return null;
      const res = validateRelativeFilePath(raw.filePath);
      if (!res.valid || !res.normalizedPath) return null;
      let title: string | undefined;
      if (raw.title !== undefined) {
        if (!validateEditorTabTitle(raw.title as string)) return null;
        title = (raw.title as string).trim();
      }
      let order: number | undefined;
      if (raw.order !== undefined) {
        if (!Number.isSafeInteger(raw.order) || (raw.order as number) < 0) return null;
        order = raw.order as number;
      }
      let select: boolean | undefined;
      if (raw.select !== undefined) {
        if (typeof raw.select !== 'boolean') return null;
        select = raw.select;
      }
      let launchId: string | undefined;
      if (raw.launchId !== undefined) {
        if (typeof raw.launchId !== 'string' || raw.launchId.length < 1 || raw.launchId.length > 128) return null;
        launchId = raw.launchId;
      }
      if (
        raw.targetPaneId !== undefined &&
        (typeof raw.targetPaneId !== 'string' ||
          raw.targetPaneId.length < 1 ||
          raw.targetPaneId.length > 128 ||
          /[\u0000-\u001f\u007f]/.test(raw.targetPaneId))
      ) {
        return null;
      }
      return {
        type: 'agency.editorTab.open',
        requestId,
        workspaceId: raw.workspaceId as WorkspaceId,
        filePath: res.normalizedPath,
        ...(title !== undefined ? { title } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(select !== undefined ? { select } : {}),
        ...(launchId !== undefined ? { launchId } : {}),
        ...(raw.targetPaneId !== undefined ? { targetPaneId: raw.targetPaneId as string } : {}),
      };
    }
    case 'agency.editorTab.select': {
      if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) return null;
      if (typeof raw.tabId !== 'string' || !UUID_RE.test(raw.tabId)) return null;
      return {
        type: 'agency.editorTab.select',
        requestId,
        workspaceId: raw.workspaceId as WorkspaceId,
        tabId: raw.tabId,
      };
    }
    case 'agency.editorTab.rename': {
      if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) return null;
      if (typeof raw.tabId !== 'string' || !UUID_RE.test(raw.tabId)) return null;
      if (!validateEditorTabTitle(raw.title as string)) return null;
      return {
        type: 'agency.editorTab.rename',
        requestId,
        workspaceId: raw.workspaceId as WorkspaceId,
        tabId: raw.tabId,
        title: (raw.title as string).trim(),
      };
    }
    case 'agency.editorTab.order': {
      if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) return null;
      if (!Array.isArray(raw.tabIds) || !raw.tabIds.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
        return null;
      }
      return {
        type: 'agency.editorTab.order',
        requestId,
        workspaceId: raw.workspaceId as WorkspaceId,
        tabIds: raw.tabIds as string[],
      };
    }
    case 'agency.editorTab.close': {
      if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) return null;
      if (typeof raw.tabId !== 'string' || !UUID_RE.test(raw.tabId)) return null;
      return {
        type: 'agency.editorTab.close',
        requestId,
        workspaceId: raw.workspaceId as WorkspaceId,
        tabId: raw.tabId,
      };
    }
    case 'agency.editorTabs.list': {
      if (raw.workspaceId !== undefined && (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId))) {
        return null;
      }
      return {
        type: 'agency.editorTabs.list',
        requestId,
        ...(raw.workspaceId !== undefined ? { workspaceId: raw.workspaceId as WorkspaceId } : {}),
      };
    }
    default:
      return null;
  }
}

export function parseEditorTabServerMessage(raw: unknown): EditorTabServerMessage | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'agency.editorTabs.snapshot': {
      if (typeof raw.requestId !== 'string') return null;
      if (!Array.isArray(raw.tabs) || !raw.tabs.every(isEditorTab)) return null;
      return {
        type: 'agency.editorTabs.snapshot',
        requestId: raw.requestId,
        tabs: raw.tabs,
      };
    }
    case 'agency.editorTab.opened':
    case 'agency.editorTab.updated':
    case 'agency.editorTab.closed': {
      if (typeof raw.requestId !== 'string' || !isEditorTab(raw.tab)) return null;
      return {
        type: raw.type,
        requestId: raw.requestId,
        tab: raw.tab,
      };
    }
    case 'agency.editorTab.changed': {
      if (
        !['created', 'updated', 'closed', 'ordered'].includes(raw.change as string) ||
        typeof raw.workspaceId !== 'string' ||
        !UUID_RE.test(raw.workspaceId)
      ) {
        return null;
      }
      if (raw.tab !== undefined && !isEditorTab(raw.tab)) return null;
      if (raw.tabs !== undefined && (!Array.isArray(raw.tabs) || !raw.tabs.every(isEditorTab))) return null;
      return {
        type: 'agency.editorTab.changed',
        change: raw.change as 'created' | 'updated' | 'closed' | 'ordered',
        workspaceId: raw.workspaceId as WorkspaceId,
        ...(raw.tab !== undefined ? { tab: raw.tab } : {}),
        ...(raw.tabs !== undefined ? { tabs: raw.tabs } : {}),
      };
    }
    default:
      return null;
  }
}

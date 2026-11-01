/**
 * Durable metadata store for Agency Workspace Editor Tabs.
 *
 * Preserves stable editor tab identity, workspace association, file path, order, and selection
 * across server restarts. Writes are sequenced through an in-process serial queue and written
 * atomically with a validated backup and quarantine for corrupt primary files.
 */

import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgencyErrorCode, EditorTab, WorkspaceId } from '@agent-workbench/shared';
import { isEditorTab, validateRelativeFilePath } from '@agent-workbench/shared';
import { writeAtomically } from '../../atomic-write.js';
import { appConfigDir } from '../../paths.js';

export const EDITOR_TAB_STORE_VERSION = 1;

export class EditorTabStoreError extends Error {
  constructor(
    public readonly code: AgencyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EditorTabStoreError';
  }
}

/** Newer metadata is not corruption and must never be downgraded via a backup. */
export class UnsupportedEditorTabSchemaError extends EditorTabStoreError {
  constructor(version: unknown) {
    super('internal-error', `Unsupported editor tab store version: ${String(version)}`);
  }
}

export interface EditorTabSnapshot {
  version: number;
  tabs: EditorTab[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes tab state for durable persistence:
 * - Ensures valid relative file path.
 * - Ensures at most one tab is selected per workspace among open tabs.
 */
export function sanitizeEditorTabForDurableStorage(tab: EditorTab): EditorTab {
  const pathValidation = validateRelativeFilePath(tab.filePath);
  const normalizedPath = pathValidation.valid && pathValidation.normalizedPath ? pathValidation.normalizedPath : tab.filePath;
  return {
    id: tab.id,
    workspaceId: tab.workspaceId,
    kind: 'editor',
    filePath: normalizedPath,
    title: tab.title,
    order: tab.order,
    selected: tab.selected,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    closedAt: tab.closedAt,
    launchId: tab.launchId,
  };
}

/**
 * Normalizes tabs for workspaces so that at most one open tab is selected per workspace.
 * If multiple are marked selected, the one with lowest order is preserved as selected.
 */
export function normalizeEditorWorkspaceSelections(tabs: readonly EditorTab[]): EditorTab[] {
  const openTabsByWorkspace = new Map<string, EditorTab[]>();
  for (const tab of tabs) {
    const list = openTabsByWorkspace.get(tab.workspaceId) ?? [];
    list.push(tab);
    openTabsByWorkspace.set(tab.workspaceId, list);
  }

  const selectedTabIds = new Set<string>();
  for (const wsTabs of openTabsByWorkspace.values()) {
    const open = wsTabs.filter((t) => !t.closedAt).sort((a, b) => a.order - b.order);
    const explicitlySelected = open.filter((t) => t.selected);
    if (explicitlySelected.length > 0) {
      selectedTabIds.add(explicitlySelected[0]!.id);
    }
  }

  return tabs.map((tab) => {
    if (tab.closedAt) {
      return tab.selected ? { ...tab, selected: false } : tab;
    }
    const shouldBeSelected = selectedTabIds.has(tab.id);
    return tab.selected === shouldBeSelected ? tab : { ...tab, selected: shouldBeSelected };
  });
}

/**
 * Parse and validate a serialized snapshot. Rejects corrupted shapes without discarding files.
 */
export function parseEditorTabSnapshot(contents: string): EditorTab[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new EditorTabStoreError('internal-error', 'Malformed JSON in editor tab store');
  }

  if (!isRecord(parsed)) {
    throw new EditorTabStoreError('internal-error', 'Editor tab store must be an object');
  }

  const version = parsed.version;
  if (version !== EDITOR_TAB_STORE_VERSION) {
    throw new UnsupportedEditorTabSchemaError(version);
  }

  if (!Array.isArray(parsed.tabs)) {
    throw new EditorTabStoreError('internal-error', 'Editor tab store tabs must be an array');
  }

  const tabs: EditorTab[] = [];
  const seenIds = new Set<string>();

  for (const item of parsed.tabs) {
    if (!isEditorTab(item)) {
      throw new EditorTabStoreError('internal-error', 'Invalid EditorTab record in store');
    }
    if (seenIds.has(item.id)) {
      throw new EditorTabStoreError('conflict', `Duplicate tab ID in store: ${item.id}`);
    }
    seenIds.add(item.id);
    tabs.push({
      ...item,
      launchId: item.launchId,
    });
  }

  return normalizeEditorWorkspaceSelections(tabs);
}

export class EditorTabStore {
  private queue: Promise<void> = Promise.resolve();
  private inMemoryTabs: Map<string, EditorTab> = new Map();
  private loaded = false;

  constructor(
    readonly filePath: string = path.join(appConfigDir(), 'agency-editor-tabs.json'),
  ) {}

  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Load durable editor tabs from disk.
   * If primary is corrupted, falls back to .bak and quarantines corrupt primary.
   * If both are missing, initializes with empty state.
   */
  async load(): Promise<readonly EditorTab[]> {
    let primaryMissing = false;
    let primaryFailure: unknown = null;
    let loadedTabs: EditorTab[] | null = null;

    try {
      const raw = await readFile(this.filePath, 'utf8');
      loadedTabs = parseEditorTabSnapshot(raw);
    } catch (error) {
      if (error instanceof UnsupportedEditorTabSchemaError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        primaryMissing = true;
      }
      primaryFailure = error;
    }

    if (loadedTabs === null) {
      // Try backup
      try {
        const rawBackup = await readFile(this.filePath + '.bak', 'utf8');
        loadedTabs = parseEditorTabSnapshot(rawBackup);
      } catch (backupError) {
        if (backupError instanceof UnsupportedEditorTabSchemaError) throw backupError;
        const backupMissing = (backupError as NodeJS.ErrnoException).code === 'ENOENT';
        if (primaryMissing && backupMissing) {
          this.inMemoryTabs.clear();
          this.loaded = true;
          return [];
        }
        throw new AggregateError(
          [primaryFailure, backupError],
          'Editor tab store corrupted and backup unavailable',
        );
      }

      // If primary was present but corrupt, quarantine it
      if (!primaryMissing) {
        const quarantinePath = `${this.filePath}.corrupt-${randomUUID()}`;
        await rename(this.filePath, quarantinePath);
        console.warn(`[maw] corrupt editor tab metadata quarantined at ${quarantinePath}`);
      }
    }

    this.inMemoryTabs.clear();
    for (const tab of loadedTabs) {
      this.inMemoryTabs.set(tab.id, tab);
    }
    this.loaded = true;
    return this.listTabs(undefined, { includeClosed: true });
  }

  listTabs(workspaceId?: WorkspaceId, options?: { includeClosed?: boolean }): readonly EditorTab[] {
    const all = Array.from(this.inMemoryTabs.values());
    const filtered = all.filter((tab) => {
      if (workspaceId && tab.workspaceId !== workspaceId) return false;
      if (!options?.includeClosed && tab.closedAt !== null) return false;
      return true;
    });
    return filtered.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  getTab(tabId: string): EditorTab | undefined {
    return this.inMemoryTabs.get(tabId);
  }

  /**
   * Persist full snapshot atomically to disk.
   */
  save(tabs?: readonly EditorTab[]): Promise<void> {
    if (tabs) {
      this.inMemoryTabs.clear();
      for (const tab of tabs) {
        this.inMemoryTabs.set(tab.id, tab);
      }
    }

    const allTabs = Array.from(this.inMemoryTabs.values());
    const sanitized = normalizeEditorWorkspaceSelections(allTabs.map(sanitizeEditorTabForDurableStorage));

    // Update in-memory state with normalized selections
    this.inMemoryTabs.clear();
    for (const tab of sanitized) {
      this.inMemoryTabs.set(tab.id, tab);
    }

    const snapshot: EditorTabSnapshot = {
      version: EDITOR_TAB_STORE_VERSION,
      tabs: sanitized,
    };

    const serialized = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

    const task = async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      // Create backup of current state if primary exists
      try {
        await copyFile(this.filePath, this.filePath + '.bak');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw e;
        }
      }
      await writeAtomically(this.filePath, serialized, { mode: 0o600 });
    };

    // Chain onto queue
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

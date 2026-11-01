/**
 * Durable metadata store for ChatGPT web tabs.
 *
 * Preserves stable tab identity, workspace association, URL, order, and selection
 * across server restarts, while ensuring runtime target references remain ephemeral.
 * Writes are sequenced through an in-process serial queue and written atomically
 * with a validated backup and quarantine for corrupt primary files.
 */

import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgencyErrorCode, WebTab, WorkspaceId } from '@agent-workbench/shared';
import { isWebTab } from '@agent-workbench/shared';
import { writeAtomically } from '../../atomic-write.js';
import { appConfigDir } from '../../paths.js';

export const BROWSER_TAB_STORE_VERSION = 1;

export class BrowserTabStoreError extends Error {
  constructor(
    public readonly code: AgencyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserTabStoreError';
  }
}

/** Newer metadata is not corruption and must never be downgraded via a backup. */
export class UnsupportedBrowserTabSchemaError extends BrowserTabStoreError {
  constructor(version: unknown) {
    super('internal-error', `Unsupported browser tab store version: ${String(version)}`);
  }
}

export interface BrowserTabSnapshot {
  version: number;
  tabs: WebTab[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes tab state for durable persistence:
 * - Persists targetRef for reconciliation against live browser instances across restarts.
 * - Runtime state is always reconstructed conservatively on restore.
 * - Preserves cleanupRequired flags and idempotent launch IDs.
 * - Ensures at most one tab is selected per workspace among open tabs.
 */
export function sanitizeForDurableStorage(tab: WebTab): WebTab {
  return {
    id: tab.id,
    workspaceId: tab.workspaceId,
    kind: 'web',
    title: tab.title,
    url: tab.url,
    order: tab.order,
    selected: tab.selected,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    closedAt: tab.closedAt,
    targetRef: tab.targetRef ?? null,
    cleanupRequired: tab.cleanupRequired,
    launchId: tab.launchId,
  };
}

/**
 * Normalizes tabs for workspaces so that at most one open tab is selected per workspace.
 * If multiple are marked selected, the one with lowest order is preserved as selected.
 * If none are selected and open tabs exist, leaves them unselected unless requested.
 */
export function normalizeWorkspaceSelections(tabs: readonly WebTab[]): WebTab[] {
  // First pass: identify open tabs that claim selected state, prefer lowest order
  const openTabsByWorkspace = new Map<string, WebTab[]>();
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
export function parseBrowserTabSnapshot(contents: string): WebTab[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new BrowserTabStoreError('internal-error', 'Malformed JSON in browser tab store');
  }

  if (!isRecord(parsed)) {
    throw new BrowserTabStoreError('internal-error', 'Browser tab store must be an object');
  }

  const version = parsed.version;
  if (version !== BROWSER_TAB_STORE_VERSION) {
    throw new UnsupportedBrowserTabSchemaError(version);
  }

  if (!Array.isArray(parsed.tabs)) {
    throw new BrowserTabStoreError('internal-error', 'Browser tab store tabs must be an array');
  }

  const tabs: WebTab[] = [];
  const seenIds = new Set<string>();

  for (const item of parsed.tabs) {
    if (!isWebTab(item)) {
      throw new BrowserTabStoreError('internal-error', 'Invalid WebTab record in store');
    }
    if (seenIds.has(item.id)) {
      throw new BrowserTabStoreError('conflict', `Duplicate tab ID in store: ${item.id}`);
    }
    seenIds.add(item.id);
    // Preserves last known targetRef for reconciliation; starts detached until verified
    tabs.push({
      ...item,
      targetRef: item.targetRef ?? null,
      runtimeState: 'detached',
      cleanupRequired: item.cleanupRequired ?? false,
      launchId: item.launchId,
    });
  }

  return normalizeWorkspaceSelections(tabs);
}

export class BrowserTabStore {
  private queue: Promise<void> = Promise.resolve();
  private inMemoryTabs: Map<string, WebTab> = new Map();
  private loaded = false;

  constructor(
    readonly filePath: string = path.join(appConfigDir(), 'agency-web-tabs.json'),
  ) {}

  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Load durable web tabs from disk.
   * If primary is corrupted, falls back to .bak and quarantines corrupt primary.
   * If both are missing, initializes with empty state.
   */
  async load(): Promise<readonly WebTab[]> {
    let primaryMissing = false;
    let primaryFailure: unknown = null;
    let loadedTabs: WebTab[] | null = null;

    try {
      const raw = await readFile(this.filePath, 'utf8');
      loadedTabs = parseBrowserTabSnapshot(raw);
    } catch (error) {
      if (error instanceof UnsupportedBrowserTabSchemaError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        primaryMissing = true;
      }
      primaryFailure = error;
    }

    if (loadedTabs === null) {
      // Try backup
      try {
        const rawBackup = await readFile(this.filePath + '.bak', 'utf8');
        loadedTabs = parseBrowserTabSnapshot(rawBackup);
      } catch (backupError) {
        if (backupError instanceof UnsupportedBrowserTabSchemaError) throw backupError;
        const backupMissing = (backupError as NodeJS.ErrnoException).code === 'ENOENT';
        if (primaryMissing && backupMissing) {
          this.inMemoryTabs.clear();
          this.loaded = true;
          return [];
        }
        throw new AggregateError(
          [primaryFailure, backupError],
          'Browser tab store corrupted and backup unavailable',
        );
      }

      // If primary was present but corrupt, quarantine it
      if (!primaryMissing) {
        const quarantinePath = `${this.filePath}.corrupt-${randomUUID()}`;
        // If quarantine fails, a later save would copy the corrupt primary over
        // the only valid .bak. Fail closed and leave both files untouched.
        await rename(this.filePath, quarantinePath);
        console.warn(`[maw] corrupt browser tab metadata quarantined at ${quarantinePath}`);
      }
    }

    this.inMemoryTabs.clear();
    for (const tab of loadedTabs) {
      this.inMemoryTabs.set(tab.id, tab);
    }
    this.loaded = true;
    return this.listTabs(undefined, { includeClosed: true });
  }

  listTabs(workspaceId?: WorkspaceId, options?: { includeClosed?: boolean }): readonly WebTab[] {
    const all = Array.from(this.inMemoryTabs.values());
    const filtered = all.filter((tab) => {
      if (workspaceId && tab.workspaceId !== workspaceId) return false;
      if (!options?.includeClosed && tab.closedAt !== null) return false;
      return true;
    });
    return filtered.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  getTab(tabId: string): WebTab | undefined {
    return this.inMemoryTabs.get(tabId);
  }

  /**
   * Persist full snapshot atomically to disk.
   */
  save(tabs?: readonly WebTab[]): Promise<void> {
    if (tabs) {
      this.inMemoryTabs.clear();
      for (const tab of tabs) {
        this.inMemoryTabs.set(tab.id, tab);
      }
    }

    const allTabs = Array.from(this.inMemoryTabs.values());
    const sanitized = normalizeWorkspaceSelections(allTabs.map(sanitizeForDurableStorage));

    const snapshot: BrowserTabSnapshot = {
      version: BROWSER_TAB_STORE_VERSION,
      tabs: sanitized,
    };

    const serialized = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

    const perform = async (): Promise<void> => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await copyFile(this.filePath, this.filePath + '.bak').catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
      await writeAtomically(this.filePath, serialized, { mode: 0o600 });
    };

    const next = this.queue.then(perform);
    this.queue = next.catch(() => undefined);
    return next;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

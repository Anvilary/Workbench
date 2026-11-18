/**
 * Durable metadata store for ChatGPT web tabs.
 *
 * Preserves stable tab identity, workspace association, URL, order, and selection
 * across server restarts, while ensuring runtime target references remain ephemeral.
 * Writes are sequenced through an in-process serial queue and written atomically
 * with a validated backup and quarantine for corrupt primary files.
 */

import path from 'node:path';
import type { AgencyErrorCode, WebTab, WorkspaceId } from '@agent-workbench/shared';
import { isWebTab } from '@agent-workbench/shared';
import { appConfigDir } from '../../paths.js';
import { SerialQueue } from '../../shared/concurrency/serial-queue.js';
import {
  loadWithBackupRecovery,
  writeSnapshotWithBackup,
} from '../../shared/persistence/versioned-json-store.js';
import { isRecord } from '../../shared/validation/primitives.js';

export const BROWSER_TAB_STORE_VERSION = 2;

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
    ...(tab.provider ? { provider: tab.provider } : {}),
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
  if (version !== 1 && version !== BROWSER_TAB_STORE_VERSION) {
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
  private readonly saveQueue = new SerialQueue();
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
    const { value: loadedTabs } = await loadWithBackupRecovery({
      filePath: this.filePath,
      parse: parseBrowserTabSnapshot,
      emptyValue: () => [],
      isUnsupportedSchemaError: (error) => error instanceof UnsupportedBrowserTabSchemaError,
      recoveryErrorMessage: 'Browser tab store corrupted and backup unavailable',
      onQuarantine: (quarantinePath) => {
        console.warn(`[maw] corrupt browser tab metadata quarantined at ${quarantinePath}`);
      },
    });

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
      version: sanitized.some(tab => tab.provider === 'other') ? BROWSER_TAB_STORE_VERSION : 1,
      tabs: sanitized,
    };

    const serialized = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

    return this.saveQueue.run(() =>
      writeSnapshotWithBackup({
        filePath: this.filePath,
        content: serialized,
        dirMode: 0o700,
        fileMode: 0o600,
      }),
    );
  }

  flush(): Promise<void> {
    return this.saveQueue.flush();
  }
}

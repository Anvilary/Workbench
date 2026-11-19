/**
 * Server-owned Editor Tab adapter.
 *
 * Manages editor tab lifecycle, workspace containment, safe path resolution,
 * selection exclusivity, and persistence.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CreateEditorTabInput, EditorTab, WorkspaceId } from '@agent-workbench/shared';
import { validateEditorTabTitle, validateRelativeFilePath } from '@agent-workbench/shared';
import { EditorTabStore, EditorTabStoreError } from './editor-tab-store.js';
import type { AgencyWorkspaceStore } from '../store.js';
import { WorkspaceMutex } from '../workspace-lock.js';
import { resolveInside, InvalidPathError } from '../../path-guard.js';
import { cliFolders } from '../../cli-folders.js';

export interface EditorSelectionCoordinator {
  unselectOtherTabs?(workspaceId: WorkspaceId): Promise<void> | void;
  commitSelection?(workspaceId: WorkspaceId): Promise<void> | void;
  restoreOtherTabs?(workspaceId: WorkspaceId): Promise<void> | void;
}

export interface EditorTabAdapterOptions {
  store: EditorTabStore;
  workspaceStore?: AgencyWorkspaceStore;
  selectionCoordinator?: EditorSelectionCoordinator;
  protectedDirsProvider?: () => readonly string[];
  allowUnvalidatedWorkspacesForTesting?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class EditorTabAdapter {
  readonly store: EditorTabStore;
  private readonly workspaceStore?: AgencyWorkspaceStore;
  private selectionCoordinator?: EditorSelectionCoordinator;
  private readonly protectedDirsProvider?: () => readonly string[];
  private readonly allowUnvalidatedWorkspacesForTesting: boolean;
  private readonly tabs = new Map<string, EditorTab>();
  private readonly mutations = new WorkspaceMutex();

  constructor(options: EditorTabAdapterOptions) {
    this.store = options.store;
    this.workspaceStore = options.workspaceStore;
    this.selectionCoordinator = options.selectionCoordinator;
    this.protectedDirsProvider = options.protectedDirsProvider;
    this.allowUnvalidatedWorkspacesForTesting = options.allowUnvalidatedWorkspacesForTesting === true;
    if (!this.workspaceStore && !this.allowUnvalidatedWorkspacesForTesting) {
      throw new EditorTabStoreError('internal-error', 'Authoritative workspace validation required');
    }
  }

  setSelectionCoordinator(coordinator: EditorSelectionCoordinator): void {
    this.selectionCoordinator = coordinator;
  }

  private async assertWorkspaceValid(
    workspaceId: WorkspaceId,
    options?: { allowInactiveWorkspace?: boolean },
  ): Promise<{ cwd: string }> {
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
      throw new EditorTabStoreError('invalid-request', 'Invalid workspace ID format');
    }

    if (this.workspaceStore) {
      const ws = this.workspaceStore.getWorkspace(workspaceId);
      if (!ws) {
        throw new EditorTabStoreError('not-found', `Workspace ${workspaceId} does not exist`);
      }
      if (!options?.allowInactiveWorkspace) {
        if (ws.status === 'archived' || ws.archivedAt != null) {
          throw new EditorTabStoreError('conflict', `Workspace ${workspaceId} is archived`);
        }
        if (ws.status === 'done' || ws.doneAt != null) {
          throw new EditorTabStoreError('conflict', `Workspace ${workspaceId} is marked done`);
        }
      }
      const proj = this.workspaceStore.listProjects().find((p) => p.id === ws.projectId);
      if (!proj) {
        throw new EditorTabStoreError('not-found', `Owning project for workspace ${workspaceId} not found`);
      }
      if (!options?.allowInactiveWorkspace) {
        if (proj.status === 'archived' || proj.archivedAt != null) {
          throw new EditorTabStoreError('conflict', `Owning project for workspace ${workspaceId} is archived`);
        }
      }
      return { cwd: ws.cwd };
    }

    if (!this.allowUnvalidatedWorkspacesForTesting) {
      throw new EditorTabStoreError('internal-error', 'Authoritative workspace validation required');
    }
    return { cwd: process.cwd() };
  }

  /**
   * Validate that candidate relative path is safe within the workspace cwd:
   * - No parent traversal (..)
   * - No absolute path or drive letter
   * - No null bytes
   * - Resolves within workspace.cwd on filesystem (symlinks checked)
   * - Not inside protected CLI folders (.claude, .codex, etc.)
   */
  async validatePath(workspaceId: WorkspaceId, relativePath: string): Promise<string> {
    const val = validateRelativeFilePath(relativePath);
    if (!val.valid || !val.normalizedPath) {
      throw new EditorTabStoreError('invalid-request', val.error ?? 'Invalid relative file path');
    }

    const { cwd } = await this.assertWorkspaceValid(workspaceId);

    let absolute: string;
    try {
      absolute = await resolveInside(cwd, val.normalizedPath);
    } catch (err) {
      if (err instanceof InvalidPathError) {
        throw new EditorTabStoreError('invalid-request', 'Path escapes workspace boundary or contains invalid segments');
      }
      throw err;
    }

    // Check protected CLI directories
    if (this.protectedDirsProvider) {
      const protectedDirs = this.protectedDirsProvider();
      const folders = await cliFolders(protectedDirs);
      if (folders.holds(absolute) || (await folders.contains(absolute))) {
        throw new EditorTabStoreError('permission-denied', 'Cannot open protected CLI configuration file in editor');
      }
    }

    return val.normalizedPath;
  }

  async restore(): Promise<void> {
    this.tabs.clear();
    const stored = await this.store.load();
    for (const tab of stored) {
      this.tabs.set(tab.id, tab);
    }
  }

  listTabs(workspaceId?: WorkspaceId, options?: { includeClosed?: boolean }): readonly EditorTab[] {
    const all = Array.from(this.tabs.values());
    const filtered = all.filter((tab) => {
      if (workspaceId && tab.workspaceId !== workspaceId) return false;
      if (!options?.includeClosed && tab.closedAt !== null) return false;
      return true;
    });
    return filtered.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  getTabState(tabId: string): EditorTab | undefined {
    return this.tabs.get(tabId);
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  private async change<T>(
    workspaceId: WorkspaceId,
    action: () => T | Promise<T>,
    options?: { allowInactiveWorkspace?: boolean },
  ): Promise<T> {
    let rollbackError: unknown = null;
    let hasFailure = false;
    let didUnselect = false;
    let result!: T;

    const originalCoordinator = this.selectionCoordinator;
    // Intercept unselectOtherTabs to know if selection was altered in this specific transaction
    const wrappedCoordinator: EditorSelectionCoordinator = {
      unselectOtherTabs: async (wsId) => {
        didUnselect = true;
        await originalCoordinator?.unselectOtherTabs?.(wsId);
      },
      commitSelection: async (wsId) => {
        await originalCoordinator?.commitSelection?.(wsId);
      },
      restoreOtherTabs: async (wsId) => {
        await originalCoordinator?.restoreOtherTabs?.(wsId);
      },
    };

    // The editor-tab store persists a complete cross-workspace snapshot.
    // Serialize mutations globally so another workspace cannot commit a change
    // that a concurrent, failing transaction must roll back.
    await this.mutations.runExclusive('all-editor-tabs', async () => {
      await this.assertWorkspaceValid(workspaceId, options);
      const before = this.listTabs(workspaceId, { includeClosed: true });
      this.selectionCoordinator = wrappedCoordinator;
      try {
        result = await action();
        await this.store.save(Array.from(this.tabs.values()));
        if (didUnselect) {
          await originalCoordinator?.commitSelection?.(workspaceId);
        }
      } catch (error) {
        hasFailure = true;
        rollbackError = error;
        // Restore only this workspace: concurrent mutations elsewhere remain intact.
        for (const tab of Array.from(this.tabs.values())) {
          if (tab.workspaceId === workspaceId) {
            this.tabs.delete(tab.id);
          }
        }
        for (const tab of before) {
          this.tabs.set(tab.id, tab);
        }
      } finally {
        this.selectionCoordinator = originalCoordinator;
      }
    });

    if (hasFailure) {
      if (didUnselect) {
        try {
          await Promise.race([
            Promise.resolve(originalCoordinator?.restoreOtherTabs?.(workspaceId)),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('restoreOtherTabs timed out')), 5000),
            ),
          ]);
        } catch (coordError) {
          console.error('[editor-tab-adapter] Failed to restore other tabs selection:', coordError);
        }
      }
      throw rollbackError;
    }

    return result;
  }

  async createTab(input: CreateEditorTabInput): Promise<EditorTab> {
    return this.change(input.workspaceId, async () => {
      const safeRelativePath = await this.validatePath(input.workspaceId, input.filePath);

      // Check if an open editor tab already exists for this file in this workspace
      const existing = this.listTabs(input.workspaceId).find((t) => t.filePath === safeRelativePath);
      if (existing) {
        if (input.select) {
          return this.select(input.workspaceId, existing.id);
        }
        return existing;
      }

      const now = new Date().toISOString();
      const id = randomUUID();
      const openTabs = this.listTabs(input.workspaceId);
      const order =
        input.order !== undefined
          ? input.order
          : openTabs.length > 0
            ? Math.max(...openTabs.map((t) => t.order)) + 1
            : 0;
      const select = input.select ?? true;

      const title =
        input.title && validateEditorTabTitle(input.title)
          ? input.title.trim()
          : path.posix.basename(safeRelativePath);

      if (select) {
        // Deselect other editor tabs in this workspace
        for (const t of openTabs) {
          if (t.selected) {
            this.tabs.set(t.id, { ...t, selected: false, updatedAt: now });
          }
        }
        await this.selectionCoordinator?.unselectOtherTabs?.(input.workspaceId);
      }

      const tab: EditorTab = {
        id,
        workspaceId: input.workspaceId,
        kind: 'editor',
        filePath: safeRelativePath,
        title,
        order,
        selected: select,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        launchId: input.launchId,
      };

      this.tabs.set(id, tab);
      return tab;
    });
  }

  private async select(workspaceId: WorkspaceId, tabId: string): Promise<EditorTab> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.workspaceId !== workspaceId || tab.closedAt !== null) {
      throw new EditorTabStoreError('not-found', `Editor tab ${tabId} not found in workspace`);
    }

    const now = new Date().toISOString();
    // Unselect other editor tabs in workspace
    for (const t of this.listTabs(workspaceId)) {
      if (t.id !== tabId && t.selected) {
        this.tabs.set(t.id, { ...t, selected: false, updatedAt: now });
      }
    }

    const updated: EditorTab = {
      ...tab,
      selected: true,
      updatedAt: now,
    };
    this.tabs.set(tabId, updated);
    await this.selectionCoordinator?.unselectOtherTabs?.(workspaceId);
    return updated;
  }

  async selectTab(workspaceId: WorkspaceId, tabId: string): Promise<EditorTab> {
    return this.change(workspaceId, async () => {
      return this.select(workspaceId, tabId);
    });
  }

  async closeTab(
    workspaceId: WorkspaceId,
    tabId: string,
    options?: { allowInactiveWorkspace?: boolean },
  ): Promise<EditorTab> {
    return this.change(
      workspaceId,
      async () => {
        const tab = this.tabs.get(tabId);
        if (!tab || tab.workspaceId !== workspaceId || tab.closedAt !== null) {
          throw new EditorTabStoreError('not-found', `Editor tab ${tabId} not found in workspace`);
        }

        const now = new Date().toISOString();
        const updated: EditorTab = {
          ...tab,
          selected: false,
          closedAt: now,
          updatedAt: now,
        };
        this.tabs.set(tabId, updated);
        return updated;
      },
      options,
    );
  }

  async renameTab(workspaceId: WorkspaceId, tabId: string, title: string): Promise<EditorTab> {
    return this.change(workspaceId, async () => {
      if (!validateEditorTabTitle(title)) {
        throw new EditorTabStoreError('invalid-request', 'Invalid editor tab title');
      }
      const tab = this.tabs.get(tabId);
      if (!tab || tab.workspaceId !== workspaceId || tab.closedAt !== null) {
        throw new EditorTabStoreError('not-found', `Editor tab ${tabId} not found in workspace`);
      }

      const now = new Date().toISOString();
      const updated: EditorTab = {
        ...tab,
        title: title.trim(),
        updatedAt: now,
      };
      this.tabs.set(tabId, updated);
      return updated;
    });
  }

  async orderTabs(
    workspaceId: WorkspaceId,
    tabIds: readonly string[],
    positions?: ReadonlyMap<string, number>,
  ): Promise<readonly EditorTab[]> {
    return this.change(workspaceId, async () => {
      const open = this.listTabs(workspaceId);
      if (
        tabIds.length !== open.length ||
        new Set(tabIds).size !== tabIds.length ||
        open.some((tab) => !tabIds.includes(tab.id))
      ) {
        throw new EditorTabStoreError('invalid-request', 'Order must contain every open editor tab exactly once');
      }
      const now = new Date().toISOString();
      for (let index = 0; index < tabIds.length; index++) {
        const id = tabIds[index]!;
        const order = positions ? positions.get(id) : index;
        if (order === undefined || !Number.isSafeInteger(order) || order < 0) {
          throw new EditorTabStoreError('invalid-request', 'Invalid order');
        }
        const tab = this.tabs.get(id);
        if (tab && tab.workspaceId === workspaceId && !tab.closedAt) {
          this.tabs.set(id, { ...tab, order, updatedAt: now });
        }
      }
      return this.listTabs(workspaceId);
    });
  }

  async clearWorkspaceSelection(workspaceId: WorkspaceId): Promise<void> {
    return this.mutations.runExclusive('all-editor-tabs', async () => {
      const before = this.listTabs(workspaceId, { includeClosed: true });
      const now = new Date().toISOString();
      let modified = false;
      for (const tab of this.listTabs(workspaceId)) {
        if (tab.selected) {
          this.tabs.set(tab.id, { ...tab, selected: false, updatedAt: now });
          modified = true;
        }
      }
      if (modified) {
        try {
          await this.store.save(Array.from(this.tabs.values()));
        } catch (error) {
          for (const tab of Array.from(this.tabs.values())) {
            if (tab.workspaceId === workspaceId) {
              this.tabs.delete(tab.id);
            }
          }
          for (const tab of before) {
            this.tabs.set(tab.id, tab);
          }
          throw error;
        }
      }
    });
  }
}

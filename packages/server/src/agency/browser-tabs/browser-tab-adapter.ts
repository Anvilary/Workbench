/**
 * BrowserTabAdapter — High-level domain adapter for ChatGPT workspace tabs.
 *
 * Implements the Lane B integration contract:
 * - createTab
 * - selectTab
 * - listTabs
 * - navigateTab
 * - closeTab
 * - renameTab
 * - orderTabs
 * - getTabState
 * - clearWorkspaceSelection
 * - reconcileCleanup
 * - restore
 *
 * Lifecycle and Safety Guarantees:
 * 1. Reconciles live Chromium targets across MAW restarts without duplicating pages.
 * 2. Strictly verifies tab and workspace ownership; never matches by URL or title alone.
 * 3. Atomic operation serialization per workspace prevents race conditions and duplicate targets.
 * 4. Switching tabs activates targets without navigating away, terminating, or disturbing background tasks.
 * 5. Reliable closing persists cleanup-required state on failure and reconciles orphaned targets safely.
 * 6. Authoritative workspace validation: rejects unknown, deleted, Done, or archived workspaces/projects.
 * 7. Unavailable browser engines fail explicitly with typed errors while preserving logical tabs.
 * 8. Never marks a web tab ready when target activation fails.
 * 9. Scopes launch IDs by workspace and safely catches cleanup handlers to avoid unhandled rejections.
 * 10. Coordinates single-selection contract across native CLI, terminal, and ChatGPT tabs.
 */

import { randomUUID } from 'node:crypto';
import type {
  CreateWebTabInput,
  WebTab,
  WebTabRuntimeState,
  WorkspaceId,
} from '@agent-workbench/shared';
import {
  validateChatGptUrl,
  validateWebTabTitle,
} from '@agent-workbench/shared';
import type {
  BrowserControllerDriver,
  TargetMetadata,
} from './browser-controller-driver.js';
import { NullBrowserControllerDriver } from './browser-controller-driver.js';
import { BrowserTabStore, BrowserTabStoreError } from './browser-tab-store.js';
import type { AgencyWorkspaceStore } from '../store.js';

export type WorkspaceValidator = (
  workspaceId: WorkspaceId,
) => { valid: boolean; error?: string } | Promise<{ valid: boolean; error?: string }>;

export interface SelectionCoordinator {
  unselectNativeTabs?(workspaceId: WorkspaceId): Promise<void> | void;
}

export interface BrowserTabAdapterOptions {
  store: BrowserTabStore;
  driver?: BrowserControllerDriver;
  workspaceValidator?: WorkspaceValidator;
  workspaceStore?: AgencyWorkspaceStore;
  selectionCoordinator?: SelectionCoordinator;
  /** Explicitly named flag required to bypass authoritative workspace validation in isolated mock unit tests. */
  allowUnvalidatedWorkspacesForTesting?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class BrowserTabAdapter {
  readonly store: BrowserTabStore;
  private driver: BrowserControllerDriver;
  private workspaceValidator?: WorkspaceValidator;
  private workspaceStore?: AgencyWorkspaceStore;
  private selectionCoordinator?: SelectionCoordinator;
  private readonly allowUnvalidatedWorkspacesForTesting: boolean;

  /** Active tabs keyed by tab ID, including ephemeral runtime target references. */
  private liveTabs: Map<string, WebTab> = new Map();
  /** Serialized operation queue per workspace to guarantee atomicity. */
  private workspaceQueues: Map<string, Promise<void>> = new Map();
  /** In-flight creations keyed by workspace-scoped launchId to prevent duplicate target creation. */
  private inFlightLaunches: Map<string, Promise<WebTab>> = new Map();

  constructor(options: BrowserTabAdapterOptions) {
    this.store = options.store;
    this.driver = options.driver ?? new NullBrowserControllerDriver();
    this.workspaceValidator = options.workspaceValidator;
    this.workspaceStore = options.workspaceStore;
    this.selectionCoordinator = options.selectionCoordinator;
    this.allowUnvalidatedWorkspacesForTesting = !!options.allowUnvalidatedWorkspacesForTesting;

    if (!this.workspaceStore && !this.workspaceValidator && !this.allowUnvalidatedWorkspacesForTesting) {
      throw new BrowserTabStoreError(
        'internal-error',
        'Production BrowserTabAdapter requires an authoritative AgencyWorkspaceStore or workspaceValidator',
      );
    }
  }

  attachDriver(driver: BrowserControllerDriver): void {
    this.driver = driver;
  }

  detachDriver(): void {
    this.driver = new NullBrowserControllerDriver();
  }

  setWorkspaceValidator(validator: WorkspaceValidator): void {
    this.workspaceValidator = validator;
  }

  setSelectionCoordinator(coordinator: SelectionCoordinator): void {
    this.selectionCoordinator = coordinator;
  }

  private launchKey(workspaceId: WorkspaceId, launchId: string): string {
    return `${workspaceId}:${launchId}`;
  }

  private async assertWorkspaceValid(workspaceId: WorkspaceId): Promise<void> {
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
      throw new BrowserTabStoreError('invalid-request', 'Invalid workspace ID format');
    }

    if (this.workspaceStore) {
      const ws = this.workspaceStore.getWorkspace(workspaceId);
      if (!ws) {
        throw new BrowserTabStoreError('not-found', `Workspace ${workspaceId} does not exist`);
      }
      if (ws.status === 'archived' || ws.archivedAt != null) {
        throw new BrowserTabStoreError('conflict', `Workspace ${workspaceId} is archived`);
      }
      if (ws.status === 'done' || ws.doneAt != null) {
        throw new BrowserTabStoreError('conflict', `Workspace ${workspaceId} is marked done`);
      }
      const proj = this.workspaceStore.listProjects().find((p) => p.id === ws.projectId);
      if (!proj) {
        throw new BrowserTabStoreError('not-found', `Owning project for workspace ${workspaceId} not found`);
      }
      if (proj.status === 'archived' || proj.archivedAt != null) {
        throw new BrowserTabStoreError('conflict', `Owning project for workspace ${workspaceId} is archived`);
      }
    } else if (this.workspaceValidator) {
      const res = await this.workspaceValidator(workspaceId);
      if (!res.valid) {
        const isConflict =
          res.error?.toLowerCase().includes('archived') ||
          res.error?.toLowerCase().includes('done');
        throw new BrowserTabStoreError(
          isConflict ? 'conflict' : 'not-found',
          res.error ?? `Workspace ${workspaceId} is not valid`,
        );
      }
    } else if (!this.allowUnvalidatedWorkspacesForTesting) {
      throw new BrowserTabStoreError(
        'internal-error',
        'Authoritative workspace validation required',
      );
    }
  }

  private withWorkspaceLock<T>(workspaceId: WorkspaceId, action: () => Promise<T>): Promise<T> {
    const current = this.workspaceQueues.get(workspaceId) ?? Promise.resolve();
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const resultPromise = new Promise<T>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const next = current.then(async () => {
      try {
        const result = await action();
        resolveResult(result);
      } catch (err) {
        rejectResult(err);
      }
    });

    this.workspaceQueues.set(workspaceId, next.catch(() => undefined));
    return resultPromise;
  }

  /**
   * Conservative restart: loads durable tabs, preserves conversation references,
   * leaves browser targets detached until verified or explicitly activated.
   */
  async restore(): Promise<void> {
    const loaded = await this.store.load();
    this.liveTabs.clear();
    for (const tab of loaded) {
      this.liveTabs.set(tab.id, {
        ...tab,
        runtimeState: 'detached',
      });
    }
    // Safely retry any pending cleanup from previous runs
    await this.reconcileCleanup().catch(() => undefined);
  }

  listTabs(workspaceId?: WorkspaceId, options?: { includeClosed?: boolean }): readonly WebTab[] {
    const all = Array.from(this.liveTabs.values());
    const filtered = all.filter((tab) => {
      if (workspaceId && tab.workspaceId !== workspaceId) return false;
      if (!options?.includeClosed && tab.closedAt !== null) return false;
      return true;
    });
    return filtered.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  getTabState(tabId: string): WebTab | undefined {
    return this.liveTabs.get(tabId);
  }

  async createTab(input: CreateWebTabInput): Promise<WebTab> {
    await this.assertWorkspaceValid(input.workspaceId);

    // Workspace-scoped idempotent creation check: if launchId provided and already in-flight or created, reuse
    if (input.launchId) {
      const scopedKey = this.launchKey(input.workspaceId, input.launchId);
      const existing = this.listTabs(input.workspaceId, { includeClosed: true })
        .find((t) => t.launchId === input.launchId);
      if (existing) return { ...existing };

      const inFlight = this.inFlightLaunches.get(scopedKey);
      if (inFlight) return inFlight;
    }

    const creationPromise = this.withWorkspaceLock(input.workspaceId, async () => {
      if (input.launchId) {
        const existing = this.listTabs(input.workspaceId, { includeClosed: true })
          .find((t) => t.launchId === input.launchId);
        if (existing) return { ...existing };
      }

      const val = validateChatGptUrl(input.url);
      if (!val.valid) {
        throw new BrowserTabStoreError('invalid-request', val.error ?? 'Invalid ChatGPT URL');
      }

      let title = 'ChatGPT';
      if (input.title !== undefined) {
        if (!validateWebTabTitle(input.title)) {
          throw new BrowserTabStoreError('invalid-request', 'Invalid web tab title');
        }
        title = input.title.trim();
      }

      const openTabs = this.listTabs(input.workspaceId);
      let order = input.order;
      if (order === undefined || !Number.isSafeInteger(order) || order < 0) {
        const maxOrder = openTabs.reduce((max, t) => Math.max(max, t.order), -1);
        order = maxOrder + 1;
      }

      const select = input.select !== false;
      const now = new Date().toISOString();
      const id = randomUUID();

      let targetRef: string | null = null;
      let runtimeState: WebTabRuntimeState = input.unloaded ? 'unloaded' : 'detached';
      let browserError: unknown = null;

      // Open target in browser engine only if not explicitly marked unloaded
      if (!input.unloaded) {
        const metadata: TargetMetadata = {
          tabId: id,
          workspaceId: input.workspaceId,
          url: val.normalizedUrl!,
        };
        try {
          const res = await this.driver.openTarget(val.normalizedUrl!, metadata);
          targetRef = res.targetRef;
          runtimeState = 'attached';
        } catch (err) {
          targetRef = null;
          runtimeState = 'error';
          browserError = err;
        }
      }

      // Update selection for workspace
      if (select) {
        for (const openTab of openTabs) {
          if (openTab.selected) {
            openTab.selected = false;
            openTab.updatedAt = now;
          }
        }
        // Coordinate single selection: unselect native CLI and terminal tabs
        await this.selectionCoordinator?.unselectNativeTabs?.(input.workspaceId);
      }

      const newTab: WebTab = {
        id,
        workspaceId: input.workspaceId,
        kind: 'web',
        title,
        url: val.normalizedUrl!,
        order,
        selected: select,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        targetRef,
        runtimeState,
        cleanupRequired: false,
        launchId: input.launchId,
      };

      this.liveTabs.set(id, newTab);

      // If selected and target exists, request activation
      if (select && targetRef && !browserError) {
        try {
          await this.driver.activateTarget(targetRef);
          newTab.runtimeState = 'ready';
        } catch (err) {
          newTab.runtimeState = 'error';
          browserError = err;
        }
      }

      // Persist logical web tab safely even if browser engine failed
      await this.persist();

      // If browser engine operation failed, report explicitly so tasks are not falsely acknowledged as ready
      if (browserError) {
        throw new BrowserTabStoreError(
          'session-unavailable',
          `Web tab saved, but browser engine is unavailable: ${browserError instanceof Error ? browserError.message : String(browserError)}`,
        );
      }

      return { ...newTab };
    });

    if (input.launchId) {
      const scopedKey = this.launchKey(input.workspaceId, input.launchId);
      this.inFlightLaunches.set(scopedKey, creationPromise);
      // Clean up without triggering an unhandled promise rejection if creationPromise rejects
      creationPromise
        .catch(() => undefined)
        .finally(() => {
          this.inFlightLaunches.delete(scopedKey);
        });
    }

    return creationPromise;
  }

  async selectTab(workspaceId: WorkspaceId, tabId: string): Promise<WebTab> {
    await this.assertWorkspaceValid(workspaceId);

    return this.withWorkspaceLock(workspaceId, async () => {
      const tab = this.liveTabs.get(tabId);
      if (!tab || tab.workspaceId !== workspaceId || tab.closedAt !== null) {
        throw new BrowserTabStoreError('not-found', `Web tab ${tabId} not found in workspace ${workspaceId}`);
      }

      const now = new Date().toISOString();
      const openTabs = this.listTabs(workspaceId);

      for (const openTab of openTabs) {
        const isTarget = openTab.id === tabId;
        if (openTab.selected !== isTarget) {
          openTab.selected = isTarget;
          openTab.updatedAt = now;
        }
      }

      // Coordinate single selection: unselect native CLI and terminal tabs in this workspace
      await this.selectionCoordinator?.unselectNativeTabs?.(workspaceId);

      // Reconcile and activate Chromium target
      const expected: TargetMetadata = {
        tabId: tab.id,
        workspaceId: tab.workspaceId,
        url: tab.url,
      };

      if (tab.targetRef) {
        // Strict ownership verification: ensure target is alive and belongs to this tab
        const verified = await this.driver.verifyTargetOwnership(tab.targetRef, expected).catch(() => false);
        if (verified) {
          // Reattach to existing live target without reloading or duplicating
          try {
            await this.driver.activateTarget(tab.targetRef);
            tab.runtimeState = 'ready';
          } catch (err) {
            tab.runtimeState = 'error';
            await this.persist();
            throw new BrowserTabStoreError(
              'session-unavailable',
              `Failed to activate browser target: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else {
          // Stale, dead, or foreign target ID: treat as untrusted reconciliation hint, open fresh target
          try {
            const res = await this.driver.openTarget(tab.url, expected);
            tab.targetRef = res.targetRef;
            await this.driver.activateTarget(tab.targetRef);
            tab.runtimeState = 'ready';
          } catch (err) {
            tab.targetRef = null;
            tab.runtimeState = 'error';
            await this.persist();
            throw new BrowserTabStoreError(
              'session-unavailable',
              `Failed to attach or activate browser target: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } else {
        // Lazy target creation on first selection
        try {
          const res = await this.driver.openTarget(tab.url, expected);
          tab.targetRef = res.targetRef;
          await this.driver.activateTarget(tab.targetRef);
          tab.runtimeState = 'ready';
        } catch (err) {
          tab.targetRef = null;
          tab.runtimeState = 'error';
          await this.persist();
          throw new BrowserTabStoreError(
            'session-unavailable',
            `Failed to open or activate browser target: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      await this.persist();
      return { ...tab };
    });
  }

  async navigateTab(workspaceId: WorkspaceId, tabId: string, url: string): Promise<WebTab> {
    await this.assertWorkspaceValid(workspaceId);

    return this.withWorkspaceLock(workspaceId, async () => {
      const tab = this.liveTabs.get(tabId);
      if (!tab || tab.workspaceId !== workspaceId || tab.closedAt !== null) {
        throw new BrowserTabStoreError('not-found', `Web tab ${tabId} not found in workspace ${workspaceId}`);
      }

      const val = validateChatGptUrl(url);
      if (!val.valid) {
        throw new BrowserTabStoreError('invalid-request', val.error ?? 'Invalid ChatGPT URL');
      }

      tab.url = val.normalizedUrl!;
      tab.updatedAt = new Date().toISOString();

      if (tab.targetRef) {
        try {
          await this.driver.navigateTarget(tab.targetRef, val.normalizedUrl!);
          tab.runtimeState = 'ready';
        } catch {
          tab.runtimeState = 'error';
        }
      }

      await this.persist();
      return { ...tab };
    });
  }

  async renameTab(workspaceId: WorkspaceId, tabId: string, title: string): Promise<WebTab> {
    await this.assertWorkspaceValid(workspaceId);

    return this.withWorkspaceLock(workspaceId, async () => {
      const tab = this.liveTabs.get(tabId);
      if (!tab || tab.workspaceId !== workspaceId || tab.closedAt !== null) {
        throw new BrowserTabStoreError('not-found', `Web tab ${tabId} not found in workspace ${workspaceId}`);
      }

      if (!validateWebTabTitle(title)) {
        throw new BrowserTabStoreError('invalid-request', 'Invalid web tab title');
      }

      tab.title = title.trim();
      tab.updatedAt = new Date().toISOString();

      await this.persist();
      return { ...tab };
    });
  }

  async orderTabs(workspaceId: WorkspaceId, tabIds: readonly string[]): Promise<readonly WebTab[]> {
    await this.assertWorkspaceValid(workspaceId);

    return this.withWorkspaceLock(workspaceId, async () => {
      const openTabs = this.listTabs(workspaceId);
      const openTabIds = new Set(openTabs.map((t) => t.id));

      if (tabIds.length !== openTabIds.size) {
        throw new BrowserTabStoreError('invalid-request', 'Order array length must match open tab count');
      }

      const seen = new Set<string>();
      for (const id of tabIds) {
        if (seen.has(id)) {
          throw new BrowserTabStoreError('invalid-request', `Duplicate tab ID in order list: ${id}`);
        }
        if (!openTabIds.has(id)) {
          throw new BrowserTabStoreError('invalid-request', `Tab ID ${id} does not belong to open tabs in workspace`);
        }
        seen.add(id);
      }

      const now = new Date().toISOString();
      for (const [index, id] of tabIds.entries()) {
        const tab = this.liveTabs.get(id);
        if (tab) {
          tab.order = index;
          tab.updatedAt = now;
        }
      }

      await this.persist();
      return this.listTabs(workspaceId);
    });
  }

  async closeTab(workspaceId: WorkspaceId, tabId: string): Promise<WebTab> {
    await this.assertWorkspaceValid(workspaceId);

    return this.withWorkspaceLock(workspaceId, async () => {
      const tab = this.liveTabs.get(tabId);
      if (!tab || tab.workspaceId !== workspaceId || tab.closedAt !== null) {
        throw new BrowserTabStoreError('not-found', `Web tab ${tabId} not found in workspace ${workspaceId}`);
      }

      const now = new Date().toISOString();
      const wasSelected = tab.selected;

      tab.closedAt = now;
      tab.selected = false;
      tab.updatedAt = now;

      // Reliable closing: attempt destruction in Chromium
      if (tab.targetRef) {
        const ref = tab.targetRef;
        try {
          await this.driver.closeTarget(ref);
          tab.targetRef = null;
          tab.cleanupRequired = false;
          tab.runtimeState = 'closed';
        } catch {
          // Failure to destroy: persist cleanup-required state so it can be reconciled
          tab.cleanupRequired = true;
          tab.runtimeState = 'error';
        }
      } else {
        tab.cleanupRequired = false;
        tab.runtimeState = 'closed';
      }

      // If the closed tab was selected, select an adjacent remaining open tab
      if (wasSelected) {
        const remainingOpen = this.listTabs(workspaceId).filter((t) => t.id !== tabId);
        if (remainingOpen.length > 0) {
          const candidate = remainingOpen.find((t) => t.order >= tab.order) ?? remainingOpen[remainingOpen.length - 1];
          if (candidate) {
            candidate.selected = true;
            candidate.updatedAt = now;
            if (candidate.targetRef) {
              const verified = await this.driver.verifyTargetOwnership(candidate.targetRef, {
                tabId: candidate.id,
                workspaceId: candidate.workspaceId,
                url: candidate.url,
              }).catch(() => false);
              if (verified) {
                try {
                  await this.driver.activateTarget(candidate.targetRef);
                  candidate.runtimeState = 'ready';
                } catch {
                  candidate.runtimeState = 'error';
                }
              }
            }
          }
        }
      }

      await this.persist();
      return { ...tab };
    });
  }

  /**
   * Reconcile tabs with cleanupRequired === true, safely destroying orphaned browser targets.
   * Never touches or closes any other tabs.
   */
  async reconcileCleanup(workspaceId?: WorkspaceId): Promise<void> {
    const tabs = this.listTabs(workspaceId, { includeClosed: true })
      .filter((t) => t.cleanupRequired && t.targetRef);

    for (const tab of tabs) {
      if (!tab.targetRef) {
        tab.cleanupRequired = false;
        continue;
      }
      try {
        await this.driver.closeTarget(tab.targetRef);
        tab.targetRef = null;
        tab.cleanupRequired = false;
        tab.runtimeState = 'closed';
      } catch {
        // Will retry on subsequent reconcileCleanup
      }
    }

    if (tabs.length > 0) {
      await this.persist();
    }
  }

  /**
   * Clears selection on all web tabs in a workspace when a native CLI or terminal tab is selected.
   */
  async clearWorkspaceSelection(workspaceId: WorkspaceId): Promise<void> {
    await this.withWorkspaceLock(workspaceId, async () => {
      const openTabs = this.listTabs(workspaceId);
      let changed = false;
      const now = new Date().toISOString();
      for (const tab of openTabs) {
        if (tab.selected) {
          tab.selected = false;
          tab.updatedAt = now;
          changed = true;
        }
      }
      if (changed) {
        await this.persist();
      }
    });
  }

  private async persist(): Promise<void> {
    await this.store.save(Array.from(this.liveTabs.values()));
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }
}

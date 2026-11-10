/** Durable logical ChatGPT tabs. Native Chromium views belong exclusively to the desktop. */
import { randomUUID } from 'node:crypto';
import type { CreateWebTabInput, WebTab, WorkspaceId } from '@agent-workbench/shared';
import { classifyWebTabUrl, validateOtherWebUrl, validateWebTabTitle, webTabProviderFor } from '@agent-workbench/shared';
import { BrowserTabStore, BrowserTabStoreError } from './browser-tab-store.js';
import type { AgencyWorkspaceStore } from '../store.js';
import { WorkspaceMutex } from '../workspace-lock.js';

export type WorkspaceValidator = (workspaceId: WorkspaceId) => { valid: boolean; error?: string } | Promise<{ valid: boolean; error?: string }>;
export interface SelectionCoordinator { unselectNativeTabs?(workspaceId: WorkspaceId): Promise<void> | void }
export interface BrowserTabAdapterOptions {
  store: BrowserTabStore;
  workspaceValidator?: WorkspaceValidator;
  workspaceStore?: AgencyWorkspaceStore;
  selectionCoordinator?: SelectionCoordinator;
  allowUnvalidatedWorkspacesForTesting?: boolean;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class BrowserTabAdapter {
  readonly store: BrowserTabStore;
  private workspaceValidator?: WorkspaceValidator;
  private readonly workspaceStore?: AgencyWorkspaceStore;
  private selectionCoordinator?: SelectionCoordinator;
  private readonly allowUnvalidatedWorkspacesForTesting: boolean;
  private readonly tabs = new Map<string, WebTab>();
  private readonly mutations = new WorkspaceMutex();
  constructor(options: BrowserTabAdapterOptions) {
    this.store = options.store;
    this.workspaceValidator = options.workspaceValidator;
    this.workspaceStore = options.workspaceStore;
    this.selectionCoordinator = options.selectionCoordinator;
    this.allowUnvalidatedWorkspacesForTesting = options.allowUnvalidatedWorkspacesForTesting === true;
    if (!this.workspaceStore && !this.workspaceValidator && !this.allowUnvalidatedWorkspacesForTesting) throw new BrowserTabStoreError('internal-error', 'Authoritative workspace validation required');
  }
  setWorkspaceValidator(validator: WorkspaceValidator): void { this.workspaceValidator = validator; }
  setSelectionCoordinator(coordinator: SelectionCoordinator): void { this.selectionCoordinator = coordinator; }
  private async assertWorkspaceValid(workspaceId: WorkspaceId, options?: { allowInactiveWorkspace?: boolean }): Promise<void> {
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
      throw new BrowserTabStoreError('invalid-request', 'Invalid workspace ID format');
    }

    if (this.workspaceStore) {
      const ws = this.workspaceStore.getWorkspace(workspaceId);
      if (!ws) {
        throw new BrowserTabStoreError('not-found', `Workspace ${workspaceId} does not exist`);
      }
      if (!options?.allowInactiveWorkspace) {
        if (ws.status === 'archived' || ws.archivedAt != null) {
          throw new BrowserTabStoreError('conflict', `Workspace ${workspaceId} is archived`);
        }
        if (ws.status === 'done' || ws.doneAt != null) {
          throw new BrowserTabStoreError('conflict', `Workspace ${workspaceId} is marked done`);
        }
      }
      const proj = this.workspaceStore.listProjects().find((p) => p.id === ws.projectId);
      if (!proj) {
        throw new BrowserTabStoreError('not-found', `Owning project for workspace ${workspaceId} not found`);
      }
      if (!options?.allowInactiveWorkspace) {
        if (proj.status === 'archived' || proj.archivedAt != null) {
          throw new BrowserTabStoreError('conflict', `Owning project for workspace ${workspaceId} is archived`);
        }
      }
    } else if (this.workspaceValidator) {
      const res = await this.workspaceValidator(workspaceId);
      if (!res.valid) {
        const isConflict =
          res.error?.toLowerCase().includes('archived') ||
          res.error?.toLowerCase().includes('done');
        if (!options?.allowInactiveWorkspace || !isConflict) {
          throw new BrowserTabStoreError(
            isConflict ? 'conflict' : 'not-found',
            res.error ?? `Workspace ${workspaceId} is not valid`,
          );
        }
      }
    } else if (!this.allowUnvalidatedWorkspacesForTesting) {
      throw new BrowserTabStoreError(
        'internal-error',
        'Authoritative workspace validation required',
      );
    }
  }


  async restore(): Promise<void> {
    this.tabs.clear();
    for (const tab of await this.store.load()) this.tabs.set(tab.id, { ...tab, runtimeState: tab.closedAt ? 'closed' : 'client-managed' });
  }
  listTabs(workspaceId?: WorkspaceId, options?: { includeClosed?: boolean }): readonly WebTab[] {
    return [...this.tabs.values()].filter(tab => (!workspaceId || tab.workspaceId === workspaceId) && (options?.includeClosed || !tab.closedAt))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map(tab => ({ ...tab }));
  }
  getTabState(tabId: string): WebTab | undefined { const tab = this.tabs.get(tabId); return tab ? { ...tab } : undefined; }
  private tab(workspaceId: WorkspaceId, tabId: string): WebTab {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.workspaceId !== workspaceId || tab.closedAt) throw new BrowserTabStoreError('not-found', 'Open tab does not belong to this workspace');
    return tab;
  }
  private async change<T>(workspaceId: WorkspaceId, action: () => T | Promise<T>, options?: { allowInactiveWorkspace?: boolean }): Promise<T> {
    // The browser-tab store persists a complete cross-workspace snapshot.
    // Serialize mutations globally so another workspace cannot commit a change
    // that a concurrent, failing transaction must roll back.
    return this.mutations.runExclusive('all-browser-tabs', async () => {
      await this.assertWorkspaceValid(workspaceId, options);
      const before = this.listTabs(workspaceId, { includeClosed: true });
      try {
        const result = await action();
        await this.store.save([...this.tabs.values()]);
        return result;
      } catch (error) {
        // Restore only this workspace: concurrent mutations elsewhere remain intact.
        for (const tab of this.tabs.values()) if (tab.workspaceId === workspaceId) this.tabs.delete(tab.id);
        for (const tab of before) this.tabs.set(tab.id, tab);
        throw error;
      }
    });
  }
  private async select(workspaceId: WorkspaceId, id: string): Promise<void> {
    const now = new Date().toISOString();
    for (const tab of this.tabs.values()) if (tab.workspaceId === workspaceId && !tab.closedAt && tab.selected !== (tab.id === id)) {
      tab.selected = tab.id === id; tab.updatedAt = now;
    }
    await this.selectionCoordinator?.unselectNativeTabs?.(workspaceId);
  }
  async createTab(input: CreateWebTabInput): Promise<WebTab> {
    return this.change(input.workspaceId, async () => {
      if (input.launchId) {
        const existing = this.listTabs(input.workspaceId, { includeClosed: true }).find(tab => tab.launchId === input.launchId);
        if (existing) return existing;
      }
      const classified = classifyWebTabUrl(input.url);
      const other = input.provider === 'other' ? validateOtherWebUrl(input.url) : null;
      const valid = other?.valid ? { ...other, provider: 'other' as const } : classified;
      if (!valid.valid || !valid.provider || (input.provider && valid.provider !== input.provider)) throw new BrowserTabStoreError('invalid-request', valid.error ?? 'Invalid URL');
      if (input.title !== undefined && !validateWebTabTitle(input.title)) throw new BrowserTabStoreError('invalid-request', 'Invalid title');
      const now = new Date().toISOString();
      const tab: WebTab = { id: randomUUID(), workspaceId: input.workspaceId, kind: 'web', title: input.title?.trim() ?? (valid.provider === 'github' ? 'GitHub' : valid.provider === 'perplexity' ? 'Perplexity' : valid.provider === 'other' ? 'Other' : 'ChatGPT'), url: valid.normalizedUrl!, provider: valid.provider,
        order: input.order !== undefined && Number.isSafeInteger(input.order) && input.order >= 0 ? input.order : Math.max(-1, ...this.listTabs(input.workspaceId).map(tab => tab.order)) + 1,
        selected: input.select !== false, closedAt: null, createdAt: now, updatedAt: now, runtimeState: 'client-managed', targetRef: null, cleanupRequired: false, launchId: input.launchId };
      this.tabs.set(tab.id, tab);
      if (tab.selected) await this.select(input.workspaceId, tab.id);
      return { ...tab };
    });
  }
  async selectTab(workspaceId: WorkspaceId, tabId: string): Promise<WebTab> {
    return this.change(workspaceId, async () => { const tab = this.tab(workspaceId, tabId); await this.select(workspaceId, tabId); return { ...tab }; });
  }
  async navigateTab(workspaceId: WorkspaceId, tabId: string, url: string): Promise<WebTab> {
    return this.change(workspaceId, () => {
      const tab = this.tab(workspaceId, tabId), provider = webTabProviderFor(tab);
      const valid = provider === 'other' ? validateOtherWebUrl(url) : classifyWebTabUrl(url);
      if (!valid.valid || (provider !== 'other' && (!('provider' in valid) || valid.provider !== provider))) throw new BrowserTabStoreError('invalid-request', valid.error ?? 'Navigation must stay on the tab provider');
      tab.url = valid.normalizedUrl!; tab.provider = provider; tab.updatedAt = new Date().toISOString(); return { ...tab };
    });
  }
  async renameTab(workspaceId: WorkspaceId, tabId: string, title: string): Promise<WebTab> {
    return this.change(workspaceId, () => {
      const tab = this.tab(workspaceId, tabId);
      if (!validateWebTabTitle(title)) throw new BrowserTabStoreError('invalid-request', 'Invalid title');
      tab.title = title.trim(); tab.updatedAt = new Date().toISOString(); return { ...tab };
    });
  }
  async orderTabs(workspaceId: WorkspaceId, ids: readonly string[], positions?: ReadonlyMap<string, number>): Promise<readonly WebTab[]> {
    return this.change(workspaceId, () => {
      const open = this.listTabs(workspaceId);
      if (ids.length !== open.length || new Set(ids).size !== ids.length || open.some(tab => !ids.includes(tab.id))) throw new BrowserTabStoreError('invalid-request', 'Order must contain every open tab exactly once');
      ids.forEach((id, index) => {
        const order = positions ? positions.get(id) : index;
        if (order === undefined || !Number.isSafeInteger(order) || order < 0) throw new BrowserTabStoreError('invalid-request', 'Invalid order');
        const tab = this.tab(workspaceId, id); tab.order = order; tab.updatedAt = new Date().toISOString();
      });
      return this.listTabs(workspaceId);
    });
  }
  async closeTab(workspaceId: WorkspaceId, tabId: string, options?: { allowInactiveWorkspace?: boolean }): Promise<WebTab> {
    return this.change(workspaceId, () => {
      const tab = this.tab(workspaceId, tabId), selected = tab.selected;
      tab.closedAt = tab.updatedAt = new Date().toISOString(); tab.selected = false; tab.runtimeState = 'closed';
      // Legacy ownership metadata is retained as inert migration data, never used to access a browser.
      if (tab.targetRef) tab.cleanupRequired = true;
      if (selected) {
        const remaining = this.listTabs(workspaceId), next = remaining.find(candidate => candidate.order >= tab.order) ?? remaining.at(-1);
        if (next) this.tabs.get(next.id)!.selected = true;
      }
      return { ...tab };
    }, options);
  }
  async clearWorkspaceSelection(workspaceId: WorkspaceId, options?: { allowInactiveWorkspace?: boolean }): Promise<void> {
    await this.change(workspaceId, () => { for (const tab of this.tabs.values()) if (tab.workspaceId === workspaceId && tab.selected) { tab.selected = false; tab.updatedAt = new Date().toISOString(); } }, options);
  }
  async flush(): Promise<void> { await this.store.flush(); }
}

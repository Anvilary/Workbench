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
 *
 * Guarantees:
 * 1. Independent of Neko internals; delegates target operations to BrowserControllerDriver.
 * 2. Switching tabs activates targets without navigating away or closing previous targets.
 * 3. Ephemeral browser runtime target references stay separate from durable tab identities.
 * 4. URLs are strictly validated to prevent SSRF and access to local/privileged services.
 * 5. Conservative restart preserves conversation references without aggressive re-spawning.
 * 6. Workspaces maintain strict isolation.
 */

import { randomUUID } from 'node:crypto';
import type {
  CreateWebTabInput,
  WebTab,
  WorkspaceId,
} from '@agent-workbench/shared';
import {
  validateChatGptUrl,
  validateWebTabTitle,
} from '@agent-workbench/shared';
import type { BrowserControllerDriver } from './browser-controller-driver.js';
import { NullBrowserControllerDriver } from './browser-controller-driver.js';
import { BrowserTabStore, BrowserTabStoreError } from './browser-tab-store.js';

export interface BrowserTabAdapterOptions {
  store: BrowserTabStore;
  driver?: BrowserControllerDriver;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class BrowserTabAdapter {
  readonly store: BrowserTabStore;
  private driver: BrowserControllerDriver;
  /** Active tabs keyed by tab ID, including ephemeral runtime target references. */
  private liveTabs: Map<string, WebTab> = new Map();

  constructor(options: BrowserTabAdapterOptions) {
    this.store = options.store;
    this.driver = options.driver ?? new NullBrowserControllerDriver();
  }

  attachDriver(driver: BrowserControllerDriver): void {
    this.driver = driver;
  }

  detachDriver(): void {
    this.driver = new NullBrowserControllerDriver();
  }

  /**
   * Conservative restart: loads durable tabs, preserves conversation references,
   * leaves browser targets detached until explicitly selected or activated.
   */
  async restore(): Promise<void> {
    const loaded = await this.store.load();
    this.liveTabs.clear();
    for (const tab of loaded) {
      this.liveTabs.set(tab.id, {
        ...tab,
        targetRef: null,
        runtimeState: 'detached',
      });
    }
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
    if (typeof input.workspaceId !== 'string' || !UUID_RE.test(input.workspaceId)) {
      throw new BrowserTabStoreError('invalid-request', 'Invalid workspace ID');
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

    // Open target in browser engine
    let targetRef: string | null = null;
    let runtimeState: WebTab['runtimeState'] = 'detached';
    try {
      const res = await this.driver.openTarget(val.normalizedUrl!);
      targetRef = res.targetRef;
      runtimeState = 'attached';
    } catch {
      // If driver is not available or fails, tab still persists conservatively
      targetRef = null;
      runtimeState = 'detached';
    }

    // Update selection for workspace
    if (select) {
      for (const openTab of openTabs) {
        if (openTab.selected) {
          openTab.selected = false;
          openTab.updatedAt = now;
        }
      }
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
    };

    this.liveTabs.set(id, newTab);

    // If selected and target exists, request activation
    if (select && targetRef) {
      try {
        await this.driver.activateTarget(targetRef);
        newTab.runtimeState = 'ready';
      } catch {
        // Activation failure does not abort tab creation
      }
    }

    await this.persist();
    return { ...newTab };
  }

  async selectTab(workspaceId: WorkspaceId, tabId: string): Promise<WebTab> {
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

    // Display correct already-loaded Chromium tab, without navigating or closing others
    if (tab.targetRef) {
      const alive = await this.driver.isTargetAlive(tab.targetRef).catch(() => false);
      if (alive) {
        await this.driver.activateTarget(tab.targetRef).catch(() => undefined);
        tab.runtimeState = 'ready';
      } else {
        // Target was terminated externally; recreate target conservatively
        try {
          const res = await this.driver.openTarget(tab.url);
          tab.targetRef = res.targetRef;
          await this.driver.activateTarget(tab.targetRef);
          tab.runtimeState = 'ready';
        } catch {
          tab.targetRef = null;
          tab.runtimeState = 'detached';
        }
      }
    } else {
      // Lazy target creation on first selection after restart
      try {
        const res = await this.driver.openTarget(tab.url);
        tab.targetRef = res.targetRef;
        await this.driver.activateTarget(tab.targetRef);
        tab.runtimeState = 'ready';
      } catch {
        tab.targetRef = null;
        tab.runtimeState = 'detached';
      }
    }

    await this.persist();
    return { ...tab };
  }

  async navigateTab(workspaceId: WorkspaceId, tabId: string, url: string): Promise<WebTab> {
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
  }

  async renameTab(workspaceId: WorkspaceId, tabId: string, title: string): Promise<WebTab> {
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
  }

  async orderTabs(workspaceId: WorkspaceId, tabIds: readonly string[]): Promise<readonly WebTab[]> {
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
  }

  async closeTab(workspaceId: WorkspaceId, tabId: string): Promise<WebTab> {
    const tab = this.liveTabs.get(tabId);
    if (!tab || tab.workspaceId !== workspaceId || tab.closedAt !== null) {
      throw new BrowserTabStoreError('not-found', `Web tab ${tabId} not found in workspace ${workspaceId}`);
    }

    const now = new Date().toISOString();
    const wasSelected = tab.selected;

    tab.closedAt = now;
    tab.selected = false;
    tab.updatedAt = now;
    tab.runtimeState = 'closed';

    if (tab.targetRef) {
      const ref = tab.targetRef;
      tab.targetRef = null;
      try {
        await this.driver.closeTarget(ref);
      } catch {
        // Driver close failure does not abort tab closure
      }
    }

    // If the closed tab was selected, select an adjacent remaining open tab
    if (wasSelected) {
      const remainingOpen = this.listTabs(workspaceId).filter((t) => t.id !== tabId);
      if (remainingOpen.length > 0) {
        // Prefer adjacent tab: same order or preceding
        const candidate = remainingOpen.find((t) => t.order >= tab.order) ?? remainingOpen[remainingOpen.length - 1];
        if (candidate) {
          candidate.selected = true;
          candidate.updatedAt = now;
          if (candidate.targetRef) {
            try {
              await this.driver.activateTarget(candidate.targetRef);
              candidate.runtimeState = 'ready';
            } catch {
              // Activation failure does not abort closure
            }
          }
        }
      }
    }

    await this.persist();
    return { ...tab };
  }

  private async persist(): Promise<void> {
    await this.store.save(Array.from(this.liveTabs.values()));
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }
}

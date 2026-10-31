import { assignCreatedTab, reconcileLayout } from '@agent-workbench/shared';
import type { AgencyClientMessage, AgencyServerMessage, WebTabClientMessage, WorkspaceId } from '@agent-workbench/shared';
import { AgencyRuntimeError, type AgencySessionRuntime } from './agency-session-runtime.js';
import type { AgencyWorkspaceStore } from './store.js';
import { WorkspaceMutex } from './workspace-lock.js';
import type { BrowserTabAdapter } from './browser-tabs/browser-tab-adapter.js';
import { handleWebTabMessage } from './browser-tabs/web-tab-handler.js';
import type { AgencyLayoutStore } from './agency-layout-store.js';

/** One serialized authority for selection across native sessions and browser tabs.
 * The reservation mutex inside the native runtime remains independent: browser
 * selection calls back into that runtime without recursively locking it.
 */
export class AgencyTabCoordinator {
  readonly mutations = new WorkspaceMutex();
  private lastNativeSnapshot: string | undefined;
  private lastBrowserSnapshot: string | undefined;

  constructor(
    readonly native: AgencySessionRuntime,
    readonly browser: BrowserTabAdapter,
    readonly workspaces: AgencyWorkspaceStore,
    private readonly publish: (message: AgencyServerMessage) => void,
    readonly layouts?: AgencyLayoutStore,
  ) {
    browser.setSelectionCoordinator({ unselectNativeTabs: workspaceId => native.clearWorkspaceSelection(workspaceId) });
  }

  private openNative(workspaceId: WorkspaceId) {
    return this.native.list(workspaceId).filter(session => session.tab?.current && !session.tab.closedAt);
  }

  hasBrowserReferences(workspaceId: WorkspaceId): boolean {
    return this.browser.listTabs(workspaceId, { includeClosed: true }).some(tab => !tab.closedAt);
  }

  canInspect(workspaceId: WorkspaceId, tabId: string): boolean {
    const workspace = this.workspaces.getWorkspace(workspaceId);
    if (!workspace || workspace.status !== 'active' ||
        !this.workspaces.listProjects().some(project => project.id === workspace.projectId && project.status !== 'archived')) return false;
    const web = this.browser.getTabState(tabId);
    if (web) return web.workspaceId === workspaceId && !web.closedAt && web.selected && web.runtimeState === 'client-managed';
    return this.openNative(workspaceId).some(session => session.tab?.id === tabId && session.tab.selected);
  }

  /** Keep a concurrent selection from invalidating eligibility during acknowledgement. */
  async inspect<T>(workspaceId: WorkspaceId, tabId: string, inspection: () => Promise<T>): Promise<T> {
    return this.mutations.runExclusive(workspaceId, async () => {
      if (!this.canInspect(workspaceId, tabId)) {
        throw new AgencyRuntimeError('session-unavailable', 'Tab must be open and selected in an active workspace before inspection');
      }
      return inspection();
    });
  }

  snapshot(): void {
    // New/reconnecting sockets receive unconditional snapshots at connection
    // setup. Broadcast only changed domains here, including partial failures.
    const sessions = this.native.liveList();
    const nativeSnapshot = JSON.stringify(sessions);
    if (nativeSnapshot !== this.lastNativeSnapshot) {
      this.publish({ type: 'agency.sessions.snapshot', requestId: '', sessions });
      this.lastNativeSnapshot = nativeSnapshot;
    }
    const tabs = this.browser.listTabs();
    const browserSnapshot = JSON.stringify(tabs);
    if (browserSnapshot !== this.lastBrowserSnapshot) {
      this.publish({ type: 'agency.webTabs.snapshot', requestId: '', tabs });
      this.lastBrowserSnapshot = browserSnapshot;
    }
  }

  /** Resolve a partial cross-store selection commit conservatively on startup. */
  async restoreSelection(): Promise<void> {
    for (const workspace of this.workspaces.listWorkspaces()) {
      const web = this.browser.listTabs(workspace.id).find(tab => tab.selected);
      const native = this.openNative(workspace.id).find(session => session.tab?.selected);
      if (!web || !native) continue;
      if (web.updatedAt >= native.updatedAt) await this.native.clearWorkspaceSelection(workspace.id);
      else await this.browser.clearWorkspaceSelection(workspace.id);
    }
  }

  private async selectFallback(workspaceId: WorkspaceId): Promise<void> {
    const native = this.openNative(workspaceId);
    const web = this.browser.listTabs(workspaceId);
    if (native.some(session => session.tab?.selected) || web.some(tab => tab.selected)) return;
    if (native[0]?.tab) await this.native.tabAction(workspaceId, native[0].tab.id, 'select');
    else if (web[0]) await this.browser.selectTab(workspaceId, web[0].id);
  }

  async order(workspaceId: WorkspaceId, ids: readonly string[]): Promise<void> {
    const native = this.openNative(workspaceId).map(session => session.tab!.id);
    const web = this.browser.listTabs(workspaceId).map(tab => tab.id);
    const all = [...native, ...web];
    if (ids.length !== all.length || new Set(ids).size !== ids.length || all.some(id => !ids.includes(id))) {
      throw new AgencyRuntimeError('invalid-request', 'Order must contain every open tab exactly once');
    }
    const positions = new Map(ids.map((id, index) => [id, index]));
    await this.native.orderTabs(workspaceId, ids.filter(id => native.includes(id)), positions);
    if (web.length) await this.browser.orderTabs(workspaceId, ids.filter(id => web.includes(id)), positions);
  }

  private async placeCreatedTab(workspaceId: WorkspaceId, targetPaneId: string | undefined, tabId: string): Promise<void> {
    if (!targetPaneId || !this.layouts) return;
    const open = [...this.openNative(workspaceId).map(session => session.tab!.id), ...this.browser.listTabs(workspaceId).map(tab => tab.id)];
    const layout = await this.layouts.update(workspaceId, current =>
      assignCreatedTab(reconcileLayout(current, workspaceId, open), targetPaneId, tabId));
    this.publish({ type: 'agency.layout.changed', workspaceId, layout });
  }

  async createNative(message: Extract<AgencyClientMessage, { type: 'agency.session.create' }>) {
    return this.mutations.runExclusive(message.workspaceId, async () => {
      try {
        const before = [
          ...this.openNative(message.workspaceId).map(session => ({ id: session.tab!.id, order: session.tab!.order })),
          ...this.browser.listTabs(message.workspaceId).map(tab => ({ id: tab.id, order: tab.order })),
        ].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        const session = await this.native.create(message);
        if (session.tab?.selected) await this.browser.clearWorkspaceSelection(message.workspaceId);
        if (session.tab && !before.some(tab => tab.id === session.tab!.id)) {
          await this.order(message.workspaceId, [...before.map(tab => tab.id), session.tab.id]);
        }
        if (session.tab) await this.placeCreatedTab(message.workspaceId, message.targetPaneId, session.tab.id);
        return this.native.get(session.id) ?? session;
      } finally { this.snapshot(); }
    });
  }

  async nativeAction(message: Extract<AgencyClientMessage, { type: 'agency.tab.action' | 'agency.tabs.order' | 'agency.tab.rename' }>): Promise<void> {
    return this.mutations.runExclusive(message.workspaceId, async () => {
      try {
        if (message.type === 'agency.tab.rename') await this.native.renameTab(message.workspaceId, message.tabId, message.name);
        else if (message.type === 'agency.tabs.order') await this.order(message.workspaceId, message.tabIds);
        else {
          await this.native.tabAction(message.workspaceId, message.tabId, message.action);
          if (message.action === 'select' || message.action === 'resume') await this.browser.clearWorkspaceSelection(message.workspaceId);
          else await this.selectFallback(message.workspaceId);
        }
      } finally { this.snapshot(); }
    });
  }

  async webRequest(message: WebTabClientMessage) {
    const execute = async () => {
      try {
        const request = message.type === 'agency.webTab.create' && message.order === undefined
          ? { ...message, order: Math.max(-1, ...this.openNative(message.workspaceId).map(session => session.tab!.order),
              ...this.browser.listTabs(message.workspaceId).map(tab => tab.order)) + 1 }
          : message;
        const response = await handleWebTabMessage(request, { adapter: this.browser, publish: this.publish });
        if (message.type === 'agency.webTab.create' && response?.type === 'agency.webTab.created') {
          await this.placeCreatedTab(message.workspaceId, message.targetPaneId, response.tab.id);
        }
        if (message.type === 'agency.webTab.close' && response?.type !== 'agency.error') {
          await this.selectFallback(message.workspaceId);
        }
        return response;
      } finally { if (message.type !== 'agency.webTabs.list') this.snapshot(); }
    };
    return 'workspaceId' in message && message.workspaceId
      ? this.mutations.runExclusive(message.workspaceId, execute) : execute();
  }

  /**
   * Controlled, authenticated shutdown of all native processes, session tabs, and
   * ChatGPT web tabs for a workspace prior to deleting the workspace record.
   */
  async shutdownWorkspace(workspaceId: WorkspaceId, terminationDeadlineMs = 5000): Promise<void> {
    const ws = this.workspaces.getWorkspace(workspaceId);
    if (!ws) return;

    // 1. Request graceful shutdown of all active processes belonging to this workspace.
    const sessions = this.native.list(workspaceId);
    for (const session of sessions) {
      if (['starting', 'running', 'stopping'].includes(session.lifecycle)) {
        await this.native.stop(session.id).catch(() => undefined);
      }
    }

    // 2. Bounded wait for process termination verification.
    const deadline = Date.now() + terminationDeadlineMs;
    while (this.native.list(workspaceId).some(s => ['starting', 'running', 'stopping'].includes(s.lifecycle))) {
      if (Date.now() >= deadline) {
        throw new AgencyRuntimeError('session-unavailable', 'Process termination could not be verified within deadline; workspace deletion aborted');
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    // 3. Close each workspace-owned logical session tab through existing supported lifecycle.
    for (const session of this.native.list(workspaceId)) {
      if (session.tab?.current && !session.tab.closedAt) {
        await this.native.tabAction(workspaceId, session.tab.id, 'close');
      }
    }

    // 4. Close all workspace-owned ChatGPT tabs through the browser-tab adapter.
    // Authorized closure during workspace deletion permits inactive (done/archived) workspaces.
    const webTabs = this.browser.listTabs(workspaceId, { includeClosed: false });
    for (const tab of webTabs) {
      await this.browser.closeTab(workspaceId, tab.id, { allowInactiveWorkspace: true });
    }

    // 5. Broadcast snapshots so clients and Electron reconcile/destroy native views.
    this.snapshot();

    // 6. Delete layout for deleted workspace if present.
    await this.layouts?.delete(workspaceId);

    // 7. Recheck blocking resources before final deletion.
    if (this.native.hasWorkspaceReferences(workspaceId)) {
      throw new AgencyRuntimeError('conflict', 'Native session references remain; workspace deletion aborted');
    }
    if (this.hasBrowserReferences(workspaceId)) {
      throw new AgencyRuntimeError('conflict', 'Browser tab references remain; workspace deletion aborted');
    }
  }
}

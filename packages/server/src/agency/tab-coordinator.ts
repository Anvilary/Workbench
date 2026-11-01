import { assignCreatedTab, reconcileLayout } from '@agent-workbench/shared';
import type { AgencyClientMessage, AgencyServerMessage, EditorTabClientMessage, WebTabClientMessage, WorkspaceId, WorkspacePaneLayout } from '@agent-workbench/shared';
import { AgencyRuntimeError, type AgencySessionRuntime } from './agency-session-runtime.js';
import type { AgencyWorkspaceStore } from './store.js';
import { WorkspaceMutex } from './workspace-lock.js';
import type { BrowserTabAdapter } from './browser-tabs/browser-tab-adapter.js';
import { handleWebTabMessage } from './browser-tabs/web-tab-handler.js';
import type { AgencyLayoutStore } from './agency-layout-store.js';
import type { EditorTabAdapter } from './editor-tabs/editor-tab-adapter.js';
import { handleEditorTabMessage } from './editor-tabs/editor-tab-handler.js';

/** One serialized authority for selection across native sessions, browser tabs, and editor tabs.
 * The reservation mutex inside the native runtime remains independent: browser
 * and editor selection call back into that runtime without recursively locking it.
 */
export class AgencyTabCoordinator {
  readonly mutations = new WorkspaceMutex();
  private lastNativeSnapshot: string | undefined;
  private lastBrowserSnapshot: string | undefined;
  private lastEditorSnapshot: string | undefined;

  constructor(
    readonly native: AgencySessionRuntime,
    readonly browser: BrowserTabAdapter,
    readonly workspaces: AgencyWorkspaceStore,
    private readonly publish: (message: AgencyServerMessage) => void,
    readonly layouts?: AgencyLayoutStore,
    readonly editor?: EditorTabAdapter,
  ) {
    browser.setSelectionCoordinator({
      unselectNativeTabs: async (workspaceId) => {
        await native.clearWorkspaceSelection(workspaceId);
        await this.editor?.clearWorkspaceSelection(workspaceId);
      },
    });
    if (this.editor) {
      this.editor.setSelectionCoordinator({
        unselectOtherTabs: async (workspaceId) => {
          await native.clearWorkspaceSelection(workspaceId);
          await browser.clearWorkspaceSelection(workspaceId);
        },
      });
    }
  }

  private openNative(workspaceId?: WorkspaceId) {
    return this.native.list(workspaceId).filter(session => session.tab?.current && !session.tab.closedAt);
  }

  hasBrowserReferences(workspaceId: WorkspaceId): boolean {
    return this.browser.listTabs(workspaceId, { includeClosed: true }).some(tab => !tab.closedAt);
  }

  hasEditorReferences(workspaceId: WorkspaceId): boolean {
    return this.editor ? this.editor.listTabs(workspaceId, { includeClosed: true }).some(tab => !tab.closedAt) : false;
  }

  canInspect(workspaceId: WorkspaceId, tabId: string): boolean {
    const workspace = this.workspaces.getWorkspace(workspaceId);
    if (!workspace || workspace.status !== 'active' ||
        !this.workspaces.listProjects().some(project => project.id === workspace.projectId && project.status !== 'archived')) return false;
    const web = this.browser.getTabState(tabId);
    if (web) return web.workspaceId === workspaceId && !web.closedAt && web.selected && web.runtimeState === 'client-managed';
    const editor = this.editor?.getTabState(tabId);
    if (editor) return editor.workspaceId === workspaceId && !editor.closedAt && editor.selected;
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
    if (this.editor) {
      const editorTabs = this.editor.listTabs();
      const editorSnapshot = JSON.stringify(editorTabs);
      if (editorSnapshot !== this.lastEditorSnapshot) {
        this.publish({ type: 'agency.editorTabs.snapshot', requestId: '', tabs: editorTabs });
        this.lastEditorSnapshot = editorSnapshot;
      }
    }
  }

  /** Resolve a partial cross-store selection commit conservatively on startup. */
  async restoreSelection(): Promise<void> {
    for (const workspace of this.workspaces.listWorkspaces()) {
      const web = this.browser.listTabs(workspace.id).find(tab => tab.selected);
      const native = this.openNative(workspace.id).find(session => session.tab?.selected);
      const editor = this.editor?.listTabs(workspace.id).find(tab => tab.selected);
      const selected = [
        web ? { type: 'web' as const, time: web.updatedAt } : null,
        native ? { type: 'native' as const, time: native.updatedAt } : null,
        editor ? { type: 'editor' as const, time: editor.updatedAt } : null,
      ].filter((item): item is { type: 'web' | 'native' | 'editor'; time: string } => item !== null);
      if (selected.length <= 1) continue;
      selected.sort((a, b) => b.time.localeCompare(a.time));
      const keep = selected[0]!.type;
      if (keep !== 'native') await this.native.clearWorkspaceSelection(workspace.id);
      if (keep !== 'web') await this.browser.clearWorkspaceSelection(workspace.id);
      if (keep !== 'editor') await this.editor?.clearWorkspaceSelection(workspace.id);
    }
  }

  private async selectFallback(workspaceId: WorkspaceId): Promise<void> {
    const native = this.openNative(workspaceId);
    const web = this.browser.listTabs(workspaceId);
    const editor = this.editor ? this.editor.listTabs(workspaceId) : [];
    if (native.some(session => session.tab?.selected) || web.some(tab => tab.selected) || editor.some(tab => tab.selected)) return;
    if (native[0]?.tab) await this.native.tabAction(workspaceId, native[0].tab.id, 'select');
    else if (web[0]) await this.browser.selectTab(workspaceId, web[0].id);
    else if (editor[0]) await this.editor?.selectTab(workspaceId, editor[0].id);
  }

  async order(workspaceId: WorkspaceId, ids: readonly string[]): Promise<void> {
    const native = this.openNative(workspaceId).map(session => session.tab!.id);
    const web = this.browser.listTabs(workspaceId).map(tab => tab.id);
    const editor = this.editor ? this.editor.listTabs(workspaceId).map(tab => tab.id) : [];
    const all = [...native, ...web, ...editor];
    if (ids.length !== all.length || new Set(ids).size !== ids.length || all.some(id => !ids.includes(id))) {
      throw new AgencyRuntimeError('invalid-request', 'Order must contain every open tab exactly once');
    }
    const positions = new Map(ids.map((id, index) => [id, index]));
    await this.native.orderTabs(workspaceId, ids.filter(id => native.includes(id)), positions);
    if (web.length) await this.browser.orderTabs(workspaceId, ids.filter(id => web.includes(id)), positions);
    if (editor.length && this.editor) await this.editor.orderTabs(workspaceId, ids.filter(id => editor.includes(id)), positions);
  }

  reconcileLayout(workspaceId: WorkspaceId): WorkspacePaneLayout | undefined {
    if (!this.layouts) return undefined;
    const open = [
      ...this.openNative(workspaceId).map(session => session.tab!.id),
      ...this.browser.listTabs(workspaceId).map(tab => tab.id),
      ...(this.editor ? this.editor.listTabs(workspaceId).map(tab => tab.id) : []),
    ];
    return reconcileLayout(this.layouts.get(workspaceId), workspaceId, open);
  }

  reconcileAllLayouts(): WorkspacePaneLayout[] {
    if (!this.layouts) return [];
    const workspaceIds = new Set<WorkspaceId>();
    for (const ws of this.workspaces.listWorkspaces()) workspaceIds.add(ws.id);
    for (const l of this.layouts.list()) workspaceIds.add(l.workspaceId);
    for (const session of this.openNative()) workspaceIds.add(session.workspaceId);
    for (const tab of this.browser.listTabs()) workspaceIds.add(tab.workspaceId);
    if (this.editor) for (const tab of this.editor.listTabs()) workspaceIds.add(tab.workspaceId);

    const reconciled: WorkspacePaneLayout[] = [];
    for (const wsId of workspaceIds) {
      const open = [
        ...this.openNative(wsId).map(session => session.tab!.id),
        ...this.browser.listTabs(wsId).map(tab => tab.id),
        ...(this.editor ? this.editor.listTabs(wsId).map(tab => tab.id) : []),
      ];
      const saved = this.layouts.get(wsId);
      if (saved || open.length > 0) {
        reconciled.push(reconcileLayout(saved, wsId, open));
      }
    }
    return reconciled;
  }

  private resolveTabLabel(workspaceId: WorkspaceId, tabId: string): string {
    const webTab = this.browser.listTabs(workspaceId).find(t => t.id === tabId);
    if (webTab) return webTab.title || 'ChatGPT';
    const editorTab = this.editor?.getTabState(tabId);
    if (editorTab) return editorTab.title;
    const session = this.native.list(workspaceId).find(s => s.tab?.id === tabId);
    if (session?.tab?.name) return session.tab.name;
    if (session?.kind === 'terminal') {
      return session.tab?.terminalNumber ? `Terminal ${session.tab.terminalNumber}` : 'Terminal';
    }
    if (session?.profileId) return session.profileId;
    return tabId;
  }

  private async placeCreatedTab(workspaceId: WorkspaceId, targetPaneId: string | undefined, tabId: string): Promise<void> {
    if (!targetPaneId || !this.layouts) return;
    const open = [
      ...this.openNative(workspaceId).map(session => session.tab!.id),
      ...this.browser.listTabs(workspaceId).map(tab => tab.id),
      ...(this.editor ? this.editor.listTabs(workspaceId).map(tab => tab.id) : []),
    ];
    try {
      const layout = await this.layouts.update(workspaceId, current =>
        assignCreatedTab(reconcileLayout(current, workspaceId, open), targetPaneId, tabId));
      this.publish({ type: 'agency.layout.changed', workspaceId, layout });
    } catch (error) {
      console.error('[tab-coordinator] Failed to persist tab layout placement:', error);
      const tabLabel = this.resolveTabLabel(workspaceId, tabId);
      this.publish({
        type: 'agency.error',
        requestId: '',
        workspaceId,
        tabId,
        code: 'internal-error',
        message: `Layout placement persistence failure for tab "${tabLabel}". Safe layout reconciliation will restore placement on reconnect or refresh.`,
      });
    }
  }

  async createNative(message: Extract<AgencyClientMessage, { type: 'agency.session.create' }>) {
    return this.mutations.runExclusive(message.workspaceId, async () => {
      try {
        const before = [
          ...this.openNative(message.workspaceId).map(session => ({ id: session.tab!.id, order: session.tab!.order })),
          ...this.browser.listTabs(message.workspaceId).map(tab => ({ id: tab.id, order: tab.order })),
          ...(this.editor ? this.editor.listTabs(message.workspaceId).map(tab => ({ id: tab.id, order: tab.order })) : []),
        ].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        const session = await this.native.create(message);
        if (session.tab?.selected) {
          await this.browser.clearWorkspaceSelection(message.workspaceId);
          await this.editor?.clearWorkspaceSelection(message.workspaceId);
        }
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
        if (message.type === 'agency.tab.rename') {
          if (this.editor?.getTabState(message.tabId)) {
            await this.editor.renameTab(message.workspaceId, message.tabId, message.name);
          } else {
            await this.native.renameTab(message.workspaceId, message.tabId, message.name);
          }
        } else if (message.type === 'agency.tabs.order') {
          await this.order(message.workspaceId, message.tabIds);
        } else {
          if (this.editor?.getTabState(message.tabId)) {
            if (message.action === 'close') {
              await this.editor.closeTab(message.workspaceId, message.tabId);
              await this.selectFallback(message.workspaceId);
            } else if (message.action === 'select') {
              await this.editor.selectTab(message.workspaceId, message.tabId);
              await this.browser.clearWorkspaceSelection(message.workspaceId);
              await this.native.clearWorkspaceSelection(message.workspaceId);
            }
          } else {
            await this.native.tabAction(message.workspaceId, message.tabId, message.action);
            if (message.action === 'select' || message.action === 'resume') {
              await this.browser.clearWorkspaceSelection(message.workspaceId);
              await this.editor?.clearWorkspaceSelection(message.workspaceId);
            } else {
              await this.selectFallback(message.workspaceId);
            }
          }
        }
      } finally { this.snapshot(); }
    });
  }

  async webRequest(message: WebTabClientMessage) {
    const execute = async () => {
      try {
        const request = message.type === 'agency.webTab.create' && message.order === undefined
          ? { ...message, order: Math.max(-1, ...this.openNative(message.workspaceId).map(session => session.tab!.order),
              ...this.browser.listTabs(message.workspaceId).map(tab => tab.order),
              ...(this.editor ? this.editor.listTabs(message.workspaceId).map(tab => tab.order) : [])) + 1 }
          : message;
        const response = await handleWebTabMessage(request, { adapter: this.browser, publish: this.publish });
        if (message.type === 'agency.webTab.create' && response?.type === 'agency.webTab.created') {
          await this.placeCreatedTab(message.workspaceId, message.targetPaneId, response.tab.id);
        }
        if (message.type === 'agency.webTab.select' && response?.type === 'agency.webTab.updated') {
          await this.editor?.clearWorkspaceSelection(message.workspaceId);
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

  async editorRequest(message: EditorTabClientMessage) {
    if (!this.editor) return null;
    const adapter = this.editor;
    const execute = async () => {
      try {
        const request = message.type === 'agency.editorTab.open' && message.order === undefined
          ? {
              ...message,
              order: Math.max(
                -1,
                ...this.openNative(message.workspaceId).map(s => s.tab!.order),
                ...this.browser.listTabs(message.workspaceId).map(t => t.order),
                ...(this.editor ? this.editor.listTabs(message.workspaceId).map(t => t.order) : []),
              ) + 1,
            }
          : message;
        const response = await handleEditorTabMessage(request, { adapter, publish: this.publish });
        if (message.type === 'agency.editorTab.open' && response?.type === 'agency.editorTab.opened') {
          await this.placeCreatedTab(message.workspaceId, message.targetPaneId, response.tab.id);
        }
        if (message.type === 'agency.editorTab.close' && response?.type !== 'agency.error') {
          await this.selectFallback(message.workspaceId);
        }
        return response;
      } finally {
        if (message.type !== 'agency.editorTabs.list') this.snapshot();
      }
    };
    return 'workspaceId' in message && message.workspaceId
      ? this.mutations.runExclusive(message.workspaceId, execute)
      : execute();
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

    // 5. Close all workspace-owned editor tabs through the editor-tab adapter.
    if (this.editor) {
      const editorTabs = this.editor.listTabs(workspaceId, { includeClosed: false });
      for (const tab of editorTabs) {
        await this.editor.closeTab(workspaceId, tab.id, { allowInactiveWorkspace: true });
      }
    }

    // 6. Broadcast snapshots so clients and Electron reconcile/destroy native views.
    this.snapshot();

    // 7. Delete layout for deleted workspace if present.
    await this.layouts?.delete(workspaceId);

    // 8. Recheck blocking resources before final deletion.
    if (this.native.hasWorkspaceReferences(workspaceId)) {
      throw new AgencyRuntimeError('conflict', 'Native session references remain; workspace deletion aborted');
    }
    if (this.hasBrowserReferences(workspaceId)) {
      throw new AgencyRuntimeError('conflict', 'Browser tab references remain; workspace deletion aborted');
    }
    if (this.hasEditorReferences(workspaceId)) {
      throw new AgencyRuntimeError('conflict', 'Editor tab references remain; workspace deletion aborted');
    }
  }
}

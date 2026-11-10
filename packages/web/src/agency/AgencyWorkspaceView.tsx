import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgencyCliProfile, AgencyRuntimeSession, AgencyWorkspace, CliProfileId,
  EditorTab, MawActivityState, SplitDirection, WebTab, WorkspaceId, WorkspacePaneLayout,
} from '@agent-workbench/shared';
import {
  assignCreatedTab, swapPanes, countLeaves, createDefaultLayout, findPaneNode, getPaneNodes, moveTabBetweenPanes,
  reconcileLayout, splitPane, closePane, updatePaneNode, updateSplitRatio, MAX_LEAVES,
  validateChatGptUrl, validateGithubUrl, validatePerplexityUrl, validateOtherWebUrl, validateWebTabTitle,
} from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import { t } from '../i18n/index.js';
import { AgencyProfileDialog } from './AgencyProfileDialog.js';
import { BrowserContextMenu } from './BrowserContextMenu.js';
import { allWorkspaceTabs, selectedWorkspaceTab, type AgencyTransport, type WorkspaceTab } from './model.js';
import { nativeLayoutCoordinator } from './native-layout-coordinator.js';
import { PaneMovement } from './split/PaneMovement.js';
import { PersistentSessionPanes } from './split/PersistentSessionPanes.js';
import { SplitPaneTree } from './split/SplitPaneTree.js';
import { usePaneInspection } from './split/usePaneInspection.js';
import type { useAgencyStore } from './useAgencyStore.js';
import { editorDraftStore } from './editorDraftStore.js';

interface Props {
  workspace: AgencyWorkspace;
  profiles: readonly AgencyCliProfile[];
  sessions: readonly AgencyRuntimeSession[];
  webTabs: readonly WebTab[];
  editorTabs?: readonly EditorTab[];
  getTabActivityVersion?: (workspaceId: WorkspaceId, tabId: string) => string;
  onTabDisplayed?: (workspaceId: WorkspaceId, tabId: string) => void;
  connection: AgentConnection;
  request: ReturnType<typeof useAgencyStore>['request'];
  sendImmediate: AgencyTransport['sendImmediate'];
  online: boolean;
  draft?: string;
  onDraft?: (value: string) => void;
  onDelivered?: (value: string) => void;
  onDone: () => void;
  launchError?: string | null;
  onClearLaunchError?: () => void;
  placementWarning?: string | null;
  onClearPlacementWarning?: () => void;
  getTabActivity?: (workspaceId: WorkspaceId, tabId: string) => MawActivityState;
  onAcknowledgeTab?: (workspaceId: WorkspaceId, tabId: string) => Promise<void> | void;
  savedLayout?: WorkspacePaneLayout;
  onSaveLayout?: (workspaceId: WorkspaceId, layout: WorkspacePaneLayout) => Promise<unknown>;
}

const EMPTY_EDITOR_TABS: readonly EditorTab[] = [];

export function AgencyWorkspaceView({
  workspace,
  profiles,
  sessions,
  webTabs,
  editorTabs = EMPTY_EDITOR_TABS,
  connection,
  request,
  sendImmediate,
  online,
  onDone,
  launchError,
  onClearLaunchError,
  placementWarning,
  onClearPlacementWarning,
  getTabActivity,
  onAcknowledgeTab,
  onTabDisplayed,
  getTabActivityVersion,
  savedLayout,
  onSaveLayout,
}: Props): JSX.Element {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const creatingLaunch = useRef<string | null>(null);
  const creationTarget = useRef<string | null>(null);
  const pendingSplit = useRef<null | { paneId: string; direction: SplitDirection }>(null);
  const [createdTabs, setCreatedTabs] = useState<WorkspaceTab[]>([]);
  const [closingTabIds, setClosingTabIds] = useState<ReadonlySet<string>>(() => new Set());
  const closingInFlight = useRef<Set<string>>(new Set());
  const serverTabs = allWorkspaceTabs(sessions, webTabs, workspace.id, editorTabs);
  const openServerTabs = serverTabs.filter((tab) => !closingTabIds.has(tab.id));
  const tabs = [
    ...openServerTabs.filter((tab) => (tab.kind === 'web' ? tab.web.launchId : tab.kind === 'native' ? tab.session.launchId : undefined) !== creatingLaunch.current || !creatingLaunch.current),
    ...createdTabs.filter((tab) => !closingTabIds.has(tab.id) && !serverTabs.some((current) => current.id === tab.id)),
  ];
  useEffect(() => {
    setCreatedTabs((current) => {
      if (current.length === 0) return current;
      const next = current.filter((tab) => !serverTabs.some((row) => row.id === tab.id));
      return next.length === current.length ? current : next;
    });
    setClosingTabIds((current) => {
      if (current.size === 0) return current;
      const remaining = new Set<string>();
      for (const id of current) {
        if (serverTabs.some((row) => row.id === id)) {
          remaining.add(id);
        } else {
          closingInFlight.current.delete(id);
        }
      }
      return remaining.size === current.size ? current : remaining;
    });
  }, [sessions, webTabs, editorTabs]);
  const openTabIds = tabs.map((t) => t.id);
  const defaultSelected = selectedWorkspaceTab(tabs)?.id;
  const openTabIdsRef = useRef(openTabIds);
  openTabIdsRef.current = openTabIds;
  const defaultSelectedRef = useRef(defaultSelected);
  defaultSelectedRef.current = defaultSelected;

  const [layout, setLayout] = useState<WorkspacePaneLayout>(() =>
    reconcileLayout(savedLayout, workspace.id, openTabIds, defaultSelected),
  );

  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [webDialog, setWebDialog] = useState<'create' | 'navigate' | null>(null);
  const [webUrl, setWebUrl] = useState('https://chatgpt.com/');
  const [webProvider, setWebProvider] = useState<'chatgpt' | 'github' | 'perplexity' | 'other'>('chatgpt');
  const [webTitle, setWebTitle] = useState('');
  const [configuringProfile, setConfiguringProfile] = useState<AgencyCliProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<WorkspaceTab | null>(null);
  const [fileDialog, setFileDialog] = useState<null | { paneId: string; direction?: SplitDirection }>(null);
  const [filePathInput, setFilePathInput] = useState('');
  const [unsavedTabIds, setUnsavedTabIds] = useState<ReadonlySet<string>>(
    () => new Set(editorDraftStore.listDirtyTabIds()),
  );
  useEffect(() => {
    const sync = () => {
      const dirtyIds = editorDraftStore.listDirtyTabIds();
      setUnsavedTabIds((prev) => {
        if (prev.size === dirtyIds.length && dirtyIds.every((id) => prev.has(id))) return prev;
        return new Set(dirtyIds);
      });
    };
    return editorDraftStore.subscribe(sync);
  }, []);

  useEffect(() => {
    return editorDraftStore.attachConnection(connection);
  }, [connection]);

  useEffect(() => {
    if (!online) {
      editorDraftStore.handleDisconnect();
    }
  }, [online]);
  const handleDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    setUnsavedTabIds((prev) => {
      if (prev.has(tabId) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  }, []);
  const [busy, setBusy] = useState(false);
  const [displayed, setDisplayed] = useState<ReadonlySet<string>>(() => new Set());
  const selecting = useRef(0);
  const flight = useRef(false);
  const paneHosts = useRef(new Map<string, HTMLElement>());
  const [hostVersion, setHostVersion] = useState(0);
  const registerPaneHost = useCallback((paneId: string, element: HTMLElement | null) => {
    const current = paneHosts.current.get(paneId) ?? null;
    if (current === element) return;
    if (element) paneHosts.current.set(paneId, element);
    else paneHosts.current.delete(paneId);
    setHostVersion((version) => version + 1);
  }, []);
  const dialog = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const persistence = useRef(onSaveLayout);
  persistence.current = onSaveLayout;
  useEffect(() => () => {
    if (saveTimer.current === null) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    // Flush a divider edit before leaving this workspace, reconciling against current open tabs
    const currentOpen = openTabIdsRef.current;
    const currentLayout = reconcileLayout(layoutRef.current, workspace.id, currentOpen, defaultSelectedRef.current);
    void persistence.current?.(workspace.id, currentLayout).catch(reason => console.warn('[maw-layout] save failed:', reason));
  }, [workspace.id]);

  const serverSelectedId = selectedWorkspaceTab(tabs)?.id;

  const currentTabKey = openTabIds.join(',');
  const [prevTabKey, setPrevTabKey] = useState(currentTabKey);
  if (currentTabKey !== prevTabKey) {
    setPrevTabKey(currentTabKey);
    const reconciled = reconcileLayout(layout, workspace.id, openTabIds, defaultSelected);
    layoutRef.current = reconciled;
    setLayout(reconciled);
  }

  const [prevServerSelected, setPrevServerSelected] = useState(serverSelectedId);
  if (serverSelectedId !== prevServerSelected) {
    setPrevServerSelected(serverSelectedId);
    if (serverSelectedId && !selecting.current && !flight.current) {
      const panes = getPaneNodes(layout.tree);
      const ownerPane = panes.find((p) => p.tabIds.includes(serverSelectedId));
      if (ownerPane) {
        const nextTree = updatePaneNode(layout.tree, ownerPane.id, (p) => ({
          ...p,
          selectedTabId: serverSelectedId,
        }));
        const nextLayout = {
          ...layout,
          tree: nextTree,
          focusedPaneId: ownerPane.id,
        };
        layoutRef.current = nextLayout;
        setLayout(nextLayout);
      }
    }
  }

  // Sync with incoming server layout when available
  const initialSavedLayoutApplied = useRef(Boolean(savedLayout));
  useEffect(() => {
    if (savedLayout && savedLayout.workspaceId === workspace.id) {
      setLayout((prev) => {
        if (!initialSavedLayoutApplied.current || savedLayout.updatedAt > prev.updatedAt) {
          initialSavedLayoutApplied.current = true;
          const next = reconcileLayout(savedLayout, workspace.id, openTabIds, defaultSelected);
          layoutRef.current = next;
          return next;
        }
        return prev;
      });
    }
  }, [savedLayout, workspace.id, openTabIds, defaultSelected]);

  const save = useCallback(
    (nextLayout: WorkspacePaneLayout, immediate = false) => {
      const currentOpen = openTabIdsRef.current;
      const sanitized = reconcileLayout(nextLayout, workspace.id, currentOpen, defaultSelectedRef.current);
      layoutRef.current = sanitized;
      setLayout(sanitized);
      if (saveTimer.current !== null) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (immediate) {
        void onSaveLayout?.(workspace.id, sanitized).catch((reason) => {
          setError(t('agency.splits.saveFailed', { error: String(reason) }));
          const fallback = reconcileLayout(savedLayout ?? layoutRef.current, workspace.id, openTabIdsRef.current, defaultSelectedRef.current);
          layoutRef.current = fallback;
          setLayout(fallback);
        });
      } else {
        saveTimer.current = window.setTimeout(() => {
          const freshOpen = openTabIdsRef.current;
          const freshLayout = reconcileLayout(layoutRef.current, workspace.id, freshOpen, defaultSelectedRef.current);
          layoutRef.current = freshLayout;
          void onSaveLayout?.(workspace.id, freshLayout).catch((reason) => {
            setError(t('agency.splits.saveFailed', { error: String(reason) }));
            const fallback = reconcileLayout(savedLayout ?? layoutRef.current, workspace.id, openTabIdsRef.current, defaultSelectedRef.current);
            layoutRef.current = fallback;
            setLayout(fallback);
          });
          saveTimer.current = null;
        }, 200);
      }
    },
    [workspace.id, onSaveLayout, savedLayout],
  );

  const handleSplit = useCallback(
    (targetPaneId: string, direction: SplitDirection, tabIdToMove?: string) => {
      const newPaneId = `pane-${crypto.randomUUID().slice(0, 8)}`;
      const nextTree = splitPane(layout.tree, targetPaneId, direction, newPaneId, tabIdToMove);
      if (nextTree) {
        save(
          {
            ...layout,
            tree: nextTree,
            focusedPaneId: newPaneId,
            updatedAt: new Date().toISOString(),
          },
          true,
        );
      }
    },
    [layout, save],
  );

  const handleClosePane = useCallback(
    (paneId: string) => {
      const res = closePane(layout.tree, paneId);
      if (res) {
        save(
          {
            ...layout,
            tree: res.tree,
            focusedPaneId:
              layout.focusedPaneId === paneId ? res.remainingPaneId : layout.focusedPaneId,
            maximizedPaneId:
              layout.maximizedPaneId === paneId ? null : layout.maximizedPaneId,
            updatedAt: new Date().toISOString(),
          },
          true,
        );
      }
    },
    [layout, save],
  );

  const handleToggleMaximize = useCallback(
    (paneId: string) => {
      save(
        {
          ...layout,
          maximizedPaneId: layout.maximizedPaneId === paneId ? null : paneId,
          updatedAt: new Date().toISOString(),
        },
        true,
      );
    },
    [layout, save],
  );

  const handleSinglePane = useCallback(() => {
    const single = createDefaultLayout(workspace.id, openTabIds, defaultSelected);
    save(single, true);
  }, [workspace.id, openTabIds, defaultSelected, save]);

  const handleUpdateRatio = useCallback(
    (splitId: string, ratio: number) => {
      const nextTree = updateSplitRatio(layout.tree, splitId, ratio);
      save(
        {
          ...layout,
          tree: nextTree,
          updatedAt: new Date().toISOString(),
        },
        false,
      );
    },
    [layout, save],
  );

  const handleMoveTab = useCallback(
    (tabId: string, targetPaneId: string, targetIndex?: number) => {
      if (!tabs.some(tab => tab.id === tabId) || !findPaneNode(layout.tree, targetPaneId)) return;
      const nextTree = moveTabBetweenPanes(layout.tree, tabId, targetPaneId, targetIndex);
      save(
        {
          ...layout,
          tree: nextTree,
          focusedPaneId: targetPaneId,
          updatedAt: new Date().toISOString(),
        },
        true,
      );
    },
    [layout, save, tabs],
  );

  const handleSelectTab = useCallback(
    (paneId: string, tabId: string) => {
      if (!findPaneNode(layout.tree, paneId)?.tabIds.includes(tabId)) return;
      const nextTree = updatePaneNode(layout.tree, paneId, (pane) => ({
        ...pane,
        selectedTabId: tabId,
      }));
      save(
        {
          ...layout,
          tree: nextTree,
          focusedPaneId: paneId,
          updatedAt: new Date().toISOString(),
        },
        true,
      );
    },
    [layout, save],
  );

  const handleFocusPane = useCallback(
    (paneId: string) => {
      if (layout.focusedPaneId !== paneId) {
        save({ ...layout, focusedPaneId: paneId, updatedAt: new Date().toISOString() }, true);
      }
    },
    [layout, save],
  );

  const reportDisplayed = useCallback((id: string, ready: boolean) => {
    setDisplayed((previous) => {
      if (previous.has(id) === ready) return previous;
      const next = new Set(previous);
      if (ready) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const focusedPane = findPaneNode(layout.tree, layout.focusedPaneId);
  const activeTabId = focusedPane?.selectedTabId;
  const activity = activeTabId ? getTabActivity?.(workspace.id, activeTabId) : undefined;
  const activityVersion = activeTabId
    ? getTabActivityVersion?.(workspace.id, activeTabId) ?? ''
    : '';

  useEffect(() => {
    nativeLayoutCoordinator.setFocusedTabId(activeTabId ?? null);
  }, [activeTabId]);

  useEffect(() => {
    return () => {
      nativeLayoutCoordinator.setFocusedTabId(null);
    };
  }, []);

  usePaneInspection({
    workspaceId: workspace.id,
    tab: tabs.find((tab) => tab.id === activeTabId),
    serverSelectedId, online, displayed, activity, activityVersion, request,
    onDisplayed: onTabDisplayed,
    onAcknowledge: onAcknowledgeTab,
    onError: setError,
    onSelectionFailed: () => {
      const owner = getPaneNodes(layout.tree).find((pane) => pane.tabIds.includes(serverSelectedId ?? ''));
      if (!owner || !serverSelectedId) return;
      save({
        ...layout,
        tree: updatePaneNode(layout.tree, owner.id, (pane) => ({ ...pane, selectedTabId: serverSelectedId })),
        focusedPaneId: owner.id,
        updatedAt: new Date().toISOString(),
      }, true);
    },
  }, selecting);

  useEffect(() => {
    if ((!closing && !webDialog && !fileDialog) || configuringProfile) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !flight.current) {
        pendingSplit.current = null;
        setClosing(null);
        setWebDialog(null);
        setFileDialog(null);
      }
      if (event.key === 'Tab' && dialog.current) {
        const elements = [
          ...dialog.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), select:not(:disabled), input:not(:disabled)',
          ),
        ];
        const first = elements[0];
        const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [closing, webDialog, fileDialog, configuringProfile]);

  function completeCreation(response: Awaited<ReturnType<Props['request']>>, targetPaneId: string) {
    // The server commits the destination even if this workspace was switched away.
    if (!mounted.current) return;
    const created = response.type === 'agency.session.created'
      ? allWorkspaceTabs([response.session], [], workspace.id)[0]
      : response.type === 'agency.webTab.created'
        ? allWorkspaceTabs([], [response.tab], workspace.id)[0]
        : response.type === 'agency.editorTab.opened'
          ? allWorkspaceTabs([], [], workspace.id, [response.tab])[0]
          : undefined;
    if (!created) throw new Error(t('agency.errors.internalError'));
    setCreatedTabs((current) => [...current.filter((tab) => tab.id !== created.id), created]);
    if (!openTabIdsRef.current.includes(created.id)) {
      openTabIdsRef.current = [...openTabIdsRef.current, created.id];
    }
    save(assignCreatedTab(layoutRef.current, targetPaneId, created.id), true);
  }

  function handleSwapPane(source: string, target: string) {
    const current = layoutRef.current;
    if (!online || current.workspaceId !== workspace.id || current.maximizedPaneId) return;
    const tree = swapPanes(current.tree, source, target);
    if (!tree) return;
    save({ ...current, tree, focusedPaneId: source, updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString() }, true);
  }

  function takeSplitPane(fallback: string): { paneId: string; created: boolean } {
    const pending = pendingSplit.current;
    pendingSplit.current = null;
    if (!pending) return { paneId: fallback, created: false };
    if (countLeaves(layoutRef.current.tree) >= MAX_LEAVES) return { paneId: fallback, created: false };
    const newPaneId = `pane-${crypto.randomUUID().slice(0, 8)}`;
    const nextTree = splitPane(layoutRef.current.tree, pending.paneId, pending.direction, newPaneId, undefined, true);
    if (!nextTree) return { paneId: fallback, created: false };
    save({
      ...layoutRef.current,
      tree: nextTree,
      focusedPaneId: newPaneId,
      updatedAt: new Date().toISOString(),
    }, true);
    return { paneId: newPaneId, created: true };
  }

  function rollbackPane(paneId: string) {
    const closed = closePane(layoutRef.current.tree, paneId);
    if (!closed) return;
    save({
      ...layoutRef.current,
      tree: closed.tree,
      focusedPaneId: closed.remainingPaneId || layoutRef.current.focusedPaneId,
      updatedAt: new Date().toISOString(),
    }, true);
  }

  async function add(kind: 'agent' | 'terminal', targetPaneId = creationTarget.current ?? layoutRef.current.focusedPaneId, profileOverride?: string) {
    const profile = profileOverride;
    if (flight.current || !online || (kind === 'agent' && !profile)) {
      pendingSplit.current = null;
      return;
    }
    const placed = takeSplitPane(targetPaneId);
    flight.current = true;
    const launchId = crypto.randomUUID();
    creatingLaunch.current = launchId;
    setBusy(true);
    setError(null);
    try {
      const response = await request({
        type: 'agency.session.create',
        workspaceId: workspace.id,
        kind,
        targetPaneId: placed.paneId,
        launchId,
        cols: 100,
        rows: 30,
        ...(kind === 'agent' ? { profileId: profile as CliProfileId } : {}),
      } as Parameters<Props['request']>[0]);
      completeCreation(response, placed.paneId);
    } catch (reason) {
      if (placed.created) rollbackPane(placed.paneId);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      creatingLaunch.current = null;
      flight.current = false;
      setBusy(false);
    }
  }

  async function startAgain(session: AgencyRuntimeSession) {
    if (flight.current || !online || session.kind !== 'agent' || !session.tab) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await request({
        type: 'agency.tab.action',
        workspaceId: workspace.id,
        tabId: session.tab.id,
        action: 'close',
      });
      await request({
        type: 'agency.session.create',
        workspaceId: workspace.id,
        kind: 'agent',
        launchId: crypto.randomUUID(),
        cols: 100,
        rows: 30,
        profileId: session.profileId,
      } as Parameters<Props['request']>[0]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  async function openEditorFile(filePath: string, targetPaneId = creationTarget.current ?? layoutRef.current.focusedPaneId) {
    if (flight.current || !online || !filePath.trim()) {
      pendingSplit.current = null;
      return;
    }
    const placed = takeSplitPane(targetPaneId);
    flight.current = true;
    setBusy(true);
    try {
      const response = await request({
        type: 'agency.editorTab.open',
        workspaceId: workspace.id,
        filePath: filePath.trim(),
        targetPaneId: placed.paneId,
        select: true,
      });
      completeCreation(response, placed.paneId);
      setFileDialog(null);
      setFilePathInput('');
    } catch (reason) {
      if (placed.created) rollbackPane(placed.paneId);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  async function action(tab: WorkspaceTab, act: 'select' | 'close') {
    if (!online) throw new Error(t('agency.web.disconnected'));
    try {
      await request(
        tab.kind === 'web'
          ? {
              type: act === 'select' ? 'agency.webTab.select' : 'agency.webTab.close',
              workspaceId: workspace.id,
              tabId: tab.id,
            }
          : tab.kind === 'editor'
            ? {
                type: act === 'select' ? 'agency.editorTab.select' : 'agency.editorTab.close',
                workspaceId: workspace.id,
                tabId: tab.id,
              }
            : {
                type: 'agency.tab.action',
                workspaceId: workspace.id,
                tabId: tab.id,
                action: act,
              },
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }

  async function close(tab: WorkspaceTab) {
    if (closingInFlight.current.has(tab.id)) return;
    closingInFlight.current.add(tab.id);
    setClosing(null);
    setClosingTabIds((prev) => new Set(prev).add(tab.id));
    if (tab.kind === 'editor') {
      editorDraftStore.clearDraft(tab.id);
      setUnsavedTabIds((prev) => {
        if (!prev.has(tab.id)) return prev;
        const next = new Set(prev);
        next.delete(tab.id);
        return next;
      });
    }
    try {
      await action(tab, 'close');
    } catch (reason) {
      // Backend rejected termination or request failed:
      // Recoverable closing lifecycle rolls back optimistic removal and restores tab.
      closingInFlight.current.delete(tab.id);
      setClosingTabIds((prev) => {
        const next = new Set(prev);
        next.delete(tab.id);
        return next;
      });
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      closingInFlight.current.delete(tab.id);
    }
  }

  function webEditor(mode: 'create' | 'navigate') {
    setError(null);
    setWebDialog(mode);
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const provider = activeTab?.kind === 'web' && mode !== 'create' ? (activeTab.web.provider ?? 'chatgpt') : 'chatgpt';
    setWebProvider(provider);
    setWebUrl(activeTab?.kind === 'web' && mode !== 'create' ? activeTab.web.url : provider === 'other' ? 'https://example.com/' : 'https://chatgpt.com/');
    setWebTitle(activeTab?.kind === 'web' && mode !== 'create' ? activeTab.web.title : t('agency.web.defaultTitle'));
  }

  async function saveWeb() {
    if (flight.current || !online || !webDialog) return;
    const url = webProvider === 'github' ? validateGithubUrl(webUrl) : webProvider === 'perplexity' ? validatePerplexityUrl(webUrl) : webProvider === 'other' ? validateOtherWebUrl(webUrl) : validateChatGptUrl(webUrl);
    if (!url.valid) {
      setError(t('agency.web.invalidUrl'));
      return;
    }
    if (webDialog !== 'navigate' && !validateWebTabTitle(webTitle)) {
      setError(t('agency.web.invalidTitle'));
      return;
    }
    const placed = webDialog === 'create'
      ? takeSplitPane(creationTarget.current ?? layoutRef.current.focusedPaneId)
      : { paneId: creationTarget.current ?? layoutRef.current.focusedPaneId, created: false };
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (webDialog === 'create') {
        const targetPaneId = placed.paneId;
        const launchId = crypto.randomUUID();
        creatingLaunch.current = launchId;
        const response = await request({
          type: 'agency.webTab.create',
          workspaceId: workspace.id,
          url: url.normalizedUrl!,
          provider: webProvider,
          title: webTitle.trim(),
          select: true,
          targetPaneId,
          launchId,
        });
        completeCreation(response, targetPaneId);
      } else if (activeTabId) {
        const activeTab = tabs.find((t) => t.id === activeTabId);
        if (activeTab?.kind === 'web') {
          await request({
            type: 'agency.webTab.navigate',
            workspaceId: workspace.id,
            tabId: activeTab.id,
            url: url.normalizedUrl!,
          });
        }
      }
      setWebDialog(null);
    } catch (reason) {
      if (placed.created) rollbackPane(placed.paneId);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      creatingLaunch.current = null;
      flight.current = false;
      setBusy(false);
    }
  }

  function tabDisplayName(tab: WorkspaceTab) {
    if (tab.kind === 'web') return tab.web.title;
    if (tab.kind === 'editor') return tab.editor.title;
    const session = tab.session;
    return (
      session.tab?.name ??
      (session.kind === 'terminal'
        ? t('agency.tabs.terminalNamed', { number: session.tab?.terminalNumber ?? 1 })
        : profiles.find((p) => p.id === session.profileId)?.label ?? t('agency.ui.agentLabel'))
    );
  }

  const leafCount = countLeaves(layout.tree);
  const maximizedNode = layout.maximizedPaneId ? findPaneNode(layout.tree, layout.maximizedPaneId) : null;
  const visibleTree = maximizedNode ?? layout.tree;
  const webHeading = webDialog === 'create' ? t('agency.web.newTab') : t('agency.web.navigate');

  return (
    <section className="agency-workspace-view" aria-label={t('agency.ui.workspaceNamed', { name: workspace.name })}>
      <header className="maw-workspace-topbar">
        <span className="maw-workspace-title">{workspace.name}</span>
        <div className="agency-flex-spacer" />
        <div className="agency-dropdown">
          <button
            type="button"
            className="agency-icon-button"
            aria-label={t('agency.ui.workspaceOptions')}
            aria-haspopup="menu"
            aria-expanded={workspaceMenu}
            onClick={() => setWorkspaceMenu((open) => !open)}
          >
            ···
          </button>
          {workspaceMenu && (
            <div className="agency-dropdown-menu maw-shell-menu" role="menu">
              {leafCount > 1 && (
                <button type="button" role="menuitem" className="agency-dropdown-item" onClick={() => { setWorkspaceMenu(false); handleSinglePane(); }}>
                  {t('agency.splits.singlePane')}
                </button>
              )}
              <button type="button" role="menuitem" className="agency-dropdown-item" onClick={() => { setWorkspaceMenu(false); onDone(); }}>
                {t('agency.ui.markDone')}
              </button>
            </div>
          )}
        </div>
      </header>

      {placementWarning && (
        <div className="agency-notice-bar" role="status">
          <span>{placementWarning}</span>
          <button
            type="button"
            aria-label={t('agency.ui.dismissNotification')}
            onClick={() => onClearPlacementWarning?.()}
          >
            ×
          </button>
        </div>
      )}

      {(error || launchError) && (
        <div className="agency-error-bar" role="alert">
          <span>{error || launchError}</span>
          <button
            type="button"
            aria-label={t('agency.ui.dismissError')}
            onClick={() => {
              setError(null);
              onClearLaunchError?.();
            }}
          >
            ×
          </button>
        </div>
      )}

      <PaneMovement key={workspace.id} workspaceId={workspace.id} onSwap={handleSwapPane}>
      <div className="maw-split-workspace-content">
        <SplitPaneTree
          node={visibleTree}
          layout={layout}
          tabs={tabs}
          profiles={profiles}
          online={online}
          busy={busy}
          connection={connection}
          request={request}
          reportError={setError}
          getTabActivity={getTabActivity}
          onSelectTab={handleSelectTab}
          onCloseTab={(tab) => {
            const session = tab.kind === 'native' ? tab.session : undefined;
            if (session && ['starting', 'running', 'stopping'].includes(session.lifecycle)) {
              setClosing(tab);
            } else if (tab.kind === 'editor' && (unsavedTabIds.has(tab.id) || editorDraftStore.isDirty(tab.id))) {
              setClosing(tab);
            } else {
              if (tab.kind === 'editor') editorDraftStore.clearDraft(tab.id);
              void close(tab);
            }
          }}
          onSplit={handleSplit}
          onClosePane={handleClosePane}
          onToggleMaximize={handleToggleMaximize}
          onUpdateRatio={handleUpdateRatio}
          onSwapPane={handleSwapPane}
          onMoveTabToPane={handleMoveTab}
          onAddTerminalClick={(paneId) => {
            void add('terminal', paneId);
          }}
          onAddWebTabClick={(paneId) => {
            creationTarget.current = paneId;
            webEditor('create');
          }}
          onOpenFileClick={(paneId) => {
            creationTarget.current = paneId;
            setFileDialog({ paneId });
          }}
          onOpenRelativeFile={(paneId, targetPath) => {
            void openEditorFile(targetPath, paneId);
          }}
          onDirtyChange={handleDirtyChange}
          isTabUnsaved={(id) => unsavedTabIds.has(id)}
          onSplitCreate={(paneId, direction, action) => {
            pendingSplit.current = { paneId, direction };
            creationTarget.current = paneId;
            if (action === 'terminal') void add('terminal', paneId);
            else if (action === 'web') webEditor('create');
            else if (action === 'file') setFileDialog({ paneId, direction });
          }}
          onRenameTab={async (tab, title) => {
            await request(
              tab.kind === 'web'
                ? { type: 'agency.webTab.rename', workspaceId: workspace.id, tabId: tab.id, title }
                : tab.kind === 'editor'
                  ? { type: 'agency.editorTab.rename', workspaceId: workspace.id, tabId: tab.id, title }
                  : { type: 'agency.tab.rename', workspaceId: workspace.id, tabId: tab.id, name: title },
            );
          }}
          onFocusPane={handleFocusPane}
          onTabDisplayed={reportDisplayed}
          onPaneHost={registerPaneHost}
        />
        <PersistentSessionPanes
          tabs={tabs}
          layout={layout}
          paneHosts={paneHosts}
          hostVersion={hostVersion}
          profiles={profiles}
          connection={connection}
          online={online}
          busy={busy}
          request={request}
          sendImmediate={sendImmediate}
          report={setError}
          onDisplayed={reportDisplayed}
          onConfigure={setConfiguringProfile}
          onStartAgain={(session) => void startAgain(session)}
          workspaceCwd={workspace.cwd}
        />
      </div>

      </PaneMovement>
      <BrowserContextMenu
        tabs={webTabs}
        onCloseTab={(tab) => {
          const match = tabs.find((item) => item.id === tab.id);
          if (match) void close(match);
        }}
        onMoveNext={(tabId) => {
          const panes = getPaneNodes(layoutRef.current.tree);
          const index = panes.findIndex((pane) => pane.tabIds.includes(tabId));
          const target = index >= 0 ? panes[(index + 1) % panes.length] : undefined;
          if (target && panes.length > 1) handleMoveTab(tabId, target.id);
        }}
        onDuplicate={(tab) => {
          pendingSplit.current = null;
          creationTarget.current = layoutRef.current.focusedPaneId;
          void request({
            type: 'agency.webTab.create',
            workspaceId: workspace.id,
            url: tab.url,
            title: tab.title,
            select: true,
            targetPaneId: layoutRef.current.focusedPaneId,
            launchId: crypto.randomUUID(),
          }).then((response) => completeCreation(response, layoutRef.current.focusedPaneId)).catch((reason) => {
            setError(reason instanceof Error ? reason.message : String(reason));
          });
        }}
      />

      {(closing || webDialog || fileDialog) && (
        <div className="agency-modal-backdrop">
          <div
            ref={dialog}
            className="agency-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="maw-session-dialog"
          >
            <h2 id="maw-session-dialog">
              {closing
                ? t('agency.tabs.confirmClose', { name: tabDisplayName(closing) })
                : fileDialog
                  ? t('agency.tabs.openFile')
                  : webHeading}
            </h2>

            {closing ? (
              <p>
                {closing.kind === 'editor' && unsavedTabIds.has(closing.id)
                  ? t('agency.tabs.unsavedWarning')
                  : t('agency.tabs.closeExplanation')}
              </p>
            ) : fileDialog ? (
              <form
                id="maw-open-file-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void openEditorFile(filePathInput, fileDialog.paneId);
                }}
              >
                <label className="agency-field">
                  <span>{t('agency.tabs.filePath')}</span>
                  <input
                    autoFocus
                    value={filePathInput}
                    placeholder={t('agency.tabs.filePathPlaceholder')}
                    required
                    onChange={(event) => setFilePathInput(event.target.value)}
                  />
                </label>
              </form>
            ) : (
              <form
                id="maw-web-tab-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveWeb();
                }}
              >
                {webDialog !== 'navigate' && (
                  <label className="agency-field">
                    <span>{t('agency.web.provider')}</span>
                    <select value={webProvider} onChange={(event) => {
                      const provider = event.target.value as typeof webProvider;
                      setWebProvider(provider);
                      setWebUrl(provider === 'github' ? 'https://github.com/' : provider === 'perplexity' ? 'https://www.perplexity.ai/' : provider === 'other' ? 'https://' : 'https://chatgpt.com/');
                    }}>
                      <option value="chatgpt">{t('agency.tabs.chatgpt')}</option><option value="perplexity">{t('agency.tabs.perplexity')}</option><option value="github">{t('agency.tabs.github')}</option><option value="other">{t('agency.tabs.other')}</option>
                    </select>
                  </label>
                )}
                {webDialog !== 'navigate' && (
                  <label className="agency-field">
                    <span>{t('agency.web.title')}</span>
                    <input
                  autoFocus
                      value={webTitle}
                      maxLength={120}
                      required
                      onChange={(event) => setWebTitle(event.target.value)}
                    />
                  </label>
                )}
                <label className="agency-field">
                  <span>{t('agency.web.url')}</span>
                  <input
                    autoFocus={webDialog === 'navigate'}
                    type="url"
                    value={webUrl}
                    maxLength={2048}
                    required
                    onChange={(event) => setWebUrl(event.target.value)}
                  />
                </label>
              </form>
            )}

            {error && <p role="alert" className="agency-error">{error}</p>}
            <div className="agency-dialog-actions">
              <button
                type="button"
                autoFocus={!!closing}
                disabled={busy}
                onClick={() => {
                  pendingSplit.current = null;
                  setClosing(null);
                  setWebDialog(null);
                  setFileDialog(null);
                }}
              >
                {t('common.cancel')}
              </button>
              {fileDialog ? (
                <button
                  type="submit"
                  form="maw-open-file-form"
                  className="agency-primary-button"
                  disabled={busy || !online || !filePathInput.trim()}
                >
                  {t('agency.tabs.open')}
                </button>
              ) : webDialog ? (
                <button type="submit" form="maw-web-tab-form" className="agency-primary-button" disabled={busy || !online}>
                  {webHeading}
                </button>
              ) : (
                <button
                  type="button"
                  className="agency-primary-button"
                  disabled={busy || !online}
                  onClick={() => {
                    if (closing) {
                      if (closing.kind === 'editor') {
                        setUnsavedTabIds((prev) => {
                          const next = new Set(prev);
                          next.delete(closing.id);
                          return next;
                        });
                      }
                      void close(closing);
                    }
                  }}
                >
                  {t('agency.tabs.closeSession')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {configuringProfile && (
        <AgencyProfileDialog
          profile={configuringProfile}
          onClose={() => setConfiguringProfile(null)}
          onSave={async (executablePath, argv) => {
            await request({
              type: 'agency.profile.configure',
              profileId: configuringProfile.id,
              executable: executablePath,
              args: argv,
            });
          }}
        />
      )}
    </section>
  );
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgencyCliProfile, MawActivityState, SplitDirection, BrowserFavorite, SearchEngine } from '@anvilary/workbench-shared';
import { countLeaves, getPaneNodes, MAX_LEAVES, type LayoutPaneNode, type LayoutNode, type WorkspacePaneLayout } from '@anvilary/workbench-shared';
import { createPortal } from 'react-dom';
import { useDroppable, useDragOperation } from '@dnd-kit/react';
import { pointerIntersection } from '@dnd-kit/collision';
import { t } from '../../i18n/index.js';
import type { AgentConnection } from '../../connection/connection.js';
import type { WorkspaceTab } from '../workspaces/workspace-model.js';
import { EditorPaneView } from '../editor/EditorPaneView.js';
import { NativeBrowserView } from '../browser/NativeBrowserView.js';
import type { useWorkbenchStore } from '../workspaces/useWorkbenchStore.js';
import { PaneHeader } from './PaneHeader.js';
import { SplitDivider } from './SplitDivider.js';
import { EmptyPaneChooser } from './EmptyPaneChooser.js';
import { BrowserDestinationPicker } from '../browser/BrowserDestinationPicker.js';
import { useTabDragPreview } from './tab-drag-store.js';
import { ModalDialog } from '../../shared/ui/ModalDialog.js';
import { DEFAULT_BROWSER_FAVORITES, getSearchEngine, type WebTabProvider } from '@anvilary/workbench-shared';

function PaneBody({
  paneId,
  onPaneHost,
  children,
}: {
  paneId: string;
  onPaneHost: (paneId: string, element: HTMLElement | null) => void;
  children: ReactNode;
}): JSX.Element {
  const onPaneHostRef = useRef(onPaneHost);
  onPaneHostRef.current = onPaneHost;
  const ref = useCallback((element: HTMLDivElement | null) => {
    onPaneHostRef.current(paneId, element);
  }, [paneId]);
  return (
    <div className="wb-pane-body" ref={ref}>
      {children}
    </div>
  );
}

interface Props {
  node: LayoutNode;
  browserProfileId?: string;
  layout: WorkspacePaneLayout;
  tabs: WorkspaceTab[];
  profiles: readonly AgencyCliProfile[];
  online: boolean;
  busy: boolean;
  connection: AgentConnection;
  request: ReturnType<typeof useWorkbenchStore>['request'];
  reportError: (err: string) => void;
  getTabActivity?: (workspaceId: import('@anvilary/workbench-shared').WorkspaceId, tabId: string) => MawActivityState;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (tab: WorkspaceTab) => void;
  onSplit: (targetPaneId: string, direction: SplitDirection, tabIdToMove?: string) => void;
  onClosePane: (paneId: string, closeAllTabs?: boolean) => void | Promise<void>;
  onToggleMaximize: (paneId: string) => void;
  onUpdateRatio: (splitId: string, ratio: number) => void;
  onSwapPane: (sourcePaneId: string, targetPaneId: string) => void;
  onMoveTabToPane: (tabId: string, targetPaneId: string, targetIndex?: number) => void;
  onAddTerminalClick: (paneId: string) => void;
  onAddWebTabClick: (paneId: string) => void;
  onOpenFileClick?: (paneId: string) => void;
  onOpenRelativeFile?: (paneId: string, path: string) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
  isTabUnsaved?: (tabId: string) => boolean;
  onRenameTab: (tab: WorkspaceTab, title: string) => Promise<void>;
  onFocusPane: (paneId: string) => void;
  onTabDisplayed: (id: string, ready: boolean) => void;
  onPaneHost: (paneId: string, element: HTMLElement | null) => void;
  onMarkDone?: () => void;
  onSinglePane?: () => void;
  showSinglePane?: boolean;
  browserToolbarOpen?: Record<string, boolean>;
  onToggleBrowserToolbar?: (tabId: string) => void;
  onExpandBrowserToolbar?: (tabId: string) => void;
  browserFavorites?: readonly BrowserFavorite[];
  searchEngine?: SearchEngine;
  searchEngines?: readonly SearchEngine[];
  onSelectBrowserFavorite?: (paneId: string, favorite: BrowserFavorite) => void;
  onSelectBrowserOther?: (paneId: string) => void;
  favicons?: Record<string, string>;
  onCreateBrowserTab?: (paneId: string, options: { url: string; title?: string; provider?: WebTabProvider }) => void;
  activeWorkspace?: boolean;
}

function PaneLeaf(props: Props & {
  node: LayoutPaneNode;
  browserPickerOpen?: boolean;
  onOpenBrowserPicker?: () => void;
  onCloseBrowserPicker?: () => void;
}): JSX.Element {
  const operation = useDragOperation();
  const isDragSource = operation.source?.data.workspaceId === props.layout.workspaceId && operation.source?.data.paneId === props.node.id;
  const drop = useDroppable({ collisionDetector: pointerIntersection, id: `pane:${props.layout.workspaceId}:${props.node.id}`, type: 'pane', accept: 'pane', data: { workspaceId: props.layout.workspaceId, paneId: props.node.id }, disabled: !!props.layout.maximizedPaneId || !props.online });
  const pointerFocus = useRef(false);
  useEffect(() => {
    const release = () => { pointerFocus.current = false; };
    // A rejected pointer selection can roll back before the same click emits focus.
    // Release outside the pane must still restore keyboard focus handling.
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    return () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
  }, []);
  const { node, layout, tabs, profiles, online, busy, connection, request, reportError, getTabActivity, onSelectTab, onCloseTab, onSplit, onClosePane, onToggleMaximize, onMoveTabToPane, onAddTerminalClick, onAddWebTabClick, onRenameTab, onFocusPane, onTabDisplayed, onPaneHost } = props;

  const totalLeaves = countLeaves(layout.tree);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const setContainerRef = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    drop.ref(element);
  }, [drop.ref]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      setDimensions({ width: rect.width, height: rect.height });
    }
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxReached = totalLeaves >= MAX_LEAVES;
  const isTooNarrow = dimensions.width > 0 && dimensions.width < 280;
  const isTooShort = dimensions.height > 0 && dimensions.height < 180;

  const canSplit = !maxReached;
  const canSplitRight = !maxReached && !isTooNarrow;
  const canSplitDown = !maxReached && !isTooShort;
  const splitRightReason = maxReached
    ? t('agency.splits.maxPanesReached')
    : isTooNarrow
      ? t('agency.splits.tooNarrow')
      : undefined;
  const splitDownReason = maxReached
    ? t('agency.splits.maxPanesReached')
    : isTooShort
      ? t('agency.splits.tooShort')
      : undefined;

  const canClose = totalLeaves > 1;

  // Node is a leaf Pane
  const isFocused = layout.focusedPaneId === node.id;
  const isMaximized = layout.maximizedPaneId === node.id;
  const selectedTab = tabs.find((t) => t.id === node.selectedTabId);
  const toolbarOpen = node.selectedTabId ? (props.browserToolbarOpen?.[node.selectedTabId] ?? false) : false;
  const tabDragPreview = useTabDragPreview();
  const activeSplitTarget =
    tabDragPreview?.splitTarget?.paneId === node.id ? tabDragPreview.splitTarget.direction : null;

  const paneTabs = node.tabIds
    .map((id) => tabs.find((tab) => tab.id === id))
    .filter((tab): tab is WorkspaceTab => tab !== undefined);
  const [confirmingClosePane, setConfirmingClosePane] = useState<{ centerOn: Element | null } | null>(null);

  const handleRequestClosePane = useCallback(() => {
    if (!canClose) return;
    if (paneTabs.length === 0) {
      void onClosePane(node.id, false);
    } else {
      setConfirmingClosePane({ centerOn: containerRef.current?.querySelector('.wb-pane-body') ?? null });
    }
  }, [canClose, node.id, onClosePane, paneTabs.length]);

  const activeAgentsCount = paneTabs.filter(
    (tab) =>
      tab.kind === 'native' &&
      tab.session.kind === 'agent' &&
      ['starting', 'running', 'stopping'].includes(tab.session.lifecycle),
  ).length;
  const activeTerminalsCount = paneTabs.filter(
    (tab) =>
      tab.kind === 'native' &&
      tab.session.kind === 'terminal' &&
      ['starting', 'running', 'stopping'].includes(tab.session.lifecycle),
  ).length;
  const browserTabsCount = paneTabs.filter((tab) => tab.kind === 'web').length;
  const editorTabsInPane = paneTabs.filter((tab) => tab.kind === 'editor');
  const dirtyEditorsCount = editorTabsInPane.filter((tab) => props.isTabUnsaved?.(tab.id)).length;

  return (
    <div
      ref={setContainerRef}
      className={`wb-split-pane${isFocused ? ' is-focused' : ''}${drop.isDropTarget && !isDragSource ? ' is-pane-drop-target' : ''}${isDragSource ? ' is-pane-drag-source' : ''}`}
      id={`pane-container-${node.id}`}
      tabIndex={-1}
      onFocus={(event) => { if ((event.target as Element).closest('.wb-pane-grip, .wb-add-tab, [role=menu]')) return; if (!pointerFocus.current) onFocusPane(node.id); }}
      onPointerDown={(event) => {
        if ((event.target as Element).closest('.wb-pane-grip, .wb-add-tab, [role=menu]')) return;
        pointerFocus.current = true;
        onFocusPane(node.id);
      }}
    >
      <PaneHeader
        paneId={node.id}
        tabIds={node.tabIds}
        selectedTabId={node.selectedTabId}
        tabs={tabs}
        profiles={profiles}
        workspaceId={layout.workspaceId}
        isFocused={isFocused}
        canSplit={canSplit}
        canSplitRight={canSplitRight}
        canSplitDown={canSplitDown}
        splitRightReason={splitRightReason}
        splitDownReason={splitDownReason}
        moveDisabled={!!layout.maximizedPaneId || totalLeaves < 2 || !online || busy}
        destinations={getPaneNodes(layout.tree).filter(p => p.id !== node.id).map((p) => {
          const tab = tabs.find(tab => tab.id === p.selectedTabId);
          return { id: p.id, title: t('agency.splits.swapWith', { number: getPaneNodes(layout.tree).findIndex(item => item.id === p.id) + 1, title: tab?.kind === 'web' ? tab.web.title : tab?.kind === 'editor' ? tab.editor.title : tab?.session.tab?.name ?? t('agency.tabs.empty') }) };
        })}
        onSwapPane={props.onSwapPane}
        canClose={canClose}
        canMaximize={totalLeaves > 1}
        isMaximized={isMaximized}
        online={online}
        busy={busy}
        request={request}
        getTabActivity={getTabActivity}
        onSelectTab={(tabId) => onSelectTab(node.id, tabId)}
        onCloseTab={onCloseTab}
        onSplitRight={() => onSplit(node.id, 'row')}
        onSplitDown={() => onSplit(node.id, 'column')}
        onSplitPane={(targetPaneId, dir, tabId) => onSplit(targetPaneId, dir, tabId)}
        onToggleMaximize={() => onToggleMaximize(node.id)}
        onClosePane={handleRequestClosePane}
        onAddTerminalClick={() => onAddTerminalClick(node.id)}
        onAddWebTabClick={props.onOpenBrowserPicker ? props.onOpenBrowserPicker : () => onAddWebTabClick(node.id)}
        browserFavorites={props.browserFavorites}
        searchEngine={props.searchEngine}
        favicons={props.favicons}
        onSelectBrowserFavorite={props.onSelectBrowserFavorite ? (fav) => props.onSelectBrowserFavorite?.(node.id, fav) : undefined}
        onSelectBrowserOther={props.onSelectBrowserOther ? () => props.onSelectBrowserOther?.(node.id) : undefined}
        onOpenFileClick={props.onOpenFileClick ? () => props.onOpenFileClick?.(node.id) : undefined}
        onMoveTabToPane={onMoveTabToPane}
        onRenameTab={onRenameTab}
        isTabUnsaved={props.isTabUnsaved}
        reportError={reportError}
        onMarkDone={props.onMarkDone}
        onSinglePane={props.onSinglePane}
        showSinglePane={props.showSinglePane}
        browserToolbarOpen={toolbarOpen}
        onToggleBrowserToolbar={node.selectedTabId && props.onToggleBrowserToolbar ? () => props.onToggleBrowserToolbar?.(node.selectedTabId!) : undefined}
      />

      <PaneBody paneId={node.id} onPaneHost={onPaneHost}>
        {selectedTab?.kind === 'web' ? (
          <NativeBrowserView
            key={selectedTab.id}
            tab={selectedTab.web}
            profileId={props.browserProfileId}
            toolbarOpen={toolbarOpen}
            onExpandToolbar={props.onExpandBrowserToolbar ? () => props.onExpandBrowserToolbar?.(selectedTab.id) : undefined}
            onDisplayed={onTabDisplayed}
            onFocused={() => onFocusPane(node.id)}
            searchEngine={props.searchEngine}
            activeWorkspace={props.activeWorkspace}
          />
        ) : selectedTab?.kind === 'editor' ? (
          <EditorPaneView
            key={selectedTab.id}
            tab={selectedTab.editor}
            workspaceId={layout.workspaceId}
            connection={connection}
            online={online}
            reportError={reportError}
            onDirtyChange={props.onDirtyChange}
            onOpenRelativeFile={props.onOpenRelativeFile ? (targetPath) => props.onOpenRelativeFile?.(node.id, targetPath) : undefined}
          />
        ) : selectedTab ? null : (
          <EmptyPaneChooser
            paneId={node.id}
            online={online}
            busy={busy}
            canClose={canClose}
            onAddTerminal={() => onAddTerminalClick(node.id)}
            onAddBrowser={props.onOpenBrowserPicker ? props.onOpenBrowserPicker : () => onAddWebTabClick(node.id)}
            onOpenFile={props.onOpenFileClick ? () => props.onOpenFileClick?.(node.id) : () => {}}
            onClosePane={handleRequestClosePane}
            onMoveTabToPane={onMoveTabToPane}
          />
        )}

        {confirmingClosePane && (
          <ModalDialog
            title={`${t('agency.splits.closePane')}?`}
            titleId={`pane-close-title-${node.id}`}
            className="wb-pane-close-dialog"
            centerOn={confirmingClosePane.centerOn}
            closeLabel={t('common.close')}
            onClose={() => setConfirmingClosePane(null)}
            actions={
              <>
                <button
                  type="button"
                  className="agency-secondary-button"
                  onClick={() => setConfirmingClosePane(null)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="agency-danger-button"
                  onClick={() => {
                    setConfirmingClosePane(null);
                    void onClosePane(node.id, true);
                  }}
                >
                  {t('agency.splits.closePane')}
                </button>
              </>
            }
          >
            <p className="agency-muted">
              {t('agency.splits.closePaneWarning')}
            </p>
            <div className="agency-resource-summary wb-pane-close-summary">
              <ul>
                <li>
                  {t('agency.splits.closePaneOpenTabs', { count: paneTabs.length })}
                </li>
                {activeAgentsCount > 0 && (
                  <li>{t('agency.ui.deleteResourcesActiveClis', { count: activeAgentsCount })}</li>
                )}
                {activeTerminalsCount > 0 && (
                  <li>{t('agency.ui.deleteResourcesActiveTerminals', { count: activeTerminalsCount })}</li>
                )}
                {browserTabsCount > 0 && (
                  <li>{t('agency.ui.deleteResourcesBrowserTabs', { count: browserTabsCount })}</li>
                )}
                {editorTabsInPane.length > 0 && (
                  <li>
                    {t('agency.ui.deleteResourcesEditorTabs', { count: editorTabsInPane.length })}
                    {dirtyEditorsCount > 0 ? ` (${t('agency.ui.deleteResourcesUnsavedCount', { count: dirtyEditorsCount })})` : ''}
                  </li>
                )}
              </ul>
            </div>
            {(activeAgentsCount > 0 || activeTerminalsCount > 0 || dirtyEditorsCount > 0) && (
              <p className="agency-error" role="alert">
                {dirtyEditorsCount > 0
                  ? t('agency.tabs.unsavedChangesWarning')
                  : t('agency.ui.deleteInterruptionWarning')}
              </p>
            )}
          </ModalDialog>
        )}

        {props.browserPickerOpen && (
          <div
            className="wb-pane-browser-picker-overlay wb-browser-picker-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={t('agency.browser.pickerTitle')}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                props.onCloseBrowserPicker?.();
              }
            }}
          >
            <div className="wb-pane-browser-picker-card" onClick={(e) => e.stopPropagation()}>
              <BrowserDestinationPicker
                favorites={props.browserFavorites ?? DEFAULT_BROWSER_FAVORITES}
                searchEngine={props.searchEngine ?? getSearchEngine()}
                searchEngines={props.searchEngines}
                favicons={props.favicons}
                onConfirm={(dest) => {
                  props.onCloseBrowserPicker?.();
                  if (props.onCreateBrowserTab) {
                    props.onCreateBrowserTab(node.id, dest);
                  } else if (props.onSelectBrowserFavorite && dest.url) {
                    props.onSelectBrowserFavorite(node.id, { id: 'dest', title: dest.title, url: dest.url });
                  } else {
                    onAddWebTabClick(node.id);
                  }
                }}
                onCancel={props.onCloseBrowserPicker}
              />
            </div>
          </div>
        )}
      </PaneBody>

      {canSplit && (
        <>
          <div
            className={`wb-pane-drop-edge wb-pane-drop-edge-right${activeSplitTarget === 'row' ? ' is-active' : ''}`}
            aria-hidden="true"
          />
          <div
            className={`wb-pane-drop-edge wb-pane-drop-edge-bottom${activeSplitTarget === 'column' ? ' is-active' : ''}`}
            aria-hidden="true"
          />
        </>
      )}
    </div>
  );
}


function PaneSlot({ holder }: { holder: HTMLDivElement }): JSX.Element {
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (element && holder.parentElement !== element) element.appendChild(holder);
  }, [holder]);
  return <div className="wb-pane-slot" ref={ref} style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }} />;
}

function SplitStructure(props: Props & { holders: Map<string, HTMLDivElement> }): JSX.Element {
  const { node, onUpdateRatio } = props;
  if (node.type === 'split') {
    const isRow = node.direction === 'row';
    return (
      <div
        className={`wb-split-container wb-split-${node.direction}`}
        data-split-id={node.id}
        style={{
          display: 'flex',
          flexDirection: isRow ? 'row' : 'column',
          flex: 1,
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <div
          className="wb-split-child"
          style={{
            flex: `var(--split-ratio-first, ${node.ratio}) 1 0px`,
            display: 'flex',
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <SplitStructure {...props} node={node.first} />
        </div>

        <SplitDivider
          splitId={node.id}
          direction={node.direction}
          ratio={node.ratio}
          onRatioChange={(r) => onUpdateRatio(node.id, r)}
        />

        <div
          className="wb-split-child"
          style={{
            flex: `var(--split-ratio-second, ${1 - node.ratio}) 1 0px`,
            display: 'flex',
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <SplitStructure {...props} node={node.second} />
        </div>
      </div>
    );
  }


  return <PaneSlot holder={props.holders.get(node.id)!} />;
}

/** Stable portal containers keep pane contents mounted when leaves exchange tree positions. */
export function SplitPaneTree(props: Props): JSX.Element {
  const [browserPickerPaneId, setBrowserPickerPaneId] = useState<string | null>(null);
  const holders = useRef(new Map<string, HTMLDivElement>());
  const panes = getPaneNodes(props.node);
  for (const pane of panes) {
    if (!holders.current.has(pane.id)) {
      const holder = document.createElement('div');
      holder.className = 'wb-pane-mount';
      Object.assign(holder.style, { display: 'flex', flex: '1', minWidth: '0', minHeight: '0' });
      holders.current.set(pane.id, holder);
    }
  }
  useEffect(() => {
    const live = new Set(panes.map(p => p.id));
    for (const [id, holder] of holders.current) {
      if (!live.has(id)) { holder.remove(); holders.current.delete(id); }
    }
  });

  const handleAddWebTabClick = useCallback((paneId: string) => {
    setBrowserPickerPaneId(paneId);
    props.onAddWebTabClick?.(paneId);
  }, [props.onAddWebTabClick]);

  return <>
    <SplitStructure {...props} onAddWebTabClick={handleAddWebTabClick} holders={holders.current} />
    {panes.map(pane => createPortal(
      <PaneLeaf
        {...props}
        onAddWebTabClick={handleAddWebTabClick}
        node={pane}
        browserPickerOpen={browserPickerPaneId === pane.id}
        onOpenBrowserPicker={() => setBrowserPickerPaneId(pane.id)}
        onCloseBrowserPicker={() => setBrowserPickerPaneId(null)}
      />,
      holders.current.get(pane.id)!,
      pane.id
    ))}
  </>;
}

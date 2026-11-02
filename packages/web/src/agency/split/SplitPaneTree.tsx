import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { AgencyCliProfile, MawActivityState, SplitDirection } from '@agent-workbench/shared';
import { countLeaves, getPaneNodes, type LayoutPaneNode, type LayoutNode, type WorkspacePaneLayout } from '@agent-workbench/shared';
import { createPortal } from 'react-dom';
import { useDroppable, useDragOperation } from '@dnd-kit/react';
import { pointerIntersection } from '@dnd-kit/collision';
import { t } from '../../i18n/index.js';
import type { AgentConnection } from '../../connection.js';
import type { WorkspaceTab } from '../model.js';
import { EditorPaneView } from '../EditorPaneView.js';
import { NativeChatGptView } from '../NativeChatGptView.js';
import type { useAgencyStore } from '../useAgencyStore.js';
import { PaneHeader } from './PaneHeader.js';
import { SplitDivider } from './SplitDivider.js';

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
    <div className="maw-pane-body" ref={ref}>
      {children}
    </div>
  );
}

interface Props {
  node: LayoutNode;
  layout: WorkspacePaneLayout;
  tabs: WorkspaceTab[];
  profiles: readonly AgencyCliProfile[];
  online: boolean;
  busy: boolean;
  connection: AgentConnection;
  request: ReturnType<typeof useAgencyStore>['request'];
  reportError: (err: string) => void;
  getTabActivity?: (workspaceId: import('@agent-workbench/shared').WorkspaceId, tabId: string) => MawActivityState;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (tab: WorkspaceTab) => void;
  onSplit: (targetPaneId: string, direction: SplitDirection, tabIdToMove?: string) => void;
  onClosePane: (paneId: string) => void;
  onToggleMaximize: (paneId: string) => void;
  onUpdateRatio: (splitId: string, ratio: number) => void;
  onSwapPane: (sourcePaneId: string, targetPaneId: string) => void;
  onMoveTabToPane: (tabId: string, targetPaneId: string, targetIndex?: number) => void;
  onAddCliClick: (paneId: string) => void;
  onAddTerminalClick: (paneId: string) => void;
  onAddWebTabClick: (paneId: string) => void;
  onAddGithubClick?: (paneId: string) => void;
  onAddPerplexityClick?: (paneId: string) => void;
  onOpenFileClick?: (paneId: string) => void;
  onOpenRelativeFile?: (paneId: string, path: string) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
  isTabUnsaved?: (tabId: string) => boolean;
  onLaunchProfile?: (paneId: string, profileId: string) => void;
  onSplitCreate?: (paneId: string, direction: SplitDirection, action: 'terminal' | 'agent' | 'web' | 'github' | 'perplexity' | 'file', profileId?: string) => void;
  onRenameTab: (tab: WorkspaceTab, title: string) => Promise<void>;
  onFocusPane: (paneId: string) => void;
  onTabDisplayed: (id: string, ready: boolean) => void;
  onPaneHost: (paneId: string, element: HTMLElement | null) => void;
}

function PaneLeaf(props: Props & { node: LayoutPaneNode }): JSX.Element {
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
  const { node, layout, tabs, profiles, online, busy, connection, request, reportError, getTabActivity, onSelectTab, onCloseTab, onSplit, onClosePane, onToggleMaximize, onMoveTabToPane, onAddCliClick, onAddTerminalClick, onAddWebTabClick, onRenameTab, onFocusPane, onTabDisplayed, onPaneHost } = props;

  const totalLeaves = countLeaves(layout.tree);
  const canSplit = totalLeaves < 4;
  const canClose = totalLeaves > 1;

  // Node is a leaf Pane
  const isFocused = layout.focusedPaneId === node.id;
  const isMaximized = layout.maximizedPaneId === node.id;
  const selectedTab = tabs.find((t) => t.id === node.selectedTabId);

  return (
    <div
      ref={drop.ref}
      className={`maw-split-pane${isFocused ? ' is-focused' : ''}${drop.isDropTarget && !isDragSource ? ' is-pane-drop-target' : ''}${isDragSource ? ' is-pane-drag-source' : ''}`}
      id={`pane-container-${node.id}`}
      tabIndex={-1}
      onFocus={(event) => { if ((event.target as Element).closest('.maw-pane-grip, .maw-add-tab, [role=menu]')) return; if (!pointerFocus.current) onFocusPane(node.id); }}
      onPointerDown={(event) => {
        if ((event.target as Element).closest('.maw-pane-grip, .maw-add-tab, [role=menu]')) return;
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
        moveDisabled={!!layout.maximizedPaneId || totalLeaves < 2 || !online || busy}
        destinations={getPaneNodes(layout.tree).filter(p => p.id !== node.id).map((p) => {
          const tab = tabs.find(tab => tab.id === p.selectedTabId);
          return { id: p.id, title: t('agency.splits.swapWith', { number: getPaneNodes(layout.tree).findIndex(item => item.id === p.id) + 1, title: tab?.kind === 'web' ? tab.web.title : tab?.kind === 'editor' ? tab.editor.title : tab?.session.tab?.name ?? t('agency.tabs.empty') }) };
        })}
        onSwapPane={props.onSwapPane}
        canClose={canClose}
        isMaximized={isMaximized}
        online={online}
        busy={busy}
        request={request}
        getTabActivity={getTabActivity}
        onSelectTab={(tabId) => onSelectTab(node.id, tabId)}
        onCloseTab={onCloseTab}
        onSplitRight={() => onSplit(node.id, 'row')}
        onSplitDown={() => onSplit(node.id, 'column')}
        onToggleMaximize={() => onToggleMaximize(node.id)}
        onClosePane={() => onClosePane(node.id)}
        onAddCliClick={() => onAddCliClick(node.id)}
        onAddTerminalClick={() => onAddTerminalClick(node.id)}
        onAddWebTabClick={() => onAddWebTabClick(node.id)}
        onAddGithubClick={props.onAddGithubClick ? () => props.onAddGithubClick?.(node.id) : undefined}
        onAddPerplexityClick={props.onAddPerplexityClick ? () => props.onAddPerplexityClick?.(node.id) : undefined}
        onOpenFileClick={props.onOpenFileClick ? () => props.onOpenFileClick?.(node.id) : undefined}
        onLaunchProfile={props.onLaunchProfile ? (profileId) => props.onLaunchProfile?.(node.id, profileId) : undefined}
        onSplitCreate={props.onSplitCreate ? (direction, action, profileId) => props.onSplitCreate?.(node.id, direction, action, profileId) : undefined}
        onMoveTabToPane={onMoveTabToPane}
        onRenameTab={onRenameTab}
        isTabUnsaved={props.isTabUnsaved}
        reportError={reportError}
      />

      <PaneBody paneId={node.id} onPaneHost={onPaneHost}>
        {selectedTab?.kind === 'web' ? (
          <NativeChatGptView
            key={selectedTab.id}
            tab={selectedTab.web}
            onDisplayed={onTabDisplayed}
            onFocused={() => onFocusPane(node.id)}
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
          <div className="agency-shell-placeholder">
            <p>{tabs.length ? t('agency.web.selectTab') : t('agency.tabs.empty')}</p>
            <button
              type="button"
              className="agency-secondary-button"
              disabled={!online}
              onClick={() => onAddCliClick(node.id)}
            >
              {t('agency.tabs.newCLI')}
            </button>
          </div>
        )}
      </PaneBody>

      {canSplit && (
        <>
          <div
            className="maw-pane-drop-edge maw-pane-drop-edge-right"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/maw-tab-id')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }
            }}
            onDrop={(e) => {
              const draggedId = e.dataTransfer.getData('application/maw-tab-id');
              if (draggedId) {
                e.preventDefault();
                onSplit(node.id, 'row', draggedId);
              }
            }}
          />
          <div
            className="maw-pane-drop-edge maw-pane-drop-edge-bottom"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/maw-tab-id')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }
            }}
            onDrop={(e) => {
              const draggedId = e.dataTransfer.getData('application/maw-tab-id');
              if (draggedId) {
                e.preventDefault();
                onSplit(node.id, 'column', draggedId);
              }
            }}
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
  return <div className="maw-pane-slot" ref={ref} style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }} />;
}

function SplitStructure(props: Props & { holders: Map<string, HTMLDivElement> }): JSX.Element {
  const { node, onUpdateRatio } = props;
  if (node.type === 'split') {
    const isRow = node.direction === 'row';
    return (
      <div
        className={`maw-split-container maw-split-${node.direction}`}
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
          className="maw-split-child"
          style={{
            flex: `${node.ratio} 1 0px`,
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
          className="maw-split-child"
          style={{
            flex: `${1 - node.ratio} 1 0px`,
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
  const holders = useRef(new Map<string, HTMLDivElement>());
  const panes = getPaneNodes(props.node);
  for (const pane of panes) {
    if (!holders.current.has(pane.id)) {
      const holder = document.createElement('div');
      holder.className = 'maw-pane-mount';
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
  return <>
    <SplitStructure {...props} holders={holders.current} />
    {panes.map(pane => createPortal(<PaneLeaf {...props} node={pane} />, holders.current.get(pane.id)!, pane.id))}
  </>;
}

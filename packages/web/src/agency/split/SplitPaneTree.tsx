import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { AgencyCliProfile, MawActivityState, SplitDirection } from '@agent-workbench/shared';
import { countLeaves, type LayoutNode, type WorkspacePaneLayout } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import type { WorkspaceTab } from '../model.js';
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
  request: ReturnType<typeof useAgencyStore>['request'];
  reportError: (err: string) => void;
  getTabActivity?: (workspaceId: import('@agent-workbench/shared').WorkspaceId, tabId: string) => MawActivityState;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (tab: WorkspaceTab) => void;
  onSplit: (targetPaneId: string, direction: SplitDirection, tabIdToMove?: string) => void;
  onClosePane: (paneId: string) => void;
  onToggleMaximize: (paneId: string) => void;
  onUpdateRatio: (splitId: string, ratio: number) => void;
  onMoveTabToPane: (tabId: string, targetPaneId: string, targetIndex?: number) => void;
  onAddCliClick: (paneId: string) => void;
  onAddTerminalClick: (paneId: string) => void;
  onAddWebTabClick: (paneId: string) => void;
  onRenameTab: (tab: WorkspaceTab, title: string) => Promise<void>;
  onFocusPane: (paneId: string) => void;
  onTabDisplayed: (id: string, ready: boolean) => void;
  onPaneHost: (paneId: string, element: HTMLElement | null) => void;
}

export function SplitPaneTree(props: Props): JSX.Element {
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
  const { node, layout, tabs, profiles, online, busy, request, reportError, getTabActivity, onSelectTab, onCloseTab, onSplit, onClosePane, onToggleMaximize, onUpdateRatio, onMoveTabToPane, onAddCliClick, onAddTerminalClick, onAddWebTabClick, onRenameTab, onFocusPane, onTabDisplayed, onPaneHost } = props;

  const totalLeaves = countLeaves(layout.tree);
  const canSplit = totalLeaves < 4;
  const canClose = totalLeaves > 1;

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
          <SplitPaneTree {...props} node={node.first} />
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
          <SplitPaneTree {...props} node={node.second} />
        </div>
      </div>
    );
  }

  // Node is a leaf Pane
  const isFocused = layout.focusedPaneId === node.id;
  const isMaximized = layout.maximizedPaneId === node.id;
  const selectedTab = tabs.find((t) => t.id === node.selectedTabId);

  return (
    <div
      className={`maw-split-pane${isFocused ? ' is-focused' : ''}`}
      id={`pane-container-${node.id}`}
      tabIndex={-1}
      onFocus={() => { if (!pointerFocus.current) onFocusPane(node.id); }}
      onPointerDown={() => {
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
        onMoveTabToPane={onMoveTabToPane}
        onRenameTab={onRenameTab}
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

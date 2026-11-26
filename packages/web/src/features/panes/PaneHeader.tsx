import { useEffect, useRef, useState } from 'react';
import type { AgencyCliProfile, MawActivityState, WorkspaceId, BrowserFavorite, SearchEngine } from '@anvilary/workbench-shared';
import { t } from '../../i18n/index.js';
import type { WorkspaceTab } from '../workspaces/workspace-model.js';
import { PaneMenu } from './PaneMenu.js';
import { PaneGrip } from './PaneMovement.js';
import { tabShift } from './tab-geometry.mjs';
import { TabNameInput } from './TabNameInput.js';
import type { useWorkbenchStore } from '../workspaces/useWorkbenchStore.js';
import { StatusDot } from '../../shared/ui/StatusDot.js';
import { getWorkspaceTabDisplayName } from '../workspaces/workspace-tab-helpers.js';
import { PaneTabIcon, resolvePaneTabStatus } from './TabStatusIcon.js';
import { useHorizontalWheelScroll } from './useHorizontalWheelScroll.js';
import { useTabPointerDrag } from './useTabPointerDrag.js';

interface Props {
  paneId: string;
  tabIds: string[];
  selectedTabId: string | null;
  tabs: WorkspaceTab[];
  profiles: readonly AgencyCliProfile[];
  workspaceId: WorkspaceId;
  isFocused: boolean;
  canSplit: boolean;
  canSplitRight?: boolean;
  canSplitDown?: boolean;
  splitRightReason?: string;
  splitDownReason?: string;
  moveDisabled: boolean;
  destinations: { id: string; title: string }[];
  onSwapPane: (source: string, target: string) => void;
  canClose: boolean;
  canMaximize?: boolean;
  isMaximized: boolean;
  online: boolean;
  busy: boolean;
  request: ReturnType<typeof useWorkbenchStore>['request'];
  getTabActivity?: (workspaceId: WorkspaceId, tabId: string) => MawActivityState;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tab: WorkspaceTab) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onToggleMaximize: () => void;
  onClosePane: () => void;
  onAddTerminalClick: () => void;
  onAddWebTabClick: () => void;
  onOpenFileClick?: () => void;
  onMoveTabToPane: (tabId: string, targetPaneId: string, targetIndex?: number) => void;
  onSplitPane?: (targetPaneId: string, direction: 'row' | 'column', tabIdToMove: string) => void;
  onRenameTab: (tab: WorkspaceTab, title: string) => Promise<void>;
  isTabUnsaved?: (tabId: string) => boolean;
  reportError: (error: string) => void;
  onMarkDone?: () => void;
  onSinglePane?: () => void;
  showSinglePane?: boolean;
  browserToolbarOpen?: boolean;
  onToggleBrowserToolbar?: () => void;
  browserFavorites?: readonly BrowserFavorite[];
  searchEngine?: SearchEngine;
  onSelectBrowserFavorite?: (favorite: BrowserFavorite) => void;
  onSelectBrowserOther?: () => void;
  favicons?: Record<string, string>;
}

export function PaneHeader({
  paneId,
  tabIds,
  selectedTabId,
  tabs,
  profiles,
  workspaceId,
  isFocused,
  canSplit,
  canSplitRight,
  canSplitDown,
  splitRightReason,
  splitDownReason,
  moveDisabled,
  destinations,
  onSwapPane,
  canClose,
  canMaximize,
  isMaximized,
  online,
  busy,
  request,
  getTabActivity,
  onSelectTab,
  onCloseTab,
  onSplitRight,
  onSplitDown,
  onToggleMaximize,
  onClosePane,
  onAddTerminalClick,
  onAddWebTabClick,
  onOpenFileClick,
  onMoveTabToPane,
  onSplitPane,
  onRenameTab,
  isTabUnsaved,
  reportError,
  onMarkDone,
  onSinglePane,
  showSinglePane,
  browserToolbarOpen,
  onToggleBrowserToolbar,
  favicons,
}: Props): JSX.Element {
  const selectedTab = tabs.find((tab) => tab.id === selectedTabId);
  const isWebTab = selectedTab?.kind === 'web';
  const canToggleMaximize = isMaximized || (canMaximize ?? canClose);
  const [zoomPercentage, setZoomPercentage] = useState<number | null>(null);
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge || !selectedTabId || !isWebTab) return;
    return bridge.subscribe((state) => {
      if (state.type === 'browser-zoom' && state.id === selectedTabId && typeof state.percentage === 'number') {
        setZoomPercentage(state.percentage);
        if (zoomTimer.current) clearTimeout(zoomTimer.current);
        zoomTimer.current = setTimeout(() => {
          setZoomPercentage(null);
        }, 1800);
      }
    });
  }, [selectedTabId, isWebTab]);

  useEffect(() => {
    return () => {
      if (zoomTimer.current) clearTimeout(zoomTimer.current);
    };
  }, []);

  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paneActionsOpen, setPaneActionsOpen] = useState(false);
  const [renameWidth, setRenameWidth] = useState<number | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const paneActionBtn = useRef<HTMLButtonElement>(null);
  const splitRightAllowed = canSplitRight !== undefined ? canSplitRight : canSplit;
  const splitDownAllowed = canSplitDown !== undefined ? canSplitDown : canSplit;
  const strip = useRef<HTMLDivElement | null>(null);

  const paneTabs = tabIds
    .map((id) => tabs.find((t) => t.id === id))
    .filter((t): t is WorkspaceTab => t !== undefined);

  const {
    dragPreview,
    dragState,
    suppressTabClickUntil,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  } = useTabPointerDrag({
    paneId,
    workspaceId,
    paneTabs,
    tabs,
    profiles,
    favicons,
    onMoveTabToPane,
    onSplitPane,
    request,
    reportError,
  });

  useHorizontalWheelScroll(strip, tabIds.length);

  useEffect(() => {
    if (dragPreview) return;
    const node = strip.current;
    const selected = node?.querySelector<HTMLElement>('.wb-session-tab.active');
    if (!node || !selected) return;
    const left = selected.offsetLeft;
    const right = left + selected.offsetWidth;
    if (left < node.scrollLeft) node.scrollLeft = left;
    else if (right > node.scrollLeft + node.clientWidth) node.scrollLeft = right - node.clientWidth;
  }, [selectedTabId, dragPreview]);

  async function handleKeyDown(event: React.KeyboardEvent) {
    if (!paneTabs.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const focusedId = (event.target as Element).closest('[data-tab-id]')?.getAttribute('data-tab-id');
    const current = Math.max(0, paneTabs.findIndex((tab) => tab.id === (focusedId ?? selectedTabId)));
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? paneTabs.length - 1
          : (current + (event.key === 'ArrowLeft' ? -1 : 1) + paneTabs.length) % paneTabs.length;

    if (event.altKey && event.key.startsWith('Arrow')) {
      const ids = tabs.map((t) => t.id);
      const curGlobal = ids.indexOf(paneTabs[current]!.id);
      const nextGlobal = ids.indexOf(paneTabs[next]!.id);
      if (curGlobal !== -1 && nextGlobal !== -1) {
        [ids[curGlobal], ids[nextGlobal]] = [ids[nextGlobal]!, ids[curGlobal]!];
        onMoveTabToPane(paneTabs[current]!.id, paneId, next);
        try {
          await request({ type: 'agency.tabs.order', workspaceId, tabIds: ids });
        } catch (reason) {
          reportError(String(reason));
        }
      }
    } else {
      const targetTab = paneTabs[next]!;
      onSelectTab(targetTab.id);
      document.getElementById('tab-' + targetTab.id)?.focus();
    }
  }

  function choose(action: 'terminal' | 'web' | 'file') {
    setMenuOpen(false);
    if (action === 'terminal') onAddTerminalClick();
    else if (action === 'web') onAddWebTabClick();
    else if (action === 'file') onOpenFileClick?.();
  }

  function beginRename(tabId: string, element: HTMLElement | null) {
    const host = element?.closest<HTMLElement>('.wb-session-tab');
    setRenameWidth(host?.getBoundingClientRect().width ?? null);
    setRenamingTabId(tabId);
  }

  return (
    <div
      className={`wb-pane-header${isFocused ? ' is-focused' : ''}${dragPreview?.overPaneId === paneId && dragPreview.sourcePaneId !== paneId ? ' is-tab-drop' : ''}`}
    >
      <div
        className={'wb-pane-tabs' + (dragState ? ' is-dragging' : '')}
        ref={strip}
        role="tablist"
        aria-label={t('agency.tabs.tabList')}
        onKeyDown={handleKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
      >
        {paneTabs.map((tab, idx) => {
          const tabState = getTabActivity?.(workspaceId, tab.id);
          const isUnsaved = isTabUnsaved?.(tab.id);
          const { status, dotClass } = resolvePaneTabStatus(tab, tabState, isUnsaved);
          const displayName = getWorkspaceTabDisplayName(tab, profiles);

          const isSelected = selectedTabId === tab.id;
          const previewHere = dragPreview?.overPaneId === paneId ? dragPreview : null;
          const samePane = previewHere?.sourcePaneId === paneId;
          const shift = previewHere
            ? tabShift(idx, previewHere.sourceIndex, previewHere.overIndex, previewHere.width, samePane)
            : 0;

          const isBeingDragged = dragPreview?.tabId === tab.id && dragPreview.sourcePaneId === paneId;
          const isTargetBefore = previewHere?.overIndex === idx && previewHere.tabId !== tab.id;
          const isTargetAfter = previewHere?.overIndex === paneTabs.length && idx === paneTabs.length - 1 && previewHere.tabId !== tab.id;
          const isRenaming = renamingTabId === tab.id;
          const tabFavicon = favicons?.[tab.id];
          const tabClassName = [
            'wb-session-tab',
            isSelected ? 'active' : '',
            isRenaming ? 'renaming' : '',
            isBeingDragged ? 'dragging' : '',
            isTargetBefore ? 'wb-drop-target-before' : '',
            isTargetAfter ? 'wb-drop-target-after' : '',
          ].filter(Boolean).join(' ');

          return (
            <div
              key={tab.id}
              className={tabClassName}
              data-tab-id={tab.id}
              style={isRenaming && renameWidth ? { width: renameWidth, flexBasis: renameWidth } : shift ? { transform: `translateX(${shift}px)` } : undefined}
            >
              {isRenaming ? (
                <div className="wb-tab-rename-row">
                  <span className="wb-tab-icon" aria-hidden="true">
                    <PaneTabIcon tab={tab} favicon={tabFavicon} />
                  </span>
                  <TabNameInput
                    name={displayName}
                    report={reportError}
                    onSave={async (title) => {
                      await onRenameTab(tab, title);
                      setRenamingTabId(null);
                    }}
                    onClose={(restore) => {
                      setRenamingTabId(null);
                      setRenameWidth(null);
                      if (restore) {
                        requestAnimationFrame(() => {
                          const active = document.activeElement;
                          if (active && active !== document.body && active.isConnected) return;
                          document.getElementById('tab-' + tab.id)?.focus();
                        });
                      }
                    }}
                  />
                  <StatusDot tone={dotClass} ariaLabel={status} />
                </div>
              ) : (
                <button
                  type="button"
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-selected={isSelected}
                  tabIndex={isSelected ? 0 : -1}
                  disabled={!online}
                  title={`${displayName}${isUnsaved ? ' •' : ''} · ${status}`}
                  aria-keyshortcuts="F2 Alt+ArrowLeft Alt+ArrowRight"
                  onClick={(event) => {
                    if (Date.now() < suppressTabClickUntil.current) { event.preventDefault(); return; }
                    onSelectTab(tab.id);
                  }}
                  onDoubleClick={(event) => beginRename(tab.id, event.currentTarget)}
                  onKeyDown={(e) => {
                    if (e.key === 'F2') {
                      e.preventDefault();
                      beginRename(tab.id, e.currentTarget);
                    }
                  }}
                >
                  <span className="wb-tab-icon" aria-hidden="true">
                    <PaneTabIcon tab={tab} favicon={tabFavicon} />
                  </span>
                  <span
                    className="agency-truncate"
                    title={t('agency.web.rename')}
                    onDoubleClick={(event) => beginRename(tab.id, event.currentTarget)}
                  >
                    {displayName}{isUnsaved ? ' •' : ''}
                  </span>
                  <StatusDot tone={dotClass} ariaLabel={status} />
                </button>
              )}
              <button
                type="button"
                data-close
                aria-label={t('agency.tabs.closeNamed', { name: displayName })}
                disabled={!online || busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
        <div className="agency-dropdown wb-add-tab" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            ref={addButton}
            className="wb-pane-add-tab"
            aria-label={t('agency.tabs.add')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={!online || busy}
            onClick={() => {
              setMenuOpen(!menuOpen);
            }}
          >
            +
          </button>
          {menuOpen && (
            <PaneMenu
              anchor={addButton}
              label={t('agency.tabs.add')}
              onClose={() => setMenuOpen(false)}
            >
              <button type="button" role="menuitem" onClick={() => choose('terminal')}>
                {t('agency.tabs.newTerminal')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item-browser"
                onClick={() => {
                  setMenuOpen(false);
                  onAddWebTabClick();
                }}
              >
                {t('agency.web.newTab')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="wb-menu-item-disabled"
                disabled
                aria-disabled="true"
                title={t('agency.tabs.comingSoon')}
              >
                {t('agency.tabs.openFile')}
              </button>
            </PaneMenu>
          )}
        </div>

        {isWebTab && zoomPercentage !== null && (
          <div className="wb-zoom-indicator" role="status" aria-live="polite">
            {zoomPercentage}%
          </div>
        )}

      <div className="wb-pane-actions">
        <button
          type="button"
          className={`wb-pane-action-button wb-pane-expand-button${isMaximized ? ' active' : ''}`}
          data-pane-expand
          title={isMaximized ? t('agency.splits.collapsePane') : t('agency.splits.expandPane')}
          aria-label={isMaximized ? t('agency.splits.collapsePane') : t('agency.splits.expandPane')}
          aria-pressed={isMaximized}
          disabled={!canToggleMaximize || !online}
          onClick={onToggleMaximize}
        >
          {isMaximized ? (
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 6.5H6.5V2.5" />
              <path d="M13.5 6.5H9.5V2.5" />
              <path d="M2.5 9.5H6.5V13.5" />
              <path d="M13.5 9.5H9.5V13.5" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 6V2.5H6" />
              <path d="M10 2.5H13.5V6" />
              <path d="M2.5 10V13.5H6" />
              <path d="M10 13.5H13.5V10" />
            </svg>
          )}
        </button>
        <PaneGrip paneId={paneId} workspaceId={workspaceId} disabled={moveDisabled} destinations={destinations} onSwap={onSwapPane} />
        {isWebTab && (
          <button
            type="button"
            className={`wb-pane-action-button wb-browser-toolbar-toggle ${browserToolbarOpen ? 'active' : ''}`}
            title={browserToolbarOpen ? t('agency.browser.hideToolbar') : t('agency.browser.showToolbar')}
            aria-label={browserToolbarOpen ? t('agency.browser.hideToolbar') : t('agency.browser.showToolbar')}
            aria-expanded={browserToolbarOpen}
            onClick={onToggleBrowserToolbar}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="2" width="13" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path d="M1.5 5.5h13" stroke="currentColor" strokeWidth="1.2" />
              <circle cx="4" cy="3.75" r="0.75" fill="currentColor" />
              <circle cx="6.5" cy="3.75" r="0.75" fill="currentColor" />
            </svg>
          </button>
        )}
        <button
          ref={paneActionBtn}
          type="button"
          className="wb-pane-action-button wb-pane-menu-toggle"
          title={t('agency.splits.paneActions')}
          aria-label={t('agency.splits.paneActions')}
          aria-haspopup="menu"
          aria-expanded={paneActionsOpen}
          disabled={!online}
          onClick={() => setPaneActionsOpen((open) => !open)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
        {paneActionsOpen && (
          <PaneMenu
            anchor={paneActionBtn}
            label={t('agency.splits.paneActions')}
            onClose={() => setPaneActionsOpen(false)}
          >
            <button
              type="button"
              role="menuitem"
              className="agency-dropdown-item"
              disabled={!online || !splitRightAllowed}
              title={splitRightReason}
              onClick={() => {
                setPaneActionsOpen(false);
                onSplitRight();
              }}
            >
              <span className="agency-dropdown-label">{t('agency.splits.splitVertically')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="agency-dropdown-item"
              disabled={!online || !splitDownAllowed}
              title={splitDownReason}
              onClick={() => {
                setPaneActionsOpen(false);
                onSplitDown();
              }}
            >
              <span className="agency-dropdown-label">{t('agency.splits.splitHorizontally')}</span>
            </button>
            {showSinglePane && onSinglePane && (
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item"
                onClick={() => {
                  setPaneActionsOpen(false);
                  onSinglePane();
                }}
              >
                <span className="agency-dropdown-label">{t('agency.splits.singlePane')}</span>
              </button>
            )}
            {onMarkDone && (
              <button
                type="button"
                role="menuitem"
                className="agency-dropdown-item"
                onClick={() => {
                  setPaneActionsOpen(false);
                  onMarkDone();
                }}
              >
                <span className="agency-dropdown-label">{t('agency.ui.markDone')}</span>
              </button>
            )}
          </PaneMenu>
        )}
        <button
          type="button"
          className="wb-pane-action-button wb-pane-close-button"
          data-pane-close
          title={t('agency.splits.closePane')}
          aria-label={t('agency.splits.closePane')}
          disabled={!canClose || !online || busy}
          onClick={onClosePane}
        >
          ×
        </button>
      </div>
    </div>
  );
}

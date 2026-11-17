import { useEffect, useRef, useState } from 'react';
import type { AgencyCliProfile, MawActivityState, SplitDirection, WorkspaceId, BrowserFavorite, SearchEngine } from '@agent-workbench/shared';
import { DEFAULT_BROWSER_FAVORITES, getSearchEngine } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import { agencySessionText, agencyTabActivityText } from '../agency-labels.js';
import type { WorkspaceTab } from '../model.js';
import { PaneMenu } from './PaneMenu.js';
import { PaneGrip } from './PaneMovement.js';
import { setTabDragPreview, useTabDragPreview } from './tab-drag-store.js';
import { insertionIndex, tabShift } from './tab-geometry.mjs';
import { TabNameInput } from '../TabNameInput.js';
import type { useAgencyStore } from '../useAgencyStore.js';
import { BrowserDestinationPicker } from './BrowserDestinationPicker.js';
import { GlobeIcon } from '../GlobeIcon.js';

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
  isMaximized: boolean;
  online: boolean;
  busy: boolean;
  request: ReturnType<typeof useAgencyStore>['request'];
  getTabActivity?: (workspaceId: WorkspaceId, tabId: string) => MawActivityState;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tab: WorkspaceTab) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onToggleMaximize: () => void;
  onClosePane: () => void;
  onAddTerminalClick: () => void;
  onAddAgentClick?: (profileId?: string) => void;
  onAddWebTabClick: () => void;
  onOpenFileClick?: () => void;
  onSplitCreate?: (direction: SplitDirection, action: 'terminal' | 'web' | 'file') => void;
  onMoveTabToPane: (tabId: string, targetPaneId: string, targetIndex?: number) => void;
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
  onAddAgentClick,
  onAddWebTabClick,
  onOpenFileClick,
  onSplitCreate,
  onMoveTabToPane,
  onRenameTab,
  isTabUnsaved,
  reportError,
  onMarkDone,
  onSinglePane,
  showSinglePane,
  browserToolbarOpen,
  onToggleBrowserToolbar,
  browserFavorites,
  searchEngine,
  onSelectBrowserFavorite,
  onSelectBrowserOther,
  favicons,
}: Props): JSX.Element {
  const selectedTab = tabs.find((tab) => tab.id === selectedTabId);
  const isWebTab = selectedTab?.kind === 'web';
  const [zoomPercentage, setZoomPercentage] = useState<number | null>(null);
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const bridge = window.mawChatGpt;
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

  const [menuView, setMenuView] = useState<'main' | 'browser'>('main');

  useEffect(() => {
    return () => {
      if (zoomTimer.current) clearTimeout(zoomTimer.current);
    };
  }, []);

  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paneActionsOpen, setPaneActionsOpen] = useState(false);
  const [renameWidth, setRenameWidth] = useState<number | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const paneActionBtn = useRef<HTMLButtonElement>(null);
  const splitRightAllowed = canSplitRight !== undefined ? canSplitRight : canSplit;
  const splitDownAllowed = canSplitDown !== undefined ? canSplitDown : canSplit;
  const strip = useRef<HTMLDivElement | null>(null);
  const dragPreview = useTabDragPreview();
  const [dragState, setDragState] = useState<{ tabId: string; targetIndex: number } | null>(null);
  const suppressTabClickUntil = useRef(0);
  const tabDrag = useRef<{
    tabId: string;
    pointerId: number;
    startX: number;
    startY: number;
    grabOffsetX: number;
    grabOffsetY: number;
    isDragging: boolean;
    targetIndex: number;
    overPaneId: string | null;
    sourceWidth: number;
    ghostEl: HTMLElement | null;
    shieldEl: HTMLElement | null;
    cachedHeaders: Map<string, { rect: DOMRect; tabRects: { left: number; width: number }[] }>;
    rafId: number;
    latestX: number;
    latestY: number;
  } | null>(null);

  const cleanupDrag = () => {
    if (tabDrag.current?.rafId) {
      cancelAnimationFrame(tabDrag.current.rafId);
      tabDrag.current.rafId = 0;
    }
    if (tabDrag.current?.ghostEl) {
      tabDrag.current.ghostEl.remove();
      tabDrag.current.ghostEl = null;
    }
    if (tabDrag.current?.shieldEl) {
      tabDrag.current.shieldEl.remove();
      tabDrag.current.shieldEl = null;
    }
    document.body.classList.remove('maw-pane-dragging');
    tabDrag.current = null;
    setDragState(null);
    setTabDragPreview(null);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && tabDrag.current) {
        cleanupDrag();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      cleanupDrag();
    };
  }, []);

  useEffect(() => {
    const node = strip.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      // Touchpad horizontal swipe: pass through to native browser momentum scrolling
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

      // Vertical mouse wheel: convert to horizontal scroll
      if (node.scrollWidth <= node.clientWidth) return;

      let delta = event.deltaY;
      if (event.deltaMode === 1) {
        // Line mode
        delta *= 18;
      } else if (event.deltaMode === 2) {
        // Page mode
        delta *= node.clientWidth;
      } else {
        // Pixel mode: damp excessive wheel jumps
        delta = Math.sign(delta) * Math.min(Math.abs(delta), 100);
      }

      if (delta === 0) return;

      // Allow event to bubble to parent when reaching boundaries
      if (delta < 0 && node.scrollLeft <= 0) return;
      if (delta > 0 && node.scrollLeft + node.clientWidth >= node.scrollWidth - 1) return;

      event.preventDefault();
      node.scrollLeft += delta;
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [tabIds.length]);

  useEffect(() => {
    if (dragPreview) return;
    const node = strip.current;
    const selected = node?.querySelector<HTMLElement>('.maw-session-tab.active');
    if (!node || !selected) return;
    const left = selected.offsetLeft;
    const right = left + selected.offsetWidth;
    if (left < node.scrollLeft) node.scrollLeft = left;
    else if (right > node.scrollLeft + node.clientWidth) node.scrollLeft = right - node.clientWidth;
  }, [selectedTabId, dragPreview]);

  const paneTabs = tabIds
    .map((id) => tabs.find((t) => t.id === id))
    .filter((t): t is WorkspaceTab => t !== undefined);

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

  function choose(action: 'terminal' | 'agent' | 'web' | 'file') {
    setMenuOpen(false);
    if (action === 'terminal') onAddTerminalClick();
    else if (action === 'agent') onAddAgentClick?.();
    else if (action === 'web') onAddWebTabClick();
    else if (action === 'file') onOpenFileClick?.();
  }

  function tabName(tab: WorkspaceTab) {
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

  function renderTabIcon(tab: WorkspaceTab, favicon?: string) {
    if (tab.kind === 'web') {
      if (favicon) {
        return (
          <span className="maw-tab-icon-wrapper" aria-hidden="true">
            <img
              className="maw-tab-favicon"
              src={favicon}
              alt=""
              onError={(e) => {
                e.currentTarget.style.display = 'none';
                const fallback = e.currentTarget.nextElementSibling as HTMLElement | null;
                if (fallback) fallback.style.display = 'inline-flex';
              }}
            />
            <span className="maw-tab-icon-fallback" style={{ display: 'none' }}>
              <GlobeIcon size={14} />
            </span>
          </span>
        );
      }
      return (
        <span className="maw-tab-icon-fallback" aria-hidden="true">
          <GlobeIcon size={14} />
        </span>
      );
    }
    if (tab.kind === 'editor') return <span>✎</span>;
    if (tab.session?.kind === 'agent') return <span>◇</span>;
    return <span>&gt;_</span>;
  }

  return (
    <div
      className={`maw-pane-header${isFocused ? ' is-focused' : ''}${dragPreview?.overPaneId === paneId && dragPreview.sourcePaneId !== paneId ? ' is-tab-drop' : ''}`}
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
          onMoveTabToPane(draggedId, paneId, dragOverIndex ?? undefined);
          setDragOverIndex(null);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOverIndex(null);
        }
      }}
    >
      <div
        className={'maw-pane-tabs' + (dragState ? ' is-dragging' : '')}
        ref={strip}
        role="tablist"
        aria-label={t('agency.tabs.tabList')}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest('[data-close], input')) return;
          const tabEl = (event.target as Element).closest<HTMLElement>('.maw-session-tab');
          if (tabEl) {
            const tabId = tabEl.getAttribute('data-tab-id');
            if (tabId) {
              const idx = paneTabs.findIndex((t) => t.id === tabId);
              const rect = tabEl.getBoundingClientRect();
              tabDrag.current = {
                tabId,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                grabOffsetX: event.clientX - rect.left,
                grabOffsetY: event.clientY - rect.top,
                isDragging: false,
                targetIndex: idx,
                overPaneId: paneId,
                sourceWidth: rect.width,
                ghostEl: null,
                shieldEl: null,
                cachedHeaders: new Map(),
                rafId: 0,
                latestX: event.clientX,
                latestY: event.clientY,
              };
            }
          }
        }}
        onPointerMove={(event) => {
          const drag = tabDrag.current;
          if (drag && drag.pointerId === event.pointerId) {
            if (!drag.isDragging) {
              if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 6) {
                drag.isDragging = true;
                event.currentTarget.setPointerCapture(event.pointerId);

                // Create ghost element tracking the cursor
                const sourceTab = paneTabs.find((t) => t.id === drag.tabId);
                if (sourceTab) {
                  const ghost = document.createElement('div');
                  ghost.className = 'maw-tab-drag-ghost';
                  const iconSpan = document.createElement('span');
                  iconSpan.setAttribute('aria-hidden', 'true');
                  const sourceFav = favicons?.[sourceTab.id];
                  if (sourceTab.kind === 'web' && sourceFav) {
                    const img = document.createElement('img');
                    img.className = 'maw-tab-favicon';
                    img.src = sourceFav;
                    iconSpan.appendChild(img);
                  } else {
                    iconSpan.textContent =
                      sourceTab.kind === 'web'
                        ? '🌐'
                        : sourceTab.kind === 'editor'
                          ? '✎'
                          : sourceTab.session?.kind === 'agent'
                            ? '◇'
                            : '>_';
                  }
                  const titleSpan = document.createElement('span');
                  titleSpan.className = 'agency-truncate';
                  titleSpan.textContent = tabName(sourceTab);
                  ghost.appendChild(iconSpan);
                  ghost.appendChild(titleSpan);
                  ghost.style.transform = `translate3d(${event.clientX - drag.grabOffsetX}px, ${event.clientY - drag.grabOffsetY}px, 0)`;
                  document.body.appendChild(ghost);
                  drag.ghostEl = ghost;
                }

                // Add drag shield so native WebContentsViews do not obscure dragged ghost or drop targets
                if (!document.querySelector('.maw-pane-drag-shield')) {
                  const shield = document.createElement('div');
                  shield.className = 'maw-pane-drag-shield';
                  shield.setAttribute('aria-hidden', 'true');
                  document.body.appendChild(shield);
                  drag.shieldEl = shield;
                }
                document.body.classList.add('maw-pane-dragging');
              }
            }
            if (drag.isDragging) {
              event.preventDefault();

              // Coalesce ghost transform updates to requestAnimationFrame (cuts style recalcs under rapid pointermove)
              drag.latestX = event.clientX;
              drag.latestY = event.clientY;
              if (drag.rafId === 0) {
                drag.rafId = requestAnimationFrame(() => {
                  const current = tabDrag.current;
                  if (current && current.rafId !== 0) {
                    current.rafId = 0;
                    if (current.ghostEl) {
                      current.ghostEl.style.transform = `translate3d(${current.latestX - current.grabOffsetX}px, ${current.latestY - current.grabOffsetY}px, 0)`;
                    }
                  }
                });
              }

              // Determine target pane
              let targetPaneId: string | null = null;
              let targetPaneEl: HTMLElement | null = null;

              const currentHeader = drag.overPaneId ? drag.cachedHeaders.get(drag.overPaneId) : undefined;
              if (
                currentHeader &&
                event.clientX >= currentHeader.rect.left &&
                event.clientX <= currentHeader.rect.right &&
                event.clientY >= currentHeader.rect.top &&
                event.clientY <= currentHeader.rect.bottom
              ) {
                targetPaneId = drag.overPaneId;
              } else {
                const elUnder = document.elementFromPoint(event.clientX, event.clientY);
                targetPaneEl = elUnder?.closest<HTMLElement>('.maw-split-pane') ?? null;
                targetPaneId = targetPaneEl?.id.replace('pane-container-', '') ?? null;
              }

              if (!targetPaneId) return;

              // Cache header rects on first encounter during this drag
              let headerData = drag.cachedHeaders.get(targetPaneId);
              if (!headerData) {
                const pEl = targetPaneEl ?? document.getElementById(`pane-container-${targetPaneId}`);
                const header = pEl?.querySelector<HTMLElement>('.maw-pane-header');
                if (header) {
                  const headerRect = header.getBoundingClientRect();
                  const tabEls = [...header.querySelectorAll<HTMLElement>('.maw-session-tab')];
                  const tabRects = tabEls.map((element) => {
                    const rect = element.getBoundingClientRect();
                    return { left: rect.left, width: rect.width };
                  });
                  headerData = { rect: headerRect, tabRects };
                  drag.cachedHeaders.set(targetPaneId, headerData);
                }
              }

              const rects = headerData?.tabRects ?? [];
              const target = targetPaneId && rects.length > 0 ? insertionIndex(event.clientX, rects) : rects.length;

              // Only update React state when target index or pane actually changes!
              if (target !== drag.targetIndex || targetPaneId !== drag.overPaneId) {
                drag.targetIndex = target;
                drag.overPaneId = targetPaneId;
                setDragState({ tabId: drag.tabId, targetIndex: target });
                setTabDragPreview({
                  tabId: drag.tabId,
                  sourcePaneId: paneId,
                  sourceIndex: paneTabs.findIndex((tab) => tab.id === drag.tabId),
                  width: drag.sourceWidth,
                  overPaneId: targetPaneId,
                  overIndex: target,
                });
              }
            }
          }
        }}
        onPointerUp={async (event) => {
          const dragInfo = tabDrag.current;
          if (dragInfo && dragInfo.pointerId === event.pointerId) {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            cleanupDrag();

            if (dragInfo.isDragging) {
              suppressTabClickUntil.current = Date.now() + 200;
              const elUnder = document.elementFromPoint(event.clientX, event.clientY);
              const destination = elUnder?.closest('.maw-split-pane')?.id.replace('pane-container-', '') ?? dragInfo.overPaneId;
              if (!destination) return;
              const targetPaneEl = document.getElementById(`pane-container-${destination}`);
              const targetHeader = targetPaneEl?.querySelector('.maw-pane-header');
              const targetElements = targetHeader ? [...targetHeader.querySelectorAll<HTMLElement>('.maw-session-tab')] : [];
              const targetIndex = targetElements.findIndex((element) => {
                const rect = element.getBoundingClientRect();
                return event.clientX < rect.left + rect.width / 2;
              });
              const insertion = targetIndex < 0 ? targetElements.length : targetIndex;
              const sourceIndex = paneTabs.findIndex((tab) => tab.id === dragInfo.tabId);
              onMoveTabToPane(dragInfo.tabId, destination, destination === paneId && insertion > sourceIndex ? insertion - 1 : insertion);
              if (destination !== paneId) return;
              const currentIdx = tabs.findIndex((t) => t.id === dragInfo.tabId);
              const targetPaneTab = paneTabs[dragInfo.targetIndex];
              const targetIdx = targetPaneTab ? tabs.findIndex((t) => t.id === targetPaneTab.id) : tabs.length;
              if (currentIdx !== -1 && targetIdx !== currentIdx && targetIdx !== currentIdx + 1) {
                const ids = tabs.map((t) => t.id);
                const [draggedId] = ids.splice(currentIdx, 1);
                const insertIdx = targetIdx > currentIdx ? targetIdx - 1 : targetIdx;
                ids.splice(insertIdx, 0, draggedId!);
                try {
                  await request({ type: 'agency.tabs.order', workspaceId, tabIds: ids });
                } catch (reason) {
                  reportError(String(reason));
                }
              }
            }
          }
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          cleanupDrag();
        }}
      >
        {paneTabs.map((tab, idx) => {
          const tabState = getTabActivity?.(workspaceId, tab.id);
          const session = tab.kind === 'native' ? tab.session : undefined;
          const isUnsaved = isTabUnsaved?.(tab.id);
          const status = tabState
            ? agencyTabActivityText(tabState)
            : session
              ? agencySessionText(session)
              : tab.kind === 'editor'
                ? (isUnsaved ? t('docs.edit.unsaved') : t('agency.tabs.editor'))
                : t('agency.web.tabKind');
          const dotClass =
            tab.kind === 'editor'
              ? (isUnsaved ? 'attention' : 'idle')
              : tabState === 'finished'
                ? 'finished'
                : tabState === 'failed' ||
                    session?.lifecycle === 'failed' ||
                    session?.recovery?.status === 'manual' ||
                    (tab.kind === 'web' && ['error', 'crashed'].includes(tab.web.runtimeState ?? ''))
                  ? 'failed'
                  : session?.lifecycle === 'exited'
                    ? 'muted'
                    : session && ['awaiting-user', 'awaiting-permission'].includes(session.activity)
                      ? 'attention'
                      : (tab.kind === 'web' && ['navigating', 'attaching'].includes(tab.web.runtimeState ?? ''))
                        ? 'working'
                        : tabState === 'needs-input'
                          ? 'attention'
                          : tabState ?? (session?.activity === 'working' ? 'working' : session?.activity === 'idle' ? 'idle' : 'unknown');

          const isSelected = selectedTabId === tab.id;
          const previewHere = dragPreview?.overPaneId === paneId ? dragPreview : null;
          const samePane = previewHere?.sourcePaneId === paneId;
          const shift = previewHere
            ? tabShift(idx, previewHere.sourceIndex, previewHere.overIndex, previewHere.width, samePane)
            : 0;

          const isBeingDragged = dragPreview?.tabId === tab.id && dragPreview.sourcePaneId === paneId;
          const isTargetBefore = (previewHere?.overIndex === idx && previewHere.tabId !== tab.id) || dragOverIndex === idx;
          const isTargetAfter = previewHere?.overIndex === paneTabs.length && idx === paneTabs.length - 1 && previewHere.tabId !== tab.id;
          const isRenaming = renamingTabId === tab.id;
          const tabFavicon = favicons?.[tab.id];
          const tabClassName = [
            'maw-session-tab',
            isSelected ? 'active' : '',
            isRenaming ? 'renaming' : '',
            isBeingDragged ? 'dragging' : '',
            isTargetBefore ? 'maw-drop-target-before' : '',
            isTargetAfter ? 'maw-drop-target-after' : '',
          ].filter(Boolean).join(' ');

          return (
            <div
              key={tab.id}
              className={tabClassName}
              data-tab-id={tab.id}
              style={isRenaming && renameWidth ? { width: renameWidth, flexBasis: renameWidth } : shift ? { transform: `translateX(${shift}px)` } : undefined}
            >
              {isRenaming ? (
                <div className="maw-tab-rename-row">
                  <span className="maw-tab-icon" aria-hidden="true">
                    {renderTabIcon(tab, tabFavicon)}
                  </span>
                  <TabNameInput
                    name={tabName(tab)}
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
                  <span className={`agency-status-dot ${dotClass}`} aria-label={status} />
                </div>
              ) : (
                <button
                  type="button"
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-selected={isSelected}
                  tabIndex={isSelected ? 0 : -1}
                  disabled={!online}
                  title={`${tabName(tab)}${isUnsaved ? ' •' : ''} · ${status}`}
                  aria-keyshortcuts="F2 Alt+ArrowLeft Alt+ArrowRight"
                  onClick={(event) => {
                    if (Date.now() < suppressTabClickUntil.current) { event.preventDefault(); return; }
                    onSelectTab(tab.id);
                  }}
                  onDoubleClick={(event) => {
                    const host = (event.currentTarget as HTMLElement).closest<HTMLElement>('.maw-session-tab');
                    setRenameWidth(host?.getBoundingClientRect().width ?? null);
                    setRenamingTabId(tab.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'F2') {
                      e.preventDefault();
                      const host = (e.currentTarget as HTMLElement).closest<HTMLElement>('.maw-session-tab');
                      setRenameWidth(host?.getBoundingClientRect().width ?? null);
                      setRenamingTabId(tab.id);
                    }
                  }}
                >
                  <span className="maw-tab-icon" aria-hidden="true">
                    {renderTabIcon(tab, tabFavicon)}
                  </span>
                  <span
                    className="agency-truncate"
                    onDoubleClick={(event) => {
                      const host = (event.currentTarget as HTMLElement).closest<HTMLElement>('.maw-session-tab');
                      setRenameWidth(host?.getBoundingClientRect().width ?? null);
                      setRenamingTabId(tab.id);
                    }}
                  >
                    {tabName(tab)}{isUnsaved ? ' •' : ''}
                  </span>
                  <span className={`agency-status-dot ${dotClass}`} aria-label={status} />
                </button>
              )}
              <button
                type="button"
                data-close
                aria-label={t('agency.tabs.closeNamed', { name: tabName(tab) })}
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
        <div className="agency-dropdown maw-add-tab" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            ref={addButton}
            className="maw-pane-add-tab"
            aria-label={t('agency.tabs.add')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={!online || busy}
            onClick={() => {
              setMenuView('main');
              setMenuOpen(!menuOpen);
            }}
          >
            +
          </button>
          {menuOpen && (
            <PaneMenu
              anchor={addButton}
              label={t('agency.tabs.add')}
              onClose={() => {
                setMenuOpen(false);
                setMenuView('main');
              }}
            >
              {menuView === 'main' ? (
                <>
                  <button type="button" role="menuitem" onClick={() => choose('terminal')}>
                    {t('agency.tabs.newTerminal')}
                  </button>
                  <button type="button" role="menuitem" onClick={() => choose('agent')}>
                    {t('agency.tabs.codingAgent') || 'Coding Agent'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="agency-dropdown-item-browser"
                    onClick={() => setMenuView('browser')}
                  >
                    {t('agency.web.newTab')}
                  </button>
                  <button type="button" role="menuitem" onClick={() => choose('file')}>
                    {t('agency.tabs.openFile')}
                  </button>
                  {selectedTabId && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setRenamingTabId(selectedTabId);
                      }}
                    >
                      {t('agency.web.rename')}
                    </button>
                  )}
                </>
              ) : (
                <BrowserDestinationPicker
                  favorites={browserFavorites ?? DEFAULT_BROWSER_FAVORITES}
                  searchEngine={searchEngine ?? getSearchEngine()}
                  onBack={() => setMenuView('main')}
                  onSelectFavorite={(fav) => {
                    setMenuOpen(false);
                    setMenuView('main');
                    if (onSelectBrowserFavorite) {
                      onSelectBrowserFavorite(fav);
                    } else {
                      onAddWebTabClick();
                    }
                  }}
                  onSelectOther={() => {
                    setMenuOpen(false);
                    setMenuView('main');
                    if (onSelectBrowserOther) {
                      onSelectBrowserOther();
                    } else {
                      onAddWebTabClick();
                    }
                  }}
                />
              )}
            </PaneMenu>
          )}
        </div>

        {isWebTab && zoomPercentage !== null && (
          <div className="maw-zoom-indicator" role="status" aria-live="polite">
            {zoomPercentage}%
          </div>
        )}

      <div className="maw-pane-actions">
        {isWebTab && (
          <button
            type="button"
            className={`maw-pane-action-button maw-browser-toolbar-toggle ${browserToolbarOpen ? 'active' : ''}`}
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
          className="maw-pane-action-button maw-pane-menu-toggle"
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
                if (onSplitCreate) onSplitCreate('row', 'terminal');
                else onSplitRight();
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
                if (onSplitCreate) onSplitCreate('column', 'terminal');
                else onSplitDown();
              }}
            >
              <span className="agency-dropdown-label">{t('agency.splits.splitHorizontally')}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="agency-dropdown-item"
              onClick={() => {
                setPaneActionsOpen(false);
                onToggleMaximize();
              }}
            >
              <span className="agency-dropdown-label">
                {isMaximized ? t('agency.splits.restorePane') : t('agency.splits.maximizePane')}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="agency-dropdown-item"
              disabled={!canClose || !online}
              title={!canClose ? t('agency.splits.singlePane') : undefined}
              onClick={() => {
                setPaneActionsOpen(false);
                onClosePane();
              }}
            >
              <span className="agency-dropdown-label">{t('agency.splits.closePane')}</span>
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
        <PaneGrip paneId={paneId} workspaceId={workspaceId} disabled={moveDisabled} destinations={destinations} onSwap={onSwapPane} />
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { AgencyCliProfile, MawActivityState, SplitDirection, WorkspaceId } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import { agencySessionText, agencyTabActivityText } from '../agency-labels.js';
import { canLaunchAgent, type WorkspaceTab } from '../model.js';
import { PaneMenu } from './PaneMenu.js';
import { PaneGrip } from './PaneMovement.js';
import { setTabDragPreview, useTabDragPreview } from './tab-drag-store.js';
import { insertionIndex, tabShift } from './tab-geometry.mjs';
import { TabNameInput } from '../TabNameInput.js';
import type { useAgencyStore } from '../useAgencyStore.js';

interface Props {
  paneId: string;
  tabIds: string[];
  selectedTabId: string | null;
  tabs: WorkspaceTab[];
  profiles: readonly AgencyCliProfile[];
  workspaceId: WorkspaceId;
  isFocused: boolean;
  canSplit: boolean;
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
  onAddCliClick: () => void;
  onAddTerminalClick: () => void;
  onAddWebTabClick: () => void;
  onAddGithubClick?: () => void;
  onAddPerplexityClick?: () => void;
  onOpenFileClick?: () => void;
  onLaunchProfile?: (profileId: string) => void;
  onSplitCreate?: (direction: SplitDirection, action: 'terminal' | 'agent' | 'web' | 'github' | 'perplexity' | 'file', profileId?: string) => void;
  onMoveTabToPane: (tabId: string, targetPaneId: string, targetIndex?: number) => void;
  onRenameTab: (tab: WorkspaceTab, title: string) => Promise<void>;
  isTabUnsaved?: (tabId: string) => boolean;
  reportError: (error: string) => void;
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
  onAddCliClick,
  onAddTerminalClick,
  onAddWebTabClick,
  onAddGithubClick,
  onAddPerplexityClick,
  onOpenFileClick,
  onLaunchProfile,
  onSplitCreate,
  onMoveTabToPane,
  onRenameTab,
  isTabUnsaved,
  reportError,
}: Props): JSX.Element {
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [splitIntent, setSplitIntent] = useState<SplitDirection | null>(null);
  const [renameWidth, setRenameWidth] = useState<number | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const dragPreview = useTabDragPreview();
  const [dragState, setDragState] = useState<{ tabId: string; targetIndex: number } | null>(null);
  const suppressTabClickUntil = useRef(0);
  const tabDrag = useRef<{
    tabId: string;
    pointerId: number;
    startX: number;
    startY: number;
    isDragging: boolean;
    targetIndex: number;
  } | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && tabDrag.current) {
        tabDrag.current = null;
        setDragState(null);
        setTabDragPreview(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const node = strip.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (node.scrollWidth <= node.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
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

  function choose(action: 'terminal' | 'agent' | 'web' | 'github' | 'perplexity' | 'file', profileId?: string) {
    const direction = splitIntent;
    setMenuOpen(false);
    setSplitIntent(null);
    if (direction) {
      if (onSplitCreate) onSplitCreate(direction, action, profileId);
      else if (direction === 'row') onSplitRight();
      else onSplitDown();
      return;
    }
    if (action === 'terminal') onAddTerminalClick();
    else if (action === 'github') onAddGithubClick?.();
    else if (action === 'perplexity') onAddPerplexityClick?.();
    else if (action === 'web') onAddWebTabClick();
    else if (action === 'file') onOpenFileClick?.();
    else if (profileId) onLaunchProfile?.(profileId);
    else onAddCliClick();
  }

  function openMenu(button: HTMLButtonElement | null, direction: SplitDirection | null) {
    menuAnchor.current = button;
    setSplitIntent(direction);
    setMenuOpen(true);
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
              tabDrag.current = {
                tabId,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                isDragging: false,
                targetIndex: idx,
              };
            }
          }
        }}
        onPointerMove={(event) => {
          if (tabDrag.current && tabDrag.current.pointerId === event.pointerId) {
            if (!tabDrag.current.isDragging) {
              if (Math.hypot(event.clientX - tabDrag.current.startX, event.clientY - tabDrag.current.startY) > 6) {
                tabDrag.current.isDragging = true;
                event.currentTarget.setPointerCapture(event.pointerId);
              }
            }
            if (tabDrag.current.isDragging) {
              event.preventDefault();
              const elUnder = document.elementFromPoint(event.clientX, event.clientY);
              const paneEl = elUnder?.closest('.maw-split-pane');
              const overPaneId = paneEl?.id.replace('pane-container-', '') ?? null;
              const header = paneEl?.querySelector('.maw-pane-header');
              const rects = header ? [...header.querySelectorAll<HTMLElement>('.maw-session-tab')].map((element) => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, width: rect.width };
              }) : [];
              const target = overPaneId && rects.length > 0 ? insertionIndex(event.clientX, rects) : rects.length;
              tabDrag.current.targetIndex = target;
              const source = strip.current?.querySelector<HTMLElement>(`[data-tab-id="${tabDrag.current.tabId}"]`);
              setDragState({ tabId: tabDrag.current.tabId, targetIndex: target });
              setTabDragPreview({
                tabId: tabDrag.current.tabId,
                sourcePaneId: paneId,
                sourceIndex: paneTabs.findIndex((tab) => tab.id === tabDrag.current?.tabId),
                width: source?.getBoundingClientRect().width ?? 0,
                overPaneId,
                overIndex: overPaneId ? target : null,
              });
            }
          }
        }}
        onPointerUp={async (event) => {
          if (tabDrag.current && tabDrag.current.pointerId === event.pointerId) {
            const dragInfo = tabDrag.current;
            tabDrag.current = null;
            setDragState(null);
            setTabDragPreview(null);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            if (dragInfo.isDragging) {
              suppressTabClickUntil.current = Date.now() + 200;
              const elUnder = document.elementFromPoint(event.clientX, event.clientY);
              const destination = elUnder?.closest('.maw-split-pane')?.id.replace('pane-container-', '');
              if (!destination) return;
              const targetPaneEl = document.getElementById(`pane-container-${destination}`);
              const targetHeader = targetPaneEl?.querySelector('.maw-pane-header');
              const targetElements = targetHeader ? [...targetHeader.querySelectorAll<HTMLElement>('.maw-session-tab')] : [];
              const targetIndex = targetElements.findIndex(element => {
                const rect = element.getBoundingClientRect();
                return event.clientX < rect.left + rect.width / 2;
              });
              const insertion = targetIndex < 0 ? targetElements.length : targetIndex;
              const sourceIndex = paneTabs.findIndex(tab => tab.id === dragInfo.tabId);
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
          tabDrag.current = null;
          setDragState(null);
          setTabDragPreview(null);
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
          const tabClassName = [
            'maw-session-tab',
            isSelected ? 'active' : '',
            isBeingDragged ? 'dragging' : '',
            isTargetBefore ? 'maw-drop-target-before' : '',
            isTargetAfter ? 'maw-drop-target-after' : '',
          ].filter(Boolean).join(' ');

          return (
            <div
              key={tab.id}
              className={tabClassName}
              data-tab-id={tab.id}
              style={renamingTabId === tab.id && renameWidth ? { width: renameWidth, flexBasis: renameWidth } : shift ? { transform: `translateX(${shift}px)` } : undefined}
            >
              {renamingTabId === tab.id ? (
                <TabNameInput
                  name={tabName(tab)}
                  report={reportError}
                  onSave={async (title) => {
                    await onRenameTab(tab, title);
                    setRenamingTabId(null);
                  }}
                  onClose={(restore) => {
                    setRenamingTabId(null);
                    if (restore) {
                      requestAnimationFrame(() => {
                        const active = document.activeElement;
                        if (active && active !== document.body && active.isConnected) return;
                        document.getElementById('tab-' + tab.id)?.focus();
                      });
                    }
                  }}
                />
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
                  <span aria-hidden="true">
                    {tab.kind === 'web' ? '◎' : tab.kind === 'editor' ? '✎' : session?.kind === 'agent' ? '◇' : '>_'}
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
            aria-expanded={menuOpen && splitIntent === null}
            disabled={!online || busy}
            onClick={() => {
              menuAnchor.current = addButton.current;
              setSplitIntent(null);
              setMenuOpen(!menuOpen);
            }}
          >
            +
          </button>
          {menuOpen && (
            <PaneMenu anchor={menuAnchor.current ? menuAnchor as React.RefObject<HTMLButtonElement> : addButton} label={t('agency.tabs.add')} onClose={() => { setMenuOpen(false); setSplitIntent(null); }}>
              <button type="button" role="menuitem" onClick={() => choose('terminal')}>{t('agency.tabs.newTerminal')}</button>
              <button type="button" role="menuitem" onClick={() => choose('agent')}>{t('agency.tabs.newCLI')}</button>
              {profiles.map((profile) => (
                <button
                  type="button"
                  role="menuitem"
                  key={profile.id}
                  disabled={!canLaunchAgent(profile)}
                  title={profile.configurationMessage ?? profile.label}
                  onClick={() => choose('agent', profile.id)}
                >
                  {profile.label}
                </button>
              ))}
              <button type="button" role="menuitem" onClick={() => choose('web')}>{t('agency.web.newTab')}</button>
              <button type="button" role="menuitem" onClick={() => choose('github')}>{t('agency.tabs.github')}</button>
              <button type="button" role="menuitem" onClick={() => choose('perplexity')}>{t('agency.tabs.perplexity')}</button>
              <button type="button" role="menuitem" onClick={() => choose('file')}>{t('agency.tabs.openFile')}</button>
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
            </PaneMenu>
          )}
        </div>

      <div className="maw-pane-actions">
        <button
          type="button"
          className="maw-pane-action-button"
          title={t('agency.splits.splitRight')}
          aria-label={t('agency.splits.splitRight')}
          aria-haspopup="menu"
          aria-expanded={menuOpen && splitIntent === 'row'}
          disabled={!canSplit || !online}
          onClick={(event) => openMenu(event.currentTarget, 'row')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          type="button"
          className="maw-pane-action-button"
          title={t('agency.splits.splitDown')}
          aria-label={t('agency.splits.splitDown')}
          aria-haspopup="menu"
          aria-expanded={menuOpen && splitIntent === 'column'}
          disabled={!canSplit || !online}
          onClick={(event) => openMenu(event.currentTarget, 'column')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <line x1="2.5" y1="8" x2="13.5" y2="8" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          type="button"
          className="maw-pane-action-button"
          title={isMaximized ? t('agency.splits.restorePane') : t('agency.splits.maximizePane')}
          aria-label={isMaximized ? t('agency.splits.restorePane') : t('agency.splits.maximizePane')}
          onClick={onToggleMaximize}
        >
          {isMaximized ? '⤢' : '⤡'}
        </button>
        {canClose && (
          <button
            type="button"
            className="maw-pane-action-button"
            title={t('agency.splits.closePane')}
            aria-label={t('agency.splits.closePane')}
            disabled={!online}
            onClick={onClosePane}
          >
            ×
          </button>
        )}
        <PaneGrip paneId={paneId} workspaceId={workspaceId} disabled={moveDisabled} destinations={destinations} onSwap={onSwapPane} />
      </div>
    </div>
  );
}

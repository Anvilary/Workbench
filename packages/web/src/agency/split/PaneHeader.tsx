import { useEffect, useRef, useState } from 'react';
import type { AgencyCliProfile, MawActivityState, WorkspaceId } from '@agent-workbench/shared';
import { t } from '../../i18n/index.js';
import { agencySessionText, agencyTabActivityText } from '../agency-labels.js';
import type { WorkspaceTab } from '../model.js';
import { PaneMenu } from './PaneMenu.js';
import { PaneGrip } from './PaneMovement.js';
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
  onMoveTabToPane: (tabId: string, targetPaneId: string, targetIndex?: number) => void;
  onRenameTab: (tab: WorkspaceTab, title: string) => Promise<void>;
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
  onMoveTabToPane,
  onRenameTab,
  reportError,
}: Props): JSX.Element {
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const strip = useRef<HTMLDivElement | null>(null);
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
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  function tabName(tab: WorkspaceTab) {
    if (tab.kind === 'web') return tab.web.title;
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
      className={`maw-pane-header${isFocused ? ' is-focused' : ''}`}
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
      <PaneGrip paneId={paneId} workspaceId={workspaceId} disabled={moveDisabled} destinations={destinations} onSwap={onSwapPane} />
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
            if (tabDrag.current.isDragging && strip.current) {
              event.preventDefault();
              const tabElements = Array.from(strip.current.querySelectorAll<HTMLElement>('.maw-session-tab'));
              let target = paneTabs.length;
              for (let i = 0; i < tabElements.length; i++) {
                const rect = tabElements[i]!.getBoundingClientRect();
                const mid = rect.left + rect.width / 2;
                if (event.clientX < mid) {
                  target = i;
                  break;
                }
              }
              tabDrag.current.targetIndex = target;
              setDragState({ tabId: tabDrag.current.tabId, targetIndex: target });
            }
          }
        }}
        onPointerUp={async (event) => {
          if (tabDrag.current && tabDrag.current.pointerId === event.pointerId) {
            const dragInfo = tabDrag.current;
            tabDrag.current = null;
            setDragState(null);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            if (dragInfo.isDragging) {
              suppressTabClickUntil.current = Date.now() + 200;
              const header = document.elementFromPoint(event.clientX, event.clientY)?.closest('.maw-pane-header');
              const destination = header?.closest('.maw-split-pane')?.id.replace('pane-container-', '');
              if (!destination) return;
              const targetElements = [...header!.querySelectorAll<HTMLElement>('.maw-session-tab')];
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
        }}
      >
        {paneTabs.map((tab, idx) => {
          const tabState = getTabActivity?.(workspaceId, tab.id);
          const session = tab.kind === 'native' ? tab.session : undefined;
          const status = tabState
            ? agencyTabActivityText(tabState)
            : session
              ? agencySessionText(session)
              : t('agency.web.tabKind');
          const dotClass =
            tabState === 'finished'
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
                      : tabState ?? (session?.activity === 'working' ? 'working' : session?.activity === 'idle' ? 'idle' : 'unknown');

          const isSelected = selectedTabId === tab.id;

          const isBeingDragged = dragState?.tabId === tab.id;
          const isTargetBefore = (dragState !== null && dragState.tabId !== tab.id && dragState.targetIndex === idx) || dragOverIndex === idx;
          const isTargetAfter = dragState !== null && dragState.tabId !== tab.id && dragState.targetIndex === paneTabs.length && idx === paneTabs.length - 1;
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
                  title={`${tabName(tab)} · ${status}`}
                  onClick={(event) => {
                    if (Date.now() < suppressTabClickUntil.current) { event.preventDefault(); return; }
                    onSelectTab(tab.id);
                  }}
                  onDoubleClick={() => setRenamingTabId(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'F2') {
                      e.preventDefault();
                      setRenamingTabId(tab.id);
                    }
                  }}
                >
                  <span aria-hidden="true">
                    {tab.kind === 'web' ? '◎' : session?.kind === 'agent' ? '◇' : '>_'}
                  </span>
                  <span
                    className="agency-truncate"
                    onDoubleClick={() => setRenamingTabId(tab.id)}
                  >
                    {tabName(tab)}
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
            onClick={() => setMenuOpen(!menuOpen)}
          >
            +
          </button>
          {menuOpen && (
            <PaneMenu anchor={addButton} label={t('agency.tabs.add')} onClose={() => setMenuOpen(false)}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onAddCliClick();
                }}
              >
                {t('agency.tabs.newCLI')}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onAddTerminalClick();
                }}
              >
                {t('agency.tabs.newTerminal')}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onAddWebTabClick();
                }}
              >
                {t('agency.web.newTab')}
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
            </PaneMenu>
          )}
        </div>

      <div className="maw-pane-actions">
        <button
          type="button"
          className="maw-pane-action-button"
          title={t('agency.splits.splitRight')}
          aria-label={t('agency.splits.splitRight')}
          disabled={!canSplit || !online}
          onClick={onSplitRight}
        >
          ◫
        </button>
        <button
          type="button"
          className="maw-pane-action-button"
          title={t('agency.splits.splitDown')}
          aria-label={t('agency.splits.splitDown')}
          disabled={!canSplit || !online}
          onClick={onSplitDown}
        >
          ⬒
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
      </div>
    </div>
  );
}

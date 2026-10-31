import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgencyCliProfile, AgencyRuntimeSession, AgencyWorkspace, CliProfileId,
  MawActivityState, SplitDirection, WebTab, WorkspaceId, WorkspacePaneLayout,
} from '@agent-workbench/shared';
import {
  countLeaves, createDefaultLayout, findPaneNode, getPaneNodes, moveTabBetweenPanes,
  reconcileLayout, splitPane, closePane, updatePaneNode, updateSplitRatio,
  validateChatGptUrl, validateWebTabTitle,
} from '@agent-workbench/shared';
import type { AgentConnection } from '../connection.js';
import { t } from '../i18n/index.js';
import { AgencyProfileDialog } from './AgencyProfileDialog.js';
import { allWorkspaceTabs, canLaunchAgent, selectedWorkspaceTab, type AgencyTransport, type WorkspaceTab } from './model.js';
import { nativeLayoutCoordinator } from './native-layout-coordinator.js';
import { PersistentSessionPanes } from './split/PersistentSessionPanes.js';
import { SplitPaneTree } from './split/SplitPaneTree.js';
import { usePaneInspection } from './split/usePaneInspection.js';
import type { useAgencyStore } from './useAgencyStore.js';

interface Props {
  workspace: AgencyWorkspace;
  profiles: readonly AgencyCliProfile[];
  sessions: readonly AgencyRuntimeSession[];
  webTabs: readonly WebTab[];
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
  getTabActivity?: (workspaceId: WorkspaceId, tabId: string) => MawActivityState;
  onAcknowledgeTab?: (workspaceId: WorkspaceId, tabId: string) => Promise<void> | void;
  savedLayout?: WorkspacePaneLayout;
  onSaveLayout?: (workspaceId: WorkspaceId, layout: WorkspacePaneLayout) => Promise<unknown>;
}

export function AgencyWorkspaceView({
  workspace,
  profiles,
  sessions,
  webTabs,
  connection,
  request,
  sendImmediate,
  online,
  onDone,
  launchError,
  onClearLaunchError,
  getTabActivity,
  onAcknowledgeTab,
  onTabDisplayed,
  getTabActivityVersion,
  savedLayout,
  onSaveLayout,
}: Props): JSX.Element {
  const tabs = allWorkspaceTabs(sessions, webTabs, workspace.id);
  const openTabIds = tabs.map((t) => t.id);
  const defaultSelected = selectedWorkspaceTab(tabs)?.id;

  const [layout, setLayout] = useState<WorkspacePaneLayout>(() =>
    reconcileLayout(savedLayout, workspace.id, openTabIds, defaultSelected),
  );

  const [picker, setPicker] = useState(false);
  const [webDialog, setWebDialog] = useState<'create' | 'navigate' | null>(null);
  const [webUrl, setWebUrl] = useState('https://chatgpt.com/');
  const [webTitle, setWebTitle] = useState('');
  const [profileId, setProfileId] = useState<CliProfileId | ''>(profiles[0]?.id ?? '');
  const [configuringProfile, setConfiguringProfile] = useState<AgencyCliProfile | null>(null);
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const isUnconfigured =
    selectedProfile?.configurationStatus === 'error' &&
    (selectedProfile.configurationMessage?.includes('Configure an executable') ?? false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<WorkspaceTab | null>(null);
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

  const serverSelectedId = selectedWorkspaceTab(tabs)?.id;

  const currentTabKey = openTabIds.join(',');
  const [prevTabKey, setPrevTabKey] = useState(currentTabKey);
  if (currentTabKey !== prevTabKey) {
    setPrevTabKey(currentTabKey);
    const reconciled = reconcileLayout(layout, workspace.id, openTabIds, defaultSelected);
    setLayout(reconciled);
  }

  const [prevServerSelected, setPrevServerSelected] = useState(serverSelectedId);
  if (serverSelectedId !== prevServerSelected) {
    setPrevServerSelected(serverSelectedId);
    if (serverSelectedId && !selecting.current) {
      const panes = getPaneNodes(layout.tree);
      const ownerPane = panes.find((p) => p.tabIds.includes(serverSelectedId));
      if (ownerPane) {
        const nextTree = updatePaneNode(layout.tree, ownerPane.id, (p) => ({
          ...p,
          selectedTabId: serverSelectedId,
        }));
        setLayout({
          ...layout,
          tree: nextTree,
          focusedPaneId: ownerPane.id,
        });
      }
    }
  }

  // Sync with incoming server layout when available
  useEffect(() => {
    if (savedLayout && savedLayout.workspaceId === workspace.id) {
      setLayout((prev) => {
        if (savedLayout.updatedAt > prev.updatedAt) {
          return reconcileLayout(savedLayout, workspace.id, openTabIds, defaultSelected);
        }
        return prev;
      });
    }
  }, [savedLayout, workspace.id]);

  const save = useCallback(
    (nextLayout: WorkspacePaneLayout, immediate = false) => {
      setLayout(nextLayout);
      if (saveTimer.current !== null) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (immediate) {
        void onSaveLayout?.(workspace.id, nextLayout);
      } else {
        saveTimer.current = window.setTimeout(() => {
          void onSaveLayout?.(workspace.id, nextLayout);
          saveTimer.current = null;
        }, 200);
      }
    },
    [workspace.id, onSaveLayout],
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
    [layout, save],
  );

  const handleSelectTab = useCallback(
    (paneId: string, tabId: string) => {
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

  useEffect(() => {
    if (!profileId && profiles.length) setProfileId(profiles[0]!.id);
  }, [profileId, profiles]);

  const focusedPane = findPaneNode(layout.tree, layout.focusedPaneId);
  const activeTabId = focusedPane?.selectedTabId;
  const activity = activeTabId ? getTabActivity?.(workspace.id, activeTabId) : undefined;
  const activityVersion = activeTabId
    ? getTabActivityVersion?.(workspace.id, activeTabId) ?? ''
    : '';

  useEffect(() => {
    nativeLayoutCoordinator.setFocusedTabId(activeTabId ?? null);
  }, [activeTabId]);

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
    if ((!picker && !closing && !webDialog) || configuringProfile) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !flight.current) {
        setPicker(false);
        setClosing(null);
        setWebDialog(null);
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
  }, [picker, closing, webDialog, configuringProfile]);

  async function add(kind: 'agent' | 'terminal') {
    if (flight.current || !online || (kind === 'agent' && !profileId)) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await request({
        type: 'agency.session.create',
        workspaceId: workspace.id,
        kind,
        launchId: crypto.randomUUID(),
        cols: 100,
        rows: 30,
        ...(kind === 'agent' ? { profileId: profileId as CliProfileId } : {}),
      } as Parameters<Props['request']>[0]);
      setPicker(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
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
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      await action(tab, 'close');
      setClosing(null);
    } catch {
      // Keep confirmation and error visible until the server confirms close
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  function webEditor(mode: 'create' | 'navigate') {
    setError(null);
    setWebDialog(mode);
    const activeTab = tabs.find((t) => t.id === activeTabId);
    setWebUrl(activeTab?.kind === 'web' && mode !== 'create' ? activeTab.web.url : 'https://chatgpt.com/');
    setWebTitle(activeTab?.kind === 'web' && mode !== 'create' ? activeTab.web.title : t('agency.web.defaultTitle'));
  }

  async function saveWeb() {
    if (flight.current || !online || !webDialog) return;
    const url = validateChatGptUrl(webUrl);
    if (!url.valid) {
      setError(t('agency.web.invalidUrl'));
      return;
    }
    if (webDialog !== 'navigate' && !validateWebTabTitle(webTitle)) {
      setError(t('agency.web.invalidTitle'));
      return;
    }
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (webDialog === 'create') {
        await request({
          type: 'agency.webTab.create',
          workspaceId: workspace.id,
          url: url.normalizedUrl!,
          title: webTitle.trim(),
          select: true,
          launchId: crypto.randomUUID(),
        });
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
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  function tabDisplayName(tab: WorkspaceTab) {
    if (tab.kind === 'web') return tab.web.title;
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
        <div className="maw-workspace-topbar-left">
          <span className="maw-workspace-title">{workspace.name}</span>
          {leafCount > 1 && (
            <button
              type="button"
              className="agency-text-button maw-single-pane-btn"
              onClick={handleSinglePane}
              title={t('agency.splits.singlePane')}
            >
              {t('agency.splits.singlePane')}
            </button>
          )}
        </div>

        <div className="agency-flex-spacer" />

        <button type="button" className="agency-text-button" onClick={onDone}>
          {t('agency.ui.markDone')}
        </button>
      </header>

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

      <div className="maw-split-workspace-content">
        <SplitPaneTree
          node={visibleTree}
          layout={layout}
          tabs={tabs}
          profiles={profiles}
          online={online}
          busy={busy}
          request={request}
          reportError={setError}
          getTabActivity={getTabActivity}
          onSelectTab={handleSelectTab}
          onCloseTab={(tab) => {
            const session = tab.kind === 'native' ? tab.session : undefined;
            if (session && ['starting', 'running', 'stopping'].includes(session.lifecycle)) {
              setClosing(tab);
            } else {
              void close(tab);
            }
          }}
          onSplit={handleSplit}
          onClosePane={handleClosePane}
          onToggleMaximize={handleToggleMaximize}
          onUpdateRatio={handleUpdateRatio}
          onMoveTabToPane={handleMoveTab}
          onAddCliClick={(paneId) => {
            handleFocusPane(paneId);
            setPicker(true);
          }}
          onAddTerminalClick={(paneId) => {
            handleFocusPane(paneId);
            void add('terminal');
          }}
          onAddWebTabClick={(paneId) => {
            handleFocusPane(paneId);
            webEditor('create');
          }}
          onRenameTab={async (tab, title) => {
            await request(
              tab.kind === 'web'
                ? { type: 'agency.webTab.rename', workspaceId: workspace.id, tabId: tab.id, title }
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
        />
      </div>

      {(picker || closing || webDialog) && (
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
                : webDialog
                  ? webHeading
                  : t('agency.tabs.newCLI')}
            </h2>

            {!closing && !webDialog && isUnconfigured && (
              <div
                className="agency-callout"
                role="alert"
                style={{
                  background: 'rgba(234, 179, 8, 0.12)',
                  border: '1px solid rgba(234, 179, 8, 0.35)',
                  borderRadius: '8px',
                  padding: '10px 14px',
                  margin: '12px 0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  fontSize: '12px',
                  color: '#fef08a',
                }}
              >
                <span>⚙ {t('agency.profile.notConfiguredBanner')}</span>
                <button
                  type="button"
                  className="agency-primary-button"
                  style={{ padding: '6px 14px', fontSize: '12px', whiteSpace: 'nowrap' }}
                  onClick={() => setConfiguringProfile(selectedProfile ?? null)}
                >
                  {t('agency.profile.configureAction')}
                </button>
              </div>
            )}

            {!closing && !webDialog && !isUnconfigured && !canLaunchAgent(selectedProfile) && (
              <p role="status">
                {selectedProfile?.configurationStatus === 'not-installed'
                  ? t('agency.profile.executableNotFound')
                  : selectedProfile?.configurationMessage}
              </p>
            )}

            {closing ? (
              <p>{t('agency.tabs.closeExplanation')}</p>
            ) : webDialog ? (
              <form
                id="maw-web-tab-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveWeb();
                }}
              >
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
            ) : (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', marginBottom: '16px' }}>
                <label className="agency-field" style={{ flex: 1, marginBottom: 0 }}>
                  <span>{t('agency.ui.cliProfile')}</span>
                  <select
                    autoFocus
                    value={profileId}
                    onChange={(event) => setProfileId(event.target.value as CliProfileId)}
                  >
                    {profiles.map((profile) => (
                      <option value={profile.id} key={profile.id}>
                        {profile.label}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedProfile && (
                  <button
                    type="button"
                    className={isUnconfigured ? 'agency-primary-button' : 'agency-secondary-button'}
                    style={{ height: '40px', padding: '0 14px', whiteSpace: 'nowrap', fontWeight: 600 }}
                    onClick={() => setConfiguringProfile(selectedProfile)}
                  >
                    {t('agency.profile.configureAction')}
                  </button>
                )}
              </div>
            )}

            {error && <p role="alert" className="agency-error">{error}</p>}

            <div className="agency-dialog-actions">
              <button
                type="button"
                autoFocus={!!closing}
                disabled={busy}
                onClick={() => {
                  setPicker(false);
                  setClosing(null);
                  setWebDialog(null);
                }}
              >
                {t('common.cancel')}
              </button>
              {webDialog ? (
                <button type="submit" form="maw-web-tab-form" className="agency-primary-button" disabled={busy || !online}>
                  {webHeading}
                </button>
              ) : (
                <button
                  type="button"
                  className="agency-primary-button"
                  disabled={busy || !online || (!closing && !canLaunchAgent(selectedProfile))}
                  onClick={() => (closing ? void close(closing) : void add('agent'))}
                >
                  {closing ? t('agency.tabs.closeSession') : t('agency.ui.startCLI')}
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

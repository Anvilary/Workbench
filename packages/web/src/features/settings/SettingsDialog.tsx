/**
 * Settings dialog for Workbench (Workbench).
 *
 * Implements a cohesive, minimalist, desktop-oriented two-pane layout:
 * - Left navigation: General (including Appearance), Terminal, Browser, Agents, Usage, About, and Panels
 * - Integrated compact search input for instant discoverability across categories and settings
 * - Authoritative running version indicator at bottom-left of navigation sidebar
 * - Right content pane: Grouped settings with clear alignment, dark-only aesthetic,
 *   subtle amber accents, and inline status/error feedback.
 *
 * Preserves all persistence contracts, server-side permissions, remote-client guards,
 * and keyboard accessibility (Tab navigation, Arrow navigation, Escape, and focus restoration).
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  AgentId,
  AgentInfo,
  BrowserProfile,
  BrowserProfileId,
  BrowserProfileSite,
  ConsoleShellId,
} from '@anvilary/workbench-shared';
import { t } from '../../i18n/index.js';
import type { HideablePanel, PanelVisibility } from '../../shared/lib/panel-visibility.js';
import type { AppSettingsApi } from './useAppSettings.js';
import type { TerminalThemeState } from '../terminals/useTerminalTheme.js';
import type { AgentConnection } from '../../connection/connection.js';
import { AgentsUsageView } from '../agents/AgentsUsageView.js';
import { useBrowserSettings } from '../browser/useBrowserSettings.js';
import { BrowserSettingsSection } from '../browser/BrowserSettingsSection.js';
import { DEFAULT_FOCUSABLE_SELECTOR, isTopmostDialog, trapTabFocus } from '../../shared/hooks/useFocusTrap.js';
import { ALL_TABS, buildSettingsSearchCatalog, filterSettingsSearchCatalog, type SearchItem, type SettingsTabId, type TabDefinition } from './settings-search.js';
import { AboutSettingsSection } from './sections/AboutSettingsSection.js';
import { AgentsSettingsSection } from './sections/AgentsSettingsSection.js';
import { BrowserIcon, GearIcon, InfoIcon, PanelsIcon, RobotIcon, SearchIcon, TerminalIcon, UsageIcon } from './SettingsIcons.js';
import { GeneralSettingsSection } from './sections/GeneralSettingsSection.js';
import { PanelsSettingsSection } from './sections/PanelsSettingsSection.js';
import { TerminalSettingsSection } from './sections/TerminalSettingsSection.js';
import { getAppVersionInfo, getRuntimeInfo, sameSet, type AppVersionInfo } from './version-info.js';

export {
  BrowserIcon,
  GearIcon,
  InfoIcon,
  PanelsIcon,
  RobotIcon,
  SearchIcon,
  TerminalIcon,
  UsageIcon,
  getAppVersionInfo,
  type AppVersionInfo,
  type SearchItem,
  type SettingsTabId,
};

export interface SettingsDialogProps {
  onClose: () => void;
  terminalTheme: TerminalThemeState;
  panels?: PanelVisibility;
  showPanels?: boolean;
  consoleCount?: number;
  onHideConsole?: () => void;
  appSettings: AppSettingsApi;
  agents: readonly AgentInfo[];
  remoteClient: boolean;
  onOpenVault?: (() => void) | null;
  onOpenRemote?: (() => void) | null;
  connection?: AgentConnection;
  initialTab?: SettingsTabId | 'agents-usage' | 'appearance';
  browserProfiles?: readonly BrowserProfile[];
  onCreateBrowserProfile?: (input: {
    name: string;
    sourceProfileId?: BrowserProfileId;
    clearSites?: readonly BrowserProfileSite[];
  }) => void | Promise<unknown>;
  onRenameBrowserProfile?: (profileId: BrowserProfileId, name: string) => void | Promise<unknown>;
  onDeleteBrowserProfile?: (profileId: BrowserProfileId) => void | Promise<unknown>;
  onClearBrowserProfileSiteAuth?: (
    profileId: BrowserProfileId,
    sites: readonly BrowserProfileSite[],
  ) => void | Promise<unknown>;
  pendingBrowserProfileCleanups?: readonly {
    profileId: BrowserProfileId;
    profileName: string;
    failedPartitions?: readonly string[];
    error?: string;
  }[];
  onRetryBrowserProfileCleanup?: (profileId: BrowserProfileId, profileName: string) => void | Promise<unknown>;
}

export function SettingsDialog({
  onClose,
  terminalTheme,
  panels,
  showPanels,
  consoleCount = 0,
  onHideConsole = () => {},
  appSettings,
  agents,
  remoteClient,
  onOpenVault = null,
  onOpenRemote = null,
  connection,
  initialTab = 'general',
  browserProfiles,
  onCreateBrowserProfile,
  onRenameBrowserProfile,
  onDeleteBrowserProfile,
  onClearBrowserProfileSiteAuth,
  pendingBrowserProfileCleanups,
  onRetryBrowserProfileCleanup,
}: SettingsDialogProps): JSX.Element {
  const mappedInitial: SettingsTabId =
    initialTab === 'agents-usage'
      ? 'usage'
      : initialTab === 'appearance'
        ? 'general'
        : (initialTab ?? 'general');

  const [activeTab, setActiveTab] = useState<SettingsTabId>(mappedInitial);
  const [confirmingConsole, setConfirmingConsole] = useState(false);
  const [highlightedCardId, setHighlightedCardId] = useState<string | null>(null);
  const [expandSignal, setExpandSignal] = useState(0);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedResultIndex, setSelectedResultIndex] = useState(0);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();

  const status = appSettings.status;
  const serverEditable = status !== null && !remoteClient;

  const [pendingShell, setPendingShell] = useState<ConsoleShellId | null>(null);
  const [pendingDisabled, setPendingDisabled] = useState<AgentId[] | null>(null);

  useEffect(() => {
    setPendingShell(null);
    setPendingDisabled(null);
  }, [status, appSettings.problem]);

  const shownShell = pendingShell ?? status?.consoleShell ?? 'auto';
  const shownDisabled = pendingDisabled ?? status?.disabledAgents ?? [];

  const browserSettings = useBrowserSettings(appSettings);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      triggerRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      // Yield to any nested modal dialog or open menu rendered above SettingsDialog.
      if (!isTopmostDialog(dialogRef.current)) return;
      if (document.querySelector('[role="menu"]:not([hidden])')) return;

      if (event.key === 'Escape') {
        if (searchQuery.trim().length > 0) {
          event.preventDefault();
          event.stopPropagation();
          setSearchQuery('');
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === 'Tab') {
        trapTabFocus(event, dialogRef.current, DEFAULT_FOCUSABLE_SELECTOR);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, searchQuery]);

  const togglePanel = (panel: HideablePanel, visible: boolean): void => {
    if (panel === 'console' && !visible && consoleCount > 0) {
      setConfirmingConsole(true);
      return;
    }
    panels?.setVisible(panel, visible);
  };

  const autoShell = status?.consoleShells?.find((shell) => shell.id !== 'git-bash' && shell.id !== 'zsh') ?? null;
  const restartPending = status !== null && !sameSet(status.disabledAgents, status.disabledAtStart);

  const shellChoices: { id: ConsoleShellId; label: string }[] =
    status === null
      ? []
      : [
          {
            id: 'auto',
            label: autoShell === null ? t('settings.console.auto') : t('settings.console.autoWith', { shell: autoShell.label }),
          },
          ...status.consoleShells,
        ];

  const shouldOfferPanels = showPanels ?? (panels !== undefined);
  const visibleTabs = ALL_TABS.filter((tab) => tab.id !== 'panels' || shouldOfferPanels);

  const handleNavKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = visibleTabs.findIndex((tab) => tab.id === activeTab);
    if (currentIndex === -1) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      const nextIndex = (currentIndex + 1) % visibleTabs.length;
      const target = visibleTabs[nextIndex];
      if (target) setActiveTab(target.id);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const prevIndex = (currentIndex - 1 + visibleTabs.length) % visibleTabs.length;
      const target = visibleTabs[prevIndex];
      if (target) setActiveTab(target.id);
    }
  };

  const currentTabDef: TabDefinition = visibleTabs.find((tab) => tab.id === activeTab) ?? ALL_TABS[0]!;
  const runtime = getRuntimeInfo();
  const versionInfo = getAppVersionInfo();
  const safeAgents = Array.isArray(agents) ? agents : [];

  const searchCatalog = useMemo<SearchItem[]>(
    () =>
      buildSettingsSearchCatalog({
        visibleTabs,
        onOpenVault,
        onOpenRemote,
        shellChoices,
        searchEngines: browserSettings.searchEngines,
        favorites: browserSettings.favorites,
        browserProfiles,
        agents: safeAgents,
        shouldOfferPanels,
        panels,
        electronVersion: runtime.electronVersion,
        displayVersion: versionInfo.displayVersion,
      }),
    [
      visibleTabs,
      onOpenVault,
      onOpenRemote,
      shellChoices,
      browserSettings.searchEngines,
      browserSettings.favorites,
      browserProfiles,
      safeAgents,
      shouldOfferPanels,
      panels,
      runtime.electronVersion,
      versionInfo.displayVersion,
    ],
  );

  const searchResults = useMemo<SearchItem[]>(
    () => filterSettingsSearchCatalog(searchCatalog, searchQuery),
    [searchQuery, searchCatalog],
  );

  const handleSelectSearchResult = (result: SearchItem) => {
    setActiveTab(result.tabId);
    setSearchQuery('');
    setHighlightedCardId(result.targetId);
    setExpandSignal((prev) => prev + 1);

    setTimeout(() => {
      const el = document.getElementById(result.targetId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 60);

    setTimeout(() => {
      setHighlightedCardId(null);
    }, 1800);
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (searchResults.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedResultIndex((prev) => (prev + 1) % searchResults.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedResultIndex((prev) => (prev - 1 + searchResults.length) % searchResults.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = searchResults[selectedResultIndex];
      if (target) {
        handleSelectSearchResult(target);
      }
    }
  };

  const isSearching = searchQuery.trim().length > 0;

  return (
    <div className="modal-backdrop wb-settings-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal settings-dialog wb-settings-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header wb-settings-header">
          <div className="wb-settings-header-title-group">
            <span className="wb-settings-header-icon" aria-hidden="true">
              <GearIcon size={20} />
            </span>
            <span id={titleId} className="modal-title wb-settings-title">
              {t('settings.title')}
            </span>
          </div>
          <button
            type="button"
            className="icon-button wb-settings-close-btn"
            onClick={onClose}
            title={t('common.closeEsc')}
            aria-label={t('common.closeEsc')}
          >
            ×
          </button>
        </header>

        <div className="wb-settings-layout">
          <nav
            className="wb-settings-nav"
            role="tablist"
            aria-label={t('settings.title')}
            onKeyDown={!isSearching ? handleNavKeyDown : undefined}
          >
            <div className="wb-settings-search-box">
              <span className="wb-settings-search-icon" aria-hidden="true">
                <SearchIcon size={13} />
              </span>
              <input
                ref={searchInputRef}
                type="search"
                className="wb-settings-search-input"
                placeholder={t('settings.search.placeholder')}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSelectedResultIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                aria-label={t('settings.search.placeholder')}
              />
              {isSearching && (
                <button
                  type="button"
                  className="wb-settings-search-clear"
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                  aria-label={t('common.close')}
                  title={t('common.close')}
                >
                  ×
                </button>
              )}
            </div>

            {isSearching ? (
              <div className="wb-settings-search-results" role="listbox" aria-label={t('settings.search.placeholder')}>
                {searchResults.length === 0 ? (
                  <div className="wb-settings-search-empty">
                    <p className="wb-settings-search-empty-text">
                      {t('settings.search.noResults')}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="wb-settings-search-count">
                      {t('settings.search.resultsCount', { count: searchResults.length })}
                    </div>
                    {searchResults.map((result, idx) => (
                      <button
                        key={result.id}
                        type="button"
                        role="option"
                        aria-selected={idx === selectedResultIndex}
                        className={`wb-settings-search-item ${idx === selectedResultIndex ? 'active' : ''}`}
                        onClick={() => handleSelectSearchResult(result)}
                        onMouseEnter={() => setSelectedResultIndex(idx)}
                      >
                        <div className="wb-settings-search-item-header">
                          <span className="wb-settings-search-item-title">{result.title}</span>
                          <span className="wb-settings-search-item-category">{result.categoryName}</span>
                        </div>
                        {result.description && (
                          <div className="wb-settings-search-item-desc">{result.description}</div>
                        )}
                      </button>
                    ))}
                  </>
                )}
              </div>
            ) : (
              <div className="wb-settings-nav-list">
                {visibleTabs.map((tab) => {
                  const isSelected = activeTab === tab.id;
                  const IconComponent = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      id={`settings-tab-${tab.id}`}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      aria-controls={`settings-tabpanel-${tab.id}`}
                      className={`wb-settings-nav-item ${isSelected ? 'active' : ''}`}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      <span className="wb-settings-nav-icon">
                        <IconComponent size={15} />
                      </span>
                      <span className="wb-settings-nav-label">{t(tab.labelKey)}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="wb-settings-sidebar-footer">
              <span className="wb-settings-version" title={`Anvilary Workbench ${versionInfo.displayVersion}`}>
                {versionInfo.displayVersion}
              </span>
            </div>
          </nav>

          <main
            id={`settings-tabpanel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`settings-tab-${activeTab}`}
            className="wb-settings-content"
          >
            {activeTab === 'usage' ? (
              <AgentsUsageView connection={connection} />
            ) : (
              <div className="wb-settings-panel-inner">
                <div className="wb-settings-section-header">
                  <h2 className="wb-settings-section-title">{t(currentTabDef.labelKey)}</h2>
                  <p className="wb-settings-section-desc">{t(currentTabDef.descKey)}</p>
                </div>

                {activeTab === 'general' && (
                  <GeneralSettingsSection
                    terminalTheme={terminalTheme}
                    highlightedCardId={highlightedCardId}
                    expandSignal={expandSignal}
                    onOpenVault={onOpenVault}
                    onOpenRemote={onOpenRemote}
                  />
                )}

                {activeTab === 'terminal' && (
                  <TerminalSettingsSection
                    status={status}
                    shellChoices={shellChoices}
                    shownShell={shownShell}
                    serverEditable={serverEditable}
                    remoteClient={remoteClient}
                    highlightedCardId={highlightedCardId}
                    expandSignal={expandSignal}
                    onSelectShell={(shellId) => {
                      setPendingShell(shellId);
                      appSettings.setConsoleShell(shellId);
                    }}
                  />
                )}

                {activeTab === 'browser' && (
                  <BrowserSettingsSection
                    browserSettings={browserSettings}
                    remoteClient={remoteClient}
                    highlightedCardId={highlightedCardId}
                    expandSignal={expandSignal}
                    browserProfiles={browserProfiles}
                    onCreateBrowserProfile={onCreateBrowserProfile}
                    onRenameBrowserProfile={onRenameBrowserProfile}
                    onDeleteBrowserProfile={onDeleteBrowserProfile}
                    onClearBrowserProfileSiteAuth={onClearBrowserProfileSiteAuth}
                    pendingBrowserProfileCleanups={pendingBrowserProfileCleanups}
                    onRetryBrowserProfileCleanup={onRetryBrowserProfileCleanup}
                  />
                )}

                {activeTab === 'agents' && (
                  <AgentsSettingsSection
                    status={status}
                    appSettings={appSettings}
                    agents={safeAgents}
                    shownDisabled={shownDisabled}
                    serverEditable={serverEditable}
                    restartPending={restartPending}
                    remoteClient={remoteClient}
                    highlightedCardId={highlightedCardId}
                    expandSignal={expandSignal}
                    connection={connection}
                    onChangeDisabledAgents={(next) => {
                      setPendingDisabled(next);
                      appSettings.setDisabledAgents(next);
                    }}
                  />
                )}

                {activeTab === 'about' && (
                  <AboutSettingsSection
                    runtime={runtime}
                    highlightedCardId={highlightedCardId}
                  />
                )}

                {activeTab === 'panels' && panels && (
                  <PanelsSettingsSection
                    panels={panels}
                    consoleCount={consoleCount}
                    confirmingConsole={confirmingConsole}
                    highlightedCardId={highlightedCardId}
                    expandSignal={expandSignal}
                    onTogglePanel={togglePanel}
                    onConfirmHideConsole={() => {
                      setConfirmingConsole(false);
                      onHideConsole();
                    }}
                    onCancelHideConsole={() => setConfirmingConsole(false)}
                  />
                )}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

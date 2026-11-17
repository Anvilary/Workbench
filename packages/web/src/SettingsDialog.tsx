/**
 * Settings dialog for My Amazing Workspace (MaW).
 *
 * Implements a cohesive, minimalist, desktop-oriented two-pane layout:
 * - Left navigation: General, Appearance, Terminal, Agents, Usage, About (and Panels for legacy)
 * - Right content pane: Grouped settings with clear alignment, dark-only aesthetic,
 *   subtle amber accents, and inline status/error feedback.
 *
 * Preserves all persistence contracts, server-side permissions, remote-client guards,
 * and keyboard accessibility (Tab navigation, Arrow navigation, Escape, and focus restoration).
 */

import { useEffect, useRef, useState, useId } from 'react';
import type { AgentId, AgentInfo, ConsoleShellId } from '@agent-workbench/shared';
import { t, type MessageKey } from './i18n/index.js';
import { LocaleMenu } from './LocaleMenu.js';
import { HIDEABLE_PANELS, type HideablePanel, type PanelVisibility } from './panel-visibility.js';
import type { AppSettingsApi } from './useAppSettings.js';
import type { TerminalThemePreference, TerminalThemeState } from './useTerminalTheme.js';
import { vaultName } from './vault-ui.js';
import type { AgentConnection } from './connection.js';
import { AgentsUsageView } from './AgentsUsageView.js';
import { useBrowserSettings } from './agency/useBrowserSettings.js';
import { SEARCH_ENGINES } from '@agent-workbench/shared';

export type SettingsTabId = 'general' | 'appearance' | 'terminal' | 'browser' | 'agents' | 'usage' | 'about' | 'panels';

interface TabDefinition {
  id: SettingsTabId;
  labelKey: MessageKey;
  descKey: MessageKey;
  icon: string;
}

const ALL_TABS: readonly TabDefinition[] = [
  { id: 'general', labelKey: 'settings.category.general', descKey: 'settings.desc.general', icon: '⚙' },
  { id: 'appearance', labelKey: 'settings.category.appearance', descKey: 'settings.desc.appearance', icon: '🎨' },
  { id: 'terminal', labelKey: 'settings.category.terminal', descKey: 'settings.desc.terminal', icon: '💻' },
  { id: 'browser', labelKey: 'settings.category.browser', descKey: 'settings.desc.browser', icon: '🌐' },
  { id: 'agents', labelKey: 'settings.category.agents', descKey: 'settings.desc.agents', icon: '🤖' },
  { id: 'usage', labelKey: 'settings.category.usage', descKey: 'settings.desc.usage', icon: '📊' },
  { id: 'about', labelKey: 'settings.category.about', descKey: 'settings.desc.about', icon: 'ℹ' },
  { id: 'panels', labelKey: 'settings.category.panels', descKey: 'settings.desc.panels', icon: '🗂' },
];

const PANEL_NAMES: Readonly<Record<HideablePanel, MessageKey>> = {
  git: 'panel.tab.git',
  files: 'panel.tab.files',
  plans: 'panel.tab.plans',
  memory: 'panel.tab.memory',
  console: 'console.name',
  notes: 'notes.name',
};

const TERMINAL_THEME_NAMES: Readonly<Record<TerminalThemePreference, MessageKey>> = {
  dark: 'settings.terminalTheme.dark',
  follow: 'settings.terminalTheme.follow',
};

function toggled(list: readonly AgentId[], agent: AgentId, off: boolean): AgentId[] {
  const rest = list.filter((id) => id !== agent);
  return off ? [...rest, agent] : rest;
}

function sameSet(a: readonly AgentId[], b: readonly AgentId[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function getRuntimeInfo() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const electronMatch = ua.match(/Electron\/([\d.]+)/);
  const chromeMatch = ua.match(/Chrome\/([\d.]+)/);

  return {
    appVersion: '0.8.1',
    electronVersion: electronMatch ? electronMatch[1] : '45.2.0',
    chromiumVersion: chromeMatch ? chromeMatch[1] : '134.0.6998.35',
    platform: typeof navigator !== 'undefined' && navigator.platform ? navigator.platform : 'Linux x86_64',
  };
}

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
  initialTab?: SettingsTabId | 'agents-usage';
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
}: SettingsDialogProps): JSX.Element {
  const mappedInitial = initialTab === 'agents-usage' ? 'usage' : initialTab;
  const [activeTab, setActiveTab] = useState<SettingsTabId>(mappedInitial);
  const [confirmingConsole, setConfirmingConsole] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
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
  const [editingFavoriteId, setEditingFavoriteId] = useState<string | null>(null);
  const [isAddingFavorite, setIsAddingFavorite] = useState(false);
  const [favTitleInput, setFavTitleInput] = useState('');
  const [favUrlInput, setFavUrlInput] = useState('');
  const [favError, setFavError] = useState<string | null>(null);

  // Focus management: save trigger on mount, restore on unmount
  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    return () => {
      triggerRef.current?.focus?.();
    };
  }, []);

  // Keyboard navigation: Escape to close, focus trapping
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

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

  // Only offer panels tab if panels is provided and not explicitly hidden
  const shouldOfferPanels = showPanels ?? (panels !== undefined);
  const visibleTabs = ALL_TABS.filter((tab) => tab.id !== 'panels' || shouldOfferPanels);

  // Tab arrow key navigation
  const handleNavKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = visibleTabs.findIndex((t) => t.id === activeTab);
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

  const currentTabDef: TabDefinition = visibleTabs.find((t) => t.id === activeTab) ?? ALL_TABS[0]!;
  const runtime = getRuntimeInfo();

  return (
    <div className="modal-backdrop maw-settings-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`modal settings-dialog maw-settings-window ${activeTab === 'usage' ? 'settings-dialog-wide maw-settings-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <header className="modal-header maw-settings-header">
          <div className="maw-settings-header-title-group">
            <span className="maw-settings-header-icon">⚙</span>
            <span id={titleId} className="modal-title maw-settings-title">
              {t('settings.title')}
            </span>
          </div>
          <button
            type="button"
            className="icon-button maw-settings-close-btn"
            onClick={onClose}
            title={t('common.closeEsc')}
            aria-label={t('common.closeEsc')}
          >
            ×
          </button>
        </header>

        {/* 2-Pane Body */}
        <div className="maw-settings-layout">
          {/* Left Navigation */}
          <nav
            className="maw-settings-nav"
            role="tablist"
            aria-label={t('settings.title')}
            onKeyDown={handleNavKeyDown}
          >
            {visibleTabs.map((tab) => {
              const isSelected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`settings-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  aria-controls={`settings-tabpanel-${tab.id}`}
                  className={`maw-settings-nav-item ${isSelected ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="maw-settings-nav-icon">{tab.icon}</span>
                  <span className="maw-settings-nav-label">{t(tab.labelKey)}</span>
                </button>
              );
            })}
          </nav>

          {/* Right Content */}
          <main
            id={`settings-tabpanel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`settings-tab-${activeTab}`}
            className="maw-settings-content"
          >
            {/* Usage View handles its own full-bleed header and controls */}
            {activeTab === 'usage' ? (
              <AgentsUsageView connection={connection} />
            ) : (
              <div className="maw-settings-panel-inner">
                {/* Category Header */}
                <div className="maw-settings-section-header">
                  <h2 className="maw-settings-section-title">{t(currentTabDef.labelKey)}</h2>
                  <p className="maw-settings-section-desc">{t(currentTabDef.descKey)}</p>
                </div>

                {/* GENERAL TAB */}
                {activeTab === 'general' && (
                  <div className="maw-settings-groups">
                    <div className="maw-settings-card">
                      <div className="maw-settings-card-header">
                        <span className="maw-settings-card-title">{t('settings.language')}</span>
                      </div>
                      <div className="maw-settings-card-body">
                        <div className="maw-settings-row">
                          <div className="maw-settings-row-text">
                            <span className="maw-settings-label">{t('settings.language')}</span>
                            <span className="maw-settings-subtext">{t('settings.desc.general')}</span>
                          </div>
                          <div className="maw-settings-control">
                            <LocaleMenu />
                          </div>
                        </div>
                      </div>
                    </div>

                    {(onOpenVault !== null || onOpenRemote !== null) && (
                      <div className="maw-settings-card">
                        <div className="maw-settings-card-header">
                          <span className="maw-settings-card-title">{t('settings.section.more')}</span>
                        </div>
                        <div className="maw-settings-card-body">
                          <div className="maw-settings-action-row">
                            {onOpenVault !== null && (
                              <button
                                type="button"
                                className="primary-button primary-button-small"
                                onClick={onOpenVault}
                              >
                                {t('settings.more.open', { name: vaultName() })}
                              </button>
                            )}
                            {onOpenRemote !== null && (
                              <button
                                type="button"
                                className="primary-button primary-button-small"
                                onClick={onOpenRemote}
                              >
                                {t('settings.more.open', { name: t('app.header.remoteAccess') })}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* APPEARANCE TAB */}
                {activeTab === 'appearance' && (
                  <div className="maw-settings-groups">
                    <div className="maw-settings-card">
                      <div className="maw-settings-card-header">
                        <span className="maw-settings-card-title">{t('settings.terminalTheme')}</span>
                      </div>
                      <div className="maw-settings-card-body">
                        <div
                          className="maw-settings-choices"
                          role="radiogroup"
                          aria-label={t('settings.terminalTheme')}
                        >
                          {(['dark', 'follow'] as const).map((preference) => (
                            <label key={preference} className="maw-settings-choice">
                              <input
                                type="radio"
                                name="terminal-theme"
                                checked={terminalTheme.preference === preference}
                                onChange={() => terminalTheme.setPreference(preference)}
                              />
                              <span className="maw-settings-choice-label">
                                {t(TERMINAL_THEME_NAMES[preference])}
                              </span>
                            </label>
                          ))}
                        </div>
                        <p className="maw-settings-hint">{t('settings.terminalTheme.hint')}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* TERMINAL TAB */}
                {activeTab === 'terminal' && (
                  <div className="maw-settings-groups">
                    <div className="maw-settings-card">
                      <div className="maw-settings-card-header">
                        <span className="maw-settings-card-title">{t('settings.section.console')}</span>
                      </div>
                      <div className="maw-settings-card-body">
                        {status === null ? (
                          <p className="maw-settings-hint">{t('settings.oldServer')}</p>
                        ) : status.consoleShells.length === 0 ? (
                          <p className="maw-settings-hint">{t('console.noShell')}</p>
                        ) : (
                          <>
                            <div
                              className="maw-settings-choices"
                              role="radiogroup"
                              aria-label={t('settings.section.console')}
                            >
                              {shellChoices.map((choice) => (
                                <label key={choice.id} className="maw-settings-choice">
                                  <input
                                    type="radio"
                                    name="console-shell"
                                    checked={shownShell === choice.id}
                                    disabled={!serverEditable}
                                    onChange={() => {
                                      setPendingShell(choice.id);
                                      appSettings.setConsoleShell(choice.id);
                                    }}
                                  />
                                  <span className="maw-settings-choice-label">{choice.label}</span>
                                </label>
                              ))}
                            </div>
                            <p className="maw-settings-hint">{t('settings.console.hint')}</p>
                            {remoteClient && (
                              <p className="maw-settings-hint maw-settings-warning">{t('settings.hostOnly')}</p>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* BROWSER TAB */}
                {activeTab === 'browser' && (
                  <div className="maw-settings-groups">
                    {/* Search Engine Selection Card */}
                    <div className="maw-settings-card">
                      <div className="maw-settings-card-header">
                        <span className="maw-settings-card-title">{t('settings.browser.searchEngine')}</span>
                      </div>
                      <div className="maw-settings-card-body">
                        <div
                          className="maw-settings-choices"
                          role="radiogroup"
                          aria-label={t('settings.browser.searchEngine')}
                        >
                          {SEARCH_ENGINES.map((engine) => (
                            <label key={engine.id} className="maw-settings-choice">
                              <input
                                type="radio"
                                name="default-search-engine"
                                checked={browserSettings.defaultSearchEngine === engine.id}
                                onChange={() => browserSettings.setDefaultSearchEngine(engine.id)}
                              />
                              <span className="maw-settings-choice-label">{engine.name}</span>
                              <span className="maw-settings-choice-meta">{engine.homeUrl}</span>
                            </label>
                          ))}
                        </div>
                        <p className="maw-settings-hint">{t('settings.browser.searchEngineDesc')}</p>
                      </div>
                    </div>

                    {/* Favorites Management Card */}
                    <div className="maw-settings-card">
                      <div className="maw-settings-card-header maw-settings-card-header-flex">
                        <span className="maw-settings-card-title">{t('settings.browser.favorites')}</span>
                        {!isAddingFavorite && !editingFavoriteId && (
                          <button
                            type="button"
                            className="maw-settings-action-btn"
                            onClick={() => {
                              setIsAddingFavorite(true);
                              setEditingFavoriteId(null);
                              setFavTitleInput('');
                              setFavUrlInput('');
                              setFavError(null);
                            }}
                          >
                            + {t('settings.browser.addFavorite')}
                          </button>
                        )}
                      </div>
                      <div className="maw-settings-card-body">
                        <p className="maw-settings-hint">{t('settings.browser.favoritesDesc')}</p>

                        {(isAddingFavorite || editingFavoriteId) && (
                          <form
                            className="maw-settings-favorite-form"
                            noValidate
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (isAddingFavorite) {
                                const res = browserSettings.addFavorite({
                                  title: favTitleInput,
                                  url: favUrlInput,
                                });
                                if (!res.success) {
                                  setFavError(res.error ?? 'Invalid input');
                                } else {
                                  setIsAddingFavorite(false);
                                  setFavTitleInput('');
                                  setFavUrlInput('');
                                  setFavError(null);
                                }
                              } else if (editingFavoriteId) {
                                const res = browserSettings.editFavorite(editingFavoriteId, {
                                  title: favTitleInput,
                                  url: favUrlInput,
                                });
                                if (!res.success) {
                                  setFavError(res.error ?? 'Invalid input');
                                } else {
                                  setEditingFavoriteId(null);
                                  setFavTitleInput('');
                                  setFavUrlInput('');
                                  setFavError(null);
                                }
                              }
                            }}
                          >
                            <div className="maw-settings-form-row">
                              <label className="maw-settings-form-field">
                                <span>{t('settings.browser.name')}</span>
                                <input
                                  autoFocus
                                  type="text"
                                  required
                                  maxLength={120}
                                  value={favTitleInput}
                                  onChange={(e) => {
                                    setFavTitleInput(e.target.value);
                                    setFavError(null);
                                  }}
                                  placeholder="e.g. Documentation"
                                />
                              </label>
                              <label className="maw-settings-form-field">
                                <span>{t('settings.browser.url')}</span>
                                <input
                                  type="url"
                                  required
                                  maxLength={2048}
                                  value={favUrlInput}
                                  onChange={(e) => {
                                    setFavUrlInput(e.target.value);
                                    setFavError(null);
                                  }}
                                  placeholder="https://..."
                                />
                              </label>
                            </div>
                            {favError && (
                              <p role="alert" className="agency-error maw-settings-fav-error">
                                {favError}
                              </p>
                            )}
                            <div className="maw-settings-form-actions">
                              <button type="submit" className="agency-button-primary">
                                {t('common.save')}
                              </button>
                              <button
                                type="button"
                                className="agency-button-secondary"
                                onClick={() => {
                                  setIsAddingFavorite(false);
                                  setEditingFavoriteId(null);
                                  setFavError(null);
                                }}
                              >
                                {t('common.cancel')}
                              </button>
                            </div>
                          </form>
                        )}

                        {browserSettings.favorites.length === 0 ? (
                          <div className="maw-settings-empty-favorites">
                            <p className="maw-settings-hint">{t('settings.browser.noFavorites')}</p>
                          </div>
                        ) : (
                          <ul className="maw-settings-favorites-list">
                            {browserSettings.favorites.map((fav, index) => (
                              <li key={fav.id} className="maw-settings-favorite-row">
                                <div className="maw-settings-fav-info">
                                  <span className="maw-settings-fav-title">{fav.title}</span>
                                  <span className="maw-settings-fav-url" title={fav.url}>
                                    {fav.url}
                                  </span>
                                </div>
                                <div className="maw-settings-fav-actions">
                                  <button
                                    type="button"
                                    className="icon-button maw-settings-fav-btn"
                                    title="Move Up"
                                    aria-label="Move Up"
                                    disabled={index === 0}
                                    onClick={() => browserSettings.moveFavorite(fav.id, 'up')}
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-button maw-settings-fav-btn"
                                    title="Move Down"
                                    aria-label="Move Down"
                                    disabled={index === browserSettings.favorites.length - 1}
                                    onClick={() => browserSettings.moveFavorite(fav.id, 'down')}
                                  >
                                    ↓
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-button maw-settings-fav-btn"
                                    title={t('settings.browser.editFavorite')}
                                    aria-label={t('settings.browser.editFavorite')}
                                    onClick={() => {
                                      setEditingFavoriteId(fav.id);
                                      setIsAddingFavorite(false);
                                      setFavTitleInput(fav.title);
                                      setFavUrlInput(fav.url);
                                      setFavError(null);
                                    }}
                                  >
                                    ✎
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-button maw-settings-fav-btn maw-settings-fav-delete"
                                    title="Delete"
                                    aria-label="Delete"
                                    onClick={() => browserSettings.removeFavorite(fav.id)}
                                  >
                                    ✕
                                  </button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}

                        <div className="maw-settings-favorites-footer">
                          <button
                            type="button"
                            className="maw-settings-link-btn"
                            onClick={() => browserSettings.resetToDefaults()}
                          >
                            {t('settings.browser.resetDefaults')}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* AGENTS TAB */}
                {activeTab === 'agents' && (
                  <div className="maw-settings-groups">
                    <div className="maw-settings-card">
                      <div className="maw-settings-card-header">
                        <span className="maw-settings-card-title">{t('settings.section.clis')}</span>
                      </div>
                      <div className="maw-settings-card-body">
                        {status === null ? (
                          <p className="maw-settings-hint">{t('settings.oldServer')}</p>
                        ) : (
                          <>
                            <ul className="maw-settings-clis">
                              {agents.map((agent) => {
                                const off = shownDisabled.includes(agent.id);
                                const offAtStart = status.disabledAtStart.includes(agent.id);
                                const installed = agent.available || offAtStart;
                                return (
                                  <li key={agent.id} className="maw-settings-cli-row">
                                    <div className="maw-settings-cli-main">
                                      {installed ? (
                                        <label className="maw-settings-choice">
                                          <input
                                            type="checkbox"
                                            checked={!off}
                                            disabled={!serverEditable}
                                            onChange={(event) => {
                                              const next = toggled(shownDisabled, agent.id, !event.target.checked);
                                              setPendingDisabled(next);
                                              appSettings.setDisabledAgents(next);
                                            }}
                                          />
                                          <span className="maw-settings-cli-name">{agent.label}</span>
                                        </label>
                                      ) : (
                                        <span className="maw-settings-cli-name maw-settings-cli-missing">
                                          {agent.label}
                                        </span>
                                      )}
                                    </div>
                                    <div className="maw-settings-cli-actions">
                                      <span
                                        className={`maw-settings-badge ${
                                          agent.available
                                            ? 'badge-available'
                                            : offAtStart
                                              ? 'badge-disabled'
                                              : 'badge-missing'
                                        }`}
                                      >
                                        {agent.available
                                          ? agent.version || t('settings.cli.available')
                                          : offAtStart
                                            ? t('settings.cli.disabled')
                                            : t('settings.cli.notInstalled')}
                                      </span>
                                      {!installed && (
                                        <a
                                          className="link-button maw-settings-install-link"
                                          href={agent.installUrl}
                                          target="_blank"
                                          rel="noreferrer noopener"
                                        >
                                          {t('settings.cli.install')}
                                        </a>
                                      )}
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                            <p className="maw-settings-hint">{t('settings.cli.hint')}</p>
                            {restartPending && (
                              <div className="maw-settings-banner maw-settings-banner-warning" role="status">
                                <span className="maw-settings-banner-icon">ℹ</span>
                                <span>{t('settings.cli.restart')}</span>
                              </div>
                            )}
                            {remoteClient && (
                              <p className="maw-settings-hint maw-settings-warning">{t('settings.hostOnly')}</p>
                            )}
                            {appSettings.problem !== null && (
                              <div className="maw-settings-banner maw-settings-banner-error" role="alert">
                                <span>{appSettings.problem}</span>
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={appSettings.dismissProblem}
                                >
                                  {t('common.close')}
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* ABOUT TAB */}
                {activeTab === 'about' && (
                  <div className="maw-settings-groups">
                    <div className="maw-settings-card">
                      <div className="maw-settings-about-hero">
                        <div className="maw-settings-about-logo">MaW</div>
                        <div>
                          <h3 className="maw-settings-about-name">{t('settings.about.app')}</h3>
                          <p className="maw-settings-about-tagline">{t('settings.about.tagline')}</p>
                        </div>
                      </div>

                      <div className="maw-settings-spec-table">
                        <div className="maw-settings-spec-row">
                          <span className="maw-settings-spec-label">{t('settings.about.version')}</span>
                          <span className="maw-settings-spec-val">v{runtime.appVersion}</span>
                        </div>
                        <div className="maw-settings-spec-row">
                          <span className="maw-settings-spec-label">{t('settings.about.runtime')}</span>
                          <span className="maw-settings-spec-val">Electron {runtime.electronVersion}</span>
                        </div>
                        <div className="maw-settings-spec-row">
                          <span className="maw-settings-spec-label">{t('settings.about.platform')}</span>
                          <span className="maw-settings-spec-val">{runtime.platform}</span>
                        </div>
                      </div>

                      <div className="maw-settings-about-links">
                        <a
                          className="link-button"
                          href="https://github.com/cvelasquez/agent-workbench"
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {t('settings.about.github')} ↗
                        </a>
                      </div>
                    </div>
                  </div>
                )}

                {/* PANELS TAB (Legacy Workbench compatibility) */}
                {activeTab === 'panels' && panels && (
                  <div className="maw-settings-groups">
                    <div className="maw-settings-card">
                      <div className="maw-settings-card-header">
                        <span className="maw-settings-card-title">{t('settings.section.panels')}</span>
                      </div>
                      <div className="maw-settings-card-body">
                        <div className="maw-settings-panels-grid">
                          {HIDEABLE_PANELS.map((panel) => (
                            <label key={panel} className="maw-settings-choice">
                              <input
                                type="checkbox"
                                checked={panels.isVisible(panel)}
                                onChange={(event) => togglePanel(panel, event.target.checked)}
                              />
                              <span className="maw-settings-choice-label">{t(PANEL_NAMES[panel])}</span>
                            </label>
                          ))}
                        </div>
                        {confirmingConsole && (
                          <div className="maw-settings-confirm" role="alert">
                            <span>{t('settings.panels.consoleConfirm', { count: consoleCount })}</span>
                            <div className="maw-settings-confirm-actions">
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => {
                                  setConfirmingConsole(false);
                                  onHideConsole();
                                }}
                              >
                                {t('settings.panels.consoleConfirmYes')}
                              </button>
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => setConfirmingConsole(false)}
                              >
                                {t('common.cancel')}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

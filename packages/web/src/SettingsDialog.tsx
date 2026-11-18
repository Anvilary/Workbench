/**
 * Settings dialog for My Amazing Workspace (MaW).
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

import { useEffect, useRef, useState, useId, useMemo } from 'react';
import type { AgentId, AgentInfo, ConsoleShellId } from '@agent-workbench/shared';
import { t, type MessageKey } from './i18n/index.js';
import { LocaleMenu } from './LocaleMenu.js';
import { HIDEABLE_PANELS, type HideablePanel, type PanelVisibility } from './panel-visibility.js';
import type { AppSettingsApi } from './useAppSettings.js';
import type { TerminalThemePreference, TerminalThemeState } from './useTerminalTheme.js';
import { vaultName } from './vault-ui.js';
import type { AgentConnection } from './connection.js';
import { AgentsUsageView } from './AgentsUsageView.js';
import { AgentProfilesManager } from './AgentProfilesManager.js';
import { useBrowserSettings } from './agency/useBrowserSettings.js';
import { BrowserSettingsSection } from './BrowserSettingsSection.js';

// Icons: Consistent monochrome neutral SVG system (16x16, strokeWidth 1.3)
export function GearIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v1.75M8 12.75v1.75M1.5 8h1.75M12.75 8h1.75M3.4 3.4l1.24 1.24M11.36 11.36l1.24 1.24M3.4 12.6l1.24-1.24M11.36 4.64l1.24-1.24" />
    </svg>
  );
}

export function TerminalIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="2" width="13" height="12" rx="1.5" />
      <path d="M4.5 5.5l3 2.5-3 2.5M9.5 10.5h2.5" />
    </svg>
  );
}

export function BrowserIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" />
      <line x1="1.75" y1="8" x2="14.25" y2="8" />
      <path d="M8 1.75c-2.4 2-3.8 4.25-3.8 6.25s1.4 4.25 3.8 6.25c2.4-2 3.8-4.25 3.8-6.25s-1.4-4.25-3.8-6.25z" />
    </svg>
  );
}

export function RobotIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.5" y="4.5" width="11" height="9" rx="1.5" />
      <path d="M5.5 8h.01M10.5 8h.01M8 1.5v3M4 1.5h8" />
      <path d="M6 11h4" />
    </svg>
  );
}

export function UsageIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="2" y1="13.5" x2="14" y2="13.5" />
      <rect x="3" y="8.5" width="2.5" height="5" rx="0.5" />
      <rect x="6.75" y="5.5" width="2.5" height="8" rx="0.5" />
      <rect x="10.5" y="2.5" width="2.5" height="11" rx="0.5" />
    </svg>
  );
}

export function InfoIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" />
      <line x1="8" y1="7" x2="8" y2="11.5" />
      <circle cx="8" cy="4.75" r="0.5" fill="currentColor" />
    </svg>
  );
}

export function PanelsIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="2" width="13" height="12" rx="1.5" />
      <line x1="5.5" y1="2" x2="5.5" y2="14" />
      <line x1="1.5" y1="6" x2="5.5" y2="6" />
    </svg>
  );
}

export function SearchIcon({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="6.5" cy="6.5" r="4.5" />
      <line x1="10" y1="10" x2="14" y2="14" />
    </svg>
  );
}

export type SettingsTabId = 'general' | 'terminal' | 'browser' | 'agents' | 'usage' | 'about' | 'panels';

interface TabDefinition {
  id: SettingsTabId;
  labelKey: MessageKey;
  descKey: MessageKey;
  icon: (props: { size?: number }) => JSX.Element;
}

const ALL_TABS: readonly TabDefinition[] = [
  { id: 'general', labelKey: 'settings.category.general', descKey: 'settings.desc.general', icon: GearIcon },
  { id: 'terminal', labelKey: 'settings.category.terminal', descKey: 'settings.desc.terminal', icon: TerminalIcon },
  { id: 'browser', labelKey: 'settings.category.browser', descKey: 'settings.desc.browser', icon: BrowserIcon },
  { id: 'agents', labelKey: 'settings.category.agents', descKey: 'settings.desc.agents', icon: RobotIcon },
  { id: 'usage', labelKey: 'settings.category.usage', descKey: 'settings.desc.usage', icon: UsageIcon },
  { id: 'about', labelKey: 'settings.category.about', descKey: 'settings.desc.about', icon: InfoIcon },
  { id: 'panels', labelKey: 'settings.category.panels', descKey: 'settings.desc.panels', icon: PanelsIcon },
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

export interface AppVersionInfo {
  version: string;
  gitSha: string | null;
  isDev: boolean;
  displayVersion: string;
}

export function getAppVersionInfo(): AppVersionInfo {
  let version = '0.8.1';
  if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__ !== 'dev' && __APP_VERSION__ !== 'test') {
    version = __APP_VERSION__;
  } else if (typeof process !== 'undefined' && process.env?.MAW_APP_VERSION) {
    version = process.env.MAW_APP_VERSION;
  }

  let gitSha: string | null = null;
  if (typeof __APP_GIT_SHA__ === 'string' && __APP_GIT_SHA__.trim().length > 0) {
    gitSha = __APP_GIT_SHA__.trim().slice(0, 7);
  } else if (typeof process !== 'undefined') {
    const rawSha = process.env?.GIT_SHA || process.env?.VITE_GIT_SHA;
    if (rawSha && rawSha.trim().length > 0) {
      gitSha = rawSha.trim().slice(0, 7);
    }
  }

  const isDev = Boolean(
    gitSha ||
    (typeof __APP_IS_DEV__ === 'boolean' && __APP_IS_DEV__) ||
    (typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) ||
    (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production' && process.env?.NODE_ENV !== 'test')
  );

  const displayVersion = isDev && gitSha
    ? `v${version} (dev @${gitSha})`
    : isDev
      ? `v${version} (dev)`
      : `v${version}`;

  return {
    version,
    gitSha,
    isDev,
    displayVersion,
  };
}

function getRuntimeInfo() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const electronMatch = ua.match(/Electron\/([\d.]+)/);
  const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
  const versionInfo = getAppVersionInfo();

  return {
    appVersion: versionInfo.version,
    displayVersion: versionInfo.displayVersion,
    electronVersion: electronMatch ? electronMatch[1] : '45.2.0',
    chromiumVersion: chromeMatch ? chromeMatch[1] : '134.0.6998.35',
    platform: typeof navigator !== 'undefined' && navigator.platform ? navigator.platform : 'Linux x86_64',
  };
}

export interface SearchItem {
  id: string;
  tabId: SettingsTabId;
  targetId: string;
  categoryName: string;
  title: string;
  description: string;
  keywords: string[];
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
  initialTab?: SettingsTabId | 'agents-usage' | 'appearance';
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
  // Support legacy or redirected initial tab
  const mappedInitial: SettingsTabId =
    initialTab === 'agents-usage'
      ? 'usage'
      : initialTab === 'appearance'
        ? 'general'
        : (initialTab ?? 'general');

  const [activeTab, setActiveTab] = useState<SettingsTabId>(mappedInitial);
  const [confirmingConsole, setConfirmingConsole] = useState(false);
  const [highlightedCardId, setHighlightedCardId] = useState<string | null>(null);

  // Search state
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
        // If user is searching, clear search first; otherwise close modal
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
  const versionInfo = getAppVersionInfo();

  const safeAgents = Array.isArray(agents) ? agents : [];

  // Search indexing: Build comprehensive searchable catalog
  const searchCatalog = useMemo<SearchItem[]>(() => {
    const items: SearchItem[] = [];

    // 1. Categories
    for (const tab of visibleTabs) {
      items.push({
        id: `cat-${tab.id}`,
        tabId: tab.id,
        targetId: `settings-tabpanel-${tab.id}`,
        categoryName: t(tab.labelKey),
        title: t(tab.labelKey),
        description: t(tab.descKey),
        keywords: [tab.id, 'category', 'tab', 'settings'],
      });
    }

    // 2. General settings
    items.push({
      id: 'general-language',
      tabId: 'general',
      targetId: 'setting-card-language',
      categoryName: t('settings.category.general'),
      title: t('settings.language'),
      description: t('settings.desc.general'),
      keywords: ['language', 'locale', 'translation', 'idioma', 'sprache'],
    });

    items.push({
      id: 'general-theme',
      tabId: 'general',
      targetId: 'setting-card-theme',
      categoryName: t('settings.category.general'),
      title: t('settings.terminalTheme'),
      description: `${t('settings.terminalTheme.hint')} - ${t('settings.appearance.themeDark')}`,
      keywords: ['appearance', 'theme', 'dark', 'follow', 'terminal theme', 'dark-only', 'color', 'contrast'],
    });

    if (onOpenVault !== null) {
      items.push({
        id: 'general-vault',
        tabId: 'general',
        targetId: 'setting-card-more',
        categoryName: t('settings.category.general'),
        title: vaultName(),
        description: t('settings.more.open', { name: vaultName() }),
        keywords: ['vault', 'memory', 'private', 'documents'],
      });
    }

    if (onOpenRemote !== null) {
      items.push({
        id: 'general-remote',
        tabId: 'general',
        targetId: 'setting-card-more',
        categoryName: t('settings.category.general'),
        title: t('app.header.remoteAccess'),
        description: t('settings.more.open', { name: t('app.header.remoteAccess') }),
        keywords: ['remote', 'network', 'mobile', 'browser access', 'port'],
      });
    }

    // 3. Terminal settings
    items.push({
      id: 'terminal-console',
      tabId: 'terminal',
      targetId: 'setting-card-console',
      categoryName: t('settings.category.terminal'),
      title: t('settings.section.console'),
      description: t('settings.console.hint'),
      keywords: ['terminal', 'console', 'shell', 'bash', 'zsh', 'sh', 'command line'],
    });

    for (const shell of shellChoices) {
      items.push({
        id: `terminal-shell-${shell.id}`,
        tabId: 'terminal',
        targetId: 'setting-card-console',
        categoryName: t('settings.category.terminal'),
        title: shell.label,
        description: t('settings.console.hint'),
        keywords: ['shell', shell.id, 'terminal', 'console'],
      });
    }

    // 4. Browser settings
    items.push({
      id: 'browser-search-engine',
      tabId: 'browser',
      targetId: 'setting-card-search-engine',
      categoryName: t('settings.category.browser'),
      title: t('settings.browser.searchEngine'),
      description: t('settings.browser.searchEngineDesc'),
      keywords: ['browser', 'search engine', 'default search', 'web', 'omnibar'],
    });

    for (const engine of browserSettings.searchEngines) {
      items.push({
        id: `browser-engine-${engine.id}`,
        tabId: 'browser',
        targetId: 'setting-card-search-engine',
        categoryName: t('settings.category.browser'),
        title: engine.name,
        description: engine.homeUrl,
        keywords: ['search', engine.id, engine.name, 'engine', engine.homeUrl, engine.searchUrl],
      });
    }

    items.push({
      id: 'browser-favorites',
      tabId: 'browser',
      targetId: 'setting-card-favorites',
      categoryName: t('settings.category.browser'),
      title: t('settings.browser.favorites'),
      description: t('settings.browser.favoritesDesc'),
      keywords: ['favorites', 'bookmarks', 'links', 'browser', 'web'],
    });

    for (const fav of browserSettings.favorites) {
      items.push({
        id: `browser-fav-${fav.id}`,
        tabId: 'browser',
        targetId: 'setting-card-favorites',
        categoryName: t('settings.category.browser'),
        title: fav.title,
        description: fav.url,
        keywords: ['favorite', 'bookmark', fav.title, fav.url],
      });
    }

    // 5. Agents settings
    items.push({
      id: 'agents-clis',
      tabId: 'agents',
      targetId: 'setting-card-clis',
      categoryName: t('settings.category.agents'),
      title: t('settings.section.clis'),
      description: t('settings.cli.hint'),
      keywords: ['agents', 'clis', 'coding agents', 'integrations'],
    });

    items.push({
      id: 'agents-profiles',
      tabId: 'agents',
      targetId: 'setting-card-profiles',
      categoryName: t('settings.category.agents'),
      title: t('settings.profiles.sectionTitle'),
      description: t('settings.profiles.sectionDesc'),
      keywords: ['profiles', 'accounts', 'codex', 'claude code', 'antigravity', 'opencode', 'pi', 'add profile'],
    });

    for (const agent of safeAgents) {
      items.push({
        id: `agent-${agent.id}`,
        tabId: 'agents',
        targetId: `setting-agent-${agent.id}`,
        categoryName: t('settings.category.agents'),
        title: agent.label || agent.id,
        description: agent.available
          ? (agent.version ? `v${agent.version} (${t('settings.cli.available')})` : t('settings.cli.available'))
          : t('settings.cli.notInstalled'),
        keywords: ['agent', 'cli', agent.id, agent.label || '', 'ai', 'model'],
      });
    }

    // 6. Usage settings
    items.push({
      id: 'usage-metrics',
      tabId: 'usage',
      targetId: 'settings-tabpanel-usage',
      categoryName: t('settings.category.usage'),
      title: t('settings.category.usage'),
      description: t('settings.desc.usage'),
      keywords: ['usage', 'telemetry', 'tokens', 'cost', 'metrics', 'profiles', 'quota', 'five hour', 'weekly'],
    });

    // 7. About settings
    items.push({
      id: 'about-specs',
      tabId: 'about',
      targetId: 'setting-card-about',
      categoryName: t('settings.category.about'),
      title: t('settings.about.app'),
      description: `${t('settings.about.version')} ${versionInfo.displayVersion} - Electron ${runtime.electronVersion}`,
      keywords: ['about', 'version', 'electron', 'platform', 'runtime', 'specifications', 'git', 'release'],
    });

    // 8. Panels settings (if available)
    if (shouldOfferPanels && panels) {
      items.push({
        id: 'panels-visibility',
        tabId: 'panels',
        targetId: 'setting-card-panels',
        categoryName: t('settings.category.panels'),
        title: t('settings.section.panels'),
        description: t('settings.desc.panels'),
        keywords: ['panels', 'sidebar', 'visibility', 'toggle'],
      });

      for (const panel of HIDEABLE_PANELS) {
        items.push({
          id: `panel-${panel}`,
          tabId: 'panels',
          targetId: 'setting-card-panels',
          categoryName: t('settings.category.panels'),
          title: t(PANEL_NAMES[panel]),
          description: t('settings.section.panels'),
          keywords: ['panel', panel, 'visibility'],
        });
      }
    }

    return items;
  }, [visibleTabs, onOpenVault, onOpenRemote, shellChoices, browserSettings.favorites, agents, shouldOfferPanels, panels, runtime.electronVersion, versionInfo.displayVersion]);

  // Compute search results based on case-insensitive query matching
  const searchResults = useMemo<SearchItem[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];

    return searchCatalog.filter((item) => {
      const matchTitle = item.title.toLowerCase().includes(q);
      const matchDesc = item.description.toLowerCase().includes(q);
      const matchCat = item.categoryName.toLowerCase().includes(q);
      const matchKeywords = item.keywords.some((k) => k.toLowerCase().includes(q));
      return matchTitle || matchDesc || matchCat || matchKeywords;
    });
  }, [searchQuery, searchCatalog]);

  const handleSelectSearchResult = (result: SearchItem) => {
    setActiveTab(result.tabId);
    setSearchQuery('');
    setHighlightedCardId(result.targetId);

    // Scroll to setting smoothly after tab render
    setTimeout(() => {
      const el = document.getElementById(result.targetId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 60);

    // Remove temporary highlight animation after 1.8 seconds
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
    <div className="modal-backdrop maw-settings-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`modal settings-dialog maw-settings-window ${activeTab === 'usage' ? 'settings-dialog-wide maw-settings-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header: Proportionately larger, aligned, restrained */}
        <header className="modal-header maw-settings-header">
          <div className="maw-settings-header-title-group">
            <span className="maw-settings-header-icon" aria-hidden="true">
              <GearIcon size={20} />
            </span>
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
          {/* Left Navigation Sidebar */}
          <nav
            className="maw-settings-nav"
            role="tablist"
            aria-label={t('settings.title')}
            onKeyDown={!isSearching ? handleNavKeyDown : undefined}
          >
            {/* Compact Search Input */}
            <div className="maw-settings-search-box">
              <span className="maw-settings-search-icon" aria-hidden="true">
                <SearchIcon size={13} />
              </span>
              <input
                ref={searchInputRef}
                type="search"
                className="maw-settings-search-input"
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
                  className="maw-settings-search-clear"
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

            {/* If searching, render search results or empty state; otherwise tab items */}
            {isSearching ? (
              <div className="maw-settings-search-results" role="listbox" aria-label="Search results">
                {searchResults.length === 0 ? (
                  <div className="maw-settings-search-empty">
                    <p className="maw-settings-search-empty-text">
                      {t('settings.search.noResults')}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="maw-settings-search-count">
                      {t('settings.search.resultsCount', { count: searchResults.length })}
                    </div>
                    {searchResults.map((result, idx) => (
                      <button
                        key={result.id}
                        type="button"
                        role="option"
                        aria-selected={idx === selectedResultIndex}
                        className={`maw-settings-search-item ${idx === selectedResultIndex ? 'active' : ''}`}
                        onClick={() => handleSelectSearchResult(result)}
                        onMouseEnter={() => setSelectedResultIndex(idx)}
                      >
                        <div className="maw-settings-search-item-header">
                          <span className="maw-settings-search-item-title">{result.title}</span>
                          <span className="maw-settings-search-item-category">{result.categoryName}</span>
                        </div>
                        {result.description && (
                          <div className="maw-settings-search-item-desc">{result.description}</div>
                        )}
                      </button>
                    ))}
                  </>
                )}
              </div>
            ) : (
              <div className="maw-settings-nav-list">
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
                      className={`maw-settings-nav-item ${isSelected ? 'active' : ''}`}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      <span className="maw-settings-nav-icon">
                        <IconComponent size={15} />
                      </span>
                      <span className="maw-settings-nav-label">{t(tab.labelKey)}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Authoritative Version Display at bottom-left */}
            <div className="maw-settings-sidebar-footer">
              <span className="maw-settings-version" title={`MaW ${versionInfo.displayVersion}`}>
                {versionInfo.displayVersion}
              </span>
            </div>
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

                {/* GENERAL TAB (Includes Language, Appearance & Terminal Theme, More) */}
                {activeTab === 'general' && (
                  <div className="maw-settings-groups">
                    {/* Language Card */}
                    <div
                      id="setting-card-language"
                      className={`maw-settings-card ${highlightedCardId === 'setting-card-language' ? 'maw-settings-card-highlighted' : ''}`}
                    >
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

                    {/* Appearance & Terminal Theme Card */}
                    <div
                      id="setting-card-theme"
                      className={`maw-settings-card ${highlightedCardId === 'setting-card-theme' ? 'maw-settings-card-highlighted' : ''}`}
                    >
                      <div className="maw-settings-card-header">
                        <span className="maw-settings-card-title">{t('settings.section.appearance')}</span>
                      </div>
                      <div className="maw-settings-card-body">
                        {/* Application Theme: Dark-only design affirmation */}
                        <div className="maw-settings-row">
                          <div className="maw-settings-row-text">
                            <span className="maw-settings-label">{t('settings.section.appearance')}</span>
                            <span className="maw-settings-subtext">{t('settings.appearance.themeDark')}</span>
                          </div>
                          <div className="maw-settings-control">
                            <span className="maw-settings-badge badge-available">Dark</span>
                          </div>
                        </div>

                        {/* Terminal Theme Preference */}
                        <div className="maw-settings-row maw-settings-row-top" style={{ marginTop: '12px' }}>
                          <div className="maw-settings-row-text">
                            <span className="maw-settings-label">{t('settings.terminalTheme')}</span>
                            <span className="maw-settings-subtext">{t('settings.terminalTheme.hint')}</span>
                          </div>
                          <div className="maw-settings-control">
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
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* More Card (Vault and Remote Access) */}
                    {(onOpenVault !== null || onOpenRemote !== null) && (
                      <div
                        id="setting-card-more"
                        className={`maw-settings-card ${highlightedCardId === 'setting-card-more' ? 'maw-settings-card-highlighted' : ''}`}
                      >
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

                {/* TERMINAL TAB */}
                {activeTab === 'terminal' && (
                  <div className="maw-settings-groups">
                    <div
                      id="setting-card-console"
                      className={`maw-settings-card ${highlightedCardId === 'setting-card-console' ? 'maw-settings-card-highlighted' : ''}`}
                    >
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
                  <BrowserSettingsSection
                    browserSettings={browserSettings}
                    highlightedCardId={highlightedCardId}
                  />
                )}

                {/* AGENTS TAB */}
                {activeTab === 'agents' && (
                  <div className="maw-settings-groups">
                    <div
                      id="setting-card-clis"
                      className={`maw-settings-card ${highlightedCardId === 'setting-card-clis' ? 'maw-settings-card-highlighted' : ''}`}
                    >
                      <div className="maw-settings-card-header">
                        <span className="maw-settings-card-title">{t('settings.section.clis')}</span>
                      </div>
                      <div className="maw-settings-card-body">
                        {status === null ? (
                          <p className="maw-settings-hint">{t('settings.oldServer')}</p>
                        ) : (
                          <>
                            <ul className="maw-settings-clis">
                              {safeAgents.map((agent) => {
                                const off = shownDisabled.includes(agent.id);
                                const offAtStart = status.disabledAtStart.includes(agent.id);
                                const installed = agent.available || offAtStart;
                                const isAgentHighlighted = highlightedCardId === `setting-agent-${agent.id}`;
                                return (
                                  <li
                                    key={agent.id}
                                    id={`setting-agent-${agent.id}`}
                                    className={`maw-settings-cli-row ${isAgentHighlighted ? 'maw-settings-card-highlighted' : ''}`}
                                  >
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
                                <span className="maw-settings-banner-icon" aria-hidden="true">
                                  <InfoIcon size={14} />
                                </span>
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

                    <AgentProfilesManager
                      agents={safeAgents}
                      connection={connection}
                      remoteClient={remoteClient}
                    />
                  </div>
                )}

                {/* ABOUT TAB */}
                {activeTab === 'about' && (
                  <div className="maw-settings-groups">
                    <div
                      id="setting-card-about"
                      className={`maw-settings-card ${highlightedCardId === 'setting-card-about' ? 'maw-settings-card-highlighted' : ''}`}
                    >
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
                          <span className="maw-settings-spec-val">{runtime.displayVersion}</span>
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
                    <div
                      id="setting-card-panels"
                      className={`maw-settings-card ${highlightedCardId === 'setting-card-panels' ? 'maw-settings-card-highlighted' : ''}`}
                    >
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

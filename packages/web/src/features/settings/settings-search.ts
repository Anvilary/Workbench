import type { AgentInfo, BrowserFavorite, BrowserProfile, ConsoleShellId, SearchEngine } from '@agent-workbench/shared';
import { t, type MessageKey } from '../../i18n/index.js';
import { HIDEABLE_PANELS, type HideablePanel, type PanelVisibility } from '../../panel-visibility.js';
import type { TerminalThemePreference } from '../../useTerminalTheme.js';
import { vaultName } from '../../vault-ui.js';
import {
  BrowserIcon,
  GearIcon,
  InfoIcon,
  PanelsIcon,
  RobotIcon,
  TerminalIcon,
  UsageIcon,
} from './SettingsIcons.js';

export type SettingsTabId = 'general' | 'terminal' | 'browser' | 'agents' | 'usage' | 'about' | 'panels';

export interface TabDefinition {
  id: SettingsTabId;
  labelKey: MessageKey;
  descKey: MessageKey;
  icon: (props: { size?: number }) => JSX.Element;
}

export const ALL_TABS: readonly TabDefinition[] = [
  { id: 'general', labelKey: 'settings.category.general', descKey: 'settings.desc.general', icon: GearIcon },
  { id: 'terminal', labelKey: 'settings.category.terminal', descKey: 'settings.desc.terminal', icon: TerminalIcon },
  { id: 'browser', labelKey: 'settings.category.browser', descKey: 'settings.desc.browser', icon: BrowserIcon },
  { id: 'agents', labelKey: 'settings.category.agents', descKey: 'settings.desc.agents', icon: RobotIcon },
  { id: 'usage', labelKey: 'settings.category.usage', descKey: 'settings.desc.usage', icon: UsageIcon },
  { id: 'about', labelKey: 'settings.category.about', descKey: 'settings.desc.about', icon: InfoIcon },
  { id: 'panels', labelKey: 'settings.category.panels', descKey: 'settings.desc.panels', icon: PanelsIcon },
];

export const PANEL_NAMES: Readonly<Record<HideablePanel, MessageKey>> = {
  git: 'panel.tab.git',
  files: 'panel.tab.files',
  plans: 'panel.tab.plans',
  memory: 'panel.tab.memory',
  console: 'console.name',
  notes: 'notes.name',
};

export const TERMINAL_THEME_NAMES: Readonly<Record<TerminalThemePreference, MessageKey>> = {
  dark: 'settings.terminalTheme.dark',
  follow: 'settings.terminalTheme.follow',
};

export interface SearchItem {
  id: string;
  tabId: SettingsTabId;
  targetId: string;
  categoryName: string;
  title: string;
  description: string;
  keywords: string[];
}

export interface BuildSearchCatalogParams {
  visibleTabs: readonly TabDefinition[];
  onOpenVault: (() => void) | null;
  onOpenRemote: (() => void) | null;
  shellChoices: readonly { id: ConsoleShellId; label: string }[];
  searchEngines: readonly SearchEngine[];
  favorites: readonly BrowserFavorite[];
  browserProfiles?: readonly BrowserProfile[];
  agents: readonly AgentInfo[];
  shouldOfferPanels: boolean;
  panels?: PanelVisibility;
  electronVersion: string;
  displayVersion: string;
}

export function buildSettingsSearchCatalog({
  visibleTabs,
  onOpenVault,
  onOpenRemote,
  shellChoices,
  searchEngines,
  favorites,
  browserProfiles = [],
  agents,
  shouldOfferPanels,
  panels,
  electronVersion,
  displayVersion,
}: BuildSearchCatalogParams): SearchItem[] {
  const items: SearchItem[] = [];

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

  items.push({
    id: 'browser-search-engine',
    tabId: 'browser',
    targetId: 'setting-card-search-engine',
    categoryName: t('settings.category.browser'),
    title: t('settings.browser.searchEngine'),
    description: t('settings.browser.searchEngineDesc'),
    keywords: ['browser', 'search engine', 'default search', 'web', 'omnibar'],
  });

  for (const engine of searchEngines) {
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
    id: 'browser-profiles',
    tabId: 'browser',
    targetId: 'setting-card-browser-profiles',
    categoryName: t('settings.category.browser'),
    title: t('settings.browser.profiles'),
    description: t('settings.browser.profilesDesc'),
    keywords: ['browser profiles', 'profiles', 'sessions', 'cookies', 'clone', 'isolation', 'main', 'auth'],
  });

  for (const profile of browserProfiles) {
    items.push({
      id: `browser-profile-${profile.id}`,
      tabId: 'browser',
      targetId: 'setting-card-browser-profiles',
      categoryName: t('settings.category.browser'),
      title: profile.name,
      description: t('settings.browser.profiles'),
      keywords: ['browser', 'profile', profile.id, profile.name, 'session', 'cookies'],
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

  for (const fav of favorites) {
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

  for (const agent of agents) {
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

  items.push({
    id: 'usage-metrics',
    tabId: 'usage',
    targetId: 'settings-tabpanel-usage',
    categoryName: t('settings.category.usage'),
    title: t('settings.category.usage'),
    description: t('settings.desc.usage'),
    keywords: ['usage', 'telemetry', 'tokens', 'cost', 'metrics', 'profiles', 'quota', 'five hour', 'weekly'],
  });

  items.push({
    id: 'about-specs',
    tabId: 'about',
    targetId: 'setting-card-about',
    categoryName: t('settings.category.about'),
    title: t('settings.about.app'),
    description: `${t('settings.about.version')} ${displayVersion} - Electron ${electronVersion}`,
    keywords: ['about', 'version', 'electron', 'platform', 'runtime', 'specifications', 'git', 'release'],
  });

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
}

export function filterSettingsSearchCatalog(
  catalog: readonly SearchItem[],
  query: string,
): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return catalog.filter((item) => {
    const matchTitle = item.title.toLowerCase().includes(q);
    const matchDesc = item.description.toLowerCase().includes(q);
    const matchCat = item.categoryName.toLowerCase().includes(q);
    const matchKeywords = item.keywords.some((k) => k.toLowerCase().includes(q));
    return matchTitle || matchDesc || matchCat || matchKeywords;
  });
}

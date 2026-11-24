/**
 * Browser settings state hook.
 *
 * Manages user-configurable favorites, search engines, default search engine,
 * and spellcheck preferences (including profile-isolated custom dictionaries).
 *
 * Architecture:
 * - Single module-level coordinated store shared across all consumers
 *   (`WorkbenchApp`, `WorkspaceView`, `BrowserContextMenu`, `SettingsDialog`).
 * - `settings.json` via `appSettings` is authoritative when connected; `localStorage`
 *   acts as an offline/startup cache.
 * - Custom dictionary additions/removals await native Electron partition mutations
 *   first and only commit to authoritative settings after native confirmation,
 *   preventing false success or stale reconciliation overwrites.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_BROWSER_FAVORITES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_SEARCH_ENGINES,
  DEFAULT_SEARCH_ENGINE_ID,
  DEFAULT_SPELLCHECK_SETTINGS,
  getSearchEngine,
  isValidBrowserProfileId,
  parseBrowserSettings,
  validateBrowserFavoriteUrl,
  validateSearchEngine,
  type BrowserFavorite,
  type BrowserSettings,
  type SearchEngine,
  type SearchEngineCandidate,
  type SearchEngineId,
  type SpellCheckSettings,
} from '@agent-workbench/shared';
import type { AppSettingsApi } from '../settings/useAppSettings.js';

export const BROWSER_SETTINGS_STORAGE_KEY = 'agency-ui.browser-settings.v1';

type BrowserSettingsListener = (next: BrowserSettings) => void;
const browserSettingsListeners = new Set<BrowserSettingsListener>();

let currentSettings: BrowserSettings | null = null;
let activeAppSettings: AppSettingsApi | null = null;
let pendingServerSaves: string[] = [];
let lastServerStatusObject: BrowserSettings | undefined;
let lastSyncedSpellCheckKey = '';
let lastReconciledDictKey = '';
let lastBridgeRef: unknown = null;

function createDefaultSpellCheck(): SpellCheckSettings {
  return {
    enabled: DEFAULT_SPELLCHECK_SETTINGS.enabled,
    languages: [...DEFAULT_SPELLCHECK_SETTINGS.languages],
    configuredLanguages: [...DEFAULT_SPELLCHECK_SETTINGS.configuredLanguages],
    customWordsByProfile: {},
  };
}

function createDefaultBrowserSettings(): BrowserSettings {
  return {
    defaultSearchEngine: DEFAULT_SEARCH_ENGINE_ID,
    favorites: [...DEFAULT_BROWSER_FAVORITES],
    searchEngines: [...DEFAULT_SEARCH_ENGINES],
    spellCheck: createDefaultSpellCheck(),
  };
}

function loadCachedBrowserSettings(): BrowserSettings {
  if (typeof window === 'undefined' || !window.localStorage) {
    return createDefaultBrowserSettings();
  }
  try {
    const raw = window.localStorage.getItem(BROWSER_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return createDefaultBrowserSettings();
    }
    const parsed = parseBrowserSettings(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {
    // Malformed cache falls back cleanly
  }
  return createDefaultBrowserSettings();
}

function getCurrentSettings(): BrowserSettings {
  if (currentSettings === null) {
    currentSettings = loadCachedBrowserSettings();
  }
  return currentSettings;
}

function saveCachedBrowserSettings(settings: BrowserSettings): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota or disabled errors
  }
}

function broadcastBrowserSettings(next: BrowserSettings): void {
  for (const listener of browserSettingsListeners) {
    listener(next);
  }
}

function syncSpellCheckConfigToDesktop(sc: SpellCheckSettings): void {
  const bridge = typeof window !== 'undefined' ? window.mawChatGpt : undefined;
  if (!bridge) return;
  if (lastBridgeRef !== bridge) {
    lastBridgeRef = bridge;
    lastSyncedSpellCheckKey = '';
    lastReconciledDictKey = '';
  }
  const key = JSON.stringify({ enabled: sc.enabled !== false, languages: sc.languages ?? [] });
  if (lastSyncedSpellCheckKey === key) return;
  lastSyncedSpellCheckKey = key;
  void bridge.command({
    type: 'update-spellcheck-settings',
    enabled: sc.enabled !== false,
    languages: sc.languages ?? [],
  });
}

function syncCustomDictionaryToDesktop(sc: SpellCheckSettings): void {
  const bridge = typeof window !== 'undefined' ? window.mawChatGpt : undefined;
  if (!bridge) return;
  if (lastBridgeRef !== bridge) {
    lastBridgeRef = bridge;
    lastSyncedSpellCheckKey = '';
    lastReconciledDictKey = '';
  }
  const map = sc.customWordsByProfile ?? {};
  const key = JSON.stringify(map);
  if (lastReconciledDictKey === key) return;
  lastReconciledDictKey = key;
  void bridge.command({
    type: 'reconcile-custom-dictionary',
    customWordsByProfile: map,
  });
}

function syncAllDesktopSpellCheck(sc: SpellCheckSettings | undefined): void {
  if (!sc) return;
  syncSpellCheckConfigToDesktop(sc);
  syncCustomDictionaryToDesktop(sc);
}

/** Resets module-level browser-settings coordination state (for unit/E2E test isolation). */
export function resetBrowserSettingsStoreForTests(): void {
  currentSettings = null;
  activeAppSettings = null;
  pendingServerSaves = [];
  lastServerStatusObject = undefined;
  lastSyncedSpellCheckKey = '';
  lastReconciledDictKey = '';
  lastBridgeRef = null;
}

export interface UseBrowserSettingsResult {
  favorites: readonly BrowserFavorite[];
  searchEngines: readonly SearchEngine[];
  defaultSearchEngine: SearchEngineId;
  searchEngine: SearchEngine;
  spellCheck: SpellCheckSettings;
  setSpellCheckEnabled: (enabled: boolean) => void;
  toggleSpellCheckLanguage: (code: string) => void;
  addSpellCheckLanguage: (code: string) => void;
  removeSpellCheckLanguage: (code: string) => void;
  getCustomDictionaryWords: (profileId?: string) => string[];
  addCustomDictionaryWord: (word: string, profileId?: string) => Promise<{ success: boolean; error?: string }>;
  removeCustomDictionaryWord: (word: string, profileId?: string) => Promise<{ success: boolean; error?: string }>;
  clearProfileCustomDictionary: (profileId: string) => void;
  addFavorite: (favorite: { title: string; url: string }) => { success: boolean; error?: string };
  editFavorite: (id: string, updates: { title?: string; url?: string }) => { success: boolean; error?: string };
  removeFavorite: (id: string) => void;
  reorderFavorites: (ids: readonly string[]) => void;
  moveFavorite: (id: string, direction: 'up' | 'down') => void;
  setDefaultSearchEngine: (engineId: SearchEngineId) => void;
  addSearchEngine: (candidate: { name: string; homeUrl: string; searchUrl: string }) => { success: boolean; error?: string };
  editSearchEngine: (id: string, updates: { name: string; homeUrl: string; searchUrl: string }) => { success: boolean; error?: string };
  removeSearchEngine: (id: string) => { success: boolean; error?: string };
  restoreBuiltinSearchEngines: () => void;
  resetFavoritesToDefaults: () => void;
  resetToDefaults: () => void;
}

export function useBrowserSettings(appSettings?: AppSettingsApi): UseBrowserSettingsResult {
  const [settings, setSettings] = useState<BrowserSettings>(() => getCurrentSettings());

  useEffect(() => {
    if (appSettings) {
      activeAppSettings = appSettings;
    }
  }, [appSettings]);

  useEffect(() => {
    const listener: BrowserSettingsListener = (next) => {
      setSettings(next);
    };
    browserSettingsListeners.add(listener);
    // Sync immediately if another caller mutated module state before this effect subscribed.
    const latest = getCurrentSettings();
    setSettings(latest);
    if (!appSettings?.status?.browser) {
      syncAllDesktopSpellCheck(latest.spellCheck);
    }
    return () => {
      browserSettingsListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (appSettings?.problem) {
      pendingServerSaves = [];
    }
  }, [appSettings?.problem]);

  // Synchronize when authoritative server status arrives or updates
  useEffect(() => {
    const serverBrowser = appSettings?.status?.browser;
    if (!serverBrowser || serverBrowser === lastServerStatusObject) return;
    const isInitialServerSync = lastServerStatusObject === undefined;
    lastServerStatusObject = serverBrowser;

    const incomingSerialized = JSON.stringify(serverBrowser);
    if (pendingServerSaves.length > 0) {
      const matchIdx = pendingServerSaves.indexOf(incomingSerialized);
      if (matchIdx !== -1) {
        pendingServerSaves.splice(0, matchIdx + 1);
      }
      // If newer local saves are still awaiting server acknowledgment, keep them
      // instead of regressing to an older echo.
      if (pendingServerSaves.length > 0) {
        return;
      }
      if (matchIdx === -1 && !isInitialServerSync) {
        return;
      }
    }

    currentSettings = serverBrowser;
    setSettings(serverBrowser);
    saveCachedBrowserSettings(serverBrowser);
    broadcastBrowserSettings(serverBrowser);
    syncAllDesktopSpellCheck(serverBrowser.spellCheck);
  }, [appSettings?.status?.browser]);

  const persist = useCallback(
    (next: BrowserSettings) => {
      currentSettings = next;
      setSettings(next);
      saveCachedBrowserSettings(next);
      broadcastBrowserSettings(next);
      const targetApi = appSettings ?? activeAppSettings;
      if (targetApi) {
        pendingServerSaves.push(JSON.stringify(next));
        targetApi.setBrowserSettings(next);
      }
    },
    [appSettings],
  );

  const addFavorite = useCallback(
    (fav: { title: string; url: string }) => {
      const latest = getCurrentSettings();
      const title = fav.title.trim();
      if (!title || title.length > 120) {
        return { success: false, error: 'Name must be between 1 and 120 characters' };
      }
      const urlCheck = validateBrowserFavoriteUrl(fav.url);
      if (!urlCheck.valid || !urlCheck.normalizedUrl) {
        return { success: false, error: urlCheck.error ?? 'Invalid web URL' };
      }
      const normalizedUrl = urlCheck.normalizedUrl;

      const isDuplicate = latest.favorites.some(
        (f) => f.url.toLowerCase() === normalizedUrl.toLowerCase(),
      );
      if (isDuplicate) {
        return { success: false, error: 'A favorite with this URL already exists' };
      }

      const id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `fav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newFav: BrowserFavorite = {
        id,
        title,
        url: normalizedUrl,
      };

      const next: BrowserSettings = {
        ...latest,
        favorites: [...latest.favorites, newFav],
      };
      persist(next);
      return { success: true };
    },
    [persist],
  );

  const editFavorite = useCallback(
    (id: string, updates: { title?: string; url?: string }) => {
      const latest = getCurrentSettings();
      const index = latest.favorites.findIndex((f) => f.id === id);
      if (index === -1) return { success: false, error: 'Favorite not found' };

      const existing = latest.favorites[index]!;
      let title = existing.title;
      let url = existing.url;

      if (updates.title !== undefined) {
        const t = updates.title.trim();
        if (!t || t.length > 120) {
          return { success: false, error: 'Name must be between 1 and 120 characters' };
        }
        title = t;
      }

      if (updates.url !== undefined) {
        const urlCheck = validateBrowserFavoriteUrl(updates.url);
        if (!urlCheck.valid || !urlCheck.normalizedUrl) {
          return { success: false, error: urlCheck.error ?? 'Invalid web URL' };
        }
        const normalized = urlCheck.normalizedUrl;
        const duplicate = latest.favorites.some(
          (f) => f.id !== id && f.url.toLowerCase() === normalized.toLowerCase(),
        );
        if (duplicate) {
          return { success: false, error: 'A favorite with this URL already exists' };
        }
        url = normalized;
      }

      const updatedList = [...latest.favorites];
      updatedList[index] = { id, title, url };
      const next: BrowserSettings = {
        ...latest,
        favorites: updatedList,
      };
      persist(next);
      return { success: true };
    },
    [persist],
  );

  const removeFavorite = useCallback(
    (id: string) => {
      const latest = getCurrentSettings();
      const next: BrowserSettings = {
        ...latest,
        favorites: latest.favorites.filter((f) => f.id !== id),
      };
      persist(next);
    },
    [persist],
  );

  const reorderFavorites = useCallback(
    (ids: readonly string[]) => {
      const latest = getCurrentSettings();
      const map = new Map(latest.favorites.map((f) => [f.id, f]));
      const ordered: BrowserFavorite[] = [];
      for (const id of ids) {
        const f = map.get(id);
        if (f) ordered.push(f);
      }
      for (const f of latest.favorites) {
        if (!ids.includes(f.id)) ordered.push(f);
      }
      const next: BrowserSettings = {
        ...latest,
        favorites: ordered,
      };
      persist(next);
    },
    [persist],
  );

  const moveFavorite = useCallback(
    (id: string, direction: 'up' | 'down') => {
      const latest = getCurrentSettings();
      const index = latest.favorites.findIndex((f) => f.id === id);
      if (index === -1) return;
      if (direction === 'up' && index === 0) return;
      if (direction === 'down' && index === latest.favorites.length - 1) return;

      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      const updated = [...latest.favorites];
      const item = updated[index]!;
      updated[index] = updated[targetIndex]!;
      updated[targetIndex] = item;

      const next: BrowserSettings = {
        ...latest,
        favorites: updated,
      };
      persist(next);
    },
    [persist],
  );

  const setDefaultSearchEngine = useCallback(
    (engineId: SearchEngineId) => {
      const latest = getCurrentSettings();
      const currentList = latest.searchEngines ?? DEFAULT_SEARCH_ENGINES;
      const exists = currentList.some((e) => e.id === engineId);
      if (!exists && !DEFAULT_SEARCH_ENGINES.some((d) => d.id === engineId)) return;
      const next: BrowserSettings = {
        ...latest,
        defaultSearchEngine: engineId,
      };
      persist(next);
    },
    [persist],
  );

  const addSearchEngine = useCallback(
    (candidate: { name: string; homeUrl: string; searchUrl: string }) => {
      const latest = getCurrentSettings();
      const currentList = latest.searchEngines ?? DEFAULT_SEARCH_ENGINES;
      const validated = validateSearchEngine(candidate, currentList);
      if (!validated.valid || !validated.normalized) {
        return { success: false, error: validated.error ?? 'Invalid search engine' };
      }
      const next: BrowserSettings = {
        ...latest,
        searchEngines: [...currentList, validated.normalized],
      };
      persist(next);
      return { success: true };
    },
    [persist],
  );

  const editSearchEngine = useCallback(
    (id: string, updates: { name: string; homeUrl: string; searchUrl: string }) => {
      const latest = getCurrentSettings();
      const currentList = latest.searchEngines ?? DEFAULT_SEARCH_ENGINES;
      const index = currentList.findIndex((e) => e.id === id);
      if (index === -1) {
        return { success: false, error: 'Search engine not found' };
      }
      const existing = currentList[index]!;
      const candidate: SearchEngineCandidate = {
        id,
        name: updates.name,
        homeUrl: updates.homeUrl,
        searchUrl: updates.searchUrl,
      };
      const validated = validateSearchEngine(candidate, currentList, id);
      if (!validated.valid || !validated.normalized) {
        return { success: false, error: validated.error ?? 'Invalid search engine' };
      }
      const updatedList = [...currentList];
      updatedList[index] = {
        ...validated.normalized,
        isBuiltin: existing.isBuiltin,
      };
      const next: BrowserSettings = {
        ...latest,
        searchEngines: updatedList,
      };
      persist(next);
      return { success: true };
    },
    [persist],
  );

  const removeSearchEngine = useCallback(
    (id: string) => {
      const latest = getCurrentSettings();
      const currentList = latest.searchEngines ?? DEFAULT_SEARCH_ENGINES;
      const existing = currentList.find((e) => e.id === id);
      if (!existing) {
        return { success: false, error: 'Search engine not found' };
      }
      if (currentList.length <= 1) {
        return { success: false, error: 'At least one search engine must remain configured' };
      }
      const filtered = currentList.filter((e) => e.id !== id);
      let nextDefault = latest.defaultSearchEngine;
      if (latest.defaultSearchEngine === id || !filtered.some((e) => e.id === nextDefault)) {
        nextDefault = filtered[0]?.id ?? DEFAULT_SEARCH_ENGINE_ID;
      }
      const next: BrowserSettings = {
        ...latest,
        defaultSearchEngine: nextDefault,
        searchEngines: filtered,
      };
      persist(next);
      return { success: true };
    },
    [persist],
  );

  const restoreBuiltinSearchEngines = useCallback(() => {
    const latest = getCurrentSettings();
    const currentList = latest.searchEngines ?? DEFAULT_SEARCH_ENGINES;
    const customEngines = currentList.filter(
      (e) => !e.isBuiltin && !DEFAULT_SEARCH_ENGINES.some((d) => d.id === e.id),
    );
    const restored = [...DEFAULT_SEARCH_ENGINES, ...customEngines];
    const defaultExists = restored.some((e) => e.id === latest.defaultSearchEngine);
    const next: BrowserSettings = {
      ...latest,
      defaultSearchEngine: defaultExists ? latest.defaultSearchEngine : DEFAULT_SEARCH_ENGINE_ID,
      searchEngines: restored,
    };
    persist(next);
  }, [persist]);

  const resetFavoritesToDefaults = useCallback(() => {
    const latest = getCurrentSettings();
    const next: BrowserSettings = {
      ...latest,
      favorites: [...DEFAULT_BROWSER_FAVORITES],
    };
    persist(next);
  }, [persist]);

  const spellCheck = settings.spellCheck ?? createDefaultSpellCheck();

  const setSpellCheckEnabled = useCallback(
    (enabled: boolean) => {
      const latest = getCurrentSettings();
      const currentSpellCheck = latest.spellCheck ?? createDefaultSpellCheck();
      const nextSpellCheck: SpellCheckSettings = {
        ...currentSpellCheck,
        enabled,
      };
      const next: BrowserSettings = {
        ...latest,
        spellCheck: nextSpellCheck,
      };
      persist(next);
      syncSpellCheckConfigToDesktop(nextSpellCheck);
    },
    [persist],
  );

  const toggleSpellCheckLanguage = useCallback(
    (code: string) => {
      const latest = getCurrentSettings();
      const currentSpellCheck = latest.spellCheck ?? createDefaultSpellCheck();
      const configured = Array.isArray(currentSpellCheck.configuredLanguages)
        ? currentSpellCheck.configuredLanguages
        : currentSpellCheck.languages;
      if (!configured.includes(code)) return;
      const currentLanguages = currentSpellCheck.languages || [];
      const isEnabled = currentLanguages.includes(code);
      const nextLanguages = isEnabled
        ? currentLanguages.filter((c) => c !== code)
        : [...currentLanguages, code];
      const nextSpellCheck: SpellCheckSettings = {
        ...currentSpellCheck,
        languages: nextLanguages,
      };
      const next: BrowserSettings = {
        ...latest,
        spellCheck: nextSpellCheck,
      };
      persist(next);
      syncSpellCheckConfigToDesktop(nextSpellCheck);
    },
    [persist],
  );

  const addSpellCheckLanguage = useCallback(
    (code: string) => {
      const latest = getCurrentSettings();
      const currentSpellCheck = latest.spellCheck ?? createDefaultSpellCheck();
      const configured = Array.isArray(currentSpellCheck.configuredLanguages)
        ? currentSpellCheck.configuredLanguages
        : currentSpellCheck.languages;
      if (configured.includes(code)) return;
      const nextConfigured = [...configured, code];
      const nextLanguages = [...(currentSpellCheck.languages || []), code];
      const nextSpellCheck: SpellCheckSettings = {
        ...currentSpellCheck,
        configuredLanguages: nextConfigured,
        languages: nextLanguages,
      };
      const next: BrowserSettings = {
        ...latest,
        spellCheck: nextSpellCheck,
      };
      persist(next);
      syncSpellCheckConfigToDesktop(nextSpellCheck);
    },
    [persist],
  );

  const removeSpellCheckLanguage = useCallback(
    (code: string) => {
      const latest = getCurrentSettings();
      const currentSpellCheck = latest.spellCheck ?? createDefaultSpellCheck();
      const configured = Array.isArray(currentSpellCheck.configuredLanguages)
        ? currentSpellCheck.configuredLanguages
        : currentSpellCheck.languages;
      const nextConfigured = configured.filter((c) => c !== code);
      const nextLanguages = (currentSpellCheck.languages || []).filter((c) => c !== code);
      const nextSpellCheck: SpellCheckSettings = {
        ...currentSpellCheck,
        configuredLanguages: nextConfigured,
        languages: nextLanguages,
      };
      const next: BrowserSettings = {
        ...latest,
        spellCheck: nextSpellCheck,
      };
      persist(next);
      syncSpellCheckConfigToDesktop(nextSpellCheck);
    },
    [persist],
  );

  const resolveProfile = (profileId?: string): string | null => {
    if (profileId === undefined) return DEFAULT_BROWSER_PROFILE_ID;
    return isValidBrowserProfileId(profileId) ? profileId : null;
  };

  const getCustomDictionaryWords = useCallback(
    (profileId: string = DEFAULT_BROWSER_PROFILE_ID): string[] => {
      const effective = resolveProfile(profileId);
      if (!effective) return [];
      return spellCheck.customWordsByProfile?.[effective] ?? [];
    },
    [spellCheck],
  );

  const addCustomDictionaryWord = useCallback(
    async (word: string, profileId: string = DEFAULT_BROWSER_PROFILE_ID) => {
      const effective = resolveProfile(profileId);
      if (!effective) return { success: false, error: 'Invalid browser profile' };
      if (/[\r\n\0]/.test(word)) return { success: false, error: 'Word contains invalid characters' };
      const clean = word.trim();
      if (!clean) return { success: false, error: 'Word cannot be empty' };
      if (clean.length > 128) return { success: false, error: 'Word exceeds 128 characters' };

      const bridge = typeof window !== 'undefined' ? window.mawChatGpt : undefined;
      if (!bridge) {
        return { success: false, error: 'Custom dictionary changes require the desktop app' };
      }

      const initialLatest = getCurrentSettings();
      const initialWords = initialLatest.spellCheck?.customWordsByProfile?.[effective] ?? [];
      if (initialWords.includes(clean)) {
        return { success: false, error: 'Word already exists in dictionary' };
      }

      let res: { ok?: boolean; error?: string } | undefined;
      try {
        res = (await bridge.command({
          type: 'add-custom-dictionary-word',
          word: clean,
          profileId: effective,
        })) as { ok?: boolean; error?: string } | undefined;
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update custom dictionary' };
      }
      if (!res?.ok) {
        return { success: false, error: res?.error || 'Failed to update custom dictionary' };
      }

      const latest = getCurrentSettings();
      const currentSpellCheck = latest.spellCheck ?? createDefaultSpellCheck();
      const existingMap = currentSpellCheck.customWordsByProfile ?? {};
      const currentWords = existingMap[effective] ?? [];
      if (currentWords.includes(clean)) {
        return { success: true };
      }

      const nextWords = [...currentWords, clean];
      const nextMap: Record<string, string[]> = {};
      for (const pid of Object.keys({ ...existingMap, [effective]: nextWords }).sort()) {
        const list = pid === effective ? nextWords : existingMap[pid];
        if (list && list.length > 0) nextMap[pid] = list;
      }
      const nextSpellCheck: SpellCheckSettings = {
        ...currentSpellCheck,
        customWordsByProfile: nextMap,
      };
      lastReconciledDictKey = JSON.stringify(nextMap);
      persist({ ...latest, spellCheck: nextSpellCheck });
      return { success: true };
    },
    [persist],
  );

  const removeCustomDictionaryWord = useCallback(
    async (word: string, profileId: string = DEFAULT_BROWSER_PROFILE_ID) => {
      const effective = resolveProfile(profileId);
      if (!effective) return { success: false, error: 'Invalid browser profile' };
      if (/[\r\n\0]/.test(word)) return { success: false, error: 'Word contains invalid characters' };
      const clean = word.trim();
      if (!clean) return { success: false, error: 'Word cannot be empty' };

      const bridge = typeof window !== 'undefined' ? window.mawChatGpt : undefined;
      if (!bridge) {
        return { success: false, error: 'Custom dictionary changes require the desktop app' };
      }

      let res: { ok?: boolean; error?: string } | undefined;
      try {
        res = (await bridge.command({
          type: 'remove-custom-dictionary-word',
          word: clean,
          profileId: effective,
        })) as { ok?: boolean; error?: string } | undefined;
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to remove custom dictionary word' };
      }
      if (!res?.ok) {
        return { success: false, error: res?.error || 'Failed to remove custom dictionary word' };
      }

      const latest = getCurrentSettings();
      const currentSpellCheck = latest.spellCheck ?? createDefaultSpellCheck();
      const existingMap = currentSpellCheck.customWordsByProfile ?? {};
      const currentWords = existingMap[effective] ?? [];
      const nextWords = currentWords.filter((w) => w !== clean);
      const nextMap: Record<string, string[]> = {};
      for (const pid of Object.keys(existingMap).sort()) {
        const list = pid === effective ? nextWords : existingMap[pid];
        if (list && list.length > 0) nextMap[pid] = list;
      }
      const nextSpellCheck: SpellCheckSettings = {
        ...currentSpellCheck,
        customWordsByProfile: nextMap,
      };
      lastReconciledDictKey = JSON.stringify(nextMap);
      persist({ ...latest, spellCheck: nextSpellCheck });
      return { success: true };
    },
    [persist],
  );

  const clearProfileCustomDictionary = useCallback(
    (profileId: string) => {
      if (!profileId || profileId === DEFAULT_BROWSER_PROFILE_ID) return;
      const latest = getCurrentSettings();
      const currentSpellCheck = latest.spellCheck ?? createDefaultSpellCheck();
      const existingMap = currentSpellCheck.customWordsByProfile ?? {};
      if (!(profileId in existingMap)) return;
      const nextMap: Record<string, string[]> = {};
      for (const pid of Object.keys(existingMap).sort()) {
        if (pid !== profileId && existingMap[pid]?.length) {
          nextMap[pid] = existingMap[pid];
        }
      }
      lastReconciledDictKey = JSON.stringify(nextMap);
      persist({
        ...latest,
        spellCheck: {
          ...currentSpellCheck,
          customWordsByProfile: nextMap,
        },
      });
    },
    [persist],
  );

  const resetToDefaults = useCallback(() => {
    const next = createDefaultBrowserSettings();
    persist(next);
    syncAllDesktopSpellCheck(next.spellCheck);
  }, [persist]);

  const currentSearchEngines = settings.searchEngines ?? DEFAULT_SEARCH_ENGINES;

  return {
    favorites: settings.favorites,
    searchEngines: currentSearchEngines,
    defaultSearchEngine: settings.defaultSearchEngine,
    searchEngine: getSearchEngine(settings.defaultSearchEngine, currentSearchEngines),
    spellCheck,
    setSpellCheckEnabled,
    toggleSpellCheckLanguage,
    addSpellCheckLanguage,
    removeSpellCheckLanguage,
    getCustomDictionaryWords,
    addCustomDictionaryWord,
    removeCustomDictionaryWord,
    clearProfileCustomDictionary,
    addFavorite,
    editFavorite,
    removeFavorite,
    reorderFavorites,
    moveFavorite,
    setDefaultSearchEngine,
    addSearchEngine,
    editSearchEngine,
    removeSearchEngine,
    restoreBuiltinSearchEngines,
    resetFavoritesToDefaults,
    resetToDefaults,
  };
}

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_BROWSER_FAVORITES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_SEARCH_ENGINES,
  DEFAULT_SEARCH_ENGINE_ID,
  DEFAULT_SPELLCHECK_SETTINGS,
  getSearchEngine,
  isValidBrowserProfileId,
  validateBrowserFavoriteUrl,
  validateSearchEngine,
  type BrowserFavorite,
  type SearchEngine,
  type SearchEngineCandidate,
  type SearchEngineId,
  type SpellCheckSettings,
} from '@agent-workbench/shared';
import type { AppSettingsApi } from '../settings/useAppSettings.js';
import {
  createDefaultBrowserSettings,
  getBrowserSettingsStoreState,
  mutateAuthoritativeCustomDictionary,
  persistBrowserPreferencePatch,
  retryNativeDictionarySync,
  setActiveAppSettings,
  subscribeBrowserSettingsStore,
  syncAuthoritativeBrowserSettings,
  type DictionaryMutationResult,
  type NativeDictionarySyncState,
} from './browser-settings-store.js';

export { resetBrowserSettingsStoreForTests, BROWSER_SETTINGS_STORAGE_KEY } from './browser-settings-store.js';
export type { NativeDictionarySyncState, DictionaryMutationResult } from './browser-settings-store.js';

export interface UseBrowserSettingsResult {
  favorites: readonly BrowserFavorite[];
  searchEngines: readonly SearchEngine[];
  defaultSearchEngine: SearchEngineId;
  searchEngine: SearchEngine;
  spellCheck: SpellCheckSettings;
  nativeDictionarySync: NativeDictionarySyncState;
  retryNativeDictionarySync: () => Promise<{ ok: boolean; failedPartitions?: string[]; error?: string }>;
  setSpellCheckEnabled: (enabled: boolean) => void;
  toggleSpellCheckLanguage: (code: string) => void;
  addSpellCheckLanguage: (code: string) => void;
  removeSpellCheckLanguage: (code: string) => void;
  getCustomDictionaryWords: (profileId?: string) => string[];
  addCustomDictionaryWord: (word: string, profileId?: string) => Promise<DictionaryMutationResult>;
  removeCustomDictionaryWord: (word: string, profileId?: string) => Promise<DictionaryMutationResult>;
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

function createDefaultSpellCheck(): SpellCheckSettings {
  return {
    enabled: DEFAULT_SPELLCHECK_SETTINGS.enabled,
    languages: [...DEFAULT_SPELLCHECK_SETTINGS.languages],
    configuredLanguages: [...DEFAULT_SPELLCHECK_SETTINGS.configuredLanguages],
    customWordsByProfile: {},
  };
}

export function useBrowserSettings(appSettings?: AppSettingsApi): UseBrowserSettingsResult {
  const [snapshot, setSnapshot] = useState(() => getBrowserSettingsStoreState());
  const settings = snapshot.settings;

  useEffect(() => {
    setActiveAppSettings(appSettings);
  }, [appSettings]);

  useEffect(() => subscribeBrowserSettingsStore(setSnapshot, Boolean(appSettings?.status?.browser)), []);

  useEffect(() => {
    syncAuthoritativeBrowserSettings(appSettings?.status?.browser);
  }, [appSettings?.status?.browser]);

  const addFavorite = useCallback(
    (fav: { title: string; url: string }) => {
      const latest = getBrowserSettingsStoreState().settings;
      const title = fav.title.trim();
      if (!title || title.length > 120) {
        return { success: false, error: 'Name must be between 1 and 120 characters' };
      }
      const urlCheck = validateBrowserFavoriteUrl(fav.url);
      if (!urlCheck.valid || !urlCheck.normalizedUrl) {
        return { success: false, error: urlCheck.error ?? 'Invalid web URL' };
      }
      const normalizedUrl = urlCheck.normalizedUrl;
      if (latest.favorites.some((f) => f.url.toLowerCase() === normalizedUrl.toLowerCase())) {
        return { success: false, error: 'A favorite with this URL already exists' };
      }
      const id = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `fav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const nextFavorites = [...latest.favorites, { id, title, url: normalizedUrl }];
      persistBrowserPreferencePatch({ ...latest, favorites: nextFavorites }, { favorites: nextFavorites }, appSettings);
      return { success: true };
    },
    [appSettings],
  );

  const editFavorite = useCallback(
    (id: string, updates: { title?: string; url?: string }) => {
      const latest = getBrowserSettingsStoreState().settings;
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
        if (latest.favorites.some((f) => f.id !== id && f.url.toLowerCase() === normalized.toLowerCase())) {
          return { success: false, error: 'A favorite with this URL already exists' };
        }
        url = normalized;
      }

      const nextFavorites = [...latest.favorites];
      nextFavorites[index] = { id, title, url };
      persistBrowserPreferencePatch({ ...latest, favorites: nextFavorites }, { favorites: nextFavorites }, appSettings);
      return { success: true };
    },
    [appSettings],
  );

  const removeFavorite = useCallback(
    (id: string) => {
      const latest = getBrowserSettingsStoreState().settings;
      const nextFavorites = latest.favorites.filter((f) => f.id !== id);
      persistBrowserPreferencePatch({ ...latest, favorites: nextFavorites }, { favorites: nextFavorites }, appSettings);
    },
    [appSettings],
  );

  const reorderFavorites = useCallback(
    (ids: readonly string[]) => {
      const latest = getBrowserSettingsStoreState().settings;
      const map = new Map(latest.favorites.map((f) => [f.id, f]));
      const ordered: BrowserFavorite[] = [];
      for (const id of ids) {
        const f = map.get(id);
        if (f) ordered.push(f);
      }
      for (const f of latest.favorites) {
        if (!ids.includes(f.id)) ordered.push(f);
      }
      persistBrowserPreferencePatch({ ...latest, favorites: ordered }, { favorites: ordered }, appSettings);
    },
    [appSettings],
  );

  const moveFavorite = useCallback(
    (id: string, direction: 'up' | 'down') => {
      const latest = getBrowserSettingsStoreState().settings;
      const index = latest.favorites.findIndex((f) => f.id === id);
      if (index === -1) return;
      if (direction === 'up' && index === 0) return;
      if (direction === 'down' && index === latest.favorites.length - 1) return;

      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      const updated = [...latest.favorites];
      const item = updated[index]!;
      updated[index] = updated[targetIndex]!;
      updated[targetIndex] = item;
      persistBrowserPreferencePatch({ ...latest, favorites: updated }, { favorites: updated }, appSettings);
    },
    [appSettings],
  );

  const setDefaultSearchEngine = useCallback(
    (engineId: SearchEngineId) => {
      const latest = getBrowserSettingsStoreState().settings;
      const currentList = latest.searchEngines ?? DEFAULT_SEARCH_ENGINES;
      if (!currentList.some((e) => e.id === engineId) && !DEFAULT_SEARCH_ENGINES.some((d) => d.id === engineId)) return;
      persistBrowserPreferencePatch({ ...latest, defaultSearchEngine: engineId }, { defaultSearchEngine: engineId }, appSettings);
    },
    [appSettings],
  );

  const addSearchEngine = useCallback(
    (candidate: { name: string; homeUrl: string; searchUrl: string }) => {
      const latest = getBrowserSettingsStoreState().settings;
      const currentList = latest.searchEngines ?? DEFAULT_SEARCH_ENGINES;
      const validated = validateSearchEngine(candidate, currentList);
      if (!validated.valid || !validated.normalized) {
        return { success: false, error: validated.error ?? 'Invalid search engine' };
      }
      const nextEngines = [...currentList, validated.normalized];
      persistBrowserPreferencePatch({ ...latest, searchEngines: nextEngines }, { searchEngines: nextEngines }, appSettings);
      return { success: true };
    },
    [appSettings],
  );

  const editSearchEngine = useCallback(
    (id: string, updates: { name: string; homeUrl: string; searchUrl: string }) => {
      const latest = getBrowserSettingsStoreState().settings;
      const currentList = latest.searchEngines ?? DEFAULT_SEARCH_ENGINES;
      const index = currentList.findIndex((e) => e.id === id);
      if (index === -1) return { success: false, error: 'Search engine not found' };
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
      const nextEngines = [...currentList];
      nextEngines[index] = { ...validated.normalized, isBuiltin: existing.isBuiltin };
      persistBrowserPreferencePatch({ ...latest, searchEngines: nextEngines }, { searchEngines: nextEngines }, appSettings);
      return { success: true };
    },
    [appSettings],
  );

  const removeSearchEngine = useCallback(
    (id: string) => {
      const latest = getBrowserSettingsStoreState().settings;
      const currentList = latest.searchEngines ?? DEFAULT_SEARCH_ENGINES;
      if (!currentList.some((e) => e.id === id)) {
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
      persistBrowserPreferencePatch(
        { ...latest, defaultSearchEngine: nextDefault, searchEngines: filtered },
        { defaultSearchEngine: nextDefault, searchEngines: filtered },
        appSettings,
      );
      return { success: true };
    },
    [appSettings],
  );

  const restoreBuiltinSearchEngines = useCallback(() => {
    const latest = getBrowserSettingsStoreState().settings;
    const currentList = latest.searchEngines ?? DEFAULT_SEARCH_ENGINES;
    const customEngines = currentList.filter(
      (e) => !e.isBuiltin && !DEFAULT_SEARCH_ENGINES.some((d) => d.id === e.id),
    );
    const restored = [...DEFAULT_SEARCH_ENGINES, ...customEngines];
    const nextDefault = restored.some((e) => e.id === latest.defaultSearchEngine)
      ? latest.defaultSearchEngine
      : DEFAULT_SEARCH_ENGINE_ID;
    persistBrowserPreferencePatch(
      { ...latest, defaultSearchEngine: nextDefault, searchEngines: restored },
      { defaultSearchEngine: nextDefault, searchEngines: restored },
      appSettings,
    );
  }, [appSettings]);

  const resetFavoritesToDefaults = useCallback(() => {
    const latest = getBrowserSettingsStoreState().settings;
    const nextFavorites = [...DEFAULT_BROWSER_FAVORITES];
    persistBrowserPreferencePatch({ ...latest, favorites: nextFavorites }, { favorites: nextFavorites }, appSettings);
  }, [appSettings]);

  const spellCheck = settings.spellCheck ?? createDefaultSpellCheck();

  const setSpellCheckEnabled = useCallback(
    (enabled: boolean) => {
      const latest = getBrowserSettingsStoreState().settings;
      const currentSpellCheck = latest.spellCheck ?? createDefaultSpellCheck();
      const nextSpellCheck: SpellCheckSettings = { ...currentSpellCheck, enabled };
      persistBrowserPreferencePatch(
        { ...latest, spellCheck: nextSpellCheck },
        { spellCheck: { enabled } },
        appSettings,
      );
    },
    [appSettings],
  );

  const toggleSpellCheckLanguage = useCallback(
    (code: string) => {
      const latest = getBrowserSettingsStoreState().settings;
      const currentSpellCheck = latest.spellCheck ?? createDefaultSpellCheck();
      const configured = Array.isArray(currentSpellCheck.configuredLanguages)
        ? currentSpellCheck.configuredLanguages
        : currentSpellCheck.languages;
      if (!configured.includes(code)) return;
      const currentLanguages = currentSpellCheck.languages || [];
      const nextLanguages = currentLanguages.includes(code)
        ? currentLanguages.filter((c) => c !== code)
        : [...currentLanguages, code];
      const nextSpellCheck: SpellCheckSettings = { ...currentSpellCheck, languages: nextLanguages };
      persistBrowserPreferencePatch(
        { ...latest, spellCheck: nextSpellCheck },
        { spellCheck: { languages: nextLanguages } },
        appSettings,
      );
    },
    [appSettings],
  );

  const addSpellCheckLanguage = useCallback(
    (code: string) => {
      const latest = getBrowserSettingsStoreState().settings;
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
      persistBrowserPreferencePatch(
        { ...latest, spellCheck: nextSpellCheck },
        { spellCheck: { configuredLanguages: nextConfigured, languages: nextLanguages } },
        appSettings,
      );
    },
    [appSettings],
  );

  const removeSpellCheckLanguage = useCallback(
    (code: string) => {
      const latest = getBrowserSettingsStoreState().settings;
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
      persistBrowserPreferencePatch(
        { ...latest, spellCheck: nextSpellCheck },
        { spellCheck: { configuredLanguages: nextConfigured, languages: nextLanguages } },
        appSettings,
      );
    },
    [appSettings],
  );

  const getCustomDictionaryWords = useCallback(
    (profileId: string = DEFAULT_BROWSER_PROFILE_ID): string[] => {
      if (!isValidBrowserProfileId(profileId)) return [];
      return spellCheck.customWordsByProfile?.[profileId] ?? [];
    },
    [spellCheck],
  );

  const addCustomDictionaryWord = useCallback(
    (word: string, profileId: string = DEFAULT_BROWSER_PROFILE_ID) =>
      mutateAuthoritativeCustomDictionary('add', word, profileId, appSettings),
    [appSettings],
  );

  const removeCustomDictionaryWord = useCallback(
    (word: string, profileId: string = DEFAULT_BROWSER_PROFILE_ID) =>
      mutateAuthoritativeCustomDictionary('remove', word, profileId, appSettings),
    [appSettings],
  );

  const resetToDefaults = useCallback(() => {
    const next = createDefaultBrowserSettings();
    persistBrowserPreferencePatch(next, next, appSettings);
  }, [appSettings]);

  const currentSearchEngines = settings.searchEngines ?? DEFAULT_SEARCH_ENGINES;

  return {
    favorites: settings.favorites,
    searchEngines: currentSearchEngines,
    defaultSearchEngine: settings.defaultSearchEngine,
    searchEngine: getSearchEngine(settings.defaultSearchEngine, currentSearchEngines),
    spellCheck,
    nativeDictionarySync: snapshot.nativeDictionarySync,
    retryNativeDictionarySync,
    setSpellCheckEnabled,
    toggleSpellCheckLanguage,
    addSpellCheckLanguage,
    removeSpellCheckLanguage,
    getCustomDictionaryWords,
    addCustomDictionaryWord,
    removeCustomDictionaryWord,
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

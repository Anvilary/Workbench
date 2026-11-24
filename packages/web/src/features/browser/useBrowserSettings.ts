/**
 * Browser settings state hook.
 *
 * Manages user-configurable favorites, search engines, and default search engine.
 * Provides dual persistence:
 * - Instant local storage cache (resilient against network delays, tab refresh, offline mode)
 * - Server-side settings synchronization (survives desktop restart, workspace switches, multi-window)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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

function broadcastBrowserSettings(next: BrowserSettings): void {
  for (const listener of browserSettingsListeners) {
    listener(next);
  }
}

function createDefaultBrowserSettings(): BrowserSettings {
  return {
    defaultSearchEngine: DEFAULT_SEARCH_ENGINE_ID,
    favorites: [...DEFAULT_BROWSER_FAVORITES],
    searchEngines: [...DEFAULT_SEARCH_ENGINES],
    spellCheck: {
      enabled: DEFAULT_SPELLCHECK_SETTINGS.enabled,
      languages: [...DEFAULT_SPELLCHECK_SETTINGS.languages],
      configuredLanguages: [...DEFAULT_SPELLCHECK_SETTINGS.configuredLanguages],
      customWordsByProfile: {},
    },
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

function saveCachedBrowserSettings(settings: BrowserSettings): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota or disabled errors
  }
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
  syncProfileCustomDictionary: (profileId?: string) => Promise<string[]>;
  addCustomDictionaryWord: (word: string, profileId?: string) => Promise<{ success: boolean; error?: string }>;
  removeCustomDictionaryWord: (word: string, profileId?: string) => Promise<{ success: boolean }>;
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
  const [settings, setSettings] = useState<BrowserSettings>(loadCachedBrowserSettings);

  useEffect(() => {
    const listener: BrowserSettingsListener = (next) => {
      setSettings(next);
    };
    browserSettingsListeners.add(listener);
    return () => {
      browserSettingsListeners.delete(listener);
    };
  }, []);

  // Synchronize when server status arrives or updates
  const lastServerSyncRef = useRef<string>('');
  useEffect(() => {
    const serverBrowser = appSettings?.status?.browser;
    if (serverBrowser) {
      const serialized = JSON.stringify(serverBrowser);
      if (lastServerSyncRef.current !== serialized) {
        lastServerSyncRef.current = serialized;
        setSettings(serverBrowser);
        saveCachedBrowserSettings(serverBrowser);
        broadcastBrowserSettings(serverBrowser);
      }
    }
  }, [appSettings?.status?.browser]);

  const persist = useCallback(
    (next: BrowserSettings) => {
      lastServerSyncRef.current = JSON.stringify(next);
      setSettings(next);
      saveCachedBrowserSettings(next);
      broadcastBrowserSettings(next);
      if (appSettings) {
        appSettings.setBrowserSettings(next);
      }
    },
    [appSettings],
  );

  const addFavorite = useCallback(
    (fav: { title: string; url: string }) => {
      const title = fav.title.trim();
      if (!title || title.length > 120) {
        return { success: false, error: 'Name must be between 1 and 120 characters' };
      }
      const urlCheck = validateBrowserFavoriteUrl(fav.url);
      if (!urlCheck.valid || !urlCheck.normalizedUrl) {
        return { success: false, error: urlCheck.error ?? 'Invalid web URL' };
      }
      const normalizedUrl = urlCheck.normalizedUrl;

      // Check duplicates
      const isDuplicate = settings.favorites.some(
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
        ...settings,
        favorites: [...settings.favorites, newFav],
      };
      persist(next);
      return { success: true };
    },
    [settings, persist],
  );

  const editFavorite = useCallback(
    (id: string, updates: { title?: string; url?: string }) => {
      const index = settings.favorites.findIndex((f) => f.id === id);
      if (index === -1) return { success: false, error: 'Favorite not found' };

      const existing = settings.favorites[index]!;
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
        const duplicate = settings.favorites.some(
          (f) => f.id !== id && f.url.toLowerCase() === normalized.toLowerCase(),
        );
        if (duplicate) {
          return { success: false, error: 'A favorite with this URL already exists' };
        }
        url = normalized;
      }

      const updatedList = [...settings.favorites];
      updatedList[index] = { id, title, url };
      const next: BrowserSettings = {
        ...settings,
        favorites: updatedList,
      };
      persist(next);
      return { success: true };
    },
    [settings, persist],
  );

  const removeFavorite = useCallback(
    (id: string) => {
      const next: BrowserSettings = {
        ...settings,
        favorites: settings.favorites.filter((f) => f.id !== id),
      };
      persist(next);
    },
    [settings, persist],
  );

  const reorderFavorites = useCallback(
    (ids: readonly string[]) => {
      const map = new Map(settings.favorites.map((f) => [f.id, f]));
      const ordered: BrowserFavorite[] = [];
      for (const id of ids) {
        const f = map.get(id);
        if (f) ordered.push(f);
      }
      for (const f of settings.favorites) {
        if (!ids.includes(f.id)) ordered.push(f);
      }
      const next: BrowserSettings = {
        ...settings,
        favorites: ordered,
      };
      persist(next);
    },
    [settings, persist],
  );

  const moveFavorite = useCallback(
    (id: string, direction: 'up' | 'down') => {
      const index = settings.favorites.findIndex((f) => f.id === id);
      if (index === -1) return;
      if (direction === 'up' && index === 0) return;
      if (direction === 'down' && index === settings.favorites.length - 1) return;

      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      const updated = [...settings.favorites];
      const item = updated[index]!;
      updated[index] = updated[targetIndex]!;
      updated[targetIndex] = item;

      const next: BrowserSettings = {
        ...settings,
        favorites: updated,
      };
      persist(next);
    },
    [settings, persist],
  );

  const setDefaultSearchEngine = useCallback(
    (engineId: SearchEngineId) => {
      const currentList = settings.searchEngines ?? DEFAULT_SEARCH_ENGINES;
      const exists = currentList.some((e) => e.id === engineId);
      if (!exists && !DEFAULT_SEARCH_ENGINES.some((d) => d.id === engineId)) return;
      const next: BrowserSettings = {
        ...settings,
        defaultSearchEngine: engineId,
      };
      persist(next);
    },
    [settings, persist],
  );

  const addSearchEngine = useCallback(
    (candidate: { name: string; homeUrl: string; searchUrl: string }) => {
      const currentList = settings.searchEngines ?? DEFAULT_SEARCH_ENGINES;
      const validated = validateSearchEngine(candidate, currentList);
      if (!validated.valid || !validated.normalized) {
        return { success: false, error: validated.error ?? 'Invalid search engine' };
      }
      const next: BrowserSettings = {
        ...settings,
        searchEngines: [...currentList, validated.normalized],
      };
      persist(next);
      return { success: true };
    },
    [settings, persist],
  );

  const editSearchEngine = useCallback(
    (id: string, updates: { name: string; homeUrl: string; searchUrl: string }) => {
      const currentList = settings.searchEngines ?? DEFAULT_SEARCH_ENGINES;
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
        ...settings,
        searchEngines: updatedList,
      };
      persist(next);
      return { success: true };
    },
    [settings, persist],
  );

  const removeSearchEngine = useCallback(
    (id: string) => {
      const currentList = settings.searchEngines ?? DEFAULT_SEARCH_ENGINES;
      const existing = currentList.find((e) => e.id === id);
      if (!existing) {
        return { success: false, error: 'Search engine not found' };
      }
      if (currentList.length <= 1) {
        return { success: false, error: 'At least one search engine must remain configured' };
      }
      const filtered = currentList.filter((e) => e.id !== id);
      let nextDefault = settings.defaultSearchEngine;
      if (settings.defaultSearchEngine === id || !filtered.some((e) => e.id === nextDefault)) {
        nextDefault = filtered[0]?.id ?? DEFAULT_SEARCH_ENGINE_ID;
      }
      const next: BrowserSettings = {
        ...settings,
        defaultSearchEngine: nextDefault,
        searchEngines: filtered,
      };
      persist(next);
      return { success: true };
    },
    [settings, persist],
  );

  const restoreBuiltinSearchEngines = useCallback(() => {
    const currentList = settings.searchEngines ?? DEFAULT_SEARCH_ENGINES;
    const customEngines = currentList.filter(
      (e) => !e.isBuiltin && !DEFAULT_SEARCH_ENGINES.some((d) => d.id === e.id),
    );
    const restored = [...DEFAULT_SEARCH_ENGINES, ...customEngines];
    const defaultExists = restored.some((e) => e.id === settings.defaultSearchEngine);
    const next: BrowserSettings = {
      ...settings,
      defaultSearchEngine: defaultExists ? settings.defaultSearchEngine : DEFAULT_SEARCH_ENGINE_ID,
      searchEngines: restored,
    };
    persist(next);
  }, [settings, persist]);

  const resetFavoritesToDefaults = useCallback(() => {
    const next: BrowserSettings = {
      ...settings,
      favorites: [...DEFAULT_BROWSER_FAVORITES],
    };
    persist(next);
  }, [settings, persist]);

  const spellCheck = settings.spellCheck ?? {
    enabled: DEFAULT_SPELLCHECK_SETTINGS.enabled,
    languages: [...DEFAULT_SPELLCHECK_SETTINGS.languages],
    configuredLanguages: [...DEFAULT_SPELLCHECK_SETTINGS.configuredLanguages],
    customWordsByProfile: {},
  };

  const lastSyncedSpellCheckRef = useRef<string>('');

  const syncSpellCheckToDesktop = useCallback((sc: SpellCheckSettings) => {
    const key = JSON.stringify({ enabled: sc.enabled, languages: sc.languages });
    if (lastSyncedSpellCheckRef.current === key) return;
    lastSyncedSpellCheckRef.current = key;
    void window.mawChatGpt?.command({
      type: 'update-spellcheck-settings',
      enabled: sc.enabled,
      languages: sc.languages,
    });
  }, []);

  useEffect(() => {
    if (settings.spellCheck) {
      syncSpellCheckToDesktop(settings.spellCheck);
    }
  }, [settings.spellCheck, syncSpellCheckToDesktop]);

  const setSpellCheckEnabled = useCallback(
    (enabled: boolean) => {
      const nextSpellCheck: SpellCheckSettings = {
        ...spellCheck,
        enabled,
      };
      const next: BrowserSettings = {
        ...settings,
        spellCheck: nextSpellCheck,
      };
      persist(next);
      syncSpellCheckToDesktop(nextSpellCheck);
    },
    [settings, spellCheck, persist, syncSpellCheckToDesktop],
  );

  const toggleSpellCheckLanguage = useCallback(
    (code: string) => {
      const currentLanguages = spellCheck.languages || [];
      const isEnabled = currentLanguages.includes(code);
      const nextLanguages = isEnabled
        ? currentLanguages.filter((c) => c !== code)
        : [...currentLanguages, code];
      const nextSpellCheck: SpellCheckSettings = {
        ...spellCheck,
        languages: nextLanguages,
      };
      const next: BrowserSettings = {
        ...settings,
        spellCheck: nextSpellCheck,
      };
      persist(next);
      syncSpellCheckToDesktop(nextSpellCheck);
    },
    [settings, spellCheck, persist, syncSpellCheckToDesktop],
  );

  const addSpellCheckLanguage = useCallback(
    (code: string) => {
      const configured = spellCheck.configuredLanguages || spellCheck.languages || [];
      if (configured.includes(code)) return;
      const nextConfigured = [...configured, code];
      const nextLanguages = [...(spellCheck.languages || []), code];
      const nextSpellCheck: SpellCheckSettings = {
        ...spellCheck,
        configuredLanguages: nextConfigured,
        languages: nextLanguages,
      };
      const next: BrowserSettings = {
        ...settings,
        spellCheck: nextSpellCheck,
      };
      persist(next);
      syncSpellCheckToDesktop(nextSpellCheck);
    },
    [settings, spellCheck, persist, syncSpellCheckToDesktop],
  );

  const removeSpellCheckLanguage = useCallback(
    (code: string) => {
      const configured = spellCheck.configuredLanguages || spellCheck.languages || [];
      const nextConfigured = configured.filter((c) => c !== code);
      const nextLanguages = (spellCheck.languages || []).filter((c) => c !== code);
      const nextSpellCheck: SpellCheckSettings = {
        ...spellCheck,
        configuredLanguages: nextConfigured,
        languages: nextLanguages,
      };
      const next: BrowserSettings = {
        ...settings,
        spellCheck: nextSpellCheck,
      };
      persist(next);
      syncSpellCheckToDesktop(nextSpellCheck);
    },
    [settings, spellCheck, persist, syncSpellCheckToDesktop],
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

  const syncProfileCustomDictionary = useCallback(
    async (profileId: string = DEFAULT_BROWSER_PROFILE_ID): Promise<string[]> => {
      const effective = resolveProfile(profileId);
      if (!effective) return [];
      try {
        const res = (await window.mawChatGpt?.command({
          type: 'list-custom-dictionary-words',
          profileId: effective,
        })) as { ok?: boolean; words?: string[] } | undefined;
        if (res?.ok && Array.isArray(res.words)) {
          const cleanWords = [...new Set(res.words.map((w) => (typeof w === 'string' ? w.trim() : '')).filter(Boolean))];
          const existingMap = spellCheck.customWordsByProfile ?? {};
          const mergedMap: Record<string, string[]> = { ...existingMap };
          if (cleanWords.length > 0) {
            mergedMap[effective] = cleanWords;
          } else {
            delete mergedMap[effective];
          }
          const prevWords = existingMap[effective] ?? [];
          if (JSON.stringify(prevWords) !== JSON.stringify(cleanWords)) {
            const nextSpellCheck: SpellCheckSettings = {
              ...spellCheck,
              customWordsByProfile: mergedMap,
            };
            persist({ ...settings, spellCheck: nextSpellCheck });
          }
          return cleanWords;
        }
      } catch {
        // Ignore bridge unavailability
      }
      return spellCheck.customWordsByProfile?.[effective] ?? [];
    },
    [settings, spellCheck, persist],
  );

  const addCustomDictionaryWord = useCallback(
    async (word: string, profileId: string = DEFAULT_BROWSER_PROFILE_ID) => {
      const effective = resolveProfile(profileId);
      if (!effective) return { success: false, error: 'Invalid browser profile' };
      if (/[\r\n\0]/.test(word)) return { success: false, error: 'Word contains invalid characters' };
      const clean = word.trim();
      if (!clean) return { success: false, error: 'Word cannot be empty' };
      if (clean.length > 128) return { success: false, error: 'Word exceeds 128 characters' };
      const existingMap = spellCheck.customWordsByProfile ?? {};
      const currentWords = existingMap[effective] ?? [];
      if (currentWords.includes(clean)) return { success: false, error: 'Word already exists in dictionary' };

      const nextWords = [...currentWords, clean];
      const nextMap: Record<string, string[]> = {
        ...existingMap,
        [effective]: nextWords,
      };
      const nextSpellCheck: SpellCheckSettings = {
        ...spellCheck,
        customWordsByProfile: nextMap,
      };
      const next: BrowserSettings = {
        ...settings,
        spellCheck: nextSpellCheck,
      };
      persist(next);
      void window.mawChatGpt?.command({
        type: 'add-custom-dictionary-word',
        word: clean,
        profileId: effective,
      });
      return { success: true };
    },
    [settings, spellCheck, persist],
  );

  const removeCustomDictionaryWord = useCallback(
    async (word: string, profileId: string = DEFAULT_BROWSER_PROFILE_ID) => {
      const effective = resolveProfile(profileId);
      if (!effective) return { success: false };
      const clean = word.trim();
      const existingMap = spellCheck.customWordsByProfile ?? {};
      const currentWords = existingMap[effective] ?? [];
      const nextWords = currentWords.filter((w) => w !== clean);
      const nextMap: Record<string, string[]> = { ...existingMap };
      if (nextWords.length > 0) {
        nextMap[effective] = nextWords;
      } else {
        delete nextMap[effective];
      }
      const nextSpellCheck: SpellCheckSettings = {
        ...spellCheck,
        customWordsByProfile: nextMap,
      };
      const next: BrowserSettings = {
        ...settings,
        spellCheck: nextSpellCheck,
      };
      persist(next);
      void window.mawChatGpt?.command({
        type: 'remove-custom-dictionary-word',
        word: clean,
        profileId: effective,
      });
      return { success: true };
    },
    [settings, spellCheck, persist],
  );

  const clearProfileCustomDictionary = useCallback(
    (profileId: string) => {
      if (!profileId || profileId === DEFAULT_BROWSER_PROFILE_ID) return;
      const existingMap = spellCheck.customWordsByProfile ?? {};
      if (!(profileId in existingMap)) return;
      const nextMap: Record<string, string[]> = { ...existingMap };
      delete nextMap[profileId];
      persist({
        ...settings,
        spellCheck: {
          ...spellCheck,
          customWordsByProfile: nextMap,
        },
      });
    },
    [settings, spellCheck, persist],
  );

  const resetToDefaults = useCallback(() => {
    const next = createDefaultBrowserSettings();
    persist(next);
    syncSpellCheckToDesktop(next.spellCheck!);
  }, [persist, syncSpellCheckToDesktop]);

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
    syncProfileCustomDictionary,
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

/**
 * Browser settings state hook.
 *
 * Manages user-configurable favorites, search engines, and default search engine.
 * Provides dual persistence:
 * - Instant local storage cache (resilient against network delays, tab refresh, offline mode)
 * - Server-side settings synchronization (survives desktop restart, workspace switches, multi-window)
 */

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_BROWSER_FAVORITES,
  DEFAULT_SEARCH_ENGINES,
  DEFAULT_SEARCH_ENGINE_ID,
  getSearchEngine,
  parseBrowserSettings,
  validateBrowserFavoriteUrl,
  validateSearchEngine,
  type BrowserFavorite,
  type BrowserSettings,
  type SearchEngine,
  type SearchEngineCandidate,
  type SearchEngineId,
} from '@agent-workbench/shared';
import type { AppSettingsApi } from '../useAppSettings.js';

export const BROWSER_SETTINGS_STORAGE_KEY = 'agency-ui.browser-settings.v1';

function loadCachedBrowserSettings(): BrowserSettings {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {
      defaultSearchEngine: DEFAULT_SEARCH_ENGINE_ID,
      favorites: [...DEFAULT_BROWSER_FAVORITES],
      searchEngines: [...DEFAULT_SEARCH_ENGINES],
    };
  }
  try {
    const raw = window.localStorage.getItem(BROWSER_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {
        defaultSearchEngine: DEFAULT_SEARCH_ENGINE_ID,
        favorites: [...DEFAULT_BROWSER_FAVORITES],
        searchEngines: [...DEFAULT_SEARCH_ENGINES],
      };
    }
    const parsed = parseBrowserSettings(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {
    // Malformed cache falls back cleanly
  }
  return {
    defaultSearchEngine: DEFAULT_SEARCH_ENGINE_ID,
    favorites: [...DEFAULT_BROWSER_FAVORITES],
    searchEngines: [...DEFAULT_SEARCH_ENGINES],
  };
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
  resetToDefaults: () => void;
}

export function useBrowserSettings(appSettings?: AppSettingsApi): UseBrowserSettingsResult {
  const [settings, setSettings] = useState<BrowserSettings>(loadCachedBrowserSettings);

  // Synchronize when server status arrives or updates
  useEffect(() => {
    const serverBrowser = appSettings?.status?.browser;
    if (serverBrowser) {
      setSettings(serverBrowser);
      saveCachedBrowserSettings(serverBrowser);
    }
  }, [appSettings?.status?.browser]);

  const persist = useCallback(
    (next: BrowserSettings) => {
      setSettings(next);
      saveCachedBrowserSettings(next);
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
      if (existing.isBuiltin || DEFAULT_SEARCH_ENGINES.some((d) => d.id === id)) {
        return { success: false, error: 'Built-in search engines cannot be removed' };
      }
      const filtered = currentList.filter((e) => e.id !== id);
      let nextDefault = settings.defaultSearchEngine;
      if (settings.defaultSearchEngine === id) {
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

  const resetToDefaults = useCallback(() => {
    const next: BrowserSettings = {
      defaultSearchEngine: DEFAULT_SEARCH_ENGINE_ID,
      favorites: [...DEFAULT_BROWSER_FAVORITES],
      searchEngines: [...DEFAULT_SEARCH_ENGINES],
    };
    persist(next);
  }, [persist]);

  const currentSearchEngines = settings.searchEngines ?? DEFAULT_SEARCH_ENGINES;

  return {
    favorites: settings.favorites,
    searchEngines: currentSearchEngines,
    defaultSearchEngine: settings.defaultSearchEngine,
    searchEngine: getSearchEngine(settings.defaultSearchEngine, currentSearchEngines),
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
    resetToDefaults,
  };
}

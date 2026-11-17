/**
 * Browser Favorites and Search Engine Settings.
 *
 * Defines user-configurable browser favorites and default search engines
 * separate from privileged Electron session security providers.
 */

import {
  validateChatGptUrl,
  validateGithubUrl,
  validatePerplexityUrl,
  validateOtherWebUrl,
  validateWebTabTitle,
  isLoopbackHost,
  type WebTabProvider,
} from './browser-tabs.js';
import { asArrayFiltered, asLiteral, asNonEmptyString, asRecord } from './validation.js';

export type SearchEngineId = 'duckduckgo' | 'google' | 'brave' | 'bing' | 'ecosia';

export const SEARCH_ENGINE_IDS: readonly SearchEngineId[] = [
  'duckduckgo',
  'google',
  'brave',
  'bing',
  'ecosia',
] as const;

export interface SearchEngine {
  id: SearchEngineId;
  name: string;
  homeUrl: string;
  searchUrl: string;
}

export const SEARCH_ENGINES: readonly SearchEngine[] = [
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    homeUrl: 'https://duckduckgo.com/',
    searchUrl: 'https://duckduckgo.com/?q=',
  },
  {
    id: 'google',
    name: 'Google',
    homeUrl: 'https://www.google.com/',
    searchUrl: 'https://www.google.com/search?q=',
  },
  {
    id: 'brave',
    name: 'Brave',
    homeUrl: 'https://search.brave.com/',
    searchUrl: 'https://search.brave.com/search?q=',
  },
  {
    id: 'bing',
    name: 'Bing',
    homeUrl: 'https://www.bing.com/',
    searchUrl: 'https://www.bing.com/search?q=',
  },
  {
    id: 'ecosia',
    name: 'Ecosia',
    homeUrl: 'https://www.ecosia.org/',
    searchUrl: 'https://www.ecosia.org/search?q=',
  },
] as const;

export const DEFAULT_SEARCH_ENGINE_ID: SearchEngineId = 'duckduckgo';

export function getSearchEngine(id?: unknown): SearchEngine {
  const match = SEARCH_ENGINES.find((e) => e.id === id);
  return match ?? SEARCH_ENGINES[0]!;
}

export interface BrowserFavorite {
  id: string;
  title: string;
  url: string;
}

export const DEFAULT_BROWSER_FAVORITES: readonly BrowserFavorite[] = [
  { id: 'chatgpt', title: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'perplexity', title: 'Perplexity', url: 'https://www.perplexity.ai/' },
  { id: 'github', title: 'GitHub', url: 'https://github.com/' },
] as const;

export interface BrowserSettings {
  favorites: BrowserFavorite[];
  defaultSearchEngine: SearchEngineId;
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  favorites: [...DEFAULT_BROWSER_FAVORITES],
  defaultSearchEngine: DEFAULT_SEARCH_ENGINE_ID,
};

/**
 * Validates and normalizes a candidate favorite URL.
 * Automatically handles protocol prefixes if omitted.
 */
export function validateBrowserFavoriteUrl(rawUrl: string): { valid: boolean; normalizedUrl?: string; error?: string } {
  if (typeof rawUrl !== 'string') return { valid: false, error: 'URL must be a string' };
  let trimmed = rawUrl.trim();
  if (trimmed.length === 0) return { valid: false, error: 'URL cannot be empty' };
  if (trimmed.length > 2048) return { valid: false, error: 'URL exceeds maximum length of 2048 characters' };
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { valid: false, error: 'URL contains control characters' };

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    const candidateHost = trimmed.split('/')[0] ?? '';
    if (isLoopbackHost(candidateHost)) {
      trimmed = 'http://' + trimmed;
    } else {
      trimmed = 'https://' + trimmed;
    }
  }

  // Check ChatGPT
  const chat = validateChatGptUrl(trimmed);
  if (chat.valid) return chat;

  // Check Perplexity
  const perp = validatePerplexityUrl(trimmed);
  if (perp.valid) return perp;

  // Check GitHub
  const git = validateGithubUrl(trimmed);
  if (git.valid) return git;

  // Check Other public/loopback web URL
  const other = validateOtherWebUrl(trimmed);
  if (other.valid) return other;

  return { valid: false, error: other.error ?? 'Please enter a valid HTTP or HTTPS web URL' };
}

/**
 * Resolves address bar input into either a direct URL or a search query URL.
 *
 * Direct URLs are validated against existing web navigation policies.
 * Free-text searches are safely URL-encoded into the default search engine's query template.
 */
export function resolveAddressBarInput(
  rawInput: string,
  searchEngine: SearchEngine,
  provider?: WebTabProvider,
): { url: string; isSearch: boolean; error?: string } {
  if (typeof rawInput !== 'string') return { url: '', isSearch: false, error: 'Invalid address bar input' };
  const trimmed = rawInput.trim();
  if (!trimmed) return { url: '', isSearch: false, error: 'Address cannot be empty' };

  if (provider !== 'other' && provider !== undefined) {
    // Restricted provider tabs must remain within their specific domain
    if (provider === 'chatgpt') {
      const v = validateChatGptUrl(trimmed);
      return v.valid ? { url: v.normalizedUrl!, isSearch: false } : { url: '', isSearch: false, error: v.error };
    }
    if (provider === 'perplexity') {
      const v = validatePerplexityUrl(trimmed);
      return v.valid ? { url: v.normalizedUrl!, isSearch: false } : { url: '', isSearch: false, error: v.error };
    }
    if (provider === 'github') {
      const v = validateGithubUrl(trimmed);
      return v.valid ? { url: v.normalizedUrl!, isSearch: false } : { url: '', isSearch: false, error: v.error };
    }
  }

  // For 'other' (or general browser) tabs:
  // If input contains spaces or whitespace, treat it directly as search query
  if (/\s/.test(trimmed)) {
    return {
      url: `${searchEngine.searchUrl}${encodeURIComponent(trimmed)}`,
      isSearch: true,
    };
  }

  // Check if it already has http:// or https:// scheme
  if (/^https?:\/\//i.test(trimmed)) {
    const directCheck = validateOtherWebUrl(trimmed);
    if (directCheck.valid) {
      return { url: directCheck.normalizedUrl!, isSearch: false };
    }
    return { url: '', isSearch: false, error: directCheck.error };
  }

  // Other explicit schemes (e.g. javascript:, file:, data:) are rejected
  // Note: Avoid mistaking hostname:port (e.g. localhost:3000) for a URI scheme.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/i.test(trimmed)) {
    return { url: '', isSearch: false, error: 'Protocol is not allowed. Only HTTP and HTTPS are permitted.' };
  }

  // Candidate without scheme: check if it looks like a domain or loopback host
  const firstSegment = trimmed.split('/')[0] ?? '';
  const hasDot = firstSegment.includes('.');
  const isLoop = isLoopbackHost(firstSegment);

  if (hasDot || isLoop) {
    const candidateWithScheme = (isLoop ? 'http://' : 'https://') + trimmed;
    const directCheck = validateOtherWebUrl(candidateWithScheme);
    if (directCheck.valid) {
      return { url: directCheck.normalizedUrl!, isSearch: false };
    }
  }

  // Fallback to free-text search for single words or unresolvable domain strings
  return {
    url: `${searchEngine.searchUrl}${encodeURIComponent(trimmed)}`,
    isSearch: true,
  };
}

export function parseBrowserFavorite(value: unknown): BrowserFavorite | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asNonEmptyString(record['id']);
  const title = asNonEmptyString(record['title']);
  const rawUrl = asNonEmptyString(record['url']);
  if (!id || !title || !rawUrl) return null;
  if (!validateWebTabTitle(title)) return null;
  const validated = validateBrowserFavoriteUrl(rawUrl);
  if (!validated.valid || !validated.normalizedUrl) return null;
  return {
    id,
    title: title.trim(),
    url: validated.normalizedUrl,
  };
}

export function parseBrowserSettings(value: unknown): BrowserSettings | null {
  const record = asRecord(value);
  if (!record) return null;

  const rawEngine = record['defaultSearchEngine'];
  const defaultSearchEngine: SearchEngineId =
    asLiteral(rawEngine, SEARCH_ENGINE_IDS) ?? DEFAULT_SEARCH_ENGINE_ID;

  const rawFavorites = record['favorites'];
  let favorites: BrowserFavorite[];
  if (Array.isArray(rawFavorites)) {
    const parsed = asArrayFiltered(rawFavorites, parseBrowserFavorite);
    favorites = parsed !== null ? parsed : [...DEFAULT_BROWSER_FAVORITES];
  } else {
    favorites = [...DEFAULT_BROWSER_FAVORITES];
  }

  return {
    defaultSearchEngine,
    favorites,
  };
}

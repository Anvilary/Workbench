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
  isLocalOrPrivateHost,
  type WebTabProvider,
} from './browser-tabs.js';
import { DEFAULT_BROWSER_PROFILE_ID, isValidBrowserProfileId } from './browser-profiles.js';
import { asArrayFiltered, asNonEmptyString, asRecord } from '../validation/narrowing.js';

export type BuiltinSearchEngineId = 'duckduckgo' | 'google' | 'brave' | 'bing' | 'ecosia';
export type SearchEngineId = string;

export const BUILTIN_SEARCH_ENGINE_IDS: readonly BuiltinSearchEngineId[] = [
  'duckduckgo',
  'google',
  'brave',
  'bing',
  'ecosia',
] as const;

export const SEARCH_ENGINE_IDS = BUILTIN_SEARCH_ENGINE_IDS;

export interface SearchEngine {
  id: SearchEngineId;
  name: string;
  homeUrl: string;
  searchUrl: string;
  isBuiltin?: boolean;
}

export const DEFAULT_SEARCH_ENGINES: readonly SearchEngine[] = [
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    homeUrl: 'https://duckduckgo.com/',
    searchUrl: 'https://duckduckgo.com/?q=%s',
    isBuiltin: true,
  },
  {
    id: 'google',
    name: 'Google',
    homeUrl: 'https://www.google.com/',
    searchUrl: 'https://www.google.com/search?q=%s',
    isBuiltin: true,
  },
  {
    id: 'brave',
    name: 'Brave',
    homeUrl: 'https://search.brave.com/',
    searchUrl: 'https://search.brave.com/search?q=%s',
    isBuiltin: true,
  },
  {
    id: 'bing',
    name: 'Bing',
    homeUrl: 'https://www.bing.com/',
    searchUrl: 'https://www.bing.com/search?q=%s',
    isBuiltin: true,
  },
  {
    id: 'ecosia',
    name: 'Ecosia',
    homeUrl: 'https://www.ecosia.org/',
    searchUrl: 'https://www.ecosia.org/search?q=%s',
    isBuiltin: true,
  },
] as const;

export const SEARCH_ENGINES: readonly SearchEngine[] = DEFAULT_SEARCH_ENGINES;

export const DEFAULT_SEARCH_ENGINE_ID: SearchEngineId = 'duckduckgo';

/**
 * Returns true if a host is a publicly resolvable domain name,
 * rejecting private, loopback, internal domains, or IP addresses.
 */
export function isPublicWebHost(host: string): boolean {
  if (!host || typeof host !== 'string') return false;
  const clean = host.trim().toLowerCase();
  if (isLoopbackHost(clean)) return false;
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(clean);
  const ipv6 = clean.startsWith('[') || clean.endsWith(']');
  if (ipv4 || ipv6) return false;
  if (!clean.includes('.') || clean.endsWith('.')) return false;
  const internalSuffixes = [
    'localhost',
    'local',
    'internal',
    'lan',
    'home',
    'home.arpa',
    'test',
    'invalid',
    'example',
    'corp',
    'onion',
  ];
  if (internalSuffixes.some((suffix) => clean === suffix || clean.endsWith('.' + suffix))) {
    return false;
  }
  return true;
}

/**
 * Constructs a full search URL by safely encoding the query into
 * a template containing `%s`, `{q}`, or `{query}`, or appending it to a query prefix.
 */
export function buildSearchUrl(templateOrPrefix: string, query: string): string {
  const encoded = encodeURIComponent(query);
  if (templateOrPrefix.includes('%s')) {
    return templateOrPrefix.replace(/%s/g, encoded);
  }
  if (templateOrPrefix.includes('{query}')) {
    return templateOrPrefix.replace(/\{query\}/g, encoded);
  }
  if (templateOrPrefix.includes('{q}')) {
    return templateOrPrefix.replace(/\{q\}/g, encoded);
  }
  return `${templateOrPrefix}${encoded}`;
}

/**
 * Retrieves a search engine by ID from configured engines or defaults.
 */
export function getSearchEngine(id?: unknown, customOrAllEngines?: readonly SearchEngine[]): SearchEngine {
  if (customOrAllEngines && customOrAllEngines.length > 0) {
    const match = customOrAllEngines.find((e) => e.id === id);
    if (match) return match;
  }
  const defaultMatch = DEFAULT_SEARCH_ENGINES.find((e) => e.id === id);
  if (defaultMatch) return defaultMatch;
  if (customOrAllEngines && customOrAllEngines.length > 0) {
    return customOrAllEngines[0]!;
  }
  return DEFAULT_SEARCH_ENGINES[0]!;
}

export interface SearchEngineCandidate {
  id?: string;
  name: string;
  homeUrl: string;
  searchUrl: string;
}

/**
 * Validates a search engine candidate for security and correctness:
 * - HTTPS scheme required for both home and search URLs
 * - Query token placeholder (`%s` or `{q}`) required in searchUrl
 * - Non-empty valid URL with public host (no loopback, private IP, or internal addresses)
 * - Safe encoding and no control characters or credentials
 * - Duplicate prevention against existing configured engines
 */
export function validateSearchEngine(
  candidate: SearchEngineCandidate,
  existingEngines?: readonly SearchEngine[],
  editingId?: string,
): { valid: boolean; normalized?: SearchEngine; error?: string } {
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, error: 'Search engine candidate must be an object' };
  }

  // 1. Validate Name
  if (typeof candidate.name !== 'string') {
    return { valid: false, error: 'Name must be a string' };
  }
  const trimmedName = candidate.name.trim();
  if (trimmedName.length === 0) {
    return { valid: false, error: 'Name cannot be empty' };
  }
  if (trimmedName.length > 120) {
    return { valid: false, error: 'Name exceeds maximum length of 120 characters' };
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmedName)) {
    return { valid: false, error: 'Name contains control characters' };
  }

  // Duplicate name check
  if (
    existingEngines &&
    existingEngines.some(
      (e) => e.id !== editingId && e.name.trim().toLowerCase() === trimmedName.toLowerCase(),
    )
  ) {
    return { valid: false, error: 'A search engine with this name already exists' };
  }

  // 2. Validate Homepage URL
  if (typeof candidate.homeUrl !== 'string') {
    return { valid: false, error: 'Homepage URL must be a string' };
  }
  const trimmedHome = candidate.homeUrl.trim();
  if (trimmedHome.length === 0) {
    return { valid: false, error: 'Homepage URL cannot be empty' };
  }
  if (trimmedHome.length > 2048) {
    return { valid: false, error: 'Homepage URL exceeds maximum length of 2048 characters' };
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmedHome)) {
    return { valid: false, error: 'Homepage URL contains control characters' };
  }
  if (!/^https:\/\//i.test(trimmedHome)) {
    return { valid: false, error: 'Homepage URL must use HTTPS scheme (https://)' };
  }
  let parsedHome: URL;
  try {
    parsedHome = new URL(trimmedHome);
  } catch {
    return { valid: false, error: 'Homepage URL is not a valid URL' };
  }
  if (parsedHome.protocol !== 'https:') {
    return { valid: false, error: 'Homepage URL must use HTTPS scheme' };
  }
  if (parsedHome.username || parsedHome.password) {
    return { valid: false, error: 'URLs with user credentials are not allowed' };
  }
  if (!isPublicWebHost(parsedHome.hostname)) {
    return {
      valid: false,
      error: 'Private, internal, or loopback hostnames are not permitted for search engines',
    };
  }

  // Duplicate homeUrl check
  const normalizedHome = parsedHome.toString();
  if (
    existingEngines &&
    existingEngines.some(
      (e) => e.id !== editingId && e.homeUrl.trim().toLowerCase() === normalizedHome.toLowerCase(),
    )
  ) {
    return { valid: false, error: 'A search engine with this homepage URL already exists' };
  }

  // 3. Validate Search URL Template
  if (typeof candidate.searchUrl !== 'string') {
    return { valid: false, error: 'Search URL must be a string' };
  }
  const trimmedSearch = candidate.searchUrl.trim();
  if (trimmedSearch.length === 0) {
    return { valid: false, error: 'Search URL cannot be empty' };
  }
  if (trimmedSearch.length > 2048) {
    return { valid: false, error: 'Search URL exceeds maximum length of 2048 characters' };
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmedSearch)) {
    return { valid: false, error: 'Search URL contains control characters' };
  }
  const existingEditingEngine = editingId
    ? existingEngines?.find((e) => e.id === editingId)
    : undefined;
  const isUnchangedLegacyBuiltinPrefix =
    Boolean(existingEditingEngine?.isBuiltin) &&
    existingEditingEngine?.searchUrl.trim() === trimmedSearch &&
    trimmedSearch.endsWith('=');
  const normalizedSearchUrl = isUnchangedLegacyBuiltinPrefix ? `${trimmedSearch}%s` : trimmedSearch;
  const hasQueryToken =
    normalizedSearchUrl.includes('%s') ||
    normalizedSearchUrl.includes('{q}') ||
    normalizedSearchUrl.includes('{query}');
  if (!hasQueryToken) {
    return {
      valid: false,
      error: 'Search URL template must contain query token %s, {q}, or {query}',
    };
  }
  if (!/^https:\/\//i.test(normalizedSearchUrl)) {
    return { valid: false, error: 'Search URL must use HTTPS scheme (https://)' };
  }

  // Test replacing query token with safe query string
  const testUrlStr = buildSearchUrl(normalizedSearchUrl, 'workbench-test-query');
  let parsedSearch: URL;
  try {
    parsedSearch = new URL(testUrlStr);
  } catch {
    return { valid: false, error: 'Search URL template does not produce a valid URL' };
  }
  if (parsedSearch.protocol !== 'https:') {
    return { valid: false, error: 'Search URL must use HTTPS scheme' };
  }
  if (parsedSearch.username || parsedSearch.password) {
    return { valid: false, error: 'URLs with user credentials are not allowed' };
  }
  if (!isPublicWebHost(parsedSearch.hostname)) {
    return {
      valid: false,
      error: 'Private, internal, or loopback hostnames are not permitted for search engines',
    };
  }

  // Duplicate searchUrl check
  if (
    existingEngines &&
    existingEngines.some(
      (e) => e.id !== editingId && e.searchUrl.trim().toLowerCase() === normalizedSearchUrl.toLowerCase(),
    )
  ) {
    return { valid: false, error: 'A search engine with this search URL template already exists' };
  }

  const id = candidate.id && candidate.id.trim()
    ? candidate.id.trim()
    : `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const isBuiltin = candidate.id ? DEFAULT_SEARCH_ENGINES.some((d) => d.id === candidate.id) : false;

  return {
    valid: true,
    normalized: {
      id,
      name: trimmedName,
      homeUrl: normalizedHome,
      searchUrl: normalizedSearchUrl,
      isBuiltin,
    },
  };
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

export interface SpellCheckSettings {
  enabled: boolean;
  languages: string[];
  configuredLanguages: string[];
  customWordsByProfile: Record<string, string[]>;
}

export const DEFAULT_SPELLCHECK_SETTINGS: SpellCheckSettings = {
  enabled: true,
  languages: ['en-US'],
  configuredLanguages: ['en-US'],
  customWordsByProfile: {},
};

export interface BrowserSettings {
  favorites: BrowserFavorite[];
  defaultSearchEngine: SearchEngineId;
  searchEngines?: SearchEngine[];
  spellCheck?: SpellCheckSettings;
  /**
   * Opt in: let the desktop unload inactive AI provider tabs when memory pressure is
   * high. Default false, which keeps AI tabs resident until pressure is critical.
   */
  unloadInactiveAiTabsUnderPressure?: boolean;
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  favorites: [...DEFAULT_BROWSER_FAVORITES],
  defaultSearchEngine: DEFAULT_SEARCH_ENGINE_ID,
  searchEngines: [...DEFAULT_SEARCH_ENGINES],
  spellCheck: {
    enabled: DEFAULT_SPELLCHECK_SETTINGS.enabled,
    languages: [...DEFAULT_SPELLCHECK_SETTINGS.languages],
    configuredLanguages: [...DEFAULT_SPELLCHECK_SETTINGS.configuredLanguages],
    customWordsByProfile: {},
  },
  unloadInactiveAiTabsUnderPressure: false,
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
    if (isLocalOrPrivateHost(candidateHost)) {
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
      url: buildSearchUrl(searchEngine.searchUrl, trimmed),
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

  // Candidate without scheme: check if it looks like a domain or local/private host
  const firstSegment = trimmed.split('/')[0] ?? '';
  const hasDot = firstSegment.includes('.');
  const hasPort = /:\d+$/.test(firstSegment);
  const isLoop = isLoopbackHost(firstSegment);
  const isLocal = isLocalOrPrivateHost(firstSegment);

  // Single-label non-loopback hostnames without dot (e.g. "nas") require a port or explicit scheme to navigate,
  // otherwise single words default to search query.
  const shouldAttemptDirectNavigation = hasDot || isLoop || (isLocal && hasPort);

  if (shouldAttemptDirectNavigation) {
    const candidateWithScheme = (isLocal ? 'http://' : 'https://') + trimmed;
    const directCheck = validateOtherWebUrl(candidateWithScheme);
    if (directCheck.valid) {
      return { url: directCheck.normalizedUrl!, isSearch: false };
    }
  }

  // Fallback to free-text search for single words or unresolvable domain strings
  return {
    url: buildSearchUrl(searchEngine.searchUrl, trimmed),
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

export function parseSearchEngine(value: unknown): SearchEngine | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = asNonEmptyString(record['id']);
  const name = asNonEmptyString(record['name']);
  const homeUrl = asNonEmptyString(record['homeUrl']);
  const searchUrl = asNonEmptyString(record['searchUrl']);
  if (!id || !name || !homeUrl || !searchUrl) return null;

  const isBuiltin = record['isBuiltin'] === true || DEFAULT_SEARCH_ENGINES.some((d) => d.id === id);

  // If built-in, allow legacy searchUrl that ends with '=' or query token
  if (isBuiltin) {
    return {
      id,
      name: name.trim(),
      homeUrl: homeUrl.trim(),
      searchUrl: searchUrl.trim(),
      isBuiltin: true,
    };
  }

  const validated = validateSearchEngine({ id, name, homeUrl, searchUrl });
  if (!validated.valid || !validated.normalized) return null;
  return validated.normalized;
}

const SPELLCHECK_LANG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,4})*$/;

function sanitizeSpellCheckLanguages(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string' && item.length <= 32 && SPELLCHECK_LANG_RE.test(item)) {
      seen.add(item);
    }
  }
  return [...seen];
}

function sanitizeCustomWords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || item.length > 128 || /[\r\n\0]/.test(item)) continue;
    const trimmed = item.trim();
    if (trimmed.length > 0 && trimmed.length <= 128) {
      seen.add(trimmed);
    }
  }
  return [...seen];
}

function normalizeCustomWordsByProfile(rawMap: unknown): Record<string, string[]> {
  const mapRecord = asRecord(rawMap);
  if (!mapRecord) return {};
  const result: Record<string, string[]> = {};
  for (const profileId of Object.keys(mapRecord).sort()) {
    if (!isValidBrowserProfileId(profileId)) continue;
    const words = sanitizeCustomWords(mapRecord[profileId]);
    if (words.length > 0) {
      result[profileId] = words;
    }
  }
  return result;
}

export function parseBrowserSettings(value: unknown): BrowserSettings | null {
  const record = asRecord(value);
  if (!record) return null;

  const rawEngine = record['defaultSearchEngine'];
  const defaultSearchEngine: SearchEngineId =
    typeof rawEngine === 'string' && rawEngine.trim() ? rawEngine.trim() : DEFAULT_SEARCH_ENGINE_ID;

  const rawFavorites = record['favorites'];
  let favorites: BrowserFavorite[];
  if (Array.isArray(rawFavorites)) {
    const parsed = asArrayFiltered(rawFavorites, parseBrowserFavorite);
    favorites = parsed !== null ? parsed : [...DEFAULT_BROWSER_FAVORITES];
  } else {
    favorites = [...DEFAULT_BROWSER_FAVORITES];
  }

  const rawEngines = record['searchEngines'];
  let searchEngines: SearchEngine[];
  if (Array.isArray(rawEngines)) {
    if (rawEngines.length === 0) {
      searchEngines = [];
    } else {
      const parsed = asArrayFiltered(rawEngines, parseSearchEngine);
      searchEngines = parsed !== null && parsed.length > 0 ? parsed : [...DEFAULT_SEARCH_ENGINES];
    }
  } else {
    searchEngines = [...DEFAULT_SEARCH_ENGINES];
  }

  const engineExists = searchEngines.some((e) => e.id === defaultSearchEngine);
  const resolvedDefault = engineExists ? defaultSearchEngine : (searchEngines[0]?.id ?? DEFAULT_SEARCH_ENGINE_ID);

  let spellCheck: SpellCheckSettings | undefined;
  const rawSpellCheck = record['spellCheck'];
  if (rawSpellCheck && typeof rawSpellCheck === 'object') {
    const rawRecord = asRecord(rawSpellCheck);
    if (rawRecord) {
      const enabled = rawRecord['enabled'] !== false;
      const parsedLanguages = sanitizeSpellCheckLanguages(rawRecord['languages']);
      const parsedConfigured = sanitizeSpellCheckLanguages(rawRecord['configuredLanguages']);

      let configuredLanguages: string[];
      let languages: string[];
      if (parsedConfigured !== null) {
        // Explicit configuredLanguages array (including []) is preserved verbatim.
        configuredLanguages = parsedConfigured;
        const allowed = new Set(configuredLanguages);
        languages = parsedLanguages !== null
          ? parsedLanguages.filter((l) => allowed.has(l))
          : [...configuredLanguages];
      } else if (parsedLanguages !== null) {
        // Legacy shape with explicit languages array (including []) and no configuredLanguages.
        languages = parsedLanguages;
        configuredLanguages = [...languages];
      } else {
        languages = ['en-US'];
        configuredLanguages = ['en-US'];
      }

      const rawByProfile = asRecord(rawRecord['customWordsByProfile']);
      let customWordsByProfile: Record<string, string[]>;
      if (rawByProfile !== null) {
        customWordsByProfile = normalizeCustomWordsByProfile(rawByProfile);
      } else if (Array.isArray(rawRecord['customWords'])) {
        // Legacy migration: assign previously un-scoped words solely to the default ('main') profile.
        const legacyWords = sanitizeCustomWords(rawRecord['customWords']);
        customWordsByProfile = legacyWords.length > 0 ? { [DEFAULT_BROWSER_PROFILE_ID]: legacyWords } : {};
      } else {
        customWordsByProfile = {};
      }

      spellCheck = {
        enabled,
        languages,
        configuredLanguages,
        customWordsByProfile,
      };
    }
  }
  if (!spellCheck) {
    spellCheck = {
      enabled: DEFAULT_SPELLCHECK_SETTINGS.enabled,
      languages: [...DEFAULT_SPELLCHECK_SETTINGS.languages],
      configuredLanguages: [...DEFAULT_SPELLCHECK_SETTINGS.configuredLanguages],
      customWordsByProfile: {},
    };
  }

  return {
    defaultSearchEngine: resolvedDefault,
    favorites,
    searchEngines,
    spellCheck,
    unloadInactiveAiTabsUnderPressure: record['unloadInactiveAiTabsUnderPressure'] === true,
  };
}

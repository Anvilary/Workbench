/**
 * MAW Lane B — Durable Browser Tabs and ChatGPT Workspace Integration.
 *
 * Defines the web tab domain separate from native CLI and terminal runtime sessions.
 * Preserves stable tab identity, workspace association, URL validation, and
 * separation between durable tab IDs and ephemeral browser target references.
 */

import type { WorkspaceId, IsoTimestamp, RequestId } from './agency-protocol.js';

export type WebTabKind = 'web';

export type WebTabRuntimeState =
  | 'client-managed'
  | 'unloaded'
  | 'detached'
  | 'attaching'
  | 'attached'
  | 'navigating'
  | 'ready'
  | 'crashed'
  | 'closed'
  | 'error';

/**
 * Durable ChatGPT web tab associated with a workspace.
 */
export interface WebTab {
  /** Stable UUID identifying this tab across sessions, independent of browser targets. */
  id: string;
  /** Owning Agency workspace ID. */
  workspaceId: WorkspaceId;
  /** Explicit discriminator separate from native CLI and terminal sessions. */
  kind: 'web';
  /** Human-readable tab title (e.g. conversation title or user-renamed label). */
  title: string;
  /** Strictly validated ChatGPT or GitHub URL. The provider is fixed for the life of the tab. */
  url: string;
  /**
   * Omitted on records saved before GitHub tabs existed. Those records are ChatGPT
   * and must still pass the ChatGPT URL check.
   */
  provider?: WebTabProvider;
  /** Presentation order in the tab strip (0-indexed). */
  order: number;
  /** Whether this tab is selected in its workspace. At most one open tab is selected per workspace. */
  selected: boolean;
  /** Creation timestamp. */
  createdAt: IsoTimestamp;
  /** Last update timestamp. */
  updatedAt: IsoTimestamp;
  /** Timestamp when the tab was intentionally closed, or null if open. */
  closedAt: IsoTimestamp | null;
  /** Legacy receipt retained for migration compatibility; never used to control a renderer. */
  targetRef?: string | null;
  /** Ephemeral runtime state in the browser controller. */
  runtimeState?: WebTabRuntimeState;
  /** Legacy cleanup ledger retained as inert data; no runtime cleanup is performed. */
  cleanupRequired?: boolean;
  /** Optional client-supplied idempotent launch identifier. */
  launchId?: string;
}

export interface CreateWebTabInput {
  workspaceId: WorkspaceId;
  url: string;
  provider?: WebTabProvider;
  title?: string;
  order?: number;
  select?: boolean;
  launchId?: string;
  unloaded?: boolean;
}

export interface UrlValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

const ALLOWED_ROOT_HOSTS = new Set([
  'chatgpt.com',
  'chat.openai.com',
]);

const IP_V4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAllowedDomain(host: string): boolean {
  if (ALLOWED_ROOT_HOSTS.has(host)) return true;
  if (host.endsWith('.chatgpt.com')) {
    const subdomain = host.slice(0, -'.chatgpt.com'.length);
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(subdomain);
  }
  return false;
}

/**
 * Validate and normalize allowed ChatGPT URLs.
 *
 * Security guarantees:
 * - Only `https:` protocol is permitted.
 * - Only `chatgpt.com`, `*.chatgpt.com`, or `chat.openai.com` hosts are allowed.
 * - Credentials (`user:pass@`) are rejected.
 * - Non-standard ports are rejected (prevents SSRF port scanning).
 * - IP addresses, localhost, and loopback/internal addresses are strictly rejected.
 * - Control characters and newlines are rejected.
 */
export function validateChatGptUrl(rawUrl: string): UrlValidationResult {
  if (typeof rawUrl !== 'string') {
    return { valid: false, error: 'URL must be a string' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'URL cannot be empty' };
  }
  if (trimmed.length > 2048) {
    return { valid: false, error: 'URL exceeds maximum length of 2048 characters' };
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { valid: false, error: 'URL contains control characters or newlines' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: `Protocol "${parsed.protocol}" is not allowed. Only "https:" is permitted.` };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'URLs with user credentials are not allowed' };
  }

  if (parsed.port && parsed.port !== '443') {
    return { valid: false, error: `Custom port "${parsed.port}" is not allowed` };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (IP_V4_RE.test(hostname) || hostname.startsWith('[') || hostname.endsWith(']')) {
    return { valid: false, error: 'IP addresses are not permitted' };
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { valid: false, error: 'Navigation to local or internal addresses is strictly forbidden' };
  }

  if (!isAllowedDomain(hostname)) {
    return { valid: false, error: `Host "${hostname}" is not an allowed ChatGPT domain` };
  }

  const normalized = new URL(parsed.toString());
  normalized.hostname = hostname;
  if (normalized.port === '443') {
    normalized.port = '';
  }

  return { valid: true, normalizedUrl: normalized.toString() };
}

export function isAllowedChatGptUrl(rawUrl: string): boolean {
  return validateChatGptUrl(rawUrl).valid;
}

export type WebTabProvider = 'chatgpt' | 'github' | 'perplexity' | 'other';

const GITHUB_ROOT_HOSTS = new Set(['github.com']);

function isGithubHost(host: string): boolean {
  if (GITHUB_ROOT_HOSTS.has(host)) return true;
  if (!host.endsWith('.github.com')) return false;
  const subdomain = host.slice(0, -'.github.com'.length);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(subdomain);
}

/**
 * GitHub pages only. The same transport, credential, port, and address
 * checks as ChatGPT apply. ChatGPT hosts are not accepted here.
 */
export function validateGithubUrl(rawUrl: string): UrlValidationResult {
  if (typeof rawUrl !== 'string') return { valid: false, error: 'URL must be a string' };
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return { valid: false, error: 'URL cannot be empty' };
  if (trimmed.length > 2048) return { valid: false, error: 'URL exceeds maximum length of 2048 characters' };
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { valid: false, error: 'URL contains control characters or newlines' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
  if (parsed.protocol !== 'https:') return { valid: false, error: 'Protocol is not allowed. Only "https:" is permitted.' };
  if (parsed.username || parsed.password) return { valid: false, error: 'URLs with user credentials are not allowed' };
  if (parsed.port && parsed.port !== '443') return { valid: false, error: `Custom port "${parsed.port}" is not allowed` };
  const hostname = parsed.hostname.toLowerCase();
  if (IP_V4_RE.test(hostname) || hostname.startsWith('[') || hostname.endsWith(']')) {
    return { valid: false, error: 'IP addresses are not permitted' };
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { valid: false, error: 'Navigation to local or internal addresses is strictly forbidden' };
  }
  if (!isGithubHost(hostname)) return { valid: false, error: `Host "${hostname}" is not an allowed GitHub domain` };
  const normalized = new URL(parsed.toString());
  normalized.hostname = hostname;
  if (normalized.port === '443') normalized.port = '';
  return { valid: true, normalizedUrl: normalized.toString() };
}

const PERPLEXITY_ROOT_HOSTS = new Set(['perplexity.ai']);

function isPerplexityHost(host: string): boolean {
  if (PERPLEXITY_ROOT_HOSTS.has(host)) return true;
  if (!host.endsWith('.perplexity.ai')) return false;
  const subdomain = host.slice(0, -'.perplexity.ai'.length);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(subdomain);
}

/**
 * Perplexity pages only (https://www.perplexity.ai/ or https://perplexity.ai/).
 * Same strict transport, credential, port, and security boundaries.
 */
export function validatePerplexityUrl(rawUrl: string): UrlValidationResult {
  if (typeof rawUrl !== 'string') return { valid: false, error: 'URL must be a string' };
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return { valid: false, error: 'URL cannot be empty' };
  if (trimmed.length > 2048) return { valid: false, error: 'URL exceeds maximum length of 2048 characters' };
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { valid: false, error: 'URL contains control characters or newlines' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
  if (parsed.protocol !== 'https:') return { valid: false, error: 'Protocol is not allowed. Only "https:" is permitted.' };
  if (parsed.username || parsed.password) return { valid: false, error: 'URLs with user credentials are not allowed' };
  if (parsed.port && parsed.port !== '443') return { valid: false, error: `Custom port "${parsed.port}" is not allowed` };
  const hostname = parsed.hostname.toLowerCase();
  if (IP_V4_RE.test(hostname) || hostname.startsWith('[') || hostname.endsWith(']')) {
    return { valid: false, error: 'IP addresses are not permitted' };
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { valid: false, error: 'Navigation to local or internal addresses is strictly forbidden' };
  }
  if (!isPerplexityHost(hostname)) return { valid: false, error: `Host "${hostname}" is not an allowed Perplexity domain` };
  const normalized = new URL(parsed.toString());
  normalized.hostname = hostname;
  if (normalized.port === '443') normalized.port = '';
  return { valid: true, normalizedUrl: normalized.toString() };
}

export function classifyWebTabUrl(rawUrl: string): UrlValidationResult & { provider?: WebTabProvider } {
  const chat = validateChatGptUrl(rawUrl);
  if (chat.valid) return { ...chat, provider: 'chatgpt' };
  const github = validateGithubUrl(rawUrl);
  if (github.valid) return { ...github, provider: 'github' };
  const perplexity = validatePerplexityUrl(rawUrl);
  if (perplexity.valid) return { ...perplexity, provider: 'perplexity' };
  return { valid: false, error: 'URL is not an allowed ChatGPT, GitHub, or Perplexity address' };
}

/** Public HTTP(S) URLs for explicitly user-created Other tabs. */
export function validateOtherWebUrl(rawUrl: string): UrlValidationResult {
  if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.length > 2048 || /[\u0000-\u001f\u007f]/.test(rawUrl)) return { valid: false, error: 'Invalid URL' };
  let url: URL;
  try { url = new URL(rawUrl.trim()); } catch { return { valid: false, error: 'Invalid URL format' }; }
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const ipv6 = host.startsWith('[') || host.endsWith(']');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { valid: false, error: 'Only HTTP and HTTPS URLs are allowed' };
  if (url.username || url.password) return { valid: false, error: 'URLs with user credentials are not allowed' };
  if (!host || ipv4 || ipv6 || host === 'localhost' || ['.localhost', '.local', '.internal', '.lan', '.home', '.home.arpa', '.test', '.invalid', '.example'].some(suffix => host === suffix.slice(1) || host.endsWith(suffix)) || !host.includes('.')) return { valid: false, error: 'Local, private, and IP addresses are not allowed' };
  const octets = ipv4 ? host.split('.').map(Number) : [];
  if (ipv4 || ipv6 || /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host) || octets.some(n => n > 255)) return { valid: false, error: 'Local, private, and IP addresses are not allowed' };
  return { valid: true, normalizedUrl: url.toString() };
}

export function webTabProviderFor(tab: Pick<WebTab, 'url' | 'provider'>): WebTabProvider {
  if (tab.provider === 'github' || tab.provider === 'chatgpt' || tab.provider === 'perplexity' || tab.provider === 'other') return tab.provider;
  if (validateGithubUrl(tab.url).valid) return 'github';
  if (validatePerplexityUrl(tab.url).valid) return 'perplexity';
  return 'chatgpt';
}

export function validateWebTabTitle(title: unknown): boolean {
  if (typeof title !== 'string') return false;
  const clean = title.trim();
  return clean.length >= 1 && clean.length <= 120 && !/[\u0000-\u001f\u007f]/.test(clean);
}

const VALID_RUNTIME_STATES = new Set<string>([
  'client-managed',
  'unloaded',
  'detached',
  'attaching',
  'attached',
  'navigating',
  'ready',
  'crashed',
  'closed',
  'error',
]);

export function isWebTab(value: unknown): value is WebTab {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tab = value as Record<string, unknown>;
  if (tab.kind !== 'web') return false;
  if (typeof tab.id !== 'string' || !UUID_RE.test(tab.id)) return false;
  if (typeof tab.workspaceId !== 'string' || !UUID_RE.test(tab.workspaceId)) return false;
  if (!validateWebTabTitle(tab.title)) return false;
  if (typeof tab.url !== 'string') return false;
  if (tab.provider !== undefined && tab.provider !== 'chatgpt' && tab.provider !== 'github' && tab.provider !== 'perplexity' && tab.provider !== 'other') return false;
  const provider = tab.provider ?? (validateGithubUrl(tab.url).valid ? 'github' : validatePerplexityUrl(tab.url).valid ? 'perplexity' : 'chatgpt');
  const urlOk = provider === 'other' ? validateOtherWebUrl(tab.url).valid : provider === 'github' ? validateGithubUrl(tab.url).valid : provider === 'perplexity' ? validatePerplexityUrl(tab.url).valid : validateChatGptUrl(tab.url).valid;
  if (!urlOk) return false;
  if (!Number.isSafeInteger(tab.order) || (tab.order as number) < 0) return false;
  if (typeof tab.selected !== 'boolean') return false;
  if (typeof tab.createdAt !== 'string' || Number.isNaN(Date.parse(tab.createdAt))) return false;
  if (typeof tab.updatedAt !== 'string' || Number.isNaN(Date.parse(tab.updatedAt))) return false;
  if (tab.closedAt !== null && (typeof tab.closedAt !== 'string' || Number.isNaN(Date.parse(tab.closedAt)))) return false;
  if (tab.targetRef !== undefined && tab.targetRef !== null && typeof tab.targetRef !== 'string') return false;
  if (tab.runtimeState !== undefined && !VALID_RUNTIME_STATES.has(tab.runtimeState as string)) return false;
  if (tab.cleanupRequired !== undefined && typeof tab.cleanupRequired !== 'boolean') return false;
  if (tab.launchId !== undefined && (typeof tab.launchId !== 'string' || tab.launchId.length < 1 || tab.launchId.length > 128)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Client / Server Wire Protocol for Web Tabs
// ---------------------------------------------------------------------------

export type WebTabClientMessage =
  | { type: 'agency.webTab.create'; requestId: RequestId; workspaceId: WorkspaceId; url: string; provider?: WebTabProvider; title?: string; order?: number; select?: boolean; launchId?: string; targetPaneId?: string; unloaded?: boolean }
  | { type: 'agency.webTab.select'; requestId: RequestId; workspaceId: WorkspaceId; tabId: string }
  | { type: 'agency.webTab.navigate'; requestId: RequestId; workspaceId: WorkspaceId; tabId: string; url: string }
  | { type: 'agency.webTab.rename'; requestId: RequestId; workspaceId: WorkspaceId; tabId: string; title: string }
  | { type: 'agency.webTab.order'; requestId: RequestId; workspaceId: WorkspaceId; tabIds: readonly string[] }
  | { type: 'agency.webTab.close'; requestId: RequestId; workspaceId: WorkspaceId; tabId: string }
  | { type: 'agency.webTabs.list'; requestId: RequestId; workspaceId?: WorkspaceId };

export type WebTabServerMessage =
  | { type: 'agency.webTabs.snapshot'; requestId: RequestId; tabs: readonly WebTab[] }
  | { type: 'agency.webTab.created'; requestId: RequestId; tab: WebTab }
  | { type: 'agency.webTab.updated'; requestId: RequestId; tab: WebTab }
  | { type: 'agency.webTab.closed'; requestId: RequestId; tab: WebTab }
  | { type: 'agency.webTab.changed'; change: 'created' | 'updated' | 'closed' | 'ordered'; workspaceId: WorkspaceId; tab?: WebTab; tabs?: readonly WebTab[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidRequestId(v: unknown): v is RequestId {
  return typeof v === 'string' && v.length >= 1 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);
}

export function parseWebTabClientMessage(raw: unknown): WebTabClientMessage | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  const fields: Record<string, readonly string[]> = {
    'agency.webTab.create': ['workspaceId', 'url', 'provider', 'title', 'order', 'select', 'launchId', 'targetPaneId', 'unloaded'],
    'agency.webTab.select': ['workspaceId', 'tabId'],
    'agency.webTab.navigate': ['workspaceId', 'tabId', 'url'],
    'agency.webTab.rename': ['workspaceId', 'tabId', 'title'],
    'agency.webTab.order': ['workspaceId', 'tabIds'],
    'agency.webTab.close': ['workspaceId', 'tabId'],
    'agency.webTabs.list': ['workspaceId'],
  };
  const allowed = fields[raw.type];
  if (!allowed || Object.keys(raw).some(key => !['type', 'requestId', ...allowed].includes(key))) return null;
  const requestId = raw.requestId;
  if (!isValidRequestId(requestId)) return null;

  switch (raw.type) {
    case 'agency.webTab.create': {
      if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) return null;
      if (typeof raw.url !== 'string') return null;
      const provider = raw.provider;
      if (provider !== undefined && !['chatgpt', 'github', 'perplexity', 'other'].includes(String(provider))) return null;
      const val = provider === 'other' ? validateOtherWebUrl(raw.url) : classifyWebTabUrl(raw.url);
      if (!val.valid || !val.normalizedUrl) return null;
      let title: string | undefined;
      if (raw.title !== undefined) {
        if (!validateWebTabTitle(raw.title)) return null;
        title = (raw.title as string).trim();
      }
      let order: number | undefined;
      if (raw.order !== undefined) {
        if (!Number.isSafeInteger(raw.order) || (raw.order as number) < 0) return null;
        order = raw.order as number;
      }
      let select: boolean | undefined;
      if (raw.select !== undefined) {
        if (typeof raw.select !== 'boolean') return null;
        select = raw.select;
      }
      let launchId: string | undefined;
      if (raw.launchId !== undefined) {
        if (typeof raw.launchId !== 'string' || raw.launchId.length < 1 || raw.launchId.length > 128) return null;
        launchId = raw.launchId;
      }
      if (raw.targetPaneId !== undefined && (typeof raw.targetPaneId !== 'string' || raw.targetPaneId.length < 1 || raw.targetPaneId.length > 128 || /[\u0000-\u001f\u007f]/.test(raw.targetPaneId))) return null;
      let unloaded: boolean | undefined;
      if (raw.unloaded !== undefined) {
        if (typeof raw.unloaded !== 'boolean') return null;
        unloaded = raw.unloaded;
      }
      return {
        type: 'agency.webTab.create',
        requestId,
        workspaceId: raw.workspaceId as WorkspaceId,
        url: val.normalizedUrl!,
        ...(provider === 'other' ? { provider: 'other' as const } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(select !== undefined ? { select } : {}),
        ...(launchId !== undefined ? { launchId } : {}),
        ...(raw.targetPaneId !== undefined ? { targetPaneId: raw.targetPaneId as string } : {}),
        ...(unloaded !== undefined ? { unloaded } : {}),
      };
    }
    case 'agency.webTab.select': {
      if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) return null;
      if (typeof raw.tabId !== 'string' || !UUID_RE.test(raw.tabId)) return null;
      return {
        type: 'agency.webTab.select',
        requestId,
        workspaceId: raw.workspaceId as WorkspaceId,
        tabId: raw.tabId,
      };
    }
    case 'agency.webTab.navigate': {
      if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) return null;
      if (typeof raw.tabId !== 'string' || !UUID_RE.test(raw.tabId)) return null;
      if (typeof raw.url !== 'string') return null;
      const val = classifyWebTabUrl(raw.url);
      const other = validateOtherWebUrl(raw.url);
      if ((!val.valid || !val.normalizedUrl) && (!other.valid || !other.normalizedUrl)) return null;
      return {
        type: 'agency.webTab.navigate',
        requestId,
        workspaceId: raw.workspaceId as WorkspaceId,
        tabId: raw.tabId,
        url: val.normalizedUrl ?? other.normalizedUrl!,
      };
    }
    case 'agency.webTab.rename': {
      if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) return null;
      if (typeof raw.tabId !== 'string' || !UUID_RE.test(raw.tabId)) return null;
      if (!validateWebTabTitle(raw.title)) return null;
      return {
        type: 'agency.webTab.rename',
        requestId,
        workspaceId: raw.workspaceId as WorkspaceId,
        tabId: raw.tabId,
        title: (raw.title as string).trim(),
      };
    }
    case 'agency.webTab.order': {
      if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) return null;
      if (!Array.isArray(raw.tabIds) || !raw.tabIds.every((id) => typeof id === 'string' && UUID_RE.test(id))) return null;
      return {
        type: 'agency.webTab.order',
        requestId,
        workspaceId: raw.workspaceId as WorkspaceId,
        tabIds: raw.tabIds,
      };
    }
    case 'agency.webTab.close': {
      if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId)) return null;
      if (typeof raw.tabId !== 'string' || !UUID_RE.test(raw.tabId)) return null;
      return {
        type: 'agency.webTab.close',
        requestId,
        workspaceId: raw.workspaceId as WorkspaceId,
        tabId: raw.tabId,
      };
    }
    case 'agency.webTabs.list': {
      if (raw.workspaceId !== undefined && (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId))) return null;
      return {
        type: 'agency.webTabs.list',
        requestId,
        ...(raw.workspaceId ? { workspaceId: raw.workspaceId as WorkspaceId } : {}),
      };
    }
    default:
      return null;
  }
}

/** Browser messages travel through the same validated Agency transport as PTYs. */
export function parseWebTabServerMessage(raw: unknown): WebTabServerMessage | null {
  if (!isRecord(raw)) return null;
  if (raw.type === 'agency.webTab.changed') {
    if (typeof raw.workspaceId !== 'string' || !UUID_RE.test(raw.workspaceId) ||
        !['created', 'updated', 'closed', 'ordered'].includes(raw.change as string)) return null;
    if (raw.change === 'ordered') {
      if (!Array.isArray(raw.tabs) || !raw.tabs.every(isWebTab) || raw.tabs.some(tab => tab.workspaceId !== raw.workspaceId)) return null;
    } else if (!isWebTab(raw.tab) || raw.tab.workspaceId !== raw.workspaceId) return null;
    return raw as unknown as WebTabServerMessage;
  }
  if (typeof raw.requestId !== 'string' || raw.requestId.length > 128 || /[\u0000-\u001f\u007f]/.test(raw.requestId)) return null;
  if (raw.type === 'agency.webTabs.snapshot') {
    if (!Array.isArray(raw.tabs) || !raw.tabs.every(isWebTab) || new Set(raw.tabs.map(tab => tab.id)).size !== raw.tabs.length) return null;
    return { type: raw.type, requestId: raw.requestId, tabs: raw.tabs };
  }
  if (raw.type === 'agency.webTab.created' || raw.type === 'agency.webTab.updated' || raw.type === 'agency.webTab.closed') {
    if (!isWebTab(raw.tab)) return null;
    return { type: raw.type, requestId: raw.requestId, tab: raw.tab };
  }
  return null;
}

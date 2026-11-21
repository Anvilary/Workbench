import { isIP } from 'node:net';

export const PARTITION = 'persist:maw-chatgpt';
export const GITHUB_PARTITION = 'persist:maw-github';
export const PERPLEXITY_PARTITION = 'persist:maw-perplexity';
export const BROWSER_PARTITION = 'persist:maw-browser';
export const DEFAULT_BROWSER_PROFILE_ID = 'main';
const BROWSER_PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BROWSER_PROFILE_SITES = new Set(['chatgpt', 'github', 'perplexity', 'browser']);
export const CHANNEL = 'maw:chatgpt';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const authHosts = new Set([
  'auth.openai.com',
  'auth0.openai.com',
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
  'challenges.cloudflare.com',
]);
const fileDeliveryHosts = new Set(['files.oaiusercontent.com', 'oaistatic.com']);

function httpsUrl(value, maxLength = 8192) {
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

export function chatUrl(value) { return ['chatgpt.com', 'chat.openai.com'].includes(httpsUrl(value)?.hostname); }

function githubHost(hostname) {
  return hostname === 'github.com' || (hostname.endsWith('.github.com') && hostname.length > '.github.com'.length);
}

export function githubUrl(value) {
  const url = httpsUrl(value);
  return !!url && githubHost(url.hostname);
}

const githubAssetHosts = new Set(['github.githubassets.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com', 'codeload.github.com', 'avatars.githubusercontent.com']);

export function githubEmbeddedUrl(value) {
  const url = httpsUrl(value);
  if (!url) return false;
  return githubUrl(value) || authHosts.has(url.hostname) || githubAssetHosts.has(url.hostname) || url.hostname.endsWith('.githubusercontent.com');
}

const perplexityAuthHosts = new Set(['auth.perplexity.ai', 'accounts.google.com', 'appleid.apple.com']);
const perplexityAssetHosts = new Set(['cdn.perplexity.ai', 'assets.perplexity.ai', 'media.perplexity.ai']);

function perplexityHost(hostname) {
  return hostname === 'perplexity.ai' || (hostname.endsWith('.perplexity.ai') && hostname.length > '.perplexity.ai'.length);
}

export function perplexityUrl(value) {
  const url = httpsUrl(value);
  return !!url && perplexityHost(url.hostname);
}

export function perplexityEmbeddedUrl(value) {
  const url = httpsUrl(value);
  if (!url) return false;
  return perplexityUrl(value) || authHosts.has(url.hostname) || perplexityAuthHosts.has(url.hostname) || perplexityAssetHosts.has(url.hostname);
}

export function webProvider(value) {
  if (chatUrl(value)) return 'chatgpt';
  if (githubUrl(value)) return 'github';
  if (perplexityUrl(value)) return 'perplexity';
  return null;
}

export function targetWebProvider(value) {
  const p = webProvider(value);
  if (p) return p;
  if (otherUrl(value)) return 'other';
  return null;
}

export function getBrowserZoomAction(input) {
  if (!input || input.type !== 'keyDown' || (!input.control && !input.meta) || input.alt) return null;
  const key = input.key;
  const code = input.code;
  if (key === '+' || key === '=' || key === 'Add' || code === 'NumpadAdd' || code === 'Equal') {
    return 'zoom-in';
  }
  if (key === '-' || key === '_' || key === 'Subtract' || code === 'NumpadSubtract' || code === 'Minus') {
    return 'zoom-out';
  }
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
    return 'zoom-reset';
  }
  return null;
}

export function isSameSite(url1, url2) {
  if (typeof url1 !== 'string' || typeof url2 !== 'string') return false;
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    if (u1.protocol !== u2.protocol) return false;
    const h1 = u1.hostname.toLowerCase();
    const h2 = u2.hostname.toLowerCase();
    if (h1 === h2) return true;
    const parts1 = h1.split('.');
    const parts2 = h2.split('.');
    if (parts1.length >= 2 && parts2.length >= 2) {
      const s1 = parts1.slice(-2).join('.');
      const s2 = parts2.slice(-2).join('.');
      const multiTlds = new Set(['co.uk', 'com.br', 'co.jp', 'com.au', 'co.nz', 'co.za']);
      if (multiTlds.has(s1) || multiTlds.has(s2)) {
        if (parts1.length >= 3 && parts2.length >= 3) {
          return parts1.slice(-3).join('.') === parts2.slice(-3).join('.');
        }
        return false;
      }
      return s1 === s2;
    }
    return false;
  } catch {
    return false;
  }
}

const AUTH_URL_MAX = 8192;
const authenticationHosts = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
  'auth.openai.com',
  'auth0.openai.com',
  'auth.perplexity.ai',
]);
const authenticationSuffixes = ['.okta.com', '.auth0.com', '.onelogin.com'];
const blockedPublicSuffixes = ['localhost', 'local', 'internal', 'lan', 'home', 'home.arpa', 'test', 'invalid', 'example'];

function publicHttps(value, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || host.endsWith('.')) return null;
    if (blockedPublicSuffixes.some(suffix => host === suffix || host.endsWith('.' + suffix))) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Provider sign-in documents restricted strictly to explicit trusted identity
 * provider origins (never arbitrary domains by path pattern).
 */
export function authenticationUrl(value) {
  const url = publicHttps(value, AUTH_URL_MAX);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (authenticationHosts.has(host)) return true;
  return authenticationSuffixes.some(suffix => host.endsWith(suffix) && host.length > suffix.length);
}

export function popupShaped(dispositionOrFeatures, maybeFeatures) {
  const features = maybeFeatures !== undefined ? maybeFeatures : dispositionOrFeatures;
  return /(?:^|[,\s])(?:popup|width|height)(?:\s*=|\s*,|\s*$)/i.test(typeof features === 'string' ? features : '');
}

/**
 * How window.open is hosted.
 * Authentication popups stay native windows. They are never turned into workspace tabs:
 * a tab has no opener, drops form bodies, and leaves Google's sign-in document empty.
 */
export function decideWindowOpen({
  url,
  disposition = 'new-window',
  features = '',
  allowPopup = false,
  popupOpen = false,
  permitted = false,
  tabbable = false,
  external = false,
}) {
  const blank = url === 'about:blank' || url === '';
  const auth = authenticationUrl(url);
  const shaped = popupShaped(features);
  const isNewWindow = disposition === 'new-window' || disposition === 'default';
  const isPopupCandidate = (isNewWindow && auth) || shaped;
  const validDestination = blank || auth || permitted || tabbable || external;

  if (allowPopup && !popupOpen && isPopupCandidate && validDestination) return 'popup';
  if (auth) return 'external';
  if (tabbable) return 'tab';
  if (external) return 'external';
  return 'deny';
}

export function isFileDeliveryHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  return fileDeliveryHosts.has(hostname) || hostname.endsWith('.oaiusercontent.com') || hostname.endsWith('.oaistatic.com');
}

export function isDownloadOrFileDeliveryUrl(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('blob:https://chatgpt.com/') || value.startsWith('blob:https://chat.openai.com/')) return true;
  const url = httpsUrl(value);
  return !!url && isFileDeliveryHost(url.hostname);
}

export function embeddedUrl(value) {
  const url = httpsUrl(value);
  return !!url && (chatUrl(value) || authHosts.has(url.hostname) || isFileDeliveryHost(url.hostname));
}

export function externalUrl(value) {
  const url = httpsUrl(value);
  if (!url) return false;
  const host = url.hostname;
  return !isIP(host.replace(/^\[|\]$/g, '')) && host.includes('.') &&
    !['localhost', 'local', 'internal', 'test', 'invalid', 'example'].some(suffix => host === suffix || host.endsWith('.' + suffix));
}

/**
 * General web pages in embedded Electron WebContentsViews get their own
 * partition and deliberately exclude all loopback, IP literal, and local-network
 * origins. Although `@agent-workbench/shared`'s `validateOtherWebUrl` permits
 * loopback URLs for web-mode or external browser links, native desktop views
 * fail closed on loopback so untrusted general websites cannot navigate,
 * redirect, or issue subresource requests to local services or Workbench's own
 * loopback backend.
 */
export function otherUrl(value, maxLength = 2048) {
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
      !isIP(host.replace(/^\[|\]$/g, '')) && host.includes('.') && !host.endsWith('.') &&
      !blockedPublicSuffixes.some(suffix => host === suffix || host.endsWith('.' + suffix));
  } catch { return false; }
}

export function serviceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.hash) throw new Error('MAW_DESKTOP_URL must be the local MAW http://127.0.0.1:PORT/ URL');
  return url;
}

/**
 * Validates favicon URLs emitted by embedded web pages before forwarding to
 * the desktop shell. Only safe base64 `data:image/` URIs and public HTTPS URLs
 * (no HTTP, no loopback, no private IPs, no local TLDs, no credentials, no
 * custom ports) are permitted to prevent loopback/local-network SSRF.
 */
export function validateFaviconUrl(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  if (!clean || clean.length > 65536 || /[\u0000-\u001f\u007f]/.test(clean)) return null;

  // Safe data:image/ URIs (PNG, ICO, JPEG, WEBP, SVG) up to 64KB
  if (clean.startsWith('data:image/')) {
    const match = /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(clean);
    return match ? clean : null;
  }

  if (clean.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== '443') return null;

  const hostname = parsed.hostname.toLowerCase();
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  if (!bareHost || isIP(bareHost) || !bareHost.includes('.') || bareHost.endsWith('.')) return null;
  if (blockedPublicSuffixes.some(suffix => bareHost === suffix || bareHost.endsWith('.' + suffix))) return null;

  return parsed.toString();
}

export function selectBestFavicon(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    const valid = validateFaviconUrl(candidate);
    if (valid) return valid;
  }
  return null;
}

export function trustedSender(event, contents, origin) {
  try { return event.sender === contents && event.senderFrame === contents.mainFrame && new URL(event.senderFrame.url).origin === origin && new URL(event.senderFrame.url).pathname === '/'; }
  catch { return false; }
}

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join() === keys.sort().join();

function boundsOverlap(r1, r2) {
  return !(r1.x + r1.width <= r2.x || r2.x + r2.width <= r1.x || r1.y + r1.height <= r2.y || r2.y + r2.height <= r1.y);
}

export function isValidBrowserProfileId(value) {
  return typeof value === 'string' && (value === DEFAULT_BROWSER_PROFILE_ID || BROWSER_PROFILE_ID_RE.test(value));
}

export function partitionForBrowserProfile(profileId, provider = 'chatgpt') {
  const effective = isValidBrowserProfileId(profileId) ? profileId : DEFAULT_BROWSER_PROFILE_ID;
  const suffix = provider === 'github' || provider === 'perplexity' ? provider : provider === 'other' ? 'browser' : 'chatgpt';
  if (effective === DEFAULT_BROWSER_PROFILE_ID) {
    return `persist:maw-${suffix}`;
  }
  return `persist:maw-profile-${effective}-${suffix}`;
}

export function validCommand(value) {
  if (!record(value)) return false;
  if (value.type === 'retain') return exact(value, ['type', 'ids']) && Array.isArray(value.ids) && value.ids.length <= 4096 && value.ids.every(id => typeof id === 'string' && UUID.test(id));
  if (value.type === 'open' || value.type === 'update') {
    if (!(typeof value.id === 'string' && UUID.test(value.id))) return false;
    const hasProfile = 'profileId' in value;
    if (hasProfile && !isValidBrowserProfileId(value.profileId)) return false;
    const baseKeys = value.provider !== undefined ? ['type', 'id', 'url', 'provider'] : ['type', 'id', 'url'];
    const expectedKeys = hasProfile ? [...baseKeys, 'profileId'] : baseKeys;
    if (!exact(value, expectedKeys)) return false;
    if (value.provider === undefined) return chatUrl(value.url);
    if (value.provider === 'chatgpt') return chatUrl(value.url);
    if (value.provider === 'github') return githubUrl(value.url);
    if (value.provider === 'perplexity') return perplexityUrl(value.url);
    if (value.provider === 'other') return otherUrl(value.url);
    return false;
  }
  if (value.type === 'clone-profile') {
    const hasClearSites = 'clearSites' in value;
    const expectedKeys = hasClearSites
      ? ['type', 'sourceProfileId', 'targetProfileId', 'clearSites']
      : ['type', 'sourceProfileId', 'targetProfileId'];
    if (!exact(value, expectedKeys)) return false;
    if (!isValidBrowserProfileId(value.sourceProfileId)) return false;
    if (!isValidBrowserProfileId(value.targetProfileId)) return false;
    if (value.targetProfileId === DEFAULT_BROWSER_PROFILE_ID) return false;
    if (value.targetProfileId === value.sourceProfileId) return false;
    if (hasClearSites) {
      if (!Array.isArray(value.clearSites) || value.clearSites.length > 16) return false;
      if (!value.clearSites.every(site => typeof site === 'string' && BROWSER_PROFILE_SITES.has(site))) return false;
    }
    return true;
  }
  if (value.type === 'clear-profile-site-auth') {
    if (!exact(value, ['type', 'profileId', 'site'])) return false;
    return isValidBrowserProfileId(value.profileId) && typeof value.site === 'string' && BROWSER_PROFILE_SITES.has(value.site);
  }
  if (value.type === 'delete-profile') {
    if (!exact(value, ['type', 'profileId'])) return false;
    return isValidBrowserProfileId(value.profileId) && value.profileId !== DEFAULT_BROWSER_PROFILE_ID;
  }
  if (value.type === 'browser-action') {
    const actions = ['back', 'forward', 'reload', 'copy-url', 'copy-selection', 'open-page', 'zoom-in', 'zoom-out', 'zoom-reset'];
    if (exact(value, ['type', 'id', 'action'])) return UUID.test(value.id) && actions.includes(value.action);
    if (exact(value, ['type', 'id', 'action', 'word'])) {
      return value.action === 'replace-misspelling' && UUID.test(value.id) && typeof value.word === 'string' && value.word.length <= 256 && !/[\r\n\0]/.test(value.word);
    }
    if (exact(value, ['type', 'id', 'action', 'url'])) {
      return (value.action === 'open-link' || value.action === 'copy-link') && UUID.test(value.id) && externalUrl(value.url);
    }
    return false;
  }
  if (value.type === 'find-in-page') {
    if (!record(value) || typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.text !== 'string' || value.text.length > 512) return false;
    for (const key of Object.keys(value)) {
      if (!['type', 'id', 'text', 'forward', 'findNext', 'matchCase', 'searchId'].includes(key)) return false;
    }
    if ('forward' in value && typeof value.forward !== 'boolean') return false;
    if ('findNext' in value && typeof value.findNext !== 'boolean') return false;
    if ('matchCase' in value && typeof value.matchCase !== 'boolean') return false;
    if ('searchId' in value && (!Number.isSafeInteger(value.searchId) || value.searchId < 0)) return false;
    return true;
  }
  if (value.type === 'stop-find-in-page') {
    if (!record(value) || typeof value.id !== 'string' || !UUID.test(value.id)) return false;
    const allowedActions = ['clearSelection', 'keepSelection', 'activateSelection'];
    if (exact(value, ['type', 'id'])) return true;
    return exact(value, ['type', 'id', 'action']) && allowedActions.includes(value.action);
  }
  if (value.type === 'copy-file') {
    return exact(value, ['type', 'cwd', 'relative']) && typeof value.cwd === 'string' && value.cwd.startsWith('/') && value.cwd.length <= 4096 &&
      typeof value.relative === 'string' && value.relative.length > 0 && value.relative.length <= 512 && !value.relative.startsWith('/') && !value.relative.includes('\0');
  }
  if (value.type === 'close' || value.type === 'capture') return exact(value, ['type', 'id']) && typeof value.id === 'string' && UUID.test(value.id);
  if (value.type === 'get-backend-endpoint') return exact(value, ['type']);
  if (value.type === 'get-favicons') return exact(value, ['type']);
  if (value.type === 'restore-shell-storage') return exact(value, ['type']);
  if (value.type === 'write-clipboard-text') {
    return exact(value, ['type', 'text']) && typeof value.text === 'string' && value.text.length <= 25_000_000;
  }
  if (value.type === 'read-clipboard-text') return exact(value, ['type']);
  if (value.type === 'browse-executable') return exact(value, ['type']) || (exact(value, ['type', 'title']) && typeof value.title === 'string' && value.title.length <= 128);
  if (
    value.type === 'performance-subscribe' ||
    value.type === 'performance-unsubscribe' ||
    value.type === 'performance-pause' ||
    value.type === 'performance-resume' ||
    value.type === 'performance-refresh'
  ) return exact(value, ['type']);

  if (value.type === 'layout') {
    // Single-view layout (legacy / simple)
    if (exact(value, ['type', 'id', 'bounds', 'viewport'])) {
      if (value.id !== null && (typeof value.id !== 'string' || !UUID.test(value.id))) return false;
      if (!exact(value.bounds, ['x', 'y', 'width', 'height']) || !exact(value.viewport, ['width', 'height'])) return false;
      return [...Object.values(value.bounds), ...Object.values(value.viewport)].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 32768);
    }

    // Multi-view layout (Feature 3)
    const hasFocus = 'focusedId' in value;
    const expectedKeys = hasFocus ? ['type', 'views', 'viewport', 'focusedId'] : ['type', 'views', 'viewport'];
    if (!exact(value, expectedKeys)) return false;
    if (!Array.isArray(value.views) || value.views.length > 4) return false;
    if (!exact(value.viewport, ['width', 'height'])) return false;
    if (![value.viewport.width, value.viewport.height].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 32768)) return false;
    if (hasFocus && value.focusedId !== null && (typeof value.focusedId !== 'string' || !UUID.test(value.focusedId))) return false;

    const seenIds = new Set();
    const v = value.viewport;
    for (let i = 0; i < value.views.length; i++) {
      const item = value.views[i];
      if (!record(item) || !exact(item, ['id', 'bounds'])) return false;
      if (typeof item.id !== 'string' || !UUID.test(item.id) || seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      const b = item.bounds;
      if (!record(b) || !exact(b, ['x', 'y', 'width', 'height'])) return false;
      if (![b.x, b.y, b.width, b.height].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 32768)) return false;
      if (b.x + b.width > v.width || b.y + b.height > v.height) return false;

      // Check non-overlapping content rectangles
      for (let j = 0; j < i; j++) {
        if (boundsOverlap(b, value.views[j].bounds)) return false;
      }
    }
    return true;
  }

  return false;
}

export function nativeBoundsForRect(b, v, contentSize, zoom) {
  if (!b || !v || b.width < 1 || b.height < 1 || b.x + b.width > v.width || b.y + b.height > v.height) return null;
  if (Math.abs(v.width * zoom - contentSize[0]) > 2 || Math.abs(v.height * zoom - contentSize[1]) > 2) return null;
  const x = Math.ceil(b.x * zoom), y = Math.ceil(b.y * zoom);
  return { x, y, width: Math.max(0, Math.floor((b.x + b.width) * zoom) - x), height: Math.max(0, Math.floor((b.y + b.height) * zoom) - y) };
}

export function nativeBounds(command, contentSize, zoom) {
  if (!command.id || !command.bounds || !command.viewport) return null;
  return nativeBoundsForRect(command.bounds, command.viewport, contentSize, zoom);
}

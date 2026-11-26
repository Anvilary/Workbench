import { isIP } from 'node:net';

export const PARTITION = 'persist:workbench-chatgpt';
export const GITHUB_PARTITION = 'persist:workbench-github';
export const PERPLEXITY_PARTITION = 'persist:workbench-perplexity';
export const BROWSER_PARTITION = 'persist:workbench-browser';
export const DEFAULT_BROWSER_PROFILE_ID = 'main';
const BROWSER_PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BROWSER_PROFILE_SITES = new Set(['chatgpt', 'github', 'perplexity', 'browser']);
export const CHANNEL = 'workbench:chatgpt';
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
const githubFileDeliveryHosts = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'media.githubusercontent.com',
]);

export function isGithubFileDeliveryHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  return githubFileDeliveryHosts.has(hostname.toLowerCase());
}

export function githubEmbeddedUrl(value) {
  const url = httpsUrl(value);
  if (!url) return false;
  return githubUrl(value) || authHosts.has(url.hostname) || githubAssetHosts.has(url.hostname) || url.hostname.endsWith('.githubusercontent.com');
}

const perplexityAuthHosts = new Set(['auth.perplexity.ai', 'accounts.google.com', 'appleid.apple.com']);
const perplexityAssetHosts = new Set(['cdn.perplexity.ai', 'assets.perplexity.ai', 'media.perplexity.ai']);
/**
 * Trusted Perplexity file-delivery hosts:
 * - Perplexity-owned CDN and export subdomains (`*.perplexity.ai`)
 * - `pplx-res.cloudinary.com`: Perplexity's official Cloudinary media/export delivery host
 */
const perplexityFileDeliveryHosts = new Set([
  'cdn.perplexity.ai',
  'assets.perplexity.ai',
  'media.perplexity.ai',
  'r2cdn.perplexity.ai',
  'files.perplexity.ai',
  'export.perplexity.ai',
  'pplx-res.cloudinary.com',
]);

export function isPerplexityFileDeliveryHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  return perplexityFileDeliveryHosts.has(hostname.toLowerCase());
}

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
  return perplexityUrl(value) || authHosts.has(url.hostname) || perplexityAuthHosts.has(url.hostname) || perplexityAssetHosts.has(url.hostname) || isPerplexityFileDeliveryHost(url.hostname);
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

export function parseBlobDownloadUrl(value, maxLength = 2048) {
  if (typeof value !== 'string' || !value.startsWith('blob:') || value.length > maxLength || /[\u0000-\u0020\u007f]/.test(value)) {
    return null;
  }
  const inner = value.slice(5);
  try {
    const parsed = new URL(inner);
    if (parsed.username || parsed.password) return null;
    if (!parsed.pathname || parsed.pathname === '/' || parsed.pathname.includes('..')) return null;
    return {
      inner,
      origin: parsed.origin,
      protocol: parsed.protocol,
      hostname: parsed.hostname.toLowerCase(),
      pathname: parsed.pathname,
    };
  } catch {
    return null;
  }
}

export function downloadOriginAllowed(provider, value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (provider === 'chatgpt') return chatUrl(url.origin);
    if (provider === 'perplexity') return perplexityUrl(url.origin);
    if (provider === 'github') {
      return url.protocol === 'https:' && !url.port && (
        githubUrl(url.origin) ||
        isGithubFileDeliveryHost(url.hostname) ||
        url.hostname.endsWith('.githubusercontent.com')
      );
    }
    if (provider === 'other') return otherUrl(value, 8192);
    return false;
  } catch {
    return false;
  }
}

export function isAllowedBlobDownloadUrl(provider, value, contextOrigin = null) {
  const blob = parseBlobDownloadUrl(value);
  if (!blob) return false;

  let providerOk = false;
  if (provider === 'chatgpt') providerOk = chatUrl(blob.inner);
  else if (provider === 'perplexity') providerOk = perplexityUrl(blob.inner);
  else if (provider === 'github') providerOk = githubUrl(blob.inner);
  else if (provider === 'other') providerOk = otherUrl(blob.inner);
  if (!providerOk) return false;

  if (contextOrigin) {
    try {
      const ctx = new URL(contextOrigin);
      if (!downloadOriginAllowed(provider, ctx.origin)) return false;
      if (provider === 'other') {
        if (ctx.origin !== blob.origin) return false;
      } else if (ctx.origin !== blob.origin && !isSameSite(ctx.origin, blob.origin)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function isProviderFileDeliveryUrl(provider, value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('blob:')) return isAllowedBlobDownloadUrl(provider, value);
  const url = httpsUrl(value);
  if (!url) return false;
  if (provider === 'chatgpt') return isFileDeliveryHost(url.hostname);
  if (provider === 'perplexity') return isPerplexityFileDeliveryHost(url.hostname);
  if (provider === 'github') return isGithubFileDeliveryHost(url.hostname);
  return false;
}

export function isDownloadOrFileDeliveryUrl(value, provider = 'chatgpt') {
  return isProviderFileDeliveryUrl(provider, value);
}

export function downloadDestinationAllowed(provider, value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.startsWith('blob:')) return isAllowedBlobDownloadUrl(provider, value);
  if (authenticationUrl(value)) return false;
  if (provider === 'chatgpt') return chatUrl(value) || isProviderFileDeliveryUrl('chatgpt', value);
  if (provider === 'perplexity') return perplexityUrl(value) || isProviderFileDeliveryUrl('perplexity', value);
  if (provider === 'github') return githubUrl(value) || isProviderFileDeliveryUrl('github', value);
  if (provider === 'other') return otherUrl(value, 8192);
  return false;
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

export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  let clean = host.trim().toLowerCase();
  if (clean.startsWith('[') && clean.includes(']')) {
    const closeIdx = clean.indexOf(']');
    clean = clean.slice(0, closeIdx + 1);
  } else if (!clean.includes(':') || clean.indexOf(':') === clean.lastIndexOf(':')) {
    clean = clean.split(':')[0] ?? clean;
  }
  if (clean === 'localhost' || clean.endsWith('.localhost')) return true;
  const unbracketed = clean.startsWith('[') && clean.endsWith(']') ? clean.slice(1, -1) : clean;
  if (unbracketed === '::1' || unbracketed === '0:0:0:0:0:0:0:1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean);
  if (match) {
    const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
    if (octets.every(o => o >= 0 && o <= 255)) {
      return octets[0] === 127;
    }
  }
  return false;
}

export function isPrivateOrLoopbackIPv4(ip) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return false;
  const [b0, b1, b2, b3] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  if ([b0, b1, b2, b3].some(b => b < 0 || b > 255)) return false;
  if (b0 === 127) return true; // 127.0.0.0/8 loopback
  if (b0 === 10) return true; // 10.0.0.0/8 private
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12 private
  if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16 private
  if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

export function isPrivateOrLoopbackIPv6(ip) {
  let clean = ip.toLowerCase().trim();
  if (clean.startsWith('[') && clean.endsWith(']')) clean = clean.slice(1, -1);
  clean = clean.split('%')[0] ?? '';
  if (clean === '::1' || clean === '0:0:0:0:0:0:0:1') return true;
  if (clean.startsWith('::ffff:')) {
    const v4 = clean.slice(7);
    return isPrivateOrLoopbackIPv4(v4);
  }
  const hextets = clean.split(':');
  if (hextets.length < 3) return false;
  const firstHextet = clean.startsWith('::') ? '0' : hextets[0];
  if (/^[0-9a-f]{1,4}$/i.test(firstHextet)) {
    const num = parseInt(firstHextet, 16);
    if (!Number.isNaN(num)) {
      if ((num & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
      if ((num & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    }
  }
  return false;
}

export function isLocalHostname(host) {
  if (typeof host !== 'string') return false;
  let clean = host.trim().toLowerCase();
  if (clean.startsWith('[') && clean.includes(']')) return false;
  if (clean.includes(':')) clean = clean.split(':')[0] ?? '';
  if (!clean || clean.length > 253 || clean.endsWith('.')) return false;

  const localSuffixes = ['local', 'internal', 'lan', 'home', 'home.arpa'];
  if (localSuffixes.some(suffix => clean === suffix || clean.endsWith('.' + suffix))) {
    return true;
  }
  if (clean === 'localhost' || clean.endsWith('.localhost')) {
    return true;
  }
  if (!clean.includes('.')) {
    if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(clean) && !/^\d+$/.test(clean)) {
      const reserved = new Set(['test', 'invalid', 'example']);
      if (!reserved.has(clean)) return true;
    }
  }
  return false;
}

export function isLocalOrPrivateHost(host) {
  if (typeof host !== 'string') return false;
  let clean = host.trim().toLowerCase();
  if (clean.startsWith('[') && clean.includes(']')) {
    const closeIdx = clean.indexOf(']');
    clean = clean.slice(0, closeIdx + 1);
  } else if (!clean.includes(':') || clean.indexOf(':') === clean.lastIndexOf(':')) {
    clean = clean.split(':')[0] ?? clean;
  }
  if (clean.endsWith('.')) return false;
  if (isPrivateOrLoopbackIPv4(clean)) return true;
  if (isPrivateOrLoopbackIPv6(clean)) return true;
  return isLocalHostname(clean);
}

export function isWorkbenchBackendUrl(value, backendPort) {
  if (!backendPort || typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!isLoopbackHost(host)) return false;
    const port = Number(url.port || (url.protocol === 'http:' ? 80 : 443));
    return port === Number(backendPort);
  } catch {
    return false;
  }
}

/**
 * General web pages in embedded Electron WebContentsViews support public HTTP(S)
 * as well as local web applications, developer servers, Docker services, LAN
 * dashboards, and self-hosted services on loopback and private networks.
 * Requests to Workbench's own backend loopback port are strictly excluded.
 */
export function otherUrl(value, maxLength = 2048, options = {}) {
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u0020\u007f]/.test(value)) return false;

  const rawHostMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(value);
  if (!rawHostMatch) return false;
  let rawHost = rawHostMatch[1].split('@').pop() ?? '';
  if (rawHost.startsWith('[')) {
    const end = rawHost.indexOf(']');
    if (end === -1) return false;
    rawHost = rawHost.slice(0, end + 1);
  } else {
    rawHost = rawHost.split(':')[0] ?? '';
  }
  if (rawHost.endsWith('.') || /^\d+$/.test(rawHost) || /^0x[0-9a-f]+$/i.test(rawHost)) {
    return false;
  }

  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host.endsWith('.')) return false;

    const backendPort = options?.backendPort;
    if (backendPort && isWorkbenchBackendUrl(value, backendPort)) {
      return false;
    }

    if (isLocalOrPrivateHost(host)) {
      return true;
    }

    const bareHost = host.replace(/^\[|\]$/g, '');
    if (isIP(bareHost) || !host.includes('.')) return false;
    if (blockedPublicSuffixes.some(suffix => host === suffix || host.endsWith('.' + suffix))) return false;
    return true;
  } catch { return false; }
}

export function serviceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.hash) throw new Error('WORKBENCH_DESKTOP_URL must be the local MAW http://127.0.0.1:PORT/ URL');
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
    return `persist:workbench-${suffix}`;
  }
  return `persist:workbench-profile-${effective}-${suffix}`;
}

export function validCommand(value, options = {}) {
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
    if (value.provider === 'other') return otherUrl(value.url, 2048, options);
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
      return (value.action === 'open-link' || value.action === 'open-link-external' || value.action === 'copy-link') && UUID.test(value.id) && (externalUrl(value.url) || otherUrl(value.url));
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
  if (value.type === 'inspect-page') {
    if (!record(value) || typeof value.id !== 'string' || !UUID.test(value.id)) return false;
    if ('x' in value || 'y' in value) {
      if (!exact(value, ['type', 'id', 'x', 'y'])) return false;
      return Number.isSafeInteger(value.x) && value.x >= 0 && value.x <= 32768 &&
        Number.isSafeInteger(value.y) && value.y >= 0 && value.y <= 32768;
    }
    return exact(value, ['type', 'id']);
  }
  if (value.type === 'get-available-spellcheck-languages') return exact(value, ['type']);
  if (value.type === 'get-spellcheck-status') return exact(value, ['type']);
  if (value.type === 'update-spellcheck-settings') {
    if (!exact(value, ['type', 'enabled', 'languages'])) return false;
    if (typeof value.enabled !== 'boolean') return false;
    if (!Array.isArray(value.languages) || value.languages.length > 64) return false;
    return value.languages.every(lang => typeof lang === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,4})*$/.test(lang) && lang.length <= 32);
  }
  if (value.type === 'reconcile-custom-dictionary') {
    if (!exact(value, ['type', 'customWordsByProfile'])) return false;
    if (!record(value.customWordsByProfile)) return false;
    const entries = Object.entries(value.customWordsByProfile);
    if (entries.length > 64) return false;
    return entries.every(([profileId, words]) =>
      isValidBrowserProfileId(profileId) &&
      Array.isArray(words) &&
      words.length <= 2048 &&
      words.every(w => typeof w === 'string' && w.trim().length > 0 && w.length <= 128 && !/[\r\n\0]/.test(w)),
    );
  }
  if (value.type === 'list-custom-dictionary-words') {
    return exact(value, ['type']) || (exact(value, ['type', 'profileId']) && isValidBrowserProfileId(value.profileId));
  }
  if (value.type === 'add-custom-dictionary-word') {
    const validShape = exact(value, ['type', 'word']) ||
      (exact(value, ['type', 'word', 'profileId']) && isValidBrowserProfileId(value.profileId));
    return validShape && typeof value.word === 'string' && value.word.trim().length > 0 && value.word.length <= 128 && !/[\r\n\0]/.test(value.word);
  }
  if (value.type === 'remove-custom-dictionary-word') {
    const validShape = exact(value, ['type', 'word']) ||
      (exact(value, ['type', 'word', 'profileId']) && isValidBrowserProfileId(value.profileId));
    return validShape && typeof value.word === 'string' && value.word.trim().length > 0 && value.word.length <= 128 && !/[\r\n\0]/.test(value.word);
  }
  if (value.type === 'get-hardware-acceleration') return exact(value, ['type']);
  if (value.type === 'set-hardware-acceleration') return exact(value, ['type', 'enabled']) && typeof value.enabled === 'boolean';
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

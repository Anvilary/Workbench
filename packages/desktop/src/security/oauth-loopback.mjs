const PLAUSIBLE_CALLBACK_SUFFIXES = [
  '/callback',
  '/oauth/callback',
  '/oauth2/callback',
  '/oauth2callback',
  '/auth/callback',
  '/oidc/callback',
  '/signin-oidc',
  '/login/callback',
];

function isPlausibleCallbackPath(pathname) {
  const normPath = pathname.toLowerCase().replace(/\/+$/, '');
  if (!normPath) return false;
  return PLAUSIBLE_CALLBACK_SUFFIXES.some(
    (suffix) => normPath === suffix || normPath.endsWith(suffix),
  );
}

/**
 * Validates whether a URL is a loopback OAuth callback carrying a non-empty
 * authorization code or error on a plausible callback path that should be
 * handed back to a local system listener. Excludes Workbench's own port when
 * `excludePort` is provided.
 */
export function isOAuthLoopbackCallback(value, options = {}) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.username || url.password) return false;
    if (!url.port) return false;
    const portNum = Number(url.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return false;
    if (options?.excludePort !== undefined && options.excludePort !== null && String(options.excludePort) !== '') {
      if (String(portNum) === String(options.excludePort)) return false;
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
    if (!isPlausibleCallbackPath(url.pathname)) return false;
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const hasCode = typeof code === 'string' && code.trim().length > 0;
    const hasError = typeof error === 'string' && error.trim().length > 0;
    if (!hasCode && !hasError) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Rate-limiting gate for loopback OAuth external handoffs so a compromised or
 * misbehaving page cannot flood `shell.openExternal`.
 */
export function createOAuthLoopbackGate({
  maxRequests = 3,
  windowMs = 10_000,
  now = () => Date.now(),
} = {}) {
  const timestamps = new Map();
  return function allow(sourceKey = 'global') {
    const current = now();
    const key = String(sourceKey || 'global');
    const recent = (timestamps.get(key) || []).filter((ts) => current - ts < windowMs);
    if (recent.length >= maxRequests) {
      timestamps.set(key, recent);
      return false;
    }
    recent.push(current);
    timestamps.set(key, recent);
    return true;
  };
}

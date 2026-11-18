/**
 * Validates whether a URL is a loopback OAuth callback carrying an authorization
 * code or error that should be handed back to a local system listener.
 */
export function isOAuthLoopbackCallback(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
    const hasCode = url.searchParams.has('code');
    const hasError = url.searchParams.has('error');
    if (!hasCode && !hasError) return false;
    const normPath = url.pathname.toLowerCase().replace(/\/+$/, '');
    const isCallbackPath =
      normPath === '/callback' ||
      normPath.endsWith('/callback') ||
      normPath === '/oauth/callback' ||
      normPath.endsWith('/oauth/callback') ||
      normPath === '/auth/callback' ||
      normPath.endsWith('/auth/callback');
    if (!isCallbackPath && !hasCode) return false;
    return true;
  } catch {
    return false;
  }
}

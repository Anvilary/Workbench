import {
  authenticationUrl as defaultAuthenticationUrl,
  otherUrl as defaultOtherUrl,
  perplexityUrl as defaultPerplexityUrl,
} from '../../policy.mjs';

const CHAT_ALLOWED_ORIGINS = ['https://chatgpt.com', 'https://chat.openai.com'];
const GITHUB_ALLOWED_ORIGINS = ['https://github.com'];
const PERPLEXITY_ALLOWED_ORIGINS = ['https://www.perplexity.ai', 'https://perplexity.ai'];

function isInteractivePermission(permission) {
  return permission === 'fullscreen' || permission === 'pointerLock' || permission === 'speaker-selection';
}

function sameOriginMatch(contents, requestingUrl, allowedOrigins) {
  try {
    if (!contents) return false;
    const origin = new URL(contents.getURL()).origin;
    const reqOrigin = new URL(requestingUrl).origin;
    return allowedOrigins.includes(origin) && allowedOrigins.includes(reqOrigin);
  } catch {
    return false;
  }
}

/**
 * Configures strict permission handlers (and local-network webRequest filtering
 * for general browser partitions) for a single Electron provider session.
 */
export function configureProviderSessionPermissions({
  provider,
  session,
  otherUrl = defaultOtherUrl,
  authenticationUrl = defaultAuthenticationUrl,
}) {
  if (!session) return;

  if (provider === 'other') {
    session.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(isInteractivePermission(permission) || permission === 'clipboard-sanitized-write');
    });
    session.setPermissionCheckHandler((_contents, permission) => {
      return (
        isInteractivePermission(permission) ||
        permission === 'automatic-fullscreen' ||
        permission === 'clipboard-sanitized-write'
      );
    });
    session.webRequest.onBeforeRequest((details, callback) => {
      // Block direct local-network URLs, including subframes and fetches, in general web pages.
      const network = /^(https?|wss?):/.test(details.url);
      const checked = details.url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
      callback({
        cancel:
          network &&
          !otherUrl(checked, 8192) &&
          !(details.url.startsWith('https:') && authenticationUrl(details.url)),
      });
    });
    return;
  }

  if (provider === 'chatgpt') {
    // Permit clipboard writing and audio-only media only from official ChatGPT origins.
    // Clipboard reading and all unrelated permissions remain denied.
    const canWriteChatClipboard = (contents, requestingUrl) =>
      sameOriginMatch(contents, requestingUrl, CHAT_ALLOWED_ORIGINS);

    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === 'media' && details?.mediaTypes?.includes('audio') && !details?.mediaTypes?.includes('video')) {
        if (sameOriginMatch(contents, details?.requestingUrl, CHAT_ALLOWED_ORIGINS)) {
          callback(true);
          return;
        }
      }
      callback(
        isInteractivePermission(permission) ||
          (permission === 'clipboard-sanitized-write' && canWriteChatClipboard(contents, details?.requestingUrl)),
      );
    });

    session.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
      if (permission === 'media') {
        return sameOriginMatch(contents, requestingOrigin, CHAT_ALLOWED_ORIGINS);
      }
      return (
        isInteractivePermission(permission) ||
        permission === 'automatic-fullscreen' ||
        (permission === 'clipboard-sanitized-write' && canWriteChatClipboard(contents, requestingOrigin))
      );
    });
    return;
  }

  const allowedClipboardOrigins = provider === 'github'
    ? GITHUB_ALLOWED_ORIGINS
    : provider === 'perplexity'
      ? PERPLEXITY_ALLOWED_ORIGINS
      : null;

  if (!allowedClipboardOrigins) return;

  const canWriteClipboard = (contents, requestingUrl) =>
    sameOriginMatch(contents, requestingUrl, allowedClipboardOrigins);

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      isInteractivePermission(permission) ||
        (permission === 'clipboard-sanitized-write' && canWriteClipboard(contents, details?.requestingUrl)),
    );
  });
  session.setPermissionCheckHandler(
    (contents, permission, requestingOrigin) =>
      isInteractivePermission(permission) ||
      permission === 'automatic-fullscreen' ||
      (permission === 'clipboard-sanitized-write' && canWriteClipboard(contents, requestingOrigin)),
  );
}

/**
 * Configures strict per-partition permission handlers and local-network webRequest
 * filtering across the isolated Electron browser sessions.
 */
export function configureBrowserSessionPermissions({
  chatSession,
  githubSession,
  perplexitySession,
  browserSession,
  otherUrl = defaultOtherUrl,
  authenticationUrl = defaultAuthenticationUrl,
}) {
  configureProviderSessionPermissions({ provider: 'other', session: browserSession, otherUrl, authenticationUrl });
  configureProviderSessionPermissions({ provider: 'chatgpt', session: chatSession, otherUrl, authenticationUrl });
  configureProviderSessionPermissions({ provider: 'github', session: githubSession, otherUrl, authenticationUrl });
  configureProviderSessionPermissions({ provider: 'perplexity', session: perplexitySession, otherUrl, authenticationUrl });
}

function hasSensitiveParamsOrAuthPath(url, checkAuthPath = true) {
  if (checkAuthPath && /^\/(api|auth)(\/|$)/.test(url.pathname)) return true;
  return [...url.searchParams.keys()].some((key) => /token|code|state|session/i.test(key));
}

export function isDurableProviderPage(
  provider,
  value,
  { otherUrl = defaultOtherUrl, perplexityUrl = defaultPerplexityUrl } = {},
) {
  if (provider === 'other') {
    try {
      const url = new URL(value);
      return otherUrl(value) && !hasSensitiveParamsOrAuthPath(url, true);
    } catch {
      return false;
    }
  }
  if (provider === 'github') {
    try {
      const url = new URL(value);
      return url.origin === 'https://github.com' && !hasSensitiveParamsOrAuthPath(url, false);
    } catch {
      return false;
    }
  }
  if (provider === 'perplexity') {
    try {
      const url = new URL(value);
      return perplexityUrl(value) && !hasSensitiveParamsOrAuthPath(url, true);
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(value);
    return CHAT_ALLOWED_ORIGINS.includes(url.origin) && !hasSensitiveParamsOrAuthPath(url, true);
  } catch {
    return false;
  }
}

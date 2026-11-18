import {
  authenticationUrl as defaultAuthenticationUrl,
  otherUrl as defaultOtherUrl,
  perplexityUrl as defaultPerplexityUrl,
} from '../../policy.mjs';

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
  browserSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(isInteractivePermission(permission) || permission === 'clipboard-sanitized-write');
  });
  browserSession.setPermissionCheckHandler((_contents, permission) => {
    return (
      isInteractivePermission(permission) ||
      permission === 'automatic-fullscreen' ||
      permission === 'clipboard-sanitized-write'
    );
  });
  browserSession.webRequest.onBeforeRequest((details, callback) => {
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

  // Permit clipboard writing only from the official ChatGPT origin.
  // Clipboard reading and all unrelated permissions remain denied.
  const canWriteChatClipboard = (contents, requestingUrl) =>
    sameOriginMatch(contents, requestingUrl, ['https://chatgpt.com']);

  chatSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'media' && details?.mediaTypes?.includes('audio') && !details?.mediaTypes?.includes('video')) {
      if (sameOriginMatch(contents, details?.requestingUrl, ['https://chatgpt.com'])) {
        callback(true);
        return;
      }
    }
    callback(
      isInteractivePermission(permission) ||
        (permission === 'clipboard-sanitized-write' && canWriteChatClipboard(contents, details?.requestingUrl)),
    );
  });

  chatSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    if (permission === 'media') {
      return sameOriginMatch(contents, requestingOrigin, ['https://chatgpt.com']);
    }
    return (
      isInteractivePermission(permission) ||
      permission === 'automatic-fullscreen' ||
      (permission === 'clipboard-sanitized-write' && canWriteChatClipboard(contents, requestingOrigin))
    );
  });

  const canWriteGithubClipboard = (contents, requestingUrl) =>
    sameOriginMatch(contents, requestingUrl, ['https://github.com']);

  githubSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      isInteractivePermission(permission) ||
        (permission === 'clipboard-sanitized-write' && canWriteGithubClipboard(contents, details?.requestingUrl)),
    );
  });
  githubSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin) =>
      isInteractivePermission(permission) ||
      permission === 'automatic-fullscreen' ||
      (permission === 'clipboard-sanitized-write' && canWriteGithubClipboard(contents, requestingOrigin)),
  );

  const canWritePerplexityClipboard = (contents, requestingUrl) =>
    sameOriginMatch(contents, requestingUrl, ['https://www.perplexity.ai', 'https://perplexity.ai']);

  perplexitySession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      isInteractivePermission(permission) ||
        (permission === 'clipboard-sanitized-write' && canWritePerplexityClipboard(contents, details?.requestingUrl)),
    );
  });
  perplexitySession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin) =>
      isInteractivePermission(permission) ||
      permission === 'automatic-fullscreen' ||
      (permission === 'clipboard-sanitized-write' && canWritePerplexityClipboard(contents, requestingOrigin)),
  );
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
    return url.origin === 'https://chatgpt.com' && !hasSensitiveParamsOrAuthPath(url, true);
  } catch {
    return false;
  }
}

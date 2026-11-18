/**
 * Safe browser profile storage cloning and per-site authentication clearing.
 *
 * Safe Cloning Scope and Live Chromium LevelDB Limitation:
 * - Active Electron/Chromium sessions hold exclusive locks and live WAL/memtable
 *   state on LevelDB databases (LocalStorage, IndexedDB, ServiceWorkers, Cache).
 *   Copying raw Partition directories on disk while a session is active risks
 *   SQLite/LevelDB corruption and stale lock errors.
 * - Therefore, profile cloning operates strictly through Electron's live
 *   `session.fromPartition(...)` cookie API (`flushStore()`, `cookies.get()`,
 *   `cookies.set()`).
 * - Origin-scoped LocalStorage / IndexedDB entries are NOT hot-copied across
 *   live partitions; cloned profiles inherit HTTP session/auth cookies (except
 *   for sites excluded by `clearSites`).
 * - Source partitions are read-only during cloning and never mutated.
 * - Raw cookie values and tokens are never returned across IPC.
 */

import {
  DEFAULT_BROWSER_PROFILE_ID,
  isValidBrowserProfileId,
  partitionForBrowserProfile,
} from '../../policy.mjs';

const SITE_TO_PROVIDER = Object.freeze({
  chatgpt: 'chatgpt',
  github: 'github',
  perplexity: 'perplexity',
  browser: 'other',
});

const PROFILE_SITES = Object.freeze(['chatgpt', 'github', 'perplexity', 'browser']);
const VALID_SAME_SITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict']);

function assertValidSite(site) {
  if (typeof site !== 'string' || !Object.hasOwn(SITE_TO_PROVIDER, site)) {
    throw new Error(`Invalid browser profile site: ${String(site)}`);
  }
}

async function flushSessionSafely(sess) {
  if (!sess) return;
  try {
    if (typeof sess.flushStorageData === 'function') {
      sess.flushStorageData();
    }
  } catch {}
  try {
    if (sess.cookies && typeof sess.cookies.flushStore === 'function') {
      await sess.cookies.flushStore();
    }
  } catch {}
}

/**
 * Converts an Electron Cookie object returned by `cookies.get()` into a safe
 * `CookiesSetDetails` object accepted by `cookies.set()`.
 * @param {object} cookie
 * @returns {object|null}
 */
export function toCookieSetDetails(cookie) {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
    return null;
  }
  const rawDomain = typeof cookie.domain === 'string' ? cookie.domain : '';
  const cleanDomain = rawDomain.replace(/^\.+/, '');
  if (!cleanDomain) return null;

  const isSecure = Boolean(cookie.secure) || cookie.name.startsWith('__Host-') || cookie.name.startsWith('__Secure-');
  const scheme = isSecure ? 'https' : 'http';
  const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
  const url = `${scheme}://${cleanDomain}${cookiePath}`;

  const details = {
    url,
    name: cookie.name,
    value: cookie.value,
    path: cookiePath,
    secure: isSecure,
    httpOnly: Boolean(cookie.httpOnly),
  };

  // Preserve host-only semantics and __Host- prefix invariants by omitting domain when hostOnly.
  const isHostOnly = cookie.hostOnly === true || cookie.name.startsWith('__Host-') || !rawDomain.startsWith('.');
  if (!isHostOnly && rawDomain) {
    details.domain = rawDomain;
  }

  if (!cookie.session && typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)) {
    details.expirationDate = cookie.expirationDate;
  }

  if (typeof cookie.sameSite === 'string' && VALID_SAME_SITE.has(cookie.sameSite)) {
    if (cookie.sameSite !== 'no_restriction' || isSecure) {
      details.sameSite = cookie.sameSite;
    }
  }

  return details;
}

/**
 * Clones cookie state from `sourceProfileId` to `targetProfileId` across all
 * provider partitions, skipping any site listed in `clearSites`.
 */
export async function cloneBrowserProfileStorage({
  sessionApi,
  sourceProfileId,
  targetProfileId,
  clearSites = [],
  partitionForProfile = partitionForBrowserProfile,
}) {
  if (!sessionApi || typeof sessionApi.fromPartition !== 'function') {
    throw new Error('Electron session API is required');
  }
  if (!isValidBrowserProfileId(sourceProfileId)) {
    throw new Error('Invalid source browser profile ID');
  }
  if (!isValidBrowserProfileId(targetProfileId) || targetProfileId === DEFAULT_BROWSER_PROFILE_ID) {
    throw new Error('Invalid target browser profile ID');
  }
  if (sourceProfileId === targetProfileId) {
    throw new Error('Target browser profile ID must differ from source profile ID');
  }
  if (!Array.isArray(clearSites)) {
    throw new Error('clearSites must be an array');
  }

  const clearSet = new Set();
  for (const site of clearSites) {
    assertValidSite(site);
    clearSet.add(site);
  }

  const clonedSites = [];
  const clearedSites = [];
  const plans = [];
  for (const site of PROFILE_SITES) {
    const provider = SITE_TO_PROVIDER[site];
    const targetPartition = partitionForProfile(targetProfileId, provider);
    const targetSession = sessionApi.fromPartition(targetPartition);
    if ((await targetSession.cookies.get({})).length > 0) {
      throw new Error('Browser profile clone destination already contains cookies');
    }

    if (clearSet.has(site)) {
      clearedSites.push(site);
      continue;
    }

    const sourcePartition = partitionForProfile(sourceProfileId, provider);
    const sourceSession = sessionApi.fromPartition(sourcePartition);

    // Flush source cookies first without modifying source state.
    await flushSessionSafely(sourceSession);

    const cookies = sourceSession.cookies && typeof sourceSession.cookies.get === 'function'
      ? await sourceSession.cookies.get({})
      : [];

    const details = cookies.map(toCookieSetDetails);
    if (details.some(cookie => !cookie)) throw new Error('Browser profile contains an unsupported cookie');
    plans.push({ site, targetSession, details });
  }

  const written = [];
  try {
    for (const { site, targetSession, details } of plans) {
      for (const cookie of details) {
        await targetSession.cookies.set(cookie);
        written.push({ targetSession, cookie });
      }
      await targetSession.cookies.flushStore();
      clonedSites.push(site);
    }
  } catch {
    await Promise.allSettled(written.map(async ({ targetSession, cookie }) => {
      await targetSession.cookies.remove(cookie.url, cookie.name);
      await targetSession.cookies.flushStore();
    }));
    throw new Error('Browser profile cookies could not be copied');
  }

  return {
    ok: true,
    sourceProfileId,
    targetProfileId,
    clonedSites,
    clearedSites,
    cookiesCopied: written.length,
    cookiesSkipped: 0,
  };
}

/**
 * Clears all site authentication cookies and storage data for a single
 * `(profileId, site)` partition and flushes the store.
 */
export async function clearProfileSiteAuth({
  sessionApi,
  profileId,
  site,
  partitionForProfile = partitionForBrowserProfile,
}) {
  if (!sessionApi || typeof sessionApi.fromPartition !== 'function') {
    throw new Error('Electron session API is required');
  }
  if (!isValidBrowserProfileId(profileId)) {
    throw new Error('Invalid browser profile ID');
  }
  assertValidSite(site);

  const provider = SITE_TO_PROVIDER[site];
  const partition = partitionForProfile(profileId, provider);
  const targetSession = sessionApi.fromPartition(partition);

  if (typeof targetSession.clearStorageData === 'function') {
    await targetSession.clearStorageData();
  }
  if (typeof targetSession.clearAuthCache === 'function') {
    try {
      await targetSession.clearAuthCache();
    } catch {}
  }
  await flushSessionSafely(targetSession);

  return {
    ok: true,
    profileId,
    site,
    partition,
  };
}

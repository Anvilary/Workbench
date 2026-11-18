import type { WebTabProvider } from './browser-tabs.js';

export const DEFAULT_BROWSER_PROFILE_ID = 'main';
export type BrowserProfileId = string;
export type BrowserProfileSite = 'chatgpt' | 'github' | 'perplexity' | 'browser';

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface BrowserProfile {
  id: BrowserProfileId;
  name: string;
  createdAt: string;
  updatedAt: string;
  isDefault?: boolean;
}

export function isValidBrowserProfileId(value: unknown): value is BrowserProfileId {
  return typeof value === 'string' && (value === DEFAULT_BROWSER_PROFILE_ID || PROFILE_ID_RE.test(value));
}

export function resolveEffectiveBrowserProfileId(
  workspace?: { browserProfileId?: string | null } | null,
  project?: { browserProfileId?: string | null } | null,
): BrowserProfileId {
  const wsProfile = workspace?.browserProfileId;
  if (isValidBrowserProfileId(wsProfile)) return wsProfile;
  const projProfile = project?.browserProfileId;
  if (isValidBrowserProfileId(projProfile)) return projProfile;
  return DEFAULT_BROWSER_PROFILE_ID;
}

/**
 * Resolve the Electron partition name for a `(profileId, provider)` pair.
 * The default `main` profile maps to the original legacy partitions so
 * existing cookies and logins stay completely intact.
 */
export function partitionForBrowserProfile(profileId: string | undefined | null, provider: WebTabProvider): string {
  const effective = isValidBrowserProfileId(profileId) ? profileId : DEFAULT_BROWSER_PROFILE_ID;
  const suffix = provider === 'github' || provider === 'perplexity' ? provider : provider === 'other' ? 'browser' : 'chatgpt';
  if (effective === DEFAULT_BROWSER_PROFILE_ID) {
    return `persist:maw-${suffix}`;
  }
  return `persist:maw-profile-${effective}-${suffix}`;
}

export type BrowserProfileClientMessage =
  | { type: 'agency.browserProfiles.list'; requestId: string }
  | {
      type: 'agency.browserProfile.create';
      requestId: string;
      name: string;
      sourceProfileId?: BrowserProfileId;
      clearSites?: readonly BrowserProfileSite[];
    }
  | { type: 'agency.browserProfile.rename'; requestId: string; profileId: BrowserProfileId; name: string }
  | { type: 'agency.browserProfile.delete'; requestId: string; profileId: BrowserProfileId };

export type BrowserProfileServerMessage =
  | { type: 'agency.browserProfiles.snapshot'; requestId: string; profiles: readonly BrowserProfile[] }
  | {
      type: 'agency.browserProfile.created';
      requestId: string;
      profile: BrowserProfile;
      sourceProfileId?: BrowserProfileId;
      clearSites?: readonly BrowserProfileSite[];
    }
  | { type: 'agency.browserProfile.renamed'; requestId: string; profile: BrowserProfile }
  | { type: 'agency.browserProfile.deleted'; requestId: string; profileId: BrowserProfileId }
  | {
      type: 'agency.browserProfile.changed';
      change: 'created' | 'renamed' | 'deleted';
      profileId: BrowserProfileId;
      profile?: BrowserProfile;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isValidProfileName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const clean = value.trim();
  return clean.length >= 1 && clean.length <= 80 && !/[\u0000-\u001f\u007f]/.test(clean);
}

export function isBrowserProfile(value: unknown): value is BrowserProfile {
  return (
    isRecord(value) &&
    isValidBrowserProfileId(value['id']) &&
    isValidProfileName(value['name']) &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string' &&
    (value['isDefault'] === undefined || typeof value['isDefault'] === 'boolean')
  );
}

const VALID_SITES = new Set<BrowserProfileSite>(['chatgpt', 'github', 'perplexity', 'browser']);

export function parseBrowserProfileClientMessage(raw: unknown): BrowserProfileClientMessage | null {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') return null;
  const requestId = raw['requestId'];
  if (!isValidRequestId(requestId)) return null;
  switch (raw['type']) {
    case 'agency.browserProfiles.list':
      return Object.keys(raw).every((k) => k === 'type' || k === 'requestId')
        ? { type: 'agency.browserProfiles.list', requestId }
        : null;
    case 'agency.browserProfile.create': {
      if (!Object.keys(raw).every((k) => ['type', 'requestId', 'name', 'sourceProfileId', 'clearSites'].includes(k))) return null;
      if (!isValidProfileName(raw['name'])) return null;
      if (raw['sourceProfileId'] !== undefined && !isValidBrowserProfileId(raw['sourceProfileId'])) return null;
      let clearSites: readonly BrowserProfileSite[] | undefined;
      if (raw['clearSites'] !== undefined) {
        if (!Array.isArray(raw['clearSites']) || !raw['clearSites'].every((s) => typeof s === 'string' && VALID_SITES.has(s as BrowserProfileSite))) {
          return null;
        }
        clearSites = [...new Set(raw['clearSites'] as BrowserProfileSite[])];
      }
      return {
        type: 'agency.browserProfile.create',
        requestId,
        name: raw['name'].trim(),
        ...(raw['sourceProfileId'] !== undefined ? { sourceProfileId: raw['sourceProfileId'] as BrowserProfileId } : {}),
        ...(clearSites !== undefined ? { clearSites } : {}),
      };
    }
    case 'agency.browserProfile.rename': {
      if (!Object.keys(raw).every((k) => ['type', 'requestId', 'profileId', 'name'].includes(k))) return null;
      if (!isValidBrowserProfileId(raw['profileId']) || !isValidProfileName(raw['name'])) return null;
      return { type: 'agency.browserProfile.rename', requestId, profileId: raw['profileId'], name: raw['name'].trim() };
    }
    case 'agency.browserProfile.delete': {
      if (!Object.keys(raw).every((k) => ['type', 'requestId', 'profileId'].includes(k))) return null;
      if (!isValidBrowserProfileId(raw['profileId'])) return null;
      return { type: 'agency.browserProfile.delete', requestId, profileId: raw['profileId'] };
    }
    default:
      return null;
  }
}

export function parseBrowserProfileServerMessage(raw: unknown): BrowserProfileServerMessage | null {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') return null;
  switch (raw['type']) {
    case 'agency.browserProfiles.snapshot':
      if (!isValidRequestId(raw['requestId']) || !Array.isArray(raw['profiles']) || !raw['profiles'].every(isBrowserProfile)) return null;
      return { type: 'agency.browserProfiles.snapshot', requestId: raw['requestId'], profiles: raw['profiles'] };
    case 'agency.browserProfile.created':
      if (!isValidRequestId(raw['requestId']) || !isBrowserProfile(raw['profile'])) return null;
      return {
        type: 'agency.browserProfile.created',
        requestId: raw['requestId'],
        profile: raw['profile'],
        ...(isValidBrowserProfileId(raw['sourceProfileId']) ? { sourceProfileId: raw['sourceProfileId'] } : {}),
        ...(Array.isArray(raw['clearSites']) ? { clearSites: raw['clearSites'] as BrowserProfileSite[] } : {}),
      };
    case 'agency.browserProfile.renamed':
      if (!isValidRequestId(raw['requestId']) || !isBrowserProfile(raw['profile'])) return null;
      return { type: 'agency.browserProfile.renamed', requestId: raw['requestId'], profile: raw['profile'] };
    case 'agency.browserProfile.deleted':
      if (!isValidRequestId(raw['requestId']) || !isValidBrowserProfileId(raw['profileId'])) return null;
      return { type: 'agency.browserProfile.deleted', requestId: raw['requestId'], profileId: raw['profileId'] };
    case 'agency.browserProfile.changed':
      if (!['created', 'renamed', 'deleted'].includes(raw['change'] as string) || !isValidBrowserProfileId(raw['profileId'])) return null;
      if (raw['profile'] !== undefined && !isBrowserProfile(raw['profile'])) return null;
      return {
        type: 'agency.browserProfile.changed',
        change: raw['change'] as 'created' | 'renamed' | 'deleted',
        profileId: raw['profileId'],
        ...(raw['profile'] !== undefined ? { profile: raw['profile'] } : {}),
      };
    default:
      return null;
  }
}

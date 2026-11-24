/**
 * Shared Browser Settings & Dictionary Synchronization Store.
 *
 * Ownership contract:
 * - Backend `settings.json` (`appSettings`) is the authoritative source of truth.
 * - Custom dictionary mutations commit to the backend first via request-acknowledged
 *   `updateBrowserSettings({ customDictionary })`, then reconcile the committed map
 *   into Electron's per-partition dictionaries.
 * - `localStorage` is strictly a startup display cache for non-authoritative offline
 *   rendering and NEVER triggers native custom-dictionary reconciliation.
 * - Native IPC confirmation tracks applied revisions separately from desired revisions,
 *   enabling bounded event-driven recovery when native replication partially fails.
 */

import {
  DEFAULT_BROWSER_FAVORITES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_SEARCH_ENGINES,
  DEFAULT_SEARCH_ENGINE_ID,
  DEFAULT_SPELLCHECK_SETTINGS,
  isValidBrowserProfileId,
  parseBrowserSettings,
  type BrowserSettings,
  type BrowserSettingsPatch,
  type CustomDictionaryMutation,
  type SpellCheckSettings,
} from '@agent-workbench/shared';
import type { DesktopBridge } from '../../connection/desktop-bridge.js';
import type { AppSettingsApi } from '../settings/useAppSettings.js';

export const BROWSER_SETTINGS_STORAGE_KEY = 'agency-ui.browser-settings.v1';

export interface NativeDictionarySyncState {
  status: 'idle' | 'syncing' | 'synced' | 'failed';
  failedPartitions: string[];
  error: string | null;
}

export interface DictionaryMutationResult {
  success: boolean;
  error?: string;
  nativeSyncPending?: boolean;
}

interface StoreSnapshot {
  settings: BrowserSettings;
  nativeDictionarySync: NativeDictionarySyncState;
}

type StoreListener = (snapshot: StoreSnapshot) => void;

function cloneSpellCheck(sc?: SpellCheckSettings): SpellCheckSettings {
  const source = sc ?? DEFAULT_SPELLCHECK_SETTINGS;
  const configured = Array.isArray(source.configuredLanguages)
    ? [...source.configuredLanguages]
    : [...source.languages];
  const allowed = new Set(configured);
  const languages = (Array.isArray(source.languages) ? source.languages : configured).filter((l) => allowed.has(l));
  const customWordsByProfile: Record<string, string[]> = {};
  for (const pid of Object.keys(source.customWordsByProfile ?? {}).sort()) {
    const words = source.customWordsByProfile[pid];
    if (Array.isArray(words) && words.length > 0) {
      customWordsByProfile[pid] = [...words];
    }
  }
  return {
    enabled: source.enabled !== false,
    languages,
    configuredLanguages: configured,
    customWordsByProfile,
  };
}

export function createDefaultBrowserSettings(): BrowserSettings {
  return {
    defaultSearchEngine: DEFAULT_SEARCH_ENGINE_ID,
    favorites: [...DEFAULT_BROWSER_FAVORITES],
    searchEngines: [...DEFAULT_SEARCH_ENGINES],
    spellCheck: cloneSpellCheck(DEFAULT_SPELLCHECK_SETTINGS),
  };
}

function normalizeCustomWordsMap(map: Record<string, string[]> | undefined): Record<string, string[]> {
  const clean: Record<string, string[]> = {};
  for (const pid of Object.keys(map ?? {}).sort()) {
    const words = map?.[pid];
    if (Array.isArray(words) && words.length > 0) {
      clean[pid] = [...words];
    }
  }
  return clean;
}

function loadCachedBrowserSettings(): BrowserSettings {
  if (typeof window === 'undefined' || !window.localStorage) {
    return createDefaultBrowserSettings();
  }
  try {
    const raw = window.localStorage.getItem(BROWSER_SETTINGS_STORAGE_KEY);
    if (!raw) return createDefaultBrowserSettings();
    const parsed = parseBrowserSettings(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {
    // Malformed cache falls back safely
  }
  return createDefaultBrowserSettings();
}

function saveCachedBrowserSettings(settings: BrowserSettings): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota or disabled errors
  }
}

let currentSettings: BrowserSettings | null = null;
let hasAuthoritativeServerState = false;
let activeAppSettings: AppSettingsApi | null = null;
let lastServerStatusObject: BrowserSettings | undefined;

let desiredConfig: { enabled: boolean; languages: string[] } | null = null;
let desiredConfigKey = '';
let appliedConfigKey = '';
let configInFlightPromise: Promise<boolean> | null = null;

let desiredDictMap: Record<string, string[]> = {};
let desiredDictKey = '';
let appliedDictKey = '';
let dictInFlightPromise: Promise<{ ok: boolean; failedPartitions?: string[]; error?: string }> | null = null;

let lastBridgeRef: DesktopBridge | undefined;
let nativeSyncState: NativeDictionarySyncState = {
  status: 'idle',
  failedPartitions: [],
  error: null,
};

let attachedWindowRef: unknown = null;
const listeners = new Set<StoreListener>();

function getBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined' ? window.mawChatGpt : undefined;
}

function getLatestSettings(): BrowserSettings {
  if (currentSettings === null) {
    currentSettings = loadCachedBrowserSettings();
  }
  return currentSettings;
}

function getSnapshot(): StoreSnapshot {
  return {
    settings: getLatestSettings(),
    nativeDictionarySync: nativeSyncState,
  };
}

function notifyListeners(): void {
  const snap = getSnapshot();
  for (const listener of listeners) {
    listener(snap);
  }
}

function resetBridgeTrackingIfChanged(bridge: DesktopBridge | undefined): void {
  if (lastBridgeRef !== bridge) {
    lastBridgeRef = bridge;
    appliedConfigKey = '';
    appliedDictKey = '';
    configInFlightPromise = null;
    dictInFlightPromise = null;
    nativeSyncState = { status: 'idle', failedPartitions: [], error: null };
  }
}

function setDesiredConfig(sc: SpellCheckSettings | undefined): void {
  if (!sc) return;
  const payload = {
    enabled: sc.enabled !== false,
    languages: [...(sc.languages ?? [])],
  };
  desiredConfig = payload;
  desiredConfigKey = JSON.stringify(payload);
}

function setDesiredDict(sc: SpellCheckSettings | undefined): void {
  const map = normalizeCustomWordsMap(sc?.customWordsByProfile);
  desiredDictMap = map;
  desiredDictKey = JSON.stringify(map);
}

export function ensureNativeConfigSynced(bridge: DesktopBridge | undefined = getBridge()): Promise<boolean> {
  if (!bridge || !desiredConfig) return Promise.resolve(true);
  resetBridgeTrackingIfChanged(bridge);
  if (desiredConfigKey === appliedConfigKey) return Promise.resolve(true);
  if (configInFlightPromise) return configInFlightPromise;

  const run = async (): Promise<boolean> => {
    try {
      while (desiredConfig && desiredConfigKey !== appliedConfigKey) {
        const targetKey = desiredConfigKey;
        const payload = desiredConfig;
        try {
          const res = (await bridge.command({
            type: 'update-spellcheck-settings',
            enabled: payload.enabled,
            languages: payload.languages,
          })) as { ok?: boolean } | undefined;
          if (res?.ok) {
            appliedConfigKey = targetKey;
          } else {
            return false;
          }
        } catch {
          return false;
        }
      }
      return desiredConfigKey === appliedConfigKey;
    } finally {
      configInFlightPromise = null;
    }
  };

  configInFlightPromise = run();
  return configInFlightPromise;
}

export function ensureNativeDictionarySynced(
  bridge: DesktopBridge | undefined = getBridge(),
): Promise<{ ok: boolean; failedPartitions?: string[]; error?: string }> {
  if (!hasAuthoritativeServerState || !bridge) {
    return Promise.resolve({ ok: true });
  }
  resetBridgeTrackingIfChanged(bridge);
  if (desiredDictKey === appliedDictKey) {
    if (nativeSyncState.status !== 'synced') {
      nativeSyncState = { status: 'synced', failedPartitions: [], error: null };
      notifyListeners();
    }
    return Promise.resolve({ ok: true });
  }
  if (dictInFlightPromise) {
    return dictInFlightPromise;
  }

  const run = async (): Promise<{ ok: boolean; failedPartitions?: string[]; error?: string }> => {
    try {
      while (hasAuthoritativeServerState && desiredDictKey !== appliedDictKey) {
        const targetKey = desiredDictKey;
        const targetMap = normalizeCustomWordsMap(desiredDictMap);
        if (nativeSyncState.status !== 'syncing') {
          nativeSyncState = { status: 'syncing', failedPartitions: [], error: null };
          notifyListeners();
        }
        let res: { ok?: boolean; failedPartitions?: string[]; error?: string } | undefined;
        try {
          res = (await bridge.command({
            type: 'reconcile-custom-dictionary',
            customWordsByProfile: targetMap,
          })) as { ok?: boolean; failedPartitions?: string[]; error?: string } | undefined;
        } catch (err) {
          const error = err instanceof Error ? err.message : 'Failed to synchronize custom dictionary';
          nativeSyncState = { status: 'failed', failedPartitions: [], error };
          notifyListeners();
          return { ok: false, failedPartitions: [], error };
        }
        if (res?.ok) {
          appliedDictKey = targetKey;
          if (desiredDictKey === appliedDictKey) {
            nativeSyncState = { status: 'synced', failedPartitions: [], error: null };
            notifyListeners();
            return { ok: true };
          }
        } else {
          const failedPartitions = Array.isArray(res?.failedPartitions) ? [...res.failedPartitions] : [];
          const error = res?.error || 'Failed to synchronize custom dictionary across browser partitions';
          nativeSyncState = { status: 'failed', failedPartitions, error };
          notifyListeners();
          return { ok: false, failedPartitions, error };
        }
      }
      return { ok: true };
    } finally {
      dictInFlightPromise = null;
    }
  };

  dictInFlightPromise = run();
  return dictInFlightPromise;
}

function handleRecoveryTrigger(): void {
  const bridge = getBridge();
  if (!bridge) return;
  if (desiredConfig && desiredConfigKey !== appliedConfigKey && !configInFlightPromise) {
    void ensureNativeConfigSynced(bridge);
  }
  if (
    hasAuthoritativeServerState &&
    desiredDictKey !== appliedDictKey &&
    !dictInFlightPromise &&
    nativeSyncState.status !== 'syncing'
  ) {
    void ensureNativeDictionarySynced(bridge);
  }
}

function ensureRecoveryListeners(): void {
  if (typeof window === 'undefined' || attachedWindowRef === window) return;
  attachedWindowRef = window;
  window.addEventListener?.('focus', handleRecoveryTrigger);
  if (typeof document !== 'undefined') {
    document.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        handleRecoveryTrigger();
      }
    });
  }
}

export function setActiveAppSettings(appSettings?: AppSettingsApi): void {
  if (appSettings) {
    activeAppSettings = appSettings;
  }
}

export function subscribeBrowserSettingsStore(
  listener: StoreListener,
  deferInitialConfigSync = false,
): () => void {
  ensureRecoveryListeners();
  listeners.add(listener);
  listener(getSnapshot());
  const bridge = getBridge();
  const latest = getLatestSettings();
  if (!deferInitialConfigSync) {
    if (!desiredConfig && latest.spellCheck) {
      setDesiredConfig(latest.spellCheck);
    }
    if (desiredConfig && desiredConfigKey !== appliedConfigKey) {
      void ensureNativeConfigSynced(bridge);
    }
  }
  if (hasAuthoritativeServerState && desiredDictKey !== appliedDictKey && nativeSyncState.status !== 'failed') {
    void ensureNativeDictionarySynced(bridge);
  }
  return () => {
    listeners.delete(listener);
  };
}

export function syncAuthoritativeBrowserSettings(
  serverBrowser: BrowserSettings | undefined,
  options: { deferNativeDictSync?: boolean } = {},
): void {
  if (!serverBrowser || serverBrowser === lastServerStatusObject) return;
  lastServerStatusObject = serverBrowser;
  hasAuthoritativeServerState = true;
  currentSettings = serverBrowser;
  saveCachedBrowserSettings(serverBrowser);
  setDesiredConfig(serverBrowser.spellCheck);
  setDesiredDict(serverBrowser.spellCheck);
  notifyListeners();

  const bridge = getBridge();
  void ensureNativeConfigSynced(bridge);
  if (!options.deferNativeDictSync) {
    void ensureNativeDictionarySynced(bridge);
  }
}

export async function commitBrowserPatch(
  nextLocal: BrowserSettings,
  patch: { browser?: BrowserSettingsPatch; customDictionary?: CustomDictionaryMutation },
  appSettings?: AppSettingsApi,
): Promise<boolean> {
  currentSettings = nextLocal;
  saveCachedBrowserSettings(nextLocal);
  if (patch.browser?.spellCheck) {
    setDesiredConfig(nextLocal.spellCheck);
    void ensureNativeConfigSynced(getBridge());
  }
  notifyListeners();

  const targetApi = appSettings ?? activeAppSettings;
  if (!targetApi) return true;

  if (typeof targetApi.updateBrowserSettings === 'function') {
    const res = await targetApi.updateBrowserSettings(patch);
    if (res.ok && res.settings.browser) {
      syncAuthoritativeBrowserSettings(res.settings.browser);
      return true;
    }
    return false;
  }

  if (patch.browser) {
    targetApi.setBrowserSettings(patch.browser);
  }
  return true;
}

export function persistBrowserPreferencePatch(
  nextLocal: BrowserSettings,
  browserPatch: BrowserSettingsPatch,
  appSettings?: AppSettingsApi,
): void {
  void commitBrowserPatch(nextLocal, { browser: browserPatch }, appSettings);
}

function buildUpdatedCustomWordsMap(
  existingMap: Record<string, string[]>,
  profileId: string,
  updater: (current: string[]) => string[],
): Record<string, string[]> {
  const nextList = updater(existingMap[profileId] ?? []);
  const nextMap: Record<string, string[]> = {};
  const keys = new Set([...Object.keys(existingMap), profileId]);
  for (const pid of [...keys].sort()) {
    const list = pid === profileId ? nextList : existingMap[pid];
    if (list && list.length > 0) {
      nextMap[pid] = list;
    }
  }
  return nextMap;
}

export async function mutateAuthoritativeCustomDictionary(
  action: 'add' | 'remove',
  rawWord: string,
  profileId: string = DEFAULT_BROWSER_PROFILE_ID,
  appSettings?: AppSettingsApi,
): Promise<DictionaryMutationResult> {
  const effective = isValidBrowserProfileId(profileId) ? profileId : null;
  if (!effective) return { success: false, error: 'Invalid browser profile' };
  if (/[\r\n\0]/.test(rawWord)) return { success: false, error: 'Word contains invalid characters' };
  const clean = rawWord.trim();
  if (!clean) return { success: false, error: 'Word cannot be empty' };
  if (action === 'add' && clean.length > 128) {
    return { success: false, error: 'Word exceeds 128 characters' };
  }

  const bridge = getBridge();
  if (!bridge) {
    return { success: false, error: 'Custom dictionary changes require the desktop app' };
  }

  const latestBefore = getLatestSettings();
  const currentWords = latestBefore.spellCheck?.customWordsByProfile?.[effective] ?? [];
  if (action === 'add' && hasAuthoritativeServerState && currentWords.includes(clean)) {
    return { success: false, error: 'Word already exists in dictionary' };
  }

  const targetApi = appSettings ?? activeAppSettings;
  if (!targetApi) {
    // Standalone component harness without AppSettingsApi: native-only fallback
    let res: { ok?: boolean; error?: string } | undefined;
    try {
      res = (await bridge.command({
        type: action === 'add' ? 'add-custom-dictionary-word' : 'remove-custom-dictionary-word',
        word: clean,
        profileId: effective,
      })) as { ok?: boolean; error?: string } | undefined;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to update custom dictionary' };
    }
    if (!res?.ok) {
      return { success: false, error: res?.error || 'Failed to update custom dictionary' };
    }
    const latest = getLatestSettings();
    const sc = cloneSpellCheck(latest.spellCheck);
    const nextMap = buildUpdatedCustomWordsMap(sc.customWordsByProfile, effective, (list) =>
      action === 'add' ? (list.includes(clean) ? list : [...list, clean]) : list.filter((w) => w !== clean),
    );
    currentSettings = { ...latest, spellCheck: { ...sc, customWordsByProfile: nextMap } };
    saveCachedBrowserSettings(currentSettings);
    notifyListeners();
    return { success: true };
  }

  if (typeof targetApi.updateBrowserSettings === 'function') {
    // Authoritative-first: await durable backend commit BEFORE reconciling native Electron partitions.
    const commitRes = await targetApi.updateBrowserSettings({
      customDictionary: { action, profileId: effective, word: clean },
    });
    if (!commitRes.ok) {
      return { success: false, error: commitRes.error };
    }
    if (commitRes.settings.browser) {
      syncAuthoritativeBrowserSettings(commitRes.settings.browser, { deferNativeDictSync: true });
    }
    const syncRes = await ensureNativeDictionarySynced(bridge);
    if (!syncRes.ok) {
      return {
        success: true,
        nativeSyncPending: true,
        error: syncRes.error,
      };
    }
    return { success: true };
  }

  // Fallback for test doubles implementing only legacy `setBrowserSettings` without `updateBrowserSettings`
  const latest = getLatestSettings();
  const sc = cloneSpellCheck(latest.spellCheck);
  const nextMap = buildUpdatedCustomWordsMap(sc.customWordsByProfile, effective, (list) =>
    action === 'add' ? [...new Set([...list, clean])].sort() : list.filter((w) => w !== clean),
  );
  const next: BrowserSettings = { ...latest, spellCheck: { ...sc, customWordsByProfile: nextMap } };
  hasAuthoritativeServerState = true;
  currentSettings = next;
  saveCachedBrowserSettings(next);
  setDesiredDict(next.spellCheck);
  notifyListeners();
  targetApi.setBrowserSettings({ spellCheck: { customWordsByProfile: nextMap } });
  const syncRes = await ensureNativeDictionarySynced(bridge);
  return syncRes.ok
    ? { success: true }
    : { success: true, nativeSyncPending: true, error: syncRes.error };
}

export async function retryNativeDictionarySync(): Promise<{ ok: boolean; failedPartitions?: string[]; error?: string }> {
  return ensureNativeDictionarySynced(getBridge());
}

export function getBrowserSettingsStoreState(): StoreSnapshot {
  return getSnapshot();
}

/** Resets module-level browser-settings coordination state (for unit/E2E test isolation). */
export function resetBrowserSettingsStoreForTests(): void {
  currentSettings = null;
  hasAuthoritativeServerState = false;
  activeAppSettings = null;
  lastServerStatusObject = undefined;
  desiredConfig = null;
  desiredConfigKey = '';
  appliedConfigKey = '';
  configInFlightPromise = null;
  desiredDictMap = {};
  desiredDictKey = '';
  appliedDictKey = '';
  dictInFlightPromise = null;
  lastBridgeRef = undefined;
  attachedWindowRef = null;
  nativeSyncState = { status: 'idle', failedPartitions: [], error: null };
  listeners.clear();
}

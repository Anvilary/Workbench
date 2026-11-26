import { workbenchEnv } from '../../../../scripts/workbench/env.mjs';
/**
 * Chromium sessions of the browser partitions.
 *
 * One partition per (browser profile, provider). This module configures a
 * partition the first time it is needed (permissions, spellcheck, downloads) and
 * remembers which provider each session belongs to.
 */

import { DEFAULT_BROWSER_PROFILE_ID, isValidBrowserProfileId, partitionForBrowserProfile, otherUrl, authenticationUrl } from '../../policy.mjs';
import { browserDownloadHandler, resolveDownloadsDirectory, rememberCompletedDownloadPath } from './downloads.mjs';
import { configureProviderSessionPermissions } from '../security/session-permissions.mjs';
import { navigationAllowed, durablePage, downloadOriginAllowed, downloadDestinationAllowed } from './provider-policy.mjs';

export function createBrowserSessions({ electron, state, send, backend, trimCapacity }) {
  const { app, BrowserWindow, session } = electron;
  const { views, providers, popupOwners, popups, activeDownloads, reservedDownloadPaths, failures } = state;
  const configuredPartitions = new Map(); // partitionName -> Electron.Session
  const sessionProviders = new Map(); // Electron.Session -> provider
  const partitionProfileIds = new Map(); // partitionName -> profileId
  const dictionaryStatusesByLanguage = new Map(); // languageCode -> Map<partitionName, 'downloading' | 'ready' | 'failed'>
  const spellCheckListenersAttached = new WeakSet();
  const authoritativeCustomWords = new Map(); // profileId -> Set<string>
  const reconcilePromises = new Map(); // partitionName -> Promise<unknown>
  const deletingProfiles = new Set(); // profileId currently deleting
  const profileGenerations = new Map(); // profileId -> monotonically increasing lifecycle generation
  const inFlightProfileOps = new Map(); // profileId -> Set<Promise<unknown>>
  const failedDictionaryPartitions = new Set(); // partitionName -> last reconcile failed
  let hasAuthoritativeDictionarySync = false;
  const PROFILE_PROVIDERS = ['chatgpt', 'github', 'perplexity', 'other'];
  const spellCheckConfig = {
    enabled: true,
    languages: ['en-US'],
  };

  function getProfileGeneration(profileId) {
    return profileGenerations.get(profileId) ?? 0;
  }

  function isProfileAborted(profileId, generation) {
    return deletingProfiles.has(profileId) || getProfileGeneration(profileId) !== generation;
  }

  function trackProfileOp(profileId, promise) {
    let set = inFlightProfileOps.get(profileId);
    if (!set) {
      set = new Set();
      inFlightProfileOps.set(profileId, set);
    }
    set.add(promise);
    return promise.finally(() => {
      const current = inFlightProfileOps.get(profileId);
      if (current) {
        current.delete(promise);
        if (current.size === 0) {
          inFlightProfileOps.delete(profileId);
        }
      }
    });
  }

  function resolveStrictProfileId(profileId) {
    if (profileId === undefined) return DEFAULT_BROWSER_PROFILE_ID;
    return isValidBrowserProfileId(profileId) ? profileId : null;
  }

  function getProfilePartitionEntries(profileId, { ensure = false } = {}) {
    const effective = resolveStrictProfileId(profileId);
    if (!effective) return [];
    const entries = [];
    for (const provider of PROFILE_PROVIDERS) {
      const partitionName = partitionForBrowserProfile(effective, provider);
      const sess = configuredPartitions.get(partitionName) || (ensure ? ensurePartitionSession(effective, provider) : null);
      if (sess) {
        entries.push({ provider, partitionName, session: sess });
      }
    }
    return entries;
  }

  function sanitizeDictionaryWord(word) {
    if (typeof word !== 'string' || word.length > 128 || /[\r\n\0]/.test(word)) return null;
    const clean = word.trim();
    return clean.length > 0 && clean.length <= 128 ? clean : null;
  }

  async function awaitPendingReconcilesForProfile(profileId) {
    const pending = [];
    for (const provider of PROFILE_PROVIDERS) {
      const partitionName = partitionForBrowserProfile(profileId, provider);
      const promise = reconcilePromises.get(partitionName);
      if (promise) pending.push(promise);
    }
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  async function mutatePartitionWord(sess, action, clean) {
    if (
      !sess ||
      typeof sess.addWordToSpellCheckerDictionary !== 'function' ||
      typeof sess.removeWordFromSpellCheckerDictionary !== 'function' ||
      typeof sess.listWordsInSpellCheckerDictionary !== 'function'
    ) {
      return { ok: false, mutated: false, reason: 'missing-capability' };
    }
    let rawResult;
    try {
      rawResult = action === 'add'
        ? sess.addWordToSpellCheckerDictionary(clean)
        : sess.removeWordFromSpellCheckerDictionary(clean);
    } catch (err) {
      return { ok: false, mutated: false, reason: err?.message || 'native-error' };
    }
    if (rawResult === true) {
      return { ok: true, mutated: true };
    }
    // Chromium/Electron returns false both on failure and on idempotent no-op calls
    // (word already present on add, or word absent on remove). Disambiguate via list().
    try {
      const words = await sess.listWordsInSpellCheckerDictionary();
      if (!Array.isArray(words)) {
        return { ok: false, mutated: false, reason: 'native-list-invalid' };
      }
      const present = words.includes(clean);
      if ((action === 'add' && present) || (action === 'remove' && !present)) {
        return { ok: true, mutated: false };
      }
      return { ok: false, mutated: false, reason: 'native-returned-false' };
    } catch (err) {
      return { ok: false, mutated: false, reason: err?.message || 'native-verify-error' };
    }
  }

  function applySpellCheckToSession(targetSession, partitionName = '') {
    if (!targetSession) {
      return { ok: false, partition: partitionName, error: 'Missing browser session' };
    }
    const canToggle = typeof targetSession.setSpellCheckerEnabled === 'function';
    const canSetLangs = typeof targetSession.setSpellCheckerLanguages === 'function';
    if (!canToggle && !canSetLangs) {
      return { ok: false, partition: partitionName, error: 'Spellcheck API unavailable on session' };
    }
    try {
      if (canToggle) {
        targetSession.setSpellCheckerEnabled(spellCheckConfig.enabled);
      }
      if (canSetLangs) {
        const available = Array.isArray(targetSession.availableSpellCheckerLanguages)
          ? targetSession.availableSpellCheckerLanguages
          : [];
        const toEnable = spellCheckConfig.languages.filter(
          (lang) => available.length === 0 || available.includes(lang),
        );
        targetSession.setSpellCheckerLanguages(toEnable);
      }
      return { ok: true, partition: partitionName };
    } catch (err) {
      return {
        ok: false,
        partition: partitionName,
        error: err instanceof Error ? err.message : 'Failed to apply native spellcheck configuration',
      };
    }
  }

  function getKnownAvailableLanguagesSet() {
    const langs = getAvailableSpellCheckerLanguages();
    return langs.length > 0 ? new Set(langs) : null;
  }

  function getSpellCheckStatus() {
    const statuses = {};
    if (!spellCheckConfig.enabled) {
      return { enabled: false, languages: [...spellCheckConfig.languages], statuses };
    }
    const availableSet = getKnownAvailableLanguagesSet();
    for (const lang of spellCheckConfig.languages) {
      if (availableSet && !availableSet.has(lang)) {
        statuses[lang] = { status: 'unsupported', failedPartitions: [] };
        continue;
      }
      const partMap = dictionaryStatusesByLanguage.get(lang);
      const failedPartitions = [];
      let hasDownloading = false;
      let hasReady = false;
      if (partMap) {
        for (const [partitionName, stateValue] of partMap.entries()) {
          if (!configuredPartitions.has(partitionName)) continue;
          if (stateValue === 'failed') failedPartitions.push(partitionName);
          else if (stateValue === 'downloading') hasDownloading = true;
          else if (stateValue === 'ready') hasReady = true;
        }
      }
      if (failedPartitions.length > 0) {
        statuses[lang] = { status: 'failed', failedPartitions: failedPartitions.sort() };
      } else if (hasDownloading) {
        statuses[lang] = { status: 'downloading', failedPartitions: [] };
      } else if (hasReady) {
        statuses[lang] = { status: 'ready', failedPartitions: [] };
      } else {
        statuses[lang] = { status: 'pending', failedPartitions: [] };
      }
    }
    return {
      enabled: spellCheckConfig.enabled,
      languages: [...spellCheckConfig.languages],
      statuses,
    };
  }

  function emitSpellCheckStatus() {
    try {
      send({ type: 'spellcheck-dictionary-status', ...getSpellCheckStatus() });
    } catch {}
  }

  function pruneRetainedDictionaryStatuses() {
    if (!spellCheckConfig.enabled) {
      dictionaryStatusesByLanguage.clear();
      return;
    }
    const activeSet = new Set(spellCheckConfig.languages);
    for (const lang of [...dictionaryStatusesByLanguage.keys()]) {
      if (!activeSet.has(lang)) {
        dictionaryStatusesByLanguage.delete(lang);
      }
    }
  }

  function attachSpellCheckListeners(targetSession, partitionName) {
    if (!targetSession || typeof targetSession.on !== 'function' || spellCheckListenersAttached.has(targetSession)) return;
    spellCheckListenersAttached.add(targetSession);
    const reportStatus = (languageCode, status) => {
      if (typeof languageCode !== 'string' || !languageCode) return;
      if (!spellCheckConfig.enabled || !spellCheckConfig.languages.includes(languageCode)) return;
      let partMap = dictionaryStatusesByLanguage.get(languageCode);
      if (!partMap) {
        partMap = new Map();
        dictionaryStatusesByLanguage.set(languageCode, partMap);
      }
      partMap.set(partitionName, status);
      emitSpellCheckStatus();
    };
    targetSession.on('spellcheck-dictionary-initialized', (_event, languageCode) => reportStatus(languageCode, 'ready'));
    targetSession.on('spellcheck-dictionary-download-begin', (_event, languageCode) => reportStatus(languageCode, 'downloading'));
    targetSession.on('spellcheck-dictionary-download-success', (_event, languageCode) => reportStatus(languageCode, 'ready'));
    targetSession.on('spellcheck-dictionary-download-failure', (_event, languageCode) => reportStatus(languageCode, 'failed'));
  }

  function applySpellCheckSettings(config) {
    if (!config) {
      return { ok: false, failedPartitions: [], error: 'Invalid spellcheck configuration' };
    }
    if (typeof config.enabled === 'boolean') {
      spellCheckConfig.enabled = config.enabled;
    }
    if (Array.isArray(config.languages)) {
      spellCheckConfig.languages = [...config.languages];
    }
    pruneRetainedDictionaryStatuses();
    const failedPartitions = [];
    let firstError = null;
    for (const [partitionName, targetSession] of configuredPartitions.entries()) {
      const res = applySpellCheckToSession(targetSession, partitionName);
      if (!res.ok) {
        failedPartitions.push(partitionName);
        if (!firstError && res.error) {
          firstError = res.error;
        }
      }
    }
    emitSpellCheckStatus();
    return {
      ok: failedPartitions.length === 0,
      failedPartitions,
      ...(firstError ? { error: firstError } : {}),
    };
  }

  function getAvailableSpellCheckerLanguages() {
    try {
      if (session.defaultSession && Array.isArray(session.defaultSession.availableSpellCheckerLanguages) && session.defaultSession.availableSpellCheckerLanguages.length > 0) {
        return [...session.defaultSession.availableSpellCheckerLanguages];
      }
      for (const sess of configuredPartitions.values()) {
        if (Array.isArray(sess.availableSpellCheckerLanguages) && sess.availableSpellCheckerLanguages.length > 0) {
          return [...sess.availableSpellCheckerLanguages];
        }
      }
    } catch {}
    return [];
  }

  async function listCustomDictionaryWords(profileId) {
    const effective = resolveStrictProfileId(profileId);
    if (!effective) {
      return { ok: false, words: [], consistent: false, failedPartitions: [], inconsistentWords: [], byProvider: {} };
    }
    await awaitPendingReconcilesForProfile(effective);
    let entries = getProfilePartitionEntries(effective, { ensure: false });
    if (entries.length === 0) {
      for (const provider of PROFILE_PROVIDERS) {
        const partitionName = partitionForBrowserProfile(effective, provider);
        const sess = session.fromPartition(partitionName);
        if (sess) entries.push({ provider, partitionName, session: sess });
      }
    }
    const byProvider = {};
    const providerSets = [];
    const union = new Set();
    const failedPartitions = [];
    for (const entry of entries) {
      try {
        if (typeof entry.session.listWordsInSpellCheckerDictionary !== 'function') {
          failedPartitions.push(entry.partitionName);
          continue;
        }
        const words = await entry.session.listWordsInSpellCheckerDictionary();
        if (!Array.isArray(words)) {
          failedPartitions.push(entry.partitionName);
          continue;
        }
        const cleanSet = new Set();
        for (const word of words) {
          if (typeof word === 'string' && word.trim()) {
            cleanSet.add(word);
            union.add(word);
          }
        }
        byProvider[entry.provider] = [...cleanSet].sort();
        providerSets.push(cleanSet);
      } catch {
        failedPartitions.push(entry.partitionName);
      }
    }
    const inconsistentWords = [];
    for (const word of union) {
      if (providerSets.some((set) => !set.has(word))) {
        inconsistentWords.push(word);
      }
    }
    inconsistentWords.sort();
    return {
      ok: failedPartitions.length === 0,
      words: [...union].sort(),
      consistent: failedPartitions.length === 0 && inconsistentWords.length === 0,
      failedPartitions,
      inconsistentWords,
      byProvider,
    };
  }

  async function mutateProfileDictionaryWord(action, word, profileId) {
    const clean = sanitizeDictionaryWord(word);
    if (!clean) return { ok: false, error: 'Invalid dictionary word' };
    const effective = resolveStrictProfileId(profileId);
    if (!effective) return { ok: false, error: 'Invalid browser profile ID' };
    if (deletingProfiles.has(effective)) {
      return { ok: false, aborted: true, error: 'Browser profile is being deleted' };
    }
    const generation = getProfileGeneration(effective);

    return trackProfileOp(effective, (async () => {
      const entries = getProfilePartitionEntries(effective, { ensure: true });
      await awaitPendingReconcilesForProfile(effective);
      if (isProfileAborted(effective, generation)) {
        return { ok: false, aborted: true, error: 'Browser profile deletion interrupted operation' };
      }
      if (entries.length === 0) return { ok: false, error: 'No browser partitions available' };

      const mutatedEntries = [];
      const failedPartitions = [];
      for (const entry of entries) {
        if (isProfileAborted(effective, generation)) {
          return { ok: false, aborted: true, error: 'Browser profile deletion interrupted operation' };
        }
        const outcome = await mutatePartitionWord(entry.session, action, clean);
        if (outcome.ok) {
          if (outcome.mutated) mutatedEntries.push(entry);
        } else {
          failedPartitions.push({ partition: entry.partitionName, reason: outcome.reason });
        }
      }

      if (failedPartitions.length > 0) {
        const inverseAction = action === 'add' ? 'remove' : 'add';
        const rollbackFailedPartitions = [];
        for (const entry of mutatedEntries) {
          try {
            const rb = await mutatePartitionWord(entry.session, inverseAction, clean);
            flushBrowserSession(entry.session);
            if (!rb.ok) {
              rollbackFailedPartitions.push(entry.partitionName);
            }
          } catch {
            rollbackFailedPartitions.push(entry.partitionName);
          }
        }
        return {
          ok: false,
          error: `Failed to ${action} custom dictionary word across all partitions`,
          failedPartitions: failedPartitions.map((f) => f.partition),
          rolledBack: rollbackFailedPartitions.length === 0,
          ...(rollbackFailedPartitions.length > 0 ? { rollbackFailedPartitions } : {}),
        };
      }

      if (isProfileAborted(effective, generation)) {
        return { ok: false, aborted: true, error: 'Browser profile deletion interrupted operation' };
      }

      for (const entry of entries) {
        flushBrowserSession(entry.session);
      }

      let profileSet = authoritativeCustomWords.get(effective);
      if (!profileSet) {
        profileSet = new Set();
        authoritativeCustomWords.set(effective, profileSet);
      }
      if (action === 'add') profileSet.add(clean);
      else profileSet.delete(clean);

      return { ok: true, profileId: effective, partitionsUpdated: entries.length };
    })());
  }

  function addCustomDictionaryWord(word, profileId) {
    return mutateProfileDictionaryWord('add', word, profileId);
  }

  function removeCustomDictionaryWord(word, profileId) {
    return mutateProfileDictionaryWord('remove', word, profileId);
  }

  async function reconcileSessionDictionary(partitionName, targetSession, expectedSet, profileId, generation) {
    if (isProfileAborted(profileId, generation)) {
      return { ok: false, aborted: true, partition: partitionName, failedWords: [] };
    }
    if (
      !targetSession ||
      typeof targetSession.listWordsInSpellCheckerDictionary !== 'function' ||
      typeof targetSession.addWordToSpellCheckerDictionary !== 'function' ||
      typeof targetSession.removeWordFromSpellCheckerDictionary !== 'function'
    ) {
      return { ok: false, partition: partitionName, failedWords: [...expectedSet] };
    }
    let currentWords;
    try {
      currentWords = await targetSession.listWordsInSpellCheckerDictionary();
    } catch {
      return { ok: false, partition: partitionName, failedWords: [...expectedSet] };
    }
    if (isProfileAborted(profileId, generation)) {
      return { ok: false, aborted: true, partition: partitionName, failedWords: [] };
    }
    if (!Array.isArray(currentWords)) {
      return { ok: false, partition: partitionName, failedWords: [...expectedSet] };
    }
    const currentSet = new Set(currentWords.filter((w) => typeof w === 'string' && w.trim()));
    const failedWords = [];
    for (const word of expectedSet) {
      if (isProfileAborted(profileId, generation)) {
        return { ok: false, aborted: true, partition: partitionName, failedWords: [] };
      }
      if (!currentSet.has(word)) {
        const res = await mutatePartitionWord(targetSession, 'add', word);
        if (!res.ok) failedWords.push(word);
      }
    }
    for (const word of currentSet) {
      if (isProfileAborted(profileId, generation)) {
        return { ok: false, aborted: true, partition: partitionName, failedWords: [] };
      }
      if (!expectedSet.has(word)) {
        const res = await mutatePartitionWord(targetSession, 'remove', word);
        if (!res.ok) failedWords.push(word);
      }
    }
    if (isProfileAborted(profileId, generation)) {
      return { ok: false, aborted: true, partition: partitionName, failedWords: [] };
    }
    flushBrowserSession(targetSession);
    return { ok: failedWords.length === 0, partition: partitionName, failedWords };
  }

  function schedulePartitionReconcile(partitionName, targetSession, expectedSet, profileId, generation) {
    const previous = reconcilePromises.get(partitionName) || Promise.resolve();
    const next = trackProfileOp(
      profileId,
      previous
        .catch(() => {})
        .then(() => reconcileSessionDictionary(partitionName, targetSession, expectedSet, profileId, generation))
        .finally(() => {
          if (reconcilePromises.get(partitionName) === next) {
            reconcilePromises.delete(partitionName);
          }
        }),
    );
    reconcilePromises.set(partitionName, next);
    return next;
  }

  function emitCustomDictionarySyncStatus() {
    try {
      const failedPartitions = [...failedDictionaryPartitions]
        .filter((partitionName) => configuredPartitions.has(partitionName))
        .sort();
      send({
        type: 'custom-dictionary-sync-status',
        ok: failedPartitions.length === 0,
        failedPartitions,
      });
    } catch {}
  }

  function recordPartitionReconcileOutcome(partitionName, result, emitOnChange = false) {
    if (result?.aborted) return;
    const hadFailed = failedDictionaryPartitions.has(partitionName);
    if (result?.ok) {
      failedDictionaryPartitions.delete(partitionName);
      if (emitOnChange && hadFailed) {
        emitCustomDictionarySyncStatus();
      }
    } else {
      failedDictionaryPartitions.add(partitionName);
      if (emitOnChange) {
        emitCustomDictionarySyncStatus();
      }
    }
  }

  async function reconcileCustomDictionary(customWordsByProfile) {
    if (!customWordsByProfile || typeof customWordsByProfile !== 'object' || Array.isArray(customWordsByProfile)) {
      return { ok: false, error: 'Invalid customWordsByProfile map' };
    }
    for (const existingProfile of [...authoritativeCustomWords.keys()]) {
      if (!deletingProfiles.has(existingProfile)) {
        authoritativeCustomWords.delete(existingProfile);
      }
    }
    for (const [profileId, words] of Object.entries(customWordsByProfile)) {
      if (!isValidBrowserProfileId(profileId) || deletingProfiles.has(profileId) || !Array.isArray(words)) continue;
      const set = new Set();
      for (const rawWord of words) {
        const clean = sanitizeDictionaryWord(rawWord);
        if (clean) set.add(clean);
      }
      authoritativeCustomWords.set(profileId, set);
    }
    hasAuthoritativeDictionarySync = true;

    for (const partitionName of [...failedDictionaryPartitions]) {
      if (!configuredPartitions.has(partitionName)) {
        failedDictionaryPartitions.delete(partitionName);
      }
    }

    const results = [];
    for (const [partitionName, targetSession] of configuredPartitions.entries()) {
      const profileId = partitionProfileIds.get(partitionName) ?? DEFAULT_BROWSER_PROFILE_ID;
      if (deletingProfiles.has(profileId)) {
        results.push({ ok: false, aborted: true, partition: partitionName, failedWords: [] });
        continue;
      }
      const generation = getProfileGeneration(profileId);
      const expectedSet = authoritativeCustomWords.get(profileId) ?? new Set();
      const res = await schedulePartitionReconcile(partitionName, targetSession, expectedSet, profileId, generation);
      recordPartitionReconcileOutcome(partitionName, res, false);
      results.push(res);
    }
    const failedPartitions = results.filter((r) => !r.ok && !r.aborted).map((r) => r.partition);
    const abortedPartitions = results.filter((r) => r.aborted).map((r) => r.partition);
    return {
      ok: failedPartitions.length === 0,
      failedPartitions,
      ...(abortedPartitions.length > 0 ? { abortedPartitions } : {}),
    };
  }

  async function beginProfileDeletion(profileId) {
    deletingProfiles.add(profileId);
    profileGenerations.set(profileId, getProfileGeneration(profileId) + 1);
    authoritativeCustomWords.delete(profileId);
    const ops = [...(inFlightProfileOps.get(profileId) ?? [])];
    await awaitPendingReconcilesForProfile(profileId);
    if (ops.length > 0) {
      await Promise.allSettled(ops);
    }
  }

  function finishProfileDeletion(profileId, partitionNames = []) {
    deletingProfiles.delete(profileId);
    authoritativeCustomWords.delete(profileId);
    let statusChanged = false;
    let dictFailureCleared = false;
    for (const partitionName of partitionNames) {
      partitionProfileIds.delete(partitionName);
      reconcilePromises.delete(partitionName);
      if (failedDictionaryPartitions.delete(partitionName)) {
        dictFailureCleared = true;
      }
      for (const partMap of dictionaryStatusesByLanguage.values()) {
        if (partMap.delete(partitionName)) {
          statusChanged = true;
        }
      }
    }
    if (statusChanged) {
      emitSpellCheckStatus();
    }
    if (dictFailureCleared) {
      emitCustomDictionarySyncStatus();
    }
  }

  function flushBrowserSession(sess) {
    if (!sess) return;
    try {
      if (typeof sess.flushStorageData === 'function') sess.flushStorageData();
    } catch {}
    try {
      if (sess.cookies && typeof sess.cookies.flushStore === 'function') {
        void sess.cookies.flushStore().catch(() => {});
      }
    } catch {}
  }

  function ensurePartitionSession(profileId, provider = 'chatgpt') {
    const effectiveProfileId = isValidBrowserProfileId(profileId) ? profileId : DEFAULT_BROWSER_PROFILE_ID;
    const partitionName = partitionForBrowserProfile(effectiveProfileId, provider);
    const existing = configuredPartitions.get(partitionName);
    if (existing) return existing;

    const targetSession = session.fromPartition(partitionName);
    configuredPartitions.set(partitionName, targetSession);
    sessionProviders.set(targetSession, provider);
    partitionProfileIds.set(partitionName, effectiveProfileId);
    configureProviderSessionPermissions({
      provider,
      session: targetSession,
      backendPort: () => backend?.current()?.port,
      otherUrl,
      authenticationUrl,
    });
    // Attach listeners before initiating dictionary loading so synchronous or early
    // spellcheck-dictionary-* events are never missed.
    attachSpellCheckListeners(targetSession, partitionName);
    applySpellCheckToSession(targetSession, partitionName);
    if (!deletingProfiles.has(effectiveProfileId) &&
        (hasAuthoritativeDictionarySync || authoritativeCustomWords.has(effectiveProfileId))) {
      const expectedSet = authoritativeCustomWords.get(effectiveProfileId) ?? new Set();
      void schedulePartitionReconcile(
        partitionName,
        targetSession,
        expectedSet,
        effectiveProfileId,
        getProfileGeneration(effectiveProfileId),
      ).then(
        (result) => recordPartitionReconcileOutcome(partitionName, result, true),
        () => {
          failedDictionaryPartitions.add(partitionName);
          emitCustomDictionarySyncStatus();
        },
      );
    }
    targetSession.on('will-download', browserDownloadHandler({
      provider, views, providers, popupOwners, popups, activeDownloads,
      reservedPaths: reservedDownloadPaths,
      allowedOrigin: (value) => downloadOriginAllowed(provider, value),
      allowedDestination: (value) => downloadDestinationAllowed(provider, value),
      windowForContents: (contents) => BrowserWindow.fromWebContents(contents),
      downloadsDirectory: () => resolveDownloadsDirectory(app),
      rememberDownloadDirectory: (savedPath) => rememberCompletedDownloadPath(savedPath, { app }),
      // Native Save As is the interactive default; WORKBENCH_DOWNLOAD_AUTO_SAVE=1 is an explicit opt-in for automated/headless compatibility.
      autoSave: () => workbenchEnv('DOWNLOAD_AUTO_SAVE') === '1',
      send,
      ready: (id) => {
        const contents = views.get(id)?.webContents;
        if (contents && !contents.isDestroyed() && !contents.isLoading() && !failures.has(id) && durablePage(providers.get(id), contents.getURL())) send({ type: 'ready', id });
        trimCapacity();
      },
    }));
    return targetSession;
  }

  for (const defaultProvider of ['chatgpt', 'github', 'perplexity', 'other']) {
    ensurePartitionSession(DEFAULT_BROWSER_PROFILE_ID, defaultProvider);
  }

  return {
    ensurePartitionSession,
    configuredPartitions,
    sessionProviders,
    flushBrowserSession,
    applySpellCheckSettings,
    getAvailableSpellCheckerLanguages,
    getSpellCheckStatus,
    listCustomDictionaryWords,
    addCustomDictionaryWord,
    removeCustomDictionaryWord,
    reconcileCustomDictionary,
    beginProfileDeletion,
    finishProfileDeletion,
    onProfileDeleted: finishProfileDeletion,
  };
}

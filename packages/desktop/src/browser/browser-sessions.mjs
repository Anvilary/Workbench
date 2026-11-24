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
  const dictionaryStatuses = new Map(); // languageCode -> 'downloading' | 'ready' | 'failed'
  const spellCheckListenersAttached = new WeakSet();
  const PROFILE_PROVIDERS = ['chatgpt', 'github', 'perplexity', 'other'];
  const spellCheckConfig = {
    enabled: true,
    languages: ['en-US'],
  };

  function resolveStrictProfileId(profileId) {
    if (profileId === undefined) return DEFAULT_BROWSER_PROFILE_ID;
    return isValidBrowserProfileId(profileId) ? profileId : null;
  }

  function getProfileSessions(profileId) {
    const effective = resolveStrictProfileId(profileId);
    if (!effective) return [];
    const sessionsList = [];
    for (const provider of PROFILE_PROVIDERS) {
      const partitionName = partitionForBrowserProfile(effective, provider);
      const sess = configuredPartitions.get(partitionName) || session.fromPartition(partitionName);
      if (sess) sessionsList.push(sess);
    }
    return sessionsList;
  }

  function applySpellCheckToSession(targetSession) {
    if (!targetSession) return;
    try {
      if (typeof targetSession.setSpellCheckerEnabled === 'function') {
        targetSession.setSpellCheckerEnabled(spellCheckConfig.enabled);
      }
      if (typeof targetSession.setSpellCheckerLanguages === 'function') {
        const available = Array.isArray(targetSession.availableSpellCheckerLanguages)
          ? targetSession.availableSpellCheckerLanguages
          : [];
        const toEnable = spellCheckConfig.languages.filter(
          (lang) => available.length === 0 || available.includes(lang),
        );
        targetSession.setSpellCheckerLanguages(toEnable);
      }
    } catch {}
  }

  function attachSpellCheckListeners(targetSession) {
    if (!targetSession || typeof targetSession.on !== 'function' || spellCheckListenersAttached.has(targetSession)) return;
    spellCheckListenersAttached.add(targetSession);
    const reportStatus = (languageCode, status) => {
      if (typeof languageCode !== 'string' || !languageCode) return;
      dictionaryStatuses.set(languageCode, status);
      try {
        send({ type: 'spellcheck-dictionary-status', language: languageCode, status });
      } catch {}
    };
    targetSession.on('spellcheck-dictionary-initialized', (_event, languageCode) => reportStatus(languageCode, 'ready'));
    targetSession.on('spellcheck-dictionary-download-begin', (_event, languageCode) => reportStatus(languageCode, 'downloading'));
    targetSession.on('spellcheck-dictionary-download-success', (_event, languageCode) => reportStatus(languageCode, 'ready'));
    targetSession.on('spellcheck-dictionary-download-failure', (_event, languageCode) => reportStatus(languageCode, 'failed'));
  }

  function applySpellCheckSettings(config) {
    if (!config) return;
    if (typeof config.enabled === 'boolean') {
      spellCheckConfig.enabled = config.enabled;
    }
    if (Array.isArray(config.languages)) {
      spellCheckConfig.languages = [...config.languages];
    }
    for (const targetSession of configuredPartitions.values()) {
      applySpellCheckToSession(targetSession);
    }
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
    const profileSessions = getProfileSessions(profileId);
    if (profileSessions.length === 0) return [];
    const collected = new Set();
    for (const sess of profileSessions) {
      try {
        if (typeof sess.listWordsInSpellCheckerDictionary === 'function') {
          const words = await sess.listWordsInSpellCheckerDictionary();
          if (Array.isArray(words)) {
            for (const word of words) {
              if (typeof word === 'string' && word.trim()) collected.add(word);
            }
          }
        }
      } catch {}
    }
    return [...collected].sort();
  }

  async function addCustomDictionaryWord(word, profileId) {
    if (typeof word !== 'string' || word.length > 128 || /[\r\n\0]/.test(word)) return false;
    const clean = word.trim();
    if (!clean) return false;
    const profileSessions = getProfileSessions(profileId);
    if (profileSessions.length === 0) return false;
    let result = false;
    for (const sess of profileSessions) {
      try {
        if (typeof sess.addWordToSpellCheckerDictionary === 'function') {
          sess.addWordToSpellCheckerDictionary(clean);
          result = true;
        }
      } catch {}
    }
    return result;
  }

  async function removeCustomDictionaryWord(word, profileId) {
    if (typeof word !== 'string' || word.length > 128 || /[\r\n\0]/.test(word)) return false;
    const clean = word.trim();
    if (!clean) return false;
    const profileSessions = getProfileSessions(profileId);
    if (profileSessions.length === 0) return false;
    let result = false;
    for (const sess of profileSessions) {
      try {
        if (typeof sess.removeWordFromSpellCheckerDictionary === 'function') {
          sess.removeWordFromSpellCheckerDictionary(clean);
          result = true;
        }
      } catch {}
    }
    return result;
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
    configureProviderSessionPermissions({
      provider,
      session: targetSession,
      backendPort: () => backend?.current()?.port,
      otherUrl,
      authenticationUrl,
    });
    applySpellCheckToSession(targetSession);
    attachSpellCheckListeners(targetSession);
    targetSession.on('will-download', browserDownloadHandler({
      provider, views, providers, popupOwners, popups, activeDownloads,
      reservedPaths: reservedDownloadPaths,
      allowedOrigin: (value) => downloadOriginAllowed(provider, value),
      allowedDestination: (value) => downloadDestinationAllowed(provider, value),
      windowForContents: (contents) => BrowserWindow.fromWebContents(contents),
      downloadsDirectory: () => resolveDownloadsDirectory(app),
      rememberDownloadDirectory: (savedPath) => rememberCompletedDownloadPath(savedPath, { app }),
      // Native Save As is the interactive default; MAW_DOWNLOAD_AUTO_SAVE=1 is an explicit opt-in for automated/headless compatibility.
      autoSave: () => process.env.MAW_DOWNLOAD_AUTO_SAVE === '1',
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
    listCustomDictionaryWords,
    addCustomDictionaryWord,
    removeCustomDictionaryWord,
  };
}

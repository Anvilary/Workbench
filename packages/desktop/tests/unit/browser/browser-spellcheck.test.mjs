import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSessions } from '../../../src/browser/browser-sessions.mjs';
import { createBrowserViewState } from '../../../src/browser/view-state.mjs';

function createMockSession() {
  let spellCheckerEnabled = false;
  let spellCheckerLanguages = [];
  const customDictionary = new Set();
  const listeners = new Map();

  return {
    isSpellCheckerEnabled: () => spellCheckerEnabled,
    setSpellCheckerEnabled: (enabled) => { spellCheckerEnabled = Boolean(enabled); },
    getSpellCheckerLanguages: () => [...spellCheckerLanguages],
    setSpellCheckerLanguages: (languages) => { spellCheckerLanguages = [...languages]; },
    availableSpellCheckerLanguages: ['en-US', 'pt-PT', 'pt-BR', 'es', 'fr', 'de'],
    listWordsInSpellCheckerDictionary: async () => [...customDictionary],
    addWordToSpellCheckerDictionary: (word) => { customDictionary.add(word); return true; },
    removeWordFromSpellCheckerDictionary: (word) => { const deleted = customDictionary.delete(word); return deleted; },
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    on: (event, fn) => {
      const list = listeners.get(event) || [];
      list.push(fn);
      listeners.set(event, list);
    },
    emit: (event, ...args) => {
      for (const fn of listeners.get(event) || []) fn(...args);
    },
    flushStorageData: () => {},
    cookies: { flushStore: async () => {} },
  };
}

function harness() {
  const partitions = new Map();
  const defaultSession = createMockSession();
  const sentEvents = [];

  const electron = {
    app: { getPath: () => '/tmp/downloads' },
    BrowserWindow: { fromWebContents: () => null },
    session: {
      defaultSession,
      fromPartition: (name) => {
        if (!partitions.has(name)) {
          partitions.set(name, createMockSession());
        }
        return partitions.get(name);
      },
    },
  };

  const state = createBrowserViewState();
  const send = (msg) => sentEvents.push(msg);
  const backend = { current: () => ({ port: 4100 }) };
  const trimCapacity = () => {};

  const sessions = createBrowserSessions({ electron, state, send, backend, trimCapacity });
  return { sessions, electron, partitions, defaultSession, sentEvents };
}

test('createBrowserSessions: initializes partitions with default spellcheck settings', () => {
  const { sessions } = harness();
  const chatSession = sessions.ensurePartitionSession('main', 'chatgpt');
  assert.equal(chatSession.isSpellCheckerEnabled(), true);
  assert.deepEqual(chatSession.getSpellCheckerLanguages(), ['en-US']);
});

test('createBrowserSessions: applySpellCheckSettings updates all active partition sessions live, including empty languages', () => {
  const { sessions } = harness();
  const chatSession = sessions.ensurePartitionSession('main', 'chatgpt');
  const githubSession = sessions.ensurePartitionSession('main', 'github');

  sessions.applySpellCheckSettings({
    enabled: true,
    languages: ['en-US', 'pt-PT', 'es'],
  });

  assert.equal(chatSession.isSpellCheckerEnabled(), true);
  assert.deepEqual(chatSession.getSpellCheckerLanguages(), ['en-US', 'pt-PT', 'es']);
  assert.equal(githubSession.isSpellCheckerEnabled(), true);
  assert.deepEqual(githubSession.getSpellCheckerLanguages(), ['en-US', 'pt-PT', 'es']);

  // Empty enabled-language selection clears active languages on existing and newly created sessions
  sessions.applySpellCheckSettings({
    enabled: true,
    languages: [],
  });
  assert.deepEqual(chatSession.getSpellCheckerLanguages(), []);
  const laterSession = sessions.ensurePartitionSession('work-empty-langs', 'other');
  assert.deepEqual(laterSession.getSpellCheckerLanguages(), []);

  // Disable spellcheck live
  sessions.applySpellCheckSettings({
    enabled: false,
    languages: ['en-US'],
  });

  assert.equal(chatSession.isSpellCheckerEnabled(), false);
  assert.equal(githubSession.isSpellCheckerEnabled(), false);
});

test('createBrowserSessions: newly created partitions inherit updated spellcheck configuration', () => {
  const { sessions } = harness();

  sessions.applySpellCheckSettings({
    enabled: true,
    languages: ['de', 'fr'],
  });

  // Ensure a new partition that was not previously created
  const customSession = sessions.ensurePartitionSession('custom-profile-1', 'other');
  assert.equal(customSession.isSpellCheckerEnabled(), true);
  assert.deepEqual(customSession.getSpellCheckerLanguages(), ['de', 'fr']);
});

test('createBrowserSessions: custom dictionary words remain strictly isolated per browser profile and support Unicode', async () => {
  const { sessions, partitions, defaultSession } = harness();
  const mainChat = sessions.ensurePartitionSession('main', 'chatgpt');
  const workOther = sessions.ensurePartitionSession('work-profile', 'other');
  const personalOther = sessions.ensurePartitionSession('personal-profile', 'other');

  // Add to 'main' only
  assert.equal(await sessions.addCustomDictionaryWord('hyperconvergence', 'main'), true);
  assert.equal(await sessions.addCustomDictionaryWord('ação', 'main'), true);

  // Add to 'work-profile' only
  assert.equal(await sessions.addCustomDictionaryWord('workonlyterm', 'work-profile'), true);
  assert.equal(await sessions.addCustomDictionaryWord('résumé', 'work-profile'), true);

  const mainWords = await sessions.listCustomDictionaryWords('main');
  const workWords = await sessions.listCustomDictionaryWords('work-profile');
  const personalWords = await sessions.listCustomDictionaryWords('personal-profile');
  const defaultWords = await defaultSession.listWordsInSpellCheckerDictionary();

  assert.deepEqual(mainWords, ['ação', 'hyperconvergence']);
  assert.deepEqual(workWords, ['résumé', 'workonlyterm']);
  assert.deepEqual(personalWords, []);
  assert.deepEqual(defaultWords, []);

  // Other provider partitions in 'work-profile' share the profile dictionary, while 'main' does not
  assert.equal((await mainChat.listWordsInSpellCheckerDictionary()).includes('workonlyterm'), false);
  assert.equal((await workOther.listWordsInSpellCheckerDictionary()).includes('hyperconvergence'), false);
  assert.equal((await personalOther.listWordsInSpellCheckerDictionary()).length, 0);
  assert.equal(partitions.has('persist:maw-profile-work-profile-chatgpt'), true);

  // Remove from 'work-profile' does not affect 'main'
  assert.equal(await sessions.removeCustomDictionaryWord('workonlyterm', 'work-profile'), true);
  assert.deepEqual(await sessions.listCustomDictionaryWords('work-profile'), ['résumé']);
  assert.deepEqual(await sessions.listCustomDictionaryWords('main'), ['ação', 'hyperconvergence']);

  // Invalid profile IDs are rejected
  assert.equal(await sessions.addCustomDictionaryWord('bad', '../escape'), false);
  assert.deepEqual(await sessions.listCustomDictionaryWords('../escape'), []);
});

test('createBrowserSessions: emits spellcheck-dictionary-status on download failures and initializes fallback languages', () => {
  const { sessions, sentEvents } = harness();
  const chatSession = sessions.ensurePartitionSession('main', 'chatgpt');
  chatSession.emit('spellcheck-dictionary-download-begin', {}, 'pt-PT');
  chatSession.emit('spellcheck-dictionary-download-failure', {}, 'pt-PT');
  chatSession.emit('spellcheck-dictionary-download-success', {}, 'en-US');

  assert.deepEqual(sentEvents, [
    { type: 'spellcheck-dictionary-status', language: 'pt-PT', status: 'downloading' },
    { type: 'spellcheck-dictionary-status', language: 'pt-PT', status: 'failed' },
    { type: 'spellcheck-dictionary-status', language: 'en-US', status: 'ready' },
  ]);

  const langs = sessions.getAvailableSpellCheckerLanguages();
  assert.deepEqual(langs, ['en-US', 'pt-PT', 'pt-BR', 'es', 'fr', 'de']);
});

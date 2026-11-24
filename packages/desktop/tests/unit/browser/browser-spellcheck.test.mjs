import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSessions } from '../../../src/browser/browser-sessions.mjs';
import { createBrowserViewState } from '../../../src/browser/view-state.mjs';

function createMockSession() {
  let spellCheckerEnabled = false;
  let spellCheckerLanguages = [];
  const customDictionary = new Set();

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
    on: () => {},
    flushStorageData: () => {},
    cookies: { flushStore: async () => {} },
  };
}

function harness() {
  const partitions = new Map();
  const defaultSession = createMockSession();

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
  const send = () => {};
  const backend = { current: () => ({ port: 4100 }) };
  const trimCapacity = () => {};

  const sessions = createBrowserSessions({ electron, state, send, backend, trimCapacity });
  return { sessions, electron, partitions, defaultSession };
}

test('createBrowserSessions: initializes partitions with default spellcheck settings', () => {
  const { sessions, partitions } = harness();
  const chatSession = sessions.ensurePartitionSession('default', 'chatgpt');
  assert.equal(chatSession.isSpellCheckerEnabled(), true);
  assert.deepEqual(chatSession.getSpellCheckerLanguages(), ['en-US']);
});

test('createBrowserSessions: applySpellCheckSettings updates all active partition sessions live', () => {
  const { sessions, partitions } = harness();
  const chatSession = sessions.ensurePartitionSession('default', 'chatgpt');
  const githubSession = sessions.ensurePartitionSession('default', 'github');

  sessions.applySpellCheckSettings({
    enabled: true,
    languages: ['en-US', 'pt-PT', 'es'],
  });

  assert.equal(chatSession.isSpellCheckerEnabled(), true);
  assert.deepEqual(chatSession.getSpellCheckerLanguages(), ['en-US', 'pt-PT', 'es']);
  assert.equal(githubSession.isSpellCheckerEnabled(), true);
  assert.deepEqual(githubSession.getSpellCheckerLanguages(), ['en-US', 'pt-PT', 'es']);

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

test('createBrowserSessions: custom dictionary words add and remove across all sessions', async () => {
  const { sessions, defaultSession } = harness();
  const chatSession = sessions.ensurePartitionSession('default', 'chatgpt');

  const added = await sessions.addCustomDictionaryWord('hyperconvergence');
  assert.equal(added, true);

  const words = await sessions.listCustomDictionaryWords();
  assert.ok(words.includes('hyperconvergence'));

  const removed = await sessions.removeCustomDictionaryWord('hyperconvergence');
  assert.equal(removed, true);

  const wordsAfter = await sessions.listCustomDictionaryWords();
  assert.equal(wordsAfter.includes('hyperconvergence'), false);
});

test('createBrowserSessions: getAvailableSpellCheckerLanguages returns engine languages', () => {
  const { sessions } = harness();
  const langs = sessions.getAvailableSpellCheckerLanguages();
  assert.deepEqual(langs, ['en-US', 'pt-PT', 'pt-BR', 'es', 'fr', 'de']);
});

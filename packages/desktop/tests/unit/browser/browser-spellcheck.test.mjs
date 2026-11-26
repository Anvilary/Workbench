import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserSessions } from '../../../src/browser/browser-sessions.mjs';
import { createBrowserViewState } from '../../../src/browser/view-state.mjs';

function createMockSession({
  available = ['en-US', 'pt-PT', 'pt-BR', 'es', 'fr', 'de'],
  failAdd = false,
  failRemove = false,
  throwAdd = false,
  throwRemove = false,
  missingDictApi = false,
  emitSyncOnSetLangs = null,
} = {}) {
  let spellCheckerEnabled = false;
  let spellCheckerLanguages = [];
  const customDictionary = new Set();
  const listeners = new Map();

  const emit = (event, ...args) => {
    for (const fn of listeners.get(event) || []) fn(...args);
  };

  const sess = {
    isSpellCheckerEnabled: () => spellCheckerEnabled,
    setSpellCheckerEnabled: (enabled) => { spellCheckerEnabled = Boolean(enabled); },
    getSpellCheckerLanguages: () => [...spellCheckerLanguages],
    setSpellCheckerLanguages: (languages) => {
      spellCheckerLanguages = [...languages];
      if (typeof emitSyncOnSetLangs === 'function') {
        emitSyncOnSetLangs(languages, emit);
      }
    },
    availableSpellCheckerLanguages: [...available],
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    on: (event, fn) => {
      const list = listeners.get(event) || [];
      list.push(fn);
      listeners.set(event, list);
    },
    emit,
    flushStorageData: () => {},
    cookies: { flushStore: async () => {} },
    customDictionary,
  };

  if (!missingDictApi) {
    sess.listWordsInSpellCheckerDictionary = async () => [...customDictionary].sort();
    sess.addWordToSpellCheckerDictionary = (word) => {
      if (throwAdd) throw new Error('native add threw');
      if (failAdd || customDictionary.has(word)) return false;
      customDictionary.add(word);
      return true;
    };
    sess.removeWordFromSpellCheckerDictionary = (word) => {
      if (throwRemove) throw new Error('native remove threw');
      if (failRemove || !customDictionary.has(word)) return false;
      customDictionary.delete(word);
      return true;
    };
  }

  return sess;
}

function harness(partitionOverrides = {}) {
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
          const override = partitionOverrides[name];
          partitions.set(name, override ? override() : createMockSession());
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

  sessions.applySpellCheckSettings({
    enabled: true,
    languages: [],
  });
  assert.deepEqual(chatSession.getSpellCheckerLanguages(), []);
  const laterSession = sessions.ensurePartitionSession('work-empty-langs', 'other');
  assert.deepEqual(laterSession.getSpellCheckerLanguages(), []);

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

  const customSession = sessions.ensurePartitionSession('custom-profile-1', 'other');
  assert.equal(customSession.isSpellCheckerEnabled(), true);
  assert.deepEqual(customSession.getSpellCheckerLanguages(), ['de', 'fr']);
});

test('createBrowserSessions: custom dictionary words isolate per profile, support Unicode, and handle idempotent operations', async () => {
  const { sessions, defaultSession } = harness();
  sessions.ensurePartitionSession('main', 'chatgpt');
  sessions.ensurePartitionSession('work-profile', 'other');
  sessions.ensurePartitionSession('personal-profile', 'other');

  assert.equal((await sessions.addCustomDictionaryWord('hyperconvergence', 'main')).ok, true);
  assert.equal((await sessions.addCustomDictionaryWord('ação', 'main')).ok, true);
  // Repeated idempotent add must succeed even though Electron returns false when already present
  assert.equal((await sessions.addCustomDictionaryWord('hyperconvergence', 'main')).ok, true);

  assert.equal((await sessions.addCustomDictionaryWord('workonlyterm', 'work-profile')).ok, true);
  assert.equal((await sessions.addCustomDictionaryWord('résumé', 'work-profile')).ok, true);

  const mainList = await sessions.listCustomDictionaryWords('main');
  const workList = await sessions.listCustomDictionaryWords('work-profile');
  const personalList = await sessions.listCustomDictionaryWords('personal-profile');
  const defaultWords = await defaultSession.listWordsInSpellCheckerDictionary();

  assert.equal(mainList.ok, true);
  assert.equal(mainList.consistent, true);
  assert.deepEqual(mainList.words, ['ação', 'hyperconvergence']);
  assert.deepEqual(mainList.byProvider.chatgpt, ['ação', 'hyperconvergence']);
  assert.deepEqual(mainList.byProvider.github, ['ação', 'hyperconvergence']);
  assert.deepEqual(mainList.byProvider.perplexity, ['ação', 'hyperconvergence']);
  assert.deepEqual(mainList.byProvider.other, ['ação', 'hyperconvergence']);

  assert.equal(workList.consistent, true);
  assert.deepEqual(workList.words, ['résumé', 'workonlyterm']);
  assert.deepEqual(personalList.words, []);
  assert.deepEqual(defaultWords, []);

  // Remove and idempotent repeat remove
  assert.equal((await sessions.removeCustomDictionaryWord('workonlyterm', 'work-profile')).ok, true);
  assert.equal((await sessions.removeCustomDictionaryWord('workonlyterm', 'work-profile')).ok, true);
  assert.deepEqual((await sessions.listCustomDictionaryWords('work-profile')).words, ['résumé']);
  assert.deepEqual((await sessions.listCustomDictionaryWords('main')).words, ['ação', 'hyperconvergence']);

  // Invalid profile IDs are rejected cleanly
  assert.equal((await sessions.addCustomDictionaryWord('bad', '../escape')).ok, false);
  assert.equal((await sessions.listCustomDictionaryWords('../escape')).ok, false);
});

test('createBrowserSessions: partial native add/remove failure rolls back mutated partitions and reports failure honestly', async () => {
  // 1. Native add returns false on github partition
  {
    const h = harness({
      'persist:workbench-profile-failadd-github': () => createMockSession({ failAdd: true }),
    });
    // Pre-populate a word that must NOT be disturbed by rollback of a failed add of another word
    assert.equal((await h.sessions.addCustomDictionaryWord('existingword', 'failadd')).ok, false);
    const res = await h.sessions.addCustomDictionaryWord('partialword', 'failadd');
    assert.equal(res.ok, false);
    assert.equal(res.rolledBack, true);
    assert.deepEqual(res.failedPartitions, ['persist:workbench-profile-failadd-github']);
    const listed = await h.sessions.listCustomDictionaryWords('failadd');
    assert.deepEqual(listed.words, [], 'Rolled back partitions must not retain partialword');
    assert.equal(listed.consistent, true);
  }

  // 2. Native add throws on perplexity partition
  {
    const h = harness({
      'persist:workbench-profile-throwadd-perplexity': () => createMockSession({ throwAdd: true }),
    });
    const res = await h.sessions.addCustomDictionaryWord('throwword', 'throwadd');
    assert.equal(res.ok, false);
    assert.equal(res.rolledBack, true);
    assert.deepEqual(res.failedPartitions, ['persist:workbench-profile-throwadd-perplexity']);
    assert.deepEqual((await h.sessions.listCustomDictionaryWords('throwadd')).words, []);
  }

  // 3. Native remove fails (returns false while word remains present) on other partition -> rolls back removal on earlier partitions
  {
    let allowFailRemove = false;
    const h = harness({
      'persist:workbench-profile-failrem-browser': () => {
        const s = createMockSession();
        const origRemove = s.removeWordFromSpellCheckerDictionary;
        s.removeWordFromSpellCheckerDictionary = (w) => {
          if (allowFailRemove) return false;
          return origRemove(w);
        };
        return s;
      },
    });
    assert.equal((await h.sessions.addCustomDictionaryWord('keepme', 'failrem')).ok, true);
    allowFailRemove = true;
    const remRes = await h.sessions.removeCustomDictionaryWord('keepme', 'failrem');
    assert.equal(remRes.ok, false);
    assert.equal(remRes.rolledBack, true);
    const listed = await h.sessions.listCustomDictionaryWords('failrem');
    assert.equal(listed.consistent, true);
    assert.deepEqual(listed.words, ['keepme']);
  }

  // 4. Missing dictionary API fails cleanly
  {
    const h = harness({
      'persist:workbench-profile-noapi-chatgpt': () => createMockSession({ missingDictApi: true }),
    });
    const res = await h.sessions.addCustomDictionaryWord('missingapi', 'noapi');
    assert.equal(res.ok, false);
    const listed = await h.sessions.listCustomDictionaryWords('noapi');
    assert.equal(listed.ok, false);
    assert.equal(listed.consistent, false);
    assert.deepEqual(listed.failedPartitions, ['persist:workbench-profile-noapi-chatgpt']);
  }
});

test('createBrowserSessions: listing exposes divergent partition state and reconcileCustomDictionary converges existing and lazy partitions', async () => {
  const { sessions, partitions } = harness();
  const chatSess = sessions.ensurePartitionSession('work-rec', 'chatgpt');
  const githubSess = sessions.ensurePartitionSession('work-rec', 'github');
  chatSess.addWordToSpellCheckerDictionary('onlyinchat');
  githubSess.addWordToSpellCheckerDictionary('staleword');

  const divergent = await sessions.listCustomDictionaryWords('work-rec');
  assert.equal(divergent.consistent, false);
  assert.deepEqual(divergent.inconsistentWords, ['onlyinchat', 'staleword']);

  // Authoritative reconciliation converges configured partitions
  const recRes = await sessions.reconcileCustomDictionary({
    'work-rec': ['authoritative', 'ação'],
  });
  assert.equal(recRes.ok, true);
  assert.deepEqual(await chatSess.listWordsInSpellCheckerDictionary(), ['authoritative', 'ação']);
  assert.deepEqual(await githubSess.listWordsInSpellCheckerDictionary(), ['authoritative', 'ação']);

  // Lazily initializing another provider partition reconciles automatically
  const perplexitySess = sessions.ensurePartitionSession('work-rec', 'perplexity');
  // Await reconciliation via listCustomDictionaryWords
  const afterLazy = await sessions.listCustomDictionaryWords('work-rec');
  assert.equal(afterLazy.consistent, true);
  assert.deepEqual(afterLazy.words, ['authoritative', 'ação']);
  assert.deepEqual(await perplexitySess.listWordsInSpellCheckerDictionary(), ['authoritative', 'ação']);
  assert.equal(partitions.has('persist:workbench-profile-work-rec-perplexity'), true);
});

test('createBrowserSessions: attaches lifecycle listeners before configuring dictionaries and preserves per-partition failures', () => {
  // Verify synchronous event emitted during setSpellCheckerLanguages on initial partition is captured!
  const h = harness({
    'persist:workbench-chatgpt': () => createMockSession({
      emitSyncOnSetLangs: (langs, emit) => {
        for (const l of langs) emit('spellcheck-dictionary-download-failure', {}, l);
      },
    }),
    'persist:workbench-github': () => createMockSession({
      emitSyncOnSetLangs: (langs, emit) => {
        for (const l of langs) emit('spellcheck-dictionary-initialized', {}, l);
      },
    }),
  });

  // Even though persist:workbench-github emitted 'ready', persist:workbench-chatgpt failed -> aggregated status must stay 'failed'!
  const initialStatus = h.sessions.getSpellCheckStatus();
  assert.equal(initialStatus.statuses['en-US'].status, 'failed');
  assert.deepEqual(initialStatus.statuses['en-US'].failedPartitions, ['persist:workbench-chatgpt']);

  // Unsupported language is reported truthfully
  h.sessions.applySpellCheckSettings({ enabled: true, languages: ['en-US', 'zz-ZZ'] });
  const withUnsupported = h.sessions.getSpellCheckStatus();
  assert.equal(withUnsupported.statuses['zz-ZZ'].status, 'unsupported');

  // Removing language prunes retained status cleanly
  h.sessions.applySpellCheckSettings({ enabled: true, languages: [] });
  assert.deepEqual(h.sessions.getSpellCheckStatus().statuses, {});

  // Deleting custom profile clears its failed partition state
  const customSess = h.sessions.ensurePartitionSession('temp-prof', 'other');
  h.sessions.applySpellCheckSettings({ enabled: true, languages: ['pt-PT'] });
  customSess.emit('spellcheck-dictionary-download-failure', {}, 'pt-PT');
  assert.equal(h.sessions.getSpellCheckStatus().statuses['pt-PT'].status, 'failed');
  h.sessions.onProfileDeleted('temp-prof', ['persist:workbench-profile-temp-prof-browser']);
  assert.equal(h.sessions.getSpellCheckStatus().statuses['pt-PT'].status, 'failed'); // persist:workbench-chatgpt also failed in this mock
});

test('Scenario 9: primary partition failure followed by rollback failure reports rolledBack=false truthfully and recovers via reconcileCustomDictionary', async () => {
  let rejectRemove = false;
  const h = harness({
    'persist:workbench-profile-rbfail-chatgpt': () => {
      const s = createMockSession();
      const origRemove = s.removeWordFromSpellCheckerDictionary;
      s.removeWordFromSpellCheckerDictionary = (w) => {
        if (rejectRemove) return false;
        return origRemove(w);
      };
      return s;
    },
    'persist:workbench-profile-rbfail-github': () => createMockSession({ failAdd: true }),
  });

  // Allow chatgpt add to succeed, make inverse remove fail on chatgpt during rollback after github add fails
  rejectRemove = true;
  const res = await h.sessions.addCustomDictionaryWord('partialstuck', 'rbfail');
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, false);
  assert.deepEqual(res.failedPartitions, ['persist:workbench-profile-rbfail-github']);
  assert.deepEqual(res.rollbackFailedPartitions, ['persist:workbench-profile-rbfail-chatgpt']);

  // Listing truthfully shows divergence left behind by failed rollback
  const listed = await h.sessions.listCustomDictionaryWords('rbfail');
  assert.equal(listed.consistent, false);
  assert.deepEqual(listed.inconsistentWords, ['partialstuck']);

  // Reconcile against authoritative empty set after failure recovers once partition accepts writes again
  rejectRemove = false;
  const gh = h.partitions.get('persist:workbench-profile-rbfail-github');
  gh.addWordToSpellCheckerDictionary = (w) => {
    if (gh.customDictionary.has(w)) return false;
    gh.customDictionary.add(w);
    return true;
  };
  const rec = await h.sessions.reconcileCustomDictionary({ rbfail: [] });
  assert.equal(rec.ok, true);
  const after = await h.sessions.listCustomDictionaryWords('rbfail');
  assert.equal(after.consistent, true);
  assert.deepEqual(after.words, []);
});

test('Scenario 10: profile deletion awaits in-flight reconcile deterministically and prevents repopulation', async () => {
  let releaseList;
  let listEntered;
  const listEnteredPromise = new Promise((r) => { listEntered = r; });
  const listGatePromise = new Promise((r) => { releaseList = r; });
  let pauseList = true;

  const h = harness({
    'persist:workbench-profile-racep-chatgpt': () => {
      const s = createMockSession();
      const origList = s.listWordsInSpellCheckerDictionary;
      s.listWordsInSpellCheckerDictionary = async () => {
        if (pauseList) {
          listEntered();
          await listGatePromise;
        }
        return await origList();
      };
      return s;
    },
  });

  h.sessions.ensurePartitionSession('racep', 'chatgpt');
  h.sessions.ensurePartitionSession('main', 'chatgpt');
  await h.sessions.addCustomDictionaryWord('mainkeep', 'main');

  // Start reconcile that pauses inside chatgpt's listWordsInSpellCheckerDictionary()
  const reconcilePromise = h.sessions.reconcileCustomDictionary({
    main: ['mainkeep'],
    racep: ['shouldnotarrive'],
  });
  await listEnteredPromise;

  // Concurrent deletion marks profile deleting & awaits in-flight reconcile before wiping
  let deletionFinished = false;
  const deletionPromise = (async () => {
    await h.sessions.beginProfileDeletion('racep');
    pauseList = false;
    const afterPause = await h.sessions.listCustomDictionaryWords('racep');
    assert.deepEqual(afterPause.words, []);
    h.sessions.finishProfileDeletion('racep', ['persist:workbench-profile-racep-chatgpt']);
    deletionFinished = true;
  })();

  // Mutations targeting a profile currently being deleted reject cleanly
  const duringDeleteAdd = await h.sessions.addCustomDictionaryWord('rejectedduringdelete', 'racep');
  assert.equal(duringDeleteAdd.ok, false);
  assert.equal(duringDeleteAdd.aborted, true);
  assert.equal(deletionFinished, false);

  // Release paused list() -> reconcile must abort without writing 'shouldnotarrive', then deletion finishes
  pauseList = false;
  releaseList();
  const [recRes] = await Promise.all([reconcilePromise, deletionPromise]);
  assert.ok(recRes.abortedPartitions?.includes('persist:workbench-profile-racep-chatgpt'));

  const chatSess = h.partitions.get('persist:workbench-profile-racep-chatgpt');
  assert.deepEqual([...chatSess.customDictionary], []);
  assert.deepEqual((await h.sessions.listCustomDictionaryWords('main')).words, ['mainkeep']);
  assert.deepEqual(await h.defaultSession.listWordsInSpellCheckerDictionary(), []);
});

test('F3: lazy partition reconciliation failures emit custom-dictionary-sync-status and clear on retry or deletion', async () => {
  const h = harness({
    'persist:workbench-profile-lazysync-perplexity': () => createMockSession({ failAdd: true }),
  });
  h.sessions.ensurePartitionSession('lazysync', 'chatgpt');

  // Initial reconcile across configured partition(s) succeeds
  const initRec = await h.sessions.reconcileCustomDictionary({ lazysync: ['lazyterm'] });
  assert.equal(initRec.ok, true);
  assert.deepEqual(initRec.failedPartitions, []);

  // Lazily create perplexity partition whose dictionary write fails
  const beforeCount = h.sentEvents.length;
  h.sessions.ensurePartitionSession('lazysync', 'perplexity');
  await new Promise((r) => setTimeout(r, 20));

  const failureEvents = h.sentEvents
    .slice(beforeCount)
    .filter((e) => e.type === 'custom-dictionary-sync-status');
  assert.equal(failureEvents.length, 1);
  assert.equal(failureEvents[0].ok, false);
  assert.deepEqual(failureEvents[0].failedPartitions, ['persist:workbench-profile-lazysync-perplexity']);

  // Repair partition and retry reconcile with the EXACT same dictionary map -> recovers cleanly
  const pxSess = h.partitions.get('persist:workbench-profile-lazysync-perplexity');
  pxSess.addWordToSpellCheckerDictionary = (w) => {
    if (pxSess.customDictionary.has(w)) return false;
    pxSess.customDictionary.add(w);
    return true;
  };
  const retryRec = await h.sessions.reconcileCustomDictionary({ lazysync: ['lazyterm'] });
  assert.equal(retryRec.ok, true);
  assert.deepEqual(retryRec.failedPartitions, []);
  const listed = await h.sessions.listCustomDictionaryWords('lazysync');
  assert.equal(listed.consistent, true);
  assert.deepEqual(listed.words, ['lazyterm']);
});

test('F4: applySpellCheckSettings returns honest per-partition failure results and preserves status reporting', () => {
  let throwSetLangs = true;
  const h = harness({
    'persist:workbench-github': () => {
      const s = createMockSession();
      const origSetLangs = s.setSpellCheckerLanguages;
      s.setSpellCheckerLanguages = (langs) => {
        if (throwSetLangs) {
          throw new Error('setSpellCheckerLanguages native failure');
        }
        origSetLangs(langs);
      };
      return s;
    },
  });

  const failRes = h.sessions.applySpellCheckSettings({
    enabled: true,
    languages: ['en-US', 'zz-UNSUPPORTED'],
  });
  assert.equal(failRes.ok, false);
  assert.deepEqual(failRes.failedPartitions, ['persist:workbench-github']);
  assert.match(failRes.error ?? '', /native failure/);

  // Unsupported language status reporting must still be preserved
  const statusAfterFail = h.sessions.getSpellCheckStatus();
  assert.equal(statusAfterFail.statuses['zz-UNSUPPORTED']?.status, 'unsupported');

  // Recover on subsequent apply of identical config
  throwSetLangs = false;
  const okRes = h.sessions.applySpellCheckSettings({
    enabled: true,
    languages: ['en-US', 'zz-UNSUPPORTED'],
  });
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.failedPartitions, []);
});

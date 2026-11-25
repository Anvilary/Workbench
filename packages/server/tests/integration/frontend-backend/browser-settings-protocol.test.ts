import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  parseServerMessage,
  type ServerMessage,
} from '@agent-workbench/shared';
import { attachWorkbenchSocket } from '../../../src/transport/websocket/socket-server.js';
import { TerminalRegistry } from '../../../src/features/terminals/terminal-registry.js';
import { createAgentRegistry } from '../../../src/agents/registry.js';
import { OpenTabsStore } from '../../../src/features/terminals/open-tabs-store.js';
import { SessionIndex } from '../../../src/features/history/session-index.js';
import { ArchivedSessions } from '../../../src/features/history/archived-sessions.js';
import { VaultCatalog } from '../../../src/features/vault/catalog.js';
import { WorktreeLinks } from '../../../src/features/worktrees/links.js';
import { WorktreeStore } from '../../../src/features/worktrees/store.js';
import { VaultService } from '../../../src/features/vault/service.js';
import { WorktreeService } from '../../../src/features/worktrees/service.js';
import { AppSettingsService } from '../../../src/features/settings/app-settings-service.js';
import { SettingsStore } from '../../../src/features/settings/settings-store.js';
import { NotesStore } from '../../../src/features/notes/notes-store.js';
import { DraftStore } from '../../../src/features/composer/draft-store.js';
import { ConversationHub } from '../../../src/features/conversations/conversation-hub.js';
import { RepoHub } from '../../../src/features/git/repo-hub.js';
import { MemoryHub } from '../../../src/features/memory/memory-hub.js';
import { RemoteAccessService } from '../../../src/features/remote-access/remote-access-service.js';
import { RemoteDevicesStore } from '../../../src/features/remote-access/remote-devices-store.js';
import { AgencyWorkspaceStore } from '../../../src/features/workspaces/workspace-store.js';
import { AgencyProfileStore } from '../../../src/features/profiles/profile-store.js';
import { BrowserProfileStore } from '../../../src/features/browser/browser-profile-store.js';
import { AgencySessionRuntime } from '../../../src/features/sessions/session-runtime.js';
import { SplitAgencySessionStore } from '../../../src/features/sessions/session-store.js';
import { WorkspaceMutex } from '../../../src/features/workspaces/workspace-lock.js';

const PORT_TOKEN = 'test-browser-settings-token';

async function createSettingsHarness() {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-browser-settings-ws-'));
  const settingsDir = path.join(tempDir, 'settings-dir');
  await mkdir(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');
  const httpServer = createServer(express());
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;

  const settings = new SettingsStore(settingsPath, { log: { warn: () => undefined } });
  await settings.load();
  const agents = createAgentRegistry([]);
  const store = new OpenTabsStore();
  await store.load();
  const archived = new ArchivedSessions();
  await archived.load();
  const worktreeStore = new WorktreeStore(path.join(tempDir, 'worktrees.json'));
  await worktreeStore.load();
  const worktreeLinks = new WorktreeLinks(worktreeStore);
  const catalog = new VaultCatalog();
  const index = new SessionIndex(agents, archived, catalog, worktreeLinks);
  const vault = new VaultService({ agents, index, archived, settings, catalog, platform: process.platform });
  const registry = new TerminalRegistry(
    agents,
    { file: process.execPath, args: ['-e', 'process.exit(0)'], name: 'synthetic-shell' },
    store,
    () => null,
    async () => null,
    () => path.join(tempDir, 'shell-integration'),
    { persistentPty: false },
  );
  const worktrees = new WorktreeService({
    store: worktreeStore,
    registry,
    projectCwd: () => null,
    findSession: () => null,
    sessionsUnder: () => [],
    history: () => null,
  });
  const appSettings = new AppSettingsService({ settings, agents, shells: [], onShellChange: () => {} });
  const notes = new NotesStore(path.join(tempDir, 'notes.json'));
  await notes.load();
  const drafts = new DraftStore({ statePath: path.join(tempDir, 'drafts.json') });
  await drafts.load();
  const remote = new RemoteAccessService({
    settings,
    store: new RemoteDevicesStore(path.join(tempDir, 'devices.json')),
    listening: { port, fixed: false, fixedPortBusy: false },
  });
  await remote.load();
  const agencyWorkspaceStore = new AgencyWorkspaceStore(path.join(tempDir, 'agency-state.json'));
  await agencyWorkspaceStore.load();
  const agencyProfileStore = new AgencyProfileStore(path.join(tempDir, 'agency-profiles.json'));
  await agencyProfileStore.listDefinitions();
  const agencyBrowserProfileStore = new BrowserProfileStore(path.join(tempDir, 'browser-profiles.json'));
  await agencyBrowserProfileStore.load();
  const agencyRuntime = new AgencySessionRuntime({
    registry,
    workspaces: { protectedDirectories: () => [], withSessionReservation: (_id, action) => action(null) },
    profiles: { resolveLaunch: async () => ({}) as never },
    store: new SplitAgencySessionStore(path.join(tempDir, 'agency-sessions.json')),
  });
  await agencyRuntime.initialize();

  const detach = attachWorkbenchSocket({
    httpServer,
    port,
    token: PORT_TOKEN,
    appSettings,
    registry,
    index,
    archived,
    notes,
    drafts,
    conversations: new ConversationHub(registry, agents),
    repos: new RepoHub(registry),
    memory: new MemoryHub(registry),
    agents,
    defaultCwd: tempDir,
    vault,
    remote,
    worktrees,
    noAuth: true,
    agencyWorkspaceStore,
    agencyBrowserProfileStore,
    agencyProfileStore,
    agencyRuntime,
    workspaceLock: new WorkspaceMutex(),
  });

  return {
    port,
    tempDir,
    settingsDir,
    settingsPath,
    settings,
    appSettings,
    agencyBrowserProfileStore,
    cleanup: async () => {
      await chmod(settingsDir, 0o755).catch(() => {});
      await detach();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function openClient(port: number) {
  const messages: ServerMessage[] = [];
  const waiters: Array<(msg: ServerMessage) => boolean> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${PORT_TOKEN}`);
  ws.on('message', (raw) => {
    const parsed = parseServerMessage(raw.toString());
    if (!parsed) return;
    messages.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!(parsed)) {
        waiters.splice(i, 1);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const waitFor = (predicate: (msg: ServerMessage) => boolean, label: string): Promise<ServerMessage> => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000);
      waiters.push((msg) => {
        if (!predicate(msg)) return false;
        clearTimeout(timer);
        resolve(msg);
        return true;
      });
    });
  };
  await waitFor((m) => m.type === 'settings.status', 'initial settings.status');
  return { ws, messages, waitFor };
}

test('Scenario 1, 6, 7 & 11: acknowledged customDictionary mutations, overlapping updates, concurrent preference patches, and restart durability', async () => {
  const h = await createSettingsHarness();
  try {
    const c1 = await openClient(h.port);
    try {
      const p1 = c1.waitFor((m) => m.type === 'settings.status' && m.requestId === 'req-add-1', 'req-add-1');
      const p2 = c1.waitFor((m) => m.type === 'settings.status' && m.requestId === 'req-add-2', 'req-add-2');
      const p3 = c1.waitFor((m) => m.type === 'settings.status' && m.requestId === 'req-engine', 'req-engine');

      // Overlapping dictionary adds + unrelated browser preference patch
      c1.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'req-add-1',
        customDictionary: { action: 'add', profileId: DEFAULT_BROWSER_PROFILE_ID, word: 'alpha' },
      }));
      c1.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'req-add-2',
        customDictionary: { action: 'add', profileId: DEFAULT_BROWSER_PROFILE_ID, word: 'ação' },
      }));
      c1.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'req-engine',
        browser: { defaultSearchEngine: 'brave' },
      }));

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.equal(r1.type, 'settings.status');
      assert.equal(r2.type, 'settings.status');
      assert.equal(r3.type, 'settings.status');
      if (r3.type === 'settings.status') {
        assert.equal(r3.settings.browser?.defaultSearchEngine, 'brave');
        assert.deepEqual(r3.settings.browser?.spellCheck?.customWordsByProfile?.main, ['alpha', 'ação']);
      }

      // Preference update without customWordsByProfile must preserve existing dictionary words
      const p4 = c1.waitFor((m) => m.type === 'settings.status' && m.requestId === 'req-sc-pref', 'req-sc-pref');
      c1.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'req-sc-pref',
        browser: { spellCheck: { enabled: false, languages: [] } },
      }));
      const r4 = await p4;
      if (r4.type === 'settings.status') {
        assert.equal(r4.settings.browser?.spellCheck?.enabled, false);
        assert.deepEqual(r4.settings.browser?.spellCheck?.customWordsByProfile?.main, ['alpha', 'ação']);
      }

      // Remove word with ack
      const p5 = c1.waitFor((m) => m.type === 'settings.status' && m.requestId === 'req-rem-1', 'req-rem-1');
      c1.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'req-rem-1',
        customDictionary: { action: 'remove', profileId: DEFAULT_BROWSER_PROFILE_ID, word: 'alpha' },
      }));
      await p5;

      // Restart durability check via fresh SettingsStore load from disk
      const restarted = new SettingsStore(h.settingsPath, { log: { warn: () => undefined } });
      await restarted.load();
      assert.equal(restarted.get().browser.defaultSearchEngine, 'brave');
      assert.equal(restarted.get().browser.spellCheck?.enabled, false);
      assert.deepEqual(restarted.get().browser.spellCheck?.customWordsByProfile?.main, ['ação']);
      const disk = JSON.parse(await readFile(h.settingsPath, 'utf8'));
      assert.deepEqual(disk.browser.spellCheck.customWordsByProfile.main, ['ação']);
    } finally {
      c1.ws.close();
    }
  } finally {
    await h.cleanup();
  }
});

test('Scenario 2: server-side persistence failure emits requestId error without mutating disk state and recovers cleanly', async () => {
  const h = await createSettingsHarness();
  try {
    const client = await openClient(h.port);
    try {
      // Seed one committed word first so settings.json exists on disk
      const seedAck = client.waitFor((m) => m.type === 'settings.status' && m.requestId === 'req-seed', 'req-seed');
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'req-seed',
        customDictionary: { action: 'add', profileId: 'main', word: 'committed' },
      }));
      await seedAck;

      // Inject write failure by temporarily blocking writes via atomic temp collision OR read-only settingsPath directory
      // Replace settingsPath directory writeability (note: root bypasses chmod 0555, so swap settings.json path via non-writable target if non-root, OR stub write failure on store).
      const origWriteCheck = await stat(h.settingsDir);
      assert.ok(origWriteCheck.isDirectory());

      let injectedError = false;
      const origUpdate = h.settings.update.bind(h.settings);
      h.settings.update = (patch) => {
        if (!injectedError) {
          injectedError = true;
          return Promise.reject(new Error('ENOSPC: simulated disk full'));
        }
        return origUpdate(patch);
      };

      const errPromise = client.waitFor(
        (m) => m.type === 'error' && m.code === 'settings-failed' && m.requestId === 'req-fail-disk',
        'req-fail-disk error',
      );
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'req-fail-disk',
        customDictionary: { action: 'add', profileId: 'main', word: 'uncommitted' },
      }));
      const errMsg = await errPromise;
      assert.equal(errMsg.type, 'error');
      assert.deepEqual(h.settings.get().browser.spellCheck?.customWordsByProfile?.main, ['committed']);

      // Subsequent mutation succeeds cleanly
      const recoverPromise = client.waitFor(
        (m) => m.type === 'settings.status' && m.requestId === 'req-recover',
        'req-recover',
      );
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'req-recover',
        customDictionary: { action: 'add', profileId: 'main', word: 'recoveredword' },
      }));
      await recoverPromise;
      assert.deepEqual(h.settings.get().browser.spellCheck?.customWordsByProfile?.main, ['committed', 'recoveredword']);
    } finally {
      client.ws.close();
    }
  } finally {
    await h.cleanup();
  }
});

test('Scenario 3, 4 & 5: disconnect before/after commit and reconnect convergence with authoritative state', async () => {
  const h = await createSettingsHarness();
  try {
    const client1 = await openClient(h.port);
    // Simulate client1 committing then immediately closing before reading ack frame (Scenario 4)
    client1.ws.send(JSON.stringify({
      type: 'settings.update',
      requestId: 'req-lost-ack',
      customDictionary: { action: 'add', profileId: 'main', word: 'committedBeforeClose' },
    }));
    // Wait until backend commits, then drop client1 and also apply an authoritative server change while disconnected
    await h.settings.flush();
    while (!h.settings.get().browser.spellCheck?.customWordsByProfile?.main?.includes('committedBeforeClose')) {
      await new Promise((r) => setTimeout(r, 10));
    }
    client1.ws.terminate();

    // Another authoritative source modifies backend state while client is disconnected
    await h.appSettings.update({
      customDictionary: { action: 'add', profileId: 'main', word: 'authoritativeOnServer' },
    });

    // Reconnect (client2): initial snapshot delivers exact authoritative state (Scenario 4 & 5)
    const client2 = await openClient(h.port);
    try {
      const initial = client2.messages.find((m) => m.type === 'settings.status');
      assert.ok(initial && initial.type === 'settings.status');
      assert.deepEqual(initial.settings.browser?.spellCheck?.customWordsByProfile?.main, [
        'authoritativeOnServer',
        'committedBeforeClose',
      ]);
    } finally {
      client2.ws.close();
    }
  } finally {
    await h.cleanup();
  }
});

test('Profile deletion owns authoritative customWordsByProfile cleanup and recovers from persistence failure', async () => {
  const h = await createSettingsHarness();
  try {
    const profile = await h.agencyBrowserProfileStore.createProfile('Work Profile');
    const client = await openClient(h.port);
    try {
      const pMain = client.waitFor((m) => m.type === 'settings.status' && m.requestId === 'req-m', 'req-m');
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'req-m',
        customDictionary: { action: 'add', profileId: 'main', word: 'keepinmain' },
      }));
      await pMain;

      const pWork = client.waitFor((m) => m.type === 'settings.status' && m.requestId === 'req-w', 'req-w');
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'req-w',
        customDictionary: { action: 'add', profileId: profile.id, word: 'worksecret' },
      }));
      await pWork;

      // Fail settings persistence on first delete attempt -> profile deletion fails cleanly & keeps profile recoverable
      let failOnce = true;
      const origUpdate = h.settings.update.bind(h.settings);
      h.settings.update = (patch) => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error('Transient write error during profile deletion'));
        }
        return origUpdate(patch);
      };

      const failDelPromise = client.waitFor(
        (m) => m.type === 'agency.error' && m.requestId === 'del-fail',
        'del-fail',
      );
      client.ws.send(JSON.stringify({
        type: 'agency.browserProfile.delete',
        requestId: 'del-fail',
        profileId: profile.id,
      }));
      await failDelPromise;
      assert.ok(h.agencyBrowserProfileStore.getProfile(profile.id), 'Profile must remain intact on settings cleanup failure');
      assert.deepEqual(h.settings.get().browser.spellCheck?.customWordsByProfile?.[profile.id], ['worksecret']);

      // Retry profile deletion -> clears profile's custom words and preserves main
      const okDelPromise = client.waitFor(
        (m) => m.type === 'agency.browserProfile.deleted' && m.requestId === 'del-ok',
        'del-ok',
      );
      client.ws.send(JSON.stringify({
        type: 'agency.browserProfile.delete',
        requestId: 'del-ok',
        profileId: profile.id,
      }));
      await okDelPromise;

      assert.equal(h.agencyBrowserProfileStore.getProfile(profile.id), null);
      assert.equal(h.settings.get().browser.spellCheck?.customWordsByProfile?.[profile.id], undefined);
      assert.deepEqual(h.settings.get().browser.spellCheck?.customWordsByProfile?.main, ['keepinmain']);
    } finally {
      client.ws.close();
    }
  } finally {
    await h.cleanup();
  }
});

test('F1: rejects customDictionary and customWordsByProfile mutations targeting nonexistent or deleted profiles', async () => {
  const h = await createSettingsHarness();
  try {
    const profile = await h.agencyBrowserProfileStore.createProfile('Transient Profile');
    const client = await openClient(h.port);
    try {
      // Seed main and existing custom profile words
      const seedMain = client.waitFor((m) => m.type === 'settings.status' && m.requestId === 'f1-seed-main', 'f1-seed-main');
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'f1-seed-main',
        customDictionary: { action: 'add', profileId: DEFAULT_BROWSER_PROFILE_ID, word: 'mainword' },
      }));
      await seedMain;

      const seedProf = client.waitFor((m) => m.type === 'settings.status' && m.requestId === 'f1-seed-prof', 'f1-seed-prof');
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'f1-seed-prof',
        customDictionary: { action: 'add', profileId: profile.id, word: 'tempword' },
      }));
      await seedProf;

      // 1. Nonexistent profile add & remove reject with requestId-correlated settings-failed
      const missingAddP = client.waitFor(
        (m) => m.type === 'error' && m.code === 'settings-failed' && m.requestId === 'f1-missing-add',
        'f1-missing-add',
      );
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'f1-missing-add',
        customDictionary: { action: 'add', profileId: 'nonexistent-profile-id', word: 'ghost' },
      }));
      const missingAddErr = await missingAddP;
      assert.equal(missingAddErr.type, 'error');

      const missingRemP = client.waitFor(
        (m) => m.type === 'error' && m.code === 'settings-failed' && m.requestId === 'f1-missing-rem',
        'f1-missing-rem',
      );
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'f1-missing-rem',
        customDictionary: { action: 'remove', profileId: 'nonexistent-profile-id', word: 'ghost' },
      }));
      await missingRemP;

      // 2. Delete the custom profile, then attempt add and full map update targeting deleted profile
      const delP = client.waitFor(
        (m) => m.type === 'agency.browserProfile.deleted' && m.requestId === 'f1-del',
        'f1-del',
      );
      client.ws.send(JSON.stringify({
        type: 'agency.browserProfile.delete',
        requestId: 'f1-del',
        profileId: profile.id,
      }));
      await delP;

      const deletedAddP = client.waitFor(
        (m) => m.type === 'error' && m.code === 'settings-failed' && m.requestId === 'f1-deleted-add',
        'f1-deleted-add',
      );
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'f1-deleted-add',
        customDictionary: { action: 'add', profileId: profile.id, word: 'recreated' },
      }));
      await deletedAddP;

      const fullMapP = client.waitFor(
        (m) => m.type === 'error' && m.code === 'settings-failed' && m.requestId === 'f1-full-map',
        'f1-full-map',
      );
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'f1-full-map',
        browser: {
          spellCheck: {
            customWordsByProfile: {
              [DEFAULT_BROWSER_PROFILE_ID]: ['mainword'],
              [profile.id]: ['bypassed'],
            },
          },
        },
      }));
      await fullMapP;

      assert.equal(h.settings.get().browser.spellCheck?.customWordsByProfile?.[profile.id], undefined);
      assert.equal(h.settings.get().browser.spellCheck?.customWordsByProfile?.['nonexistent-profile-id'], undefined);
      assert.deepEqual(h.settings.get().browser.spellCheck?.customWordsByProfile?.[DEFAULT_BROWSER_PROFILE_ID], ['mainword']);

      // 3. Subsequent main profile mutation remains fully operational
      const mainAfterP = client.waitFor(
        (m) => m.type === 'settings.status' && m.requestId === 'f1-main-after',
        'f1-main-after',
      );
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'f1-main-after',
        customDictionary: { action: 'add', profileId: DEFAULT_BROWSER_PROFILE_ID, word: 'stillworks' },
      }));
      await mainAfterP;
      assert.deepEqual(
        h.settings.get().browser.spellCheck?.customWordsByProfile?.[DEFAULT_BROWSER_PROFILE_ID],
        ['mainword', 'stillworks'],
      );
    } finally {
      client.ws.close();
    }
  } finally {
    await h.cleanup();
  }
});

test('F1 concurrency: dictionary mutations serialize against profile deletion and cannot resurrect entries', async () => {
  const h = await createSettingsHarness();
  try {
    const profileA = await h.agencyBrowserProfileStore.createProfile('Race Profile A');
    const profileB = await h.agencyBrowserProfileStore.createProfile('Race Profile B');
    const client = await openClient(h.port);
    try {
      // Case A: delete holds lock first -> concurrent add & full map update must wait and reject
      let enteredClear!: () => void;
      let releaseClear!: () => void;
      const enteredClearPromise = new Promise<void>((r) => { enteredClear = r; });
      const clearGatePromise = new Promise<void>((r) => { releaseClear = r; });
      const origClear = h.appSettings.clearProfileCustomDictionary.bind(h.appSettings);
      let interceptOnce = true;
      h.appSettings.clearProfileCustomDictionary = async (pid: string) => {
        if (interceptOnce && pid === profileA.id) {
          interceptOnce = false;
          enteredClear();
          await clearGatePromise;
        }
        return origClear(pid);
      };

      const delAP = client.waitFor(
        (m) => m.type === 'agency.browserProfile.deleted' && m.requestId === 'race-del-a',
        'race-del-a',
      );
      client.ws.send(JSON.stringify({
        type: 'agency.browserProfile.delete',
        requestId: 'race-del-a',
        profileId: profileA.id,
      }));
      await enteredClearPromise;

      let settledEarly = false;
      const raceAddP = client.waitFor(
        (m) => m.type === 'error' && m.code === 'settings-failed' && m.requestId === 'race-add-a',
        'race-add-a',
      ).then((m) => { settledEarly = true; return m; });
      const raceMapP = client.waitFor(
        (m) => m.type === 'error' && m.code === 'settings-failed' && m.requestId === 'race-map-a',
        'race-map-a',
      );

      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'race-add-a',
        customDictionary: { action: 'add', profileId: profileA.id, word: 'resurrected' },
      }));
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'race-map-a',
        browser: { spellCheck: { customWordsByProfile: { [profileA.id]: ['resurrected-map'] } } },
      }));

      await new Promise((r) => setTimeout(r, 30));
      assert.equal(settledEarly, false, 'Dictionary add must wait for in-flight profile deletion lock');

      releaseClear();
      await Promise.all([delAP, raceAddP, raceMapP]);
      assert.equal(h.agencyBrowserProfileStore.getProfile(profileA.id), null);
      assert.equal(h.settings.get().browser.spellCheck?.customWordsByProfile?.[profileA.id], undefined);

      // Case B: add holds lock first -> concurrent delete waits, then removes added entry cleanly
      let enteredAdd!: () => void;
      let releaseAdd!: () => void;
      const enteredAddPromise = new Promise<void>((r) => { enteredAdd = r; });
      const addGatePromise = new Promise<void>((r) => { releaseAdd = r; });
      const origAppUpdate = h.appSettings.update.bind(h.appSettings);
      let interceptAddOnce = true;
      h.appSettings.update = async (change) => {
        if (
          interceptAddOnce &&
          change.customDictionary?.action === 'add' &&
          change.customDictionary.profileId === profileB.id
        ) {
          interceptAddOnce = false;
          enteredAdd();
          await addGatePromise;
        }
        return origAppUpdate(change);
      };

      const addBP = client.waitFor(
        (m) => m.type === 'settings.status' && m.requestId === 'race-add-b',
        'race-add-b',
      );
      client.ws.send(JSON.stringify({
        type: 'settings.update',
        requestId: 'race-add-b',
        customDictionary: { action: 'add', profileId: profileB.id, word: 'inFlightWord' },
      }));
      await enteredAddPromise;

      let delBSettledEarly = false;
      const delBP = client.waitFor(
        (m) => m.type === 'agency.browserProfile.deleted' && m.requestId === 'race-del-b',
        'race-del-b',
      ).then((m) => { delBSettledEarly = true; return m; });
      client.ws.send(JSON.stringify({
        type: 'agency.browserProfile.delete',
        requestId: 'race-del-b',
        profileId: profileB.id,
      }));

      await new Promise((r) => setTimeout(r, 30));
      assert.equal(delBSettledEarly, false, 'Profile deletion must wait for in-flight dictionary mutation lock');

      releaseAdd();
      await Promise.all([addBP, delBP]);
      assert.equal(h.agencyBrowserProfileStore.getProfile(profileB.id), null);
      assert.equal(h.settings.get().browser.spellCheck?.customWordsByProfile?.[profileB.id], undefined);
    } finally {
      client.ws.close();
    }
  } finally {
    await h.cleanup();
  }
});

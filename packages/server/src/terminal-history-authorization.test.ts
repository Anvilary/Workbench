import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { TerminalId } from '@agent-workbench/shared';
import { SettingsStore } from './settings-store.js';
import { createAgentRegistry } from './agents/registry.js';
import { WorkspaceStore } from './workspace-store.js';
import { ArchivedSessions } from './archived-sessions.js';
import { WorktreeStore } from './worktrees/store.js';
import { WorktreeLinks } from './worktrees/links.js';
import { VaultCatalog } from './vault/catalog.js';
import { SessionIndex } from './session-index.js';
import { VaultService } from './vault/service.js';
import { TerminalRegistry } from './terminal-registry.js';
import { WorktreeService } from './worktrees/service.js';
import { AppSettingsService } from './app-settings-service.js';
import { NotesStore } from './notes-store.js';
import { DraftStore } from './draft-store.js';
import { ConversationHub } from './conversation-hub.js';
import { RepoHub } from './repo-hub.js';
import { MemoryHub } from './memory-hub.js';
import { RemoteAccessService } from './remote-access-service.js';
import { RemoteDevicesStore } from './remote-devices-store.js';
import { AgencyWorkspaceStore } from './agency/store.js';
import { AgencyProfileStore } from './agency/agency-profile-store.js';
import { AgencySessionRuntime } from './agency/agency-session-runtime.js';
import { SplitAgencySessionStore } from './agency/agency-session-store.js';
import { WorkspaceMutex } from './agency/workspace-lock.js';
import { attachTerminalSocket } from './terminal-socket.js';
import { TerminalHistoryStore } from './terminal-history-store.js';

interface MessageWaiter {
  waitFor(predicate: (msg: any) => boolean, timeoutMs?: number): Promise<any>;
}

function createWaiter(ws: WebSocket): MessageWaiter {
  const messages: any[] = [];
  const listeners: Array<(msg: any) => void> = [];

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString('utf8'));
      messages.push(parsed);
      for (const listener of listeners) {
        listener(parsed);
      }
    } catch {
      // ignore non-json
    }
  });

  return {
    waitFor(predicate: (msg: any) => boolean, timeoutMs = 5000): Promise<any> {
      for (const m of messages) {
        if (predicate(m)) return Promise.resolve(m);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(
            `Timeout waiting for message matching predicate after ${timeoutMs}ms. ` +
            `Received: ${JSON.stringify(messages.map(m => ({
              type: m.type,
              requestId: m.requestId,
              reason: m.reason,
              terminalId: m.terminalId,
            })))}`
          ));
        }, timeoutMs);

        const listener = (msg: any) => {
          if (predicate(msg)) {
            clearTimeout(timer);
            const idx = listeners.indexOf(listener);
            if (idx >= 0) listeners.splice(idx, 1);
            resolve(msg);
          }
        };
        listeners.push(listener);
      });
    },
  };
}

test('Session Authorization: terminal.history.page rejects unauthorized access and protects session boundaries', async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-auth-history-test-'));
  // All default ancillary stores are isolated too, including notifications/layouts.
  const originalConfig = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = path.join(tempDir, 'config');

  const app = express();
  const httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;

  const settings = new SettingsStore(path.join(tempDir, 'settings.json'));
  await settings.load();
  const agents = createAgentRegistry([]);
  const store = new WorkspaceStore();
  await store.load();
  const archived = new ArchivedSessions();
  await archived.load();
  const worktreeStore = new WorktreeStore(path.join(tempDir, 'worktrees.json'));
  await worktreeStore.load();
  const worktreeLinks = new WorktreeLinks(worktreeStore);
  const catalog = new VaultCatalog();
  const index = new SessionIndex(agents, archived, catalog, worktreeLinks);
  const vault = new VaultService({ agents, index, archived, settings, catalog, platform: process.platform });

  const shellLocation = {
    file: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
    name: 'test-node-shell',
  };

  const registry = new TerminalRegistry(
    agents,
    shellLocation,
    store,
    () => null,
    async () => null,
    () => tempDir,
  );
  await registry.initialize();

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
  const conversations = new ConversationHub(registry, agents);
  const repos = new RepoHub(registry);
  const memory = new MemoryHub(registry);
  const remote = new RemoteAccessService({
    settings,
    store: new RemoteDevicesStore(path.join(tempDir, 'devices.json')),
    listening: { port, fixed: false, fixedPortBusy: false },
  });
  await remote.load();
  // Exercise real WS credential dispatch with a deterministic paired-device verifier.
  remote.verifier = () => ({ match: credential => credential === 'paired-fixture-token' ? { id: 'paired-fixture-device' } : null });
  let revokePaired!: (deviceId: string | null) => void;
  const onRevoked = remote.onRevoked.bind(remote);
  remote.onRevoked = listener => { revokePaired = listener; return onRevoked(listener); };

  const agencyWorkspaceStore = new AgencyWorkspaceStore(path.join(tempDir, 'agency-state.json'));
  await agencyWorkspaceStore.load();
  const agencyProfileStore = new AgencyProfileStore(path.join(tempDir, 'agency-profiles.json'));
  await agencyProfileStore.listDefinitions();
  const workspaceLock = new WorkspaceMutex();
  const agencySessionStore = new SplitAgencySessionStore(path.join(tempDir, 'agency-sessions.json'));
  const agencyRuntime = new AgencySessionRuntime({
    registry,
    workspaces: {
      protectedDirectories: () => [],
      withSessionReservation: (_id, action) => action(null),
    },
    profiles: { resolveLaunch: async () => ({} as any) },
    store: agencySessionStore,
  });
  await agencyRuntime.initialize();

  const stores = new Map<TerminalId, TerminalHistoryStore>();
  let storesCreated = 0;
  const originalOpen = registry.open.bind(registry);
  registry.open = async (...args) => {
    const descriptor = await originalOpen(...args);
    // Output can arrive before the terminal.open request has resolved.
    registry.emit('output', descriptor.terminalId, 'early-output\n');
    return descriptor;
  };
  const detachSocket = attachTerminalSocket({
    httpServer,
    port,
    token: 'test-token',
    appSettings,
    registry,
    index,
    archived,
    notes,
    drafts,
    conversations,
    repos,
    memory,
    agents,
    defaultCwd: tempDir,
    vault,
    remote,
    worktrees,
    noAuth: false,
    historyStoreFactory: terminalId => {
      storesCreated++;
      const history = new TerminalHistoryStore(terminalId, { baseDir: path.join(tempDir, 'history'), maxQueueBytes: 64 });
      stores.set(terminalId, history);
      return history;
    },
    agencyWorkspaceStore,
    agencyProfileStore,
    agencyRuntime,
    workspaceLock,
  });

  t.after(async () => {
    try { wsA.close(); } catch {}
    try { wsB.close(); } catch {}
    await detachSocket();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    registry.disposeAll();
    await agencyRuntime.dispose();
    if (originalConfig === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = originalConfig;
    await rm(tempDir, { recursive: true, force: true });
  });

  const deniedStatus = await new Promise<number>(resolve => {
    const denied = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    denied.on('error', () => {});
    denied.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
      denied.terminate();
    });
  });
  assert.equal(deniedStatus, 403, 'history transport requires an authenticated connection');

  // Client A connects
  const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
  await new Promise<void>((resolve, reject) => {
    wsA.once('open', resolve);
    wsA.once('error', reject);
  });
  const waiterA = createWaiter(wsA);

  // Client B connects (unauthorized client)
  const wsB = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
  await new Promise<void>((resolve, reject) => {
    wsB.once('open', resolve);
    wsB.once('error', reject);
  });
  const waiterB = createWaiter(wsB);

  // 1. Client A opens a terminal
  wsA.send(JSON.stringify({
    type: 'terminal.open',
    requestId: 'open-t1',
    kind: 'shell',
    cwd: tempDir,
    label: 'Terminal Alpha',
  }));

  const openMsg = await waiterA.waitFor((m) => m.type === 'terminal.opened' && m.requestId === 'open-t1');
  const terminalId: TerminalId = openMsg.terminal.terminalId;
  assert.ok(terminalId, 'Terminal Alpha must be opened with valid ID');

  // Verify terminal exists in registry
  assert.equal(registry.has(terminalId), true);

  // 2. Client B attempts to access terminal Alpha history using the valid terminalId UUID
  wsB.send(JSON.stringify({
    type: 'terminal.history.page',
    terminalId,
    page: 0,
    pageSize: 50,
    requestId: 'attack-b-1',
  }));

  const attackReply = await waiterB.waitFor(
    (m) => m.type === 'terminal.history.error' && m.requestId === 'attack-b-1',
  );
  assert.equal(attackReply.terminalId, terminalId);
  assert.equal(attackReply.reason, 'Unauthorized session history access');

  // Even opening a terminal is not an active output/history attachment.
  wsA.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'open-before-attach' }));
  const beforeAttach = await waiterA.waitFor(m => m.requestId === 'open-before-attach');
  assert.equal(beforeAttach.reason, 'Unauthorized session history access');
  wsA.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 }));
  await waiterA.waitFor(m => m.type === 'terminal.replay' && m.terminalId === terminalId);

  // A second authenticated client may share the persistent session after attach.
  wsB.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 }));
  await waiterB.waitFor(m => m.type === 'terminal.replay' && m.terminalId === terminalId);
  wsB.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'shared-owner' }));
  const shared = await waiterB.waitFor(m => m.requestId === 'shared-owner');
  assert.equal(shared.type, 'terminal.history.data');
  assert.deepEqual(shared.lines, ['early-output']);
  wsB.send(JSON.stringify({ type: 'terminal.detach', terminalId }));

  // 3. Client A requests history for its own terminal -> succeeds
  wsA.send(JSON.stringify({
    type: 'terminal.history.page',
    terminalId,
    page: 0,
    pageSize: 50,
    requestId: 'auth-a-1',
  }));

  const authReply = await waiterA.waitFor(
    (m) => m.type === 'terminal.history.data' && m.requestId === 'auth-a-1',
  );
  assert.equal(authReply.terminalId, terminalId);
  assert.equal(authReply.page, 0);
  assert.ok(Array.isArray(authReply.lines));
  assert.equal(storesCreated, 1, 'opening reuses the store created by early output');
  assert.deepEqual(authReply.lines, ['early-output']);

  // 4. Requesting history for non-existent UUID fails with 'Terminal not found'
  const nonExistentId = randomUUID() as TerminalId;
  wsA.send(JSON.stringify({
    type: 'terminal.history.page',
    terminalId: nonExistentId,
    page: 0,
    pageSize: 50,
    requestId: 'auth-a-unknown',
  }));

  const unknownReply = await waiterA.waitFor(
    (m) => m.type === 'terminal.history.error' && m.requestId === 'auth-a-unknown',
  );
  assert.equal(unknownReply.reason, 'Terminal not found');

  // 5. Client A detaches from terminal Alpha -> authorization is revoked
  wsA.send(JSON.stringify({
    type: 'terminal.detach',
    terminalId,
  }));

  // Wait a tick for detach to take effect
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Client A requests history after detach -> rejected
  wsA.send(JSON.stringify({
    type: 'terminal.history.page',
    terminalId,
    page: 0,
    pageSize: 50,
    requestId: 'auth-a-after-detach',
  }));

  const postDetachReply = await waiterA.waitFor(
    (m) => m.type === 'terminal.history.error' && m.requestId === 'auth-a-after-detach',
  );
  assert.equal(postDetachReply.reason, 'Unauthorized session history access');

  // 6. Client A re-attaches -> authorization is restored
  wsA.send(JSON.stringify({
    type: 'terminal.attach',
    terminalId,
    cols: 80,
    rows: 24,
  }));

  await waiterA.waitFor((m) => m.type === 'terminal.replay' && m.terminalId === terminalId);

  wsA.send(JSON.stringify({
    type: 'terminal.history.page',
    terminalId,
    page: 0,
    pageSize: 50,
    requestId: 'auth-a-reattached',
  }));

  const reattachedReply = await waiterA.waitFor(
    (m) => m.type === 'terminal.history.data' && m.requestId === 'auth-a-reattached',
  );
  assert.equal(reattachedReply.terminalId, terminalId);
  assert.equal(reattachedReply.page, 0);

  const history = stores.get(terminalId)!;
  const originalGetPage = history.getPage.bind(history);
  let releaseRead!: () => void;
  let enteredRead!: () => void;
  const released = new Promise<void>(resolve => { releaseRead = resolve; });
  const entered = new Promise<void>(resolve => { enteredRead = resolve; });
  history.getPage = async (...args) => {
    enteredRead();
    await released;
    return originalGetPage(...args);
  };
  wsA.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'deferred-read' }));
  await entered;
  wsA.send(JSON.stringify({ type: 'terminal.detach', terminalId }));
  // A subsequent request is an ordering barrier for detach, without a time delay.
  wsA.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'detach-barrier' }));
  await waiterA.waitFor(m => m.type === 'terminal.history.error' && m.requestId === 'detach-barrier');
  // Even reattachment cannot restore the lease used by the pending read.
  wsA.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 81, rows: 24 }));
  // Resize is observable in registry and the attach handler is synchronous.
  wsA.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'reattach-barrier' }));
  await waiterA.waitFor(m => m.requestId === 'reattach-barrier');
  releaseRead();
  const revoked = await waiterA.waitFor(m => m.requestId === 'deferred-read');
  assert.equal(revoked.type, 'terminal.history.error');
  assert.equal(revoked.reason, 'Unauthorized session history access');
  history.getPage = originalGetPage;

  // Queue overflow is observable through the real socket response.
  registry.emit('output', terminalId, 'x'.repeat(256));
  wsA.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 }));
  wsA.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'loss-metadata' }));
  const loss = await waiterA.waitFor(m => m.requestId === 'loss-metadata');
  assert.equal(loss.type, 'terminal.history.data');
  assert.equal(loss.incomplete, true);
  assert.ok(loss.droppedBytes > 0);


  history.getPage = async () => { throw new Error('secret filesystem path or terminal data'); };
  wsA.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'private-error' }));
  const failedRead = await waiterA.waitFor(m => m.requestId === 'private-error');
  assert.equal(failedRead.reason, 'History read failed');
  history.getPage = originalGetPage;

  // A terminal can remain in the registry while its Agency workspace closes.
  const originalSessions = agencyRuntime.list.bind(agencyRuntime);
  const originalWorkspace = agencyWorkspaceStore.getWorkspace.bind(agencyWorkspaceStore);
  const workspaceId = randomUUID() as never;
  agencyRuntime.list = () => [{ terminalId, workspaceId, tab: { current: true, closedAt: null } } as never];
  agencyWorkspaceStore.getWorkspace = () => ({ id: workspaceId, status: 'done' } as never);
  wsA.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'inactive-workspace' }));
  const inactive = await waiterA.waitFor(m => m.requestId === 'inactive-workspace');
  assert.equal(inactive.reason, 'Unauthorized workspace session access');
  agencyRuntime.list = originalSessions;
  agencyWorkspaceStore.getWorkspace = originalWorkspace;

  // A transient permission revocation must not revive an older attachment.
  const sessionId = randomUUID();
  let lifecycle = 'running';
  agencyRuntime.list = () => [{ id: sessionId, terminalId, workspaceId, lifecycle, tab: { current: true, closedAt: null } } as never];
  agencyWorkspaceStore.getWorkspace = () => ({ id: workspaceId, status: 'active' } as never);
  let releasePermission!: () => void;
  let enteredPermission!: () => void;
  const permissionReleased = new Promise<void>(resolve => { releasePermission = resolve; });
  const permissionEntered = new Promise<void>(resolve => { enteredPermission = resolve; });
  history.getPage = async (...args) => { enteredPermission(); await permissionReleased; return originalGetPage(...args); };
  wsA.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'permission-read' }));
  await permissionEntered;
  lifecycle = 'stopping';
  agencyRuntime.emit('changed', { id: sessionId });
  lifecycle = 'running';
  releasePermission();
  const revokedPermission = await waiterA.waitFor(m => m.requestId === 'permission-read');
  assert.equal(revokedPermission.type, 'terminal.history.error');
  assert.equal(revokedPermission.reason, 'Unauthorized session history access');
  agencyRuntime.list = originalSessions;
  agencyWorkspaceStore.getWorkspace = originalWorkspace;
  history.getPage = originalGetPage;

  // A fresh socket has no history lease, even with the same valid owner token.
  const wsReconnected = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
  await new Promise<void>((resolve, reject) => { wsReconnected.once('open', resolve); wsReconnected.once('error', reject); });
  const reconnectedWaiter = createWaiter(wsReconnected);
  wsReconnected.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'fresh-connection' }));
  assert.equal((await reconnectedWaiter.waitFor(m => m.requestId === 'fresh-connection')).reason, 'Unauthorized session history access');
  wsReconnected.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 }));
  wsReconnected.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'fresh-attachment' }));
  assert.equal((await reconnectedWaiter.waitFor(m => m.requestId === 'fresh-attachment')).type, 'terminal.history.data');
  wsReconnected.close();

  // Paired devices share the owner's persistent session only after attaching.
  const paired = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: 'agent_workbench_device=paired-fixture-token' } });
  await new Promise<void>((resolve, reject) => { paired.once('open', resolve); paired.once('error', reject); });
  const pairedWaiter = createWaiter(paired);
  paired.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 }));
  await pairedWaiter.waitFor(m => m.type === 'terminal.replay' && m.terminalId === terminalId);
  let releasePaired!: () => void;
  let enteredPaired!: () => void;
  let finishedPaired!: () => void;
  const pairedReleased = new Promise<void>(resolve => { releasePaired = resolve; });
  const pairedEntered = new Promise<void>(resolve => { enteredPaired = resolve; });
  const pairedFinished = new Promise<void>(resolve => { finishedPaired = resolve; });
  history.getPage = async (...args) => { enteredPaired(); await pairedReleased; try { return await originalGetPage(...args); } finally { finishedPaired(); } };
  let leaked = false;
  paired.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'terminal.history.data' && message.requestId === 'revoked-device-read') leaked = true; });
  paired.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'revoked-device-read' }));
  await pairedEntered;
  const pairedClosed = new Promise<number>(resolve => paired.once('close', code => resolve(code)));
  revokePaired('paired-fixture-device');
  assert.equal(await pairedClosed, 4001);
  releasePaired();
  await pairedFinished;
  assert.equal(leaked, false);
  history.getPage = originalGetPage;

  wsA.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 }));
  // A history reply is the attach/read completion barrier.
  wsA.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'after-permission-reattach' }));
  assert.equal((await waiterA.waitFor(m => m.requestId === 'after-permission-reattach')).type, 'terminal.history.data');

  let releaseClosing!: () => void;
  let enteredClosing!: () => void;
  const closingReleased = new Promise<void>(resolve => { releaseClosing = resolve; });
  const closingEntered = new Promise<void>(resolve => { enteredClosing = resolve; });
  history.getPage = async (...args) => {
    enteredClosing();
    await closingReleased;
    return originalGetPage(...args);
  };
  wsA.send(JSON.stringify({ type: 'terminal.history.page', terminalId, page: 0, requestId: 'closing-read' }));
  await closingEntered;
  wsA.send(JSON.stringify({ type: 'terminal.close', terminalId }));
  await waiterA.waitFor(m => m.type === 'terminal.closed' && m.terminalId === terminalId);
  releaseClosing();
  const closedRead = await waiterA.waitFor(m => m.requestId === 'closing-read');
  assert.equal(closedRead.type, 'terminal.history.error');
  assert.equal(closedRead.reason, 'Terminal not found');

});

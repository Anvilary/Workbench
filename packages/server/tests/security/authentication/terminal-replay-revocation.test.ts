import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { attachTerminalSocket } from '../../../src/terminal-socket.js';
import { TerminalRegistry } from '../../../src/terminal-registry.js';
import { createAgentRegistry } from '../../../src/agents/registry.js';
import { WorkspaceStore } from '../../../src/workspace-store.js';
import { SessionIndex } from '../../../src/session-index.js';
import { ArchivedSessions } from '../../../src/archived-sessions.js';
import { VaultCatalog } from '../../../src/vault/catalog.js';
import { WorktreeLinks } from '../../../src/worktrees/links.js';
import { WorktreeStore } from '../../../src/worktrees/store.js';
import { VaultService } from '../../../src/vault/service.js';
import { WorktreeService } from '../../../src/worktrees/service.js';
import { AppSettingsService } from '../../../src/app-settings-service.js';
import { SettingsStore } from '../../../src/settings-store.js';
import { NotesStore } from '../../../src/notes-store.js';
import { DraftStore } from '../../../src/draft-store.js';
import { ConversationHub } from '../../../src/conversation-hub.js';
import { RepoHub } from '../../../src/repo-hub.js';
import { MemoryHub } from '../../../src/memory-hub.js';
import { RemoteAccessService } from '../../../src/remote-access-service.js';
import { RemoteDevicesStore } from '../../../src/remote-devices-store.js';
import { AgencyWorkspaceStore } from '../../../src/agency/store.js';
import { AgencyProfileStore } from '../../../src/agency/agency-profile-store.js';
import { AgencySessionRuntime } from '../../../src/agency/agency-session-runtime.js';
import { SplitAgencySessionStore } from '../../../src/agency/agency-session-store.js';
import { WorkspaceMutex } from '../../../src/agency/workspace-lock.js';
import { TerminalHistoryStore } from '../../../src/terminal-history-store.js';

interface TestHarness {
  port: number;
  registry: TerminalRegistry;
  agencyRuntime: AgencySessionRuntime;
  agencyWorkspaceStore: AgencyWorkspaceStore;
  tempDir: string;
  createSocket(): Promise<{ ws: WebSocket; server: WebSocket; messages: any[]; waitFor(predicate: (m: any) => boolean, timeoutMs?: number): Promise<any> }>;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<TestHarness> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-replay-revocation-test-'));
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

  const registry = new TerminalRegistry(
    agents,
    { file: process.execPath, args: ['-e', 'process.stdin.resume()'], name: 'synthetic-shell' },
    store,
    () => null,
    async () => null,
    () => path.join(tempDir, 'shell-integration'),
    { persistentPty: false },
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

  const activeSockets = new Set<WebSocket>();

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
    historyStoreFactory: (terminalId) => new TerminalHistoryStore(terminalId, { baseDir: path.join(tempDir, 'history') }),
    agencyWorkspaceStore,
    agencyProfileStore,
    agencyRuntime,
    workspaceLock,
  });

  const createSocket = async () => {
    let server!: WebSocket;
    const originalEmit = WebSocketServer.prototype.emit;
    WebSocketServer.prototype.emit = function(event: string, ...args: any[]) {
      if (event === 'connection' && args[1]?.socket?.localPort === port) server = args[0];
      return originalEmit.call(this, event, ...args);
    };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
    activeSockets.add(ws);
    try { await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 3000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    }); } finally { WebSocketServer.prototype.emit = originalEmit; }
    assert.ok(server);

    const messages: any[] = [];
    const listeners: Array<(m: any) => void> = [];

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString('utf8'));
        messages.push(msg);
        for (const l of listeners) l(msg);
      } catch {}
    });

    const waitFor = (predicate: (m: any) => boolean, timeoutMs = 3000): Promise<any> => {
      for (const m of messages) {
        if (predicate(m)) return Promise.resolve(m);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = listeners.indexOf(listener);
          if (idx >= 0) listeners.splice(idx, 1);
          reject(new Error(`Timeout waiting for message after ${timeoutMs}ms. Messages: ${JSON.stringify(messages.map(m => m.type))}`));
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
    };

    return { ws, server, messages, waitFor };
  };

  const cleanup = async () => {
    for (const ws of activeSockets) {
      try { ws.close(); ws.terminate(); } catch {}
    }
    await detachSocket();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    registry.disposeAll();
    await store.flush();
    await agencyRuntime.dispose();
    if (originalConfig === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = originalConfig;
    await rm(tempDir, { recursive: true, force: true });
  };

  return { port, registry, agencyRuntime, agencyWorkspaceStore, tempDir, createSocket, cleanup };
}

test('Scenario 1: Detach during checkpoint recovery prevents replay, stops live output and clears listener', async (t) => {
  const h = await createHarness();
  t.after(async () => { await h.cleanup(); });

  const desc = await h.registry.open({ cwd: h.tempDir, kind: 'shell' });
  const terminalId = desc.terminalId;
  const entry = (h.registry as any).terminals.get(terminalId);

  let releaseCheckpoint!: () => void;
  const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
  const origCheckpoint = entry.buffer.checkpoint.bind(entry.buffer);

  let checkpointEntered = false;
  entry.buffer.checkpoint = async () => {
    checkpointEntered = true;
    await checkpointGate;
    return origCheckpoint();
  };

  const { ws, messages } = await h.createSocket();

  try {
    // 1. Start attachment
    ws.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 }));

    const start = Date.now();
    while (!checkpointEntered && Date.now() - start < 3000) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(checkpointEntered, 'Checkpoint should have been invoked');

    // Listener is registered in entry.listeners while awaiting checkpoint
    assert.equal(entry.listeners.size, 1, 'Listener must be registered during attachment replay');

    // 2. Detach before releasing checkpoint
    ws.send(JSON.stringify({ type: 'terminal.detach', terminalId }));
    await new Promise(r => setTimeout(r, 40));

    // 3. Emit live output from PTY while checkpoint is still suspended
    entry.buffer.push('LIVE_AFTER_DETACH\r\n');
    for (const l of entry.listeners) {
      l(terminalId, 'LIVE_AFTER_DETACH\r\n', entry.buffer.endOffset);
    }
    await new Promise(r => setTimeout(r, 30));

    // 4. Release checkpoint
    releaseCheckpoint();
    await new Promise(r => setTimeout(r, 80));

    // Invariants:
    // - No revoked replay bytes reach the socket
    const replayMsg = messages.find(m => m.type === 'terminal.replay' && m.terminalId === terminalId);
    assert.equal(replayMsg, undefined, 'No revoked replay bytes must reach detached socket');

    // - No subsequent live output reaches detached socket
    const leakedOutput = messages.some(m => JSON.stringify(m).includes('LIVE_AFTER_DETACH'));
    assert.equal(leakedOutput, false, 'No subsequent live output must reach detached socket');

    // - No output listener remains registered
    assert.equal(entry.listeners.size, 0, 'No output listener must remain registered on detached terminal');

    // - Stale attachment cannot restore input grant
    let ptyReceived = '';
    const origWrite = h.registry.write.bind(h.registry);
    h.registry.write = (id, data) => {
      if (id === terminalId) ptyReceived += data;
      return origWrite(id, data);
    };

    ws.send(JSON.stringify({ type: 'input', terminalId, data: 'echo stale\n' }));
    await new Promise(r => setTimeout(r, 40));
    assert.equal(ptyReceived, '', 'Stale attachment must not restore input grant');

    // - Stale attachment cannot restore history grant
    ws.send(JSON.stringify({ type: 'terminal.history.page', terminalId, requestId: 'req-detached-hist', page: 1 }));
    await new Promise(r => setTimeout(r, 40));
    const histErr = messages.find(m => m.type === 'terminal.history.error' && m.requestId === 'req-detached-hist');
    assert.ok(histErr, 'Stale attachment must not restore history grant');
    assert.equal(histErr.reason, 'Unauthorized session history access');
  } finally {
    releaseCheckpoint();
  }
});

test('Scenario 2: Temporary workspace authorization revocation invalidates in-flight attachment even after restoration', async (t) => {
  const h = await createHarness();
  t.after(async () => { await h.cleanup(); });

  const desc = await h.registry.open({ cwd: h.tempDir, kind: 'shell' });
  const terminalId = desc.terminalId;
  const entry = (h.registry as any).terminals.get(terminalId);

  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  let sessionLifecycle = 'running';
  let workspaceStatus = 'active';

  h.agencyRuntime.list = () => [{
    id: sessionId,
    terminalId,
    workspaceId,
    lifecycle: sessionLifecycle,
    tab: { current: true, closedAt: null },
  } as any];

  h.agencyWorkspaceStore.getWorkspace = () => ({
    id: workspaceId,
    status: workspaceStatus,
  } as any);

  let releaseCheckpoint!: () => void;
  const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
  const origCheckpoint = entry.buffer.checkpoint.bind(entry.buffer);

  let checkpointEntered = false;
  entry.buffer.checkpoint = async () => {
    checkpointEntered = true;
    await checkpointGate;
    return origCheckpoint();
  };

  const { ws, messages } = await h.createSocket();

  try {
    ws.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 }));

    const start = Date.now();
    while (!checkpointEntered && Date.now() - start < 3000) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(checkpointEntered, 'Checkpoint should have entered');

    // Revoke authorization while replay is suspended
    sessionLifecycle = 'stopping';
    h.agencyRuntime.emit('changed', { id: sessionId });
    await new Promise(r => setTimeout(r, 40));

    // Restore authorization before releasing checkpoint
    sessionLifecycle = 'running';
    h.agencyRuntime.emit('changed', { id: sessionId });
    await new Promise(r => setTimeout(r, 40));

    // Release checkpoint
    releaseCheckpoint();
    await new Promise(r => setTimeout(r, 80));

    // Verification
    const replayMsg = messages.find(m => m.type === 'terminal.replay' && m.terminalId === terminalId);
    assert.equal(replayMsg, undefined, 'Replay must not be delivered for revoked lease even after authorization restored');
    assert.equal(entry.listeners.size, 0, 'No listener should remain registered');

    // Verify input rejected
    let inputReceived = '';
    const origWrite = h.registry.write.bind(h.registry);
    h.registry.write = (id, data) => {
      if (id === terminalId) inputReceived += data;
      return origWrite(id, data);
    };
    ws.send(JSON.stringify({ type: 'input', terminalId, data: 'echo unauth\n' }));
    await new Promise(r => setTimeout(r, 40));
    assert.equal(inputReceived, '', 'Input must be rejected when lease was revoked');

    // Verify history rejected
    ws.send(JSON.stringify({ type: 'terminal.history.page', terminalId, requestId: 'req-revoked-scen2', page: 1 }));
    await new Promise(r => setTimeout(r, 40));
    const histErr = messages.find(m => m.type === 'terminal.history.error' && m.requestId === 'req-revoked-scen2');
    assert.ok(histErr, 'History must be rejected');
    assert.equal(histErr.reason, 'Unauthorized session history access');
  } finally {
    releaseCheckpoint();
  }
});

test('Scenario 3: Overlapping replay operations preserve newer attachment state and deliver output exactly once', async (t) => {
  const h = await createHarness();
  t.after(async () => { await h.cleanup(); });

  const desc = await h.registry.open({ cwd: h.tempDir, kind: 'shell' });
  const terminalId = desc.terminalId;
  const entry = (h.registry as any).terminals.get(terminalId);

  let cp1Resolve!: () => void;
  let cp2Resolve!: () => void;
  const cp1Gate = new Promise<void>((r) => { cp1Resolve = r; });
  const cp2Gate = new Promise<void>((r) => { cp2Resolve = r; });

  let cpCount = 0;
  const origCheckpoint = entry.buffer.checkpoint.bind(entry.buffer);
  entry.buffer.checkpoint = async () => {
    cpCount++;
    const current = cpCount;
    if (current === 1) await cp1Gate;
    else if (current === 2) await cp2Gate;
    return origCheckpoint();
  };

  const { ws, messages } = await h.createSocket();

  try {
    // Attach 1
    ws.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 }));
    while (cpCount < 1) await new Promise(r => setTimeout(r, 10));

    // Attach 2 for same terminal
    ws.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 100, rows: 30 }));
    const cpStart = Date.now();
    while (cpCount < 2 && Date.now() - cpStart < 500) await new Promise(r => setTimeout(r, 10));
    assert.ok(cpCount >= 2, "Second attachment must be processed without being blocked by first attachment");

    // Resume Attach 1 first
    cp1Resolve();
    await new Promise(r => setTimeout(r, 40));

    // Resume Attach 2 second
    cp2Resolve();
    await new Promise(r => setTimeout(r, 80));

    // Exactly one replay delivered (Attach 2)
    const replays = messages.filter(m => m.type === 'terminal.replay' && m.terminalId === terminalId);
    assert.equal(replays.length, 1, 'Only one replay must be delivered to the client');

    // Newer listener remains registered
    assert.equal(entry.listeners.size, 1, 'Listener needed by the new attachment must remain registered');

    // Live output delivered exactly once
    const outBefore = messages.filter(m => m.type === 'terminal.output' && m.data === 'EXACTLY_ONCE\r\n').length;
    for (const l of entry.listeners) {
      l(terminalId, 'EXACTLY_ONCE\r\n', entry.buffer.endOffset);
    }
    await new Promise(r => setTimeout(r, 40));
    const outAfter = messages.filter(m => m.type === 'terminal.output' && m.data === 'EXACTLY_ONCE\r\n').length;
    assert.equal(outAfter - outBefore, 1, 'New output must be delivered exactly once');

    // Input accepted for second attachment
    let inputDelivered = '';
    const origWrite = h.registry.write.bind(h.registry);
    h.registry.write = (id, data) => {
      if (id === terminalId) inputDelivered += data;
      return origWrite(id, data);
    };
    ws.send(JSON.stringify({ type: 'input', terminalId, data: 'pwd\n' }));
    await new Promise(r => setTimeout(r, 40));
    assert.equal(inputDelivered, 'pwd\n', 'Input must be delivered under current attachment grant');
  } finally {
    cp1Resolve();
    cp2Resolve();
  }
});

test('Scenario 4: Backpressure recovery preserves watermarks and cannot revive detached terminals', async (t) => {
  const h = await createHarness();
  t.after(async () => { await h.cleanup(); });

  const descA = await h.registry.open({ cwd: h.tempDir, kind: 'shell' });
  const terminalIdA = descA.terminalId;
  const descB = await h.registry.open({ cwd: h.tempDir, kind: 'shell' });
  const terminalIdB = descB.terminalId;

  const entryA = (h.registry as any).terminals.get(terminalIdA);
  const entryB = (h.registry as any).terminals.get(terminalIdB);

  const { ws, messages, waitFor } = await h.createSocket();

  // Attach both terminals
  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: terminalIdA, cols: 80, rows: 24 }));
  await waitFor(m => m.type === 'terminal.replay' && m.terminalId === terminalIdA);

  ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: terminalIdB, cols: 80, rows: 24 }));
  await waitFor(m => m.type === 'terminal.replay' && m.terminalId === terminalIdB);

  // Detach Terminal B
  ws.send(JSON.stringify({ type: 'terminal.detach', terminalId: terminalIdB }));
  await new Promise(r => setTimeout(r, 40));

  assert.equal(entryB.listeners.size, 0, 'Detached terminal B must have 0 listeners');
  assert.equal(entryA.listeners.size, 1, 'Attached terminal A must retain 1 listener');

  // Emit output on Terminal A and verify it reaches socket
  const outBefore = messages.filter(m => m.type === 'terminal.output' && m.terminalId === terminalIdA).length;
  entryA.buffer.push('CHUNK_A\r\n');
  for (const l of entryA.listeners) l(terminalIdA, 'CHUNK_A\r\n', entryA.buffer.endOffset);
  await new Promise(r => setTimeout(r, 40));
  const outAfter = messages.filter(m => m.type === 'terminal.output' && m.terminalId === terminalIdA).length;
  assert.equal(outAfter - outBefore, 1, 'Terminal A output must be received');

  // Verify Terminal B cannot be revived by emitting to it
  entryB.buffer.push('CHUNK_B\r\n');
  for (const l of entryB.listeners) l(terminalIdB, 'CHUNK_B\r\n', entryB.buffer.endOffset);
  await new Promise(r => setTimeout(r, 40));
  const leakedB = messages.some(m => m.type === 'terminal.output' && m.terminalId === terminalIdB);
  assert.equal(leakedB, false, 'Detached terminal B must not receive output');
});

test('Scenario 5: Socket termination during suspended replay releases per-socket state and preserves other sockets', async (t) => {
  const h = await createHarness();
  t.after(async () => { await h.cleanup(); });

  const descA = await h.registry.open({ cwd: h.tempDir, kind: 'shell' });
  const terminalIdA = descA.terminalId;
  const descB = await h.registry.open({ cwd: h.tempDir, kind: 'shell' });
  const terminalIdB = descB.terminalId;

  const entryA = (h.registry as any).terminals.get(terminalIdA);
  const entryB = (h.registry as any).terminals.get(terminalIdB);

  // Healthy client 2
  const sock2 = await h.createSocket();
  sock2.ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: terminalIdB, cols: 80, rows: 24 }));
  await sock2.waitFor(m => m.type === 'terminal.replay' && m.terminalId === terminalIdB);

  // Client 1 with suspended checkpoint
  let releaseCheckpoint!: () => void;
  const checkpointGate = new Promise<void>((r) => { releaseCheckpoint = r; });
  const origCheckpoint = entryA.buffer.checkpoint.bind(entryA.buffer);

  let checkpointEntered = false;
  entryA.buffer.checkpoint = async () => {
    checkpointEntered = true;
    await checkpointGate;
    return origCheckpoint();
  };

  const sock1 = await h.createSocket();

  try {
    sock1.ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: terminalIdA, cols: 80, rows: 24 }));
    while (!checkpointEntered) await new Promise(r => setTimeout(r, 10));

    // Terminate socket 1 while checkpoint is suspended
    sock1.ws.terminate();
    await new Promise(r => setTimeout(r, 40));

    // Release checkpoint
    releaseCheckpoint();
    await new Promise(r => setTimeout(r, 60));

    // Terminal A has 0 listeners
    assert.equal(entryA.listeners.size, 0, 'Terminal A must have 0 listeners after socket 1 teardown');

    // Terminal B on Client 2 is completely unaffected
    assert.equal(entryB.listeners.size, 1, 'Terminal B on client 2 must retain its listener');
    const bBefore = sock2.messages.filter(m => m.type === 'terminal.output' && m.terminalId === terminalIdB).length;
    for (const l of entryB.listeners) l(terminalIdB, 'CLIENT2_ALIVE\r\n', entryB.buffer.endOffset);
    await new Promise(r => setTimeout(r, 40));
    const bAfter = sock2.messages.filter(m => m.type === 'terminal.output' && m.terminalId === terminalIdB).length;
    assert.equal(bAfter - bBefore, 1, 'Client 2 must receive live output on Terminal B');
  } finally {
    releaseCheckpoint();
  }
});


// A finite failure deadline bounds event gates without defining input semantics.
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 3000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test('Scenario 6: FIFO input and revocation are independent of suspended graphical recovery', { timeout: 15000 }, async (t) => {
  const h = await createHarness();
  t.after(() => h.cleanup());
  const a = (await h.registry.open({ cwd: h.tempDir, kind: 'shell' })).terminalId;
  const b = (await h.registry.open({ cwd: h.tempDir, kind: 'shell' })).terminalId;
  const entry = (h.registry as any).terminals.get(a);
  const gate = deferred();
  const started = deferred();
  const finished = deferred();
  const originalCheckpoint = entry.buffer.checkpoint.bind(entry.buffer);
  const originalWrite = h.registry.write.bind(h.registry);
  const writes: Array<{ id: string; data: string }> = [];
  let first = true;
  let oldFinished = false;
  entry.buffer.checkpoint = async (signal?: AbortSignal) => {
    if (!first) return originalCheckpoint(signal);
    first = false;
    started.resolve();
    try {
      await gate.promise;
      return await originalCheckpoint(signal);
    } finally { oldFinished = true; finished.resolve(); }
  };
  h.registry.write = (id, data) => {
    writes.push({ id, data });
    return originalWrite(id, data);
  };
  const one = await h.createSocket();
  const two = await h.createSocket();
  const send = (message: object) => one.ws.send(JSON.stringify(message));
  try {
    two.ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: b, cols: 80, rows: 24 }));
    await two.waitFor(m => m.type === 'terminal.replay' && m.terminalId === b);
    send({ type: 'input', terminalId: a, data: 'UNATTACHED' });
    send({ type: 'terminal.attach', terminalId: a, cols: 80, rows: 24 });
    await bounded(started.promise, 'checkpoint entry');
    assert.equal(entry.listeners.size, 1);
    send({ type: 'input', terminalId: a, data: 'BEFORE-1' });
    send({ type: 'input', terminalId: a, data: 'BEFORE-2' });
    // The same lease authorizes history even while graphical replay is pending.
    send({ type: 'terminal.history.page', terminalId: a, page: 0, requestId: 'pending-history' });
    await one.waitFor(m => m.requestId === 'pending-history' && m.type === 'terminal.history.data');
    assert.deepEqual(writes.filter(w => w.id === a).map(w => w.data), ['BEFORE-1', 'BEFORE-2']);
    assert.equal(oldFinished, false, 'Input and history cannot wait on graphical recovery');

    send({ type: 'terminal.detach', terminalId: a });
    send({ type: 'input', terminalId: a, data: 'AFTER-1' });
    send({ type: 'input', terminalId: a, data: 'AFTER-2' });
    send({ type: 'terminal.history.page', terminalId: a, page: 0, requestId: 'detach-barrier' });
    await one.waitFor(m => m.requestId === 'detach-barrier' && m.type === 'terminal.history.error');
    assert.equal(entry.listeners.size, 0, 'Detach revokes the listener before checkpoint release');
    assert.equal(oldFinished, false);
    assert.deepEqual(writes.filter(w => w.id === a).map(w => w.data), ['BEFORE-1', 'BEFORE-2']);
    entry.buffer.push('REVOKED-LIVE');
    for (const listener of entry.listeners) listener(a, 'REVOKED-LIVE', entry.buffer.endOffset);
    assert.equal(one.messages.some(m => m.type === 'terminal.replay' && m.terminalId === a), false);

    send({ type: 'terminal.attach', terminalId: a, cols: 100, rows: 30 });
    send({ type: 'input', terminalId: a, data: 'NEW-LEASE' });
    const replay = await one.waitFor(m => m.type === 'terminal.replay' && m.terminalId === a);
    assert.deepEqual([replay.cols, replay.rows], [100, 30]);
    assert.equal(entry.listeners.size, 1);
    gate.resolve();
    await bounded(finished.promise, 'old checkpoint completion');
    send({ type: 'input', terminalId: a, data: 'AFTER-OLD-COMPLETION' });
    send({ type: 'input', terminalId: b, data: 'FOREIGN-SOCKET' });
    send({ type: 'terminal.history.page', terminalId: a, page: 0, requestId: 'final-barrier' });
    await one.waitFor(m => m.requestId === 'final-barrier' && m.type === 'terminal.history.data');
    assert.equal(one.messages.filter(m => m.type === 'terminal.replay' && m.terminalId === a).length, 1, 'Old replay must remain cancelled');
    assert.equal(one.messages.some(m => m.type === 'terminal.output' && m.data.includes('REVOKED-LIVE')), false);
    assert.equal(entry.listeners.size, 1, 'Old completion cannot remove the newer listener');
    assert.deepEqual(writes.filter(w => w.id === a).map(w => w.data), ['BEFORE-1', 'BEFORE-2', 'NEW-LEASE', 'AFTER-OLD-COMPLETION']);
    assert.equal(writes.some(w => w.data === 'FOREIGN-SOCKET'), false);
    two.ws.send(JSON.stringify({ type: 'input', terminalId: b, data: 'INDEPENDENT' }));
    two.ws.send(JSON.stringify({ type: 'terminal.history.page', terminalId: b, page: 0, requestId: 'independent-barrier' }));
    await two.waitFor(m => m.requestId === 'independent-barrier');
    assert.equal(writes.filter(w => w.id === b && w.data === 'INDEPENDENT').length, 1);
  } finally {
    gate.resolve();
    entry.buffer.checkpoint = originalCheckpoint;
    h.registry.write = originalWrite;
  }
});

for (const ending of ['close', 'shutdown'] as const) test(`Suspended recovery permits input and ${ending} without awaiting its checkpoint`, { timeout: 10000 }, async () => {
  const h = await createHarness();
  const id = (await h.registry.open({ cwd: h.tempDir, kind: 'shell' })).terminalId;
  const entry = (h.registry as any).terminals.get(id);
  const started = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  const originalCheckpoint = entry.buffer.checkpoint.bind(entry.buffer);
  const originalWrite = h.registry.write.bind(h.registry);
  const writes: string[] = [];
  entry.buffer.checkpoint = async (s?: AbortSignal) => {
    signal = s;
    started.resolve();
    await release.promise;
    return originalCheckpoint(s);
  };
  h.registry.write = (terminalId, data) => {
    if (terminalId === id) writes.push(data);
    return originalWrite(terminalId, data);
  };
  let cleaned = false;
  try {
    const one = await h.createSocket();
    one.ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: id, cols: 80, rows: 24 }));
    await bounded(started.promise, 'checkpoint entry');
    one.ws.send(JSON.stringify({ type: 'input', terminalId: id, data: 'BEFORE' }));
    if (ending === 'close') {
      one.ws.send(JSON.stringify({ type: 'terminal.close', terminalId: id }));
      one.ws.send(JSON.stringify({ type: 'input', terminalId: id, data: 'AFTER' }));
      await one.waitFor(m => m.type === 'terminal.closed' && m.terminalId === id);
      assert.equal(h.registry.has(id), false);
    } else {
      one.ws.send(JSON.stringify({ type: 'terminal.history.page', terminalId: id, page: 0, requestId: 'input-barrier' }));
      await one.waitFor(m => m.requestId === 'input-barrier');
      await bounded(h.cleanup(), 'shutdown with suspended checkpoint');
      cleaned = true;
    }
    assert.deepEqual(writes, ['BEFORE']);
    assert.equal(entry.listeners.size, 0);
    assert.equal(signal?.aborted, true, 'Revocation cancels graphical work');
    assert.equal(one.messages.some(m => m.type === 'terminal.replay' && m.terminalId === id), false);
  } finally {
    release.resolve();
    entry.buffer.checkpoint = originalCheckpoint;
    h.registry.write = originalWrite;
    if (!cleaned) await h.cleanup();
  }
});

test('Synchronous attachment setup failure cannot leave an input or history grant', { timeout: 10000 }, async () => {
  const h = await createHarness();
  const id = (await h.registry.open({ cwd: h.tempDir, kind: 'shell' })).terminalId;
  const entry = (h.registry as any).terminals.get(id);
  const originalResize = h.registry.resize;
  const originalWrite = h.registry.write;
  const writes: string[] = [];
  h.registry.resize = () => { throw new Error('fixture supervisor disconnected'); };
  h.registry.write = (_id, data) => { writes.push(data); return true; };
  try {
    const one = await h.createSocket();
    one.ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: id, cols: 80, rows: 24 }));
    one.ws.send(JSON.stringify({ type: 'input', terminalId: id, data: 'DENIED' }));
    one.ws.send(JSON.stringify({ type: 'terminal.history.page', terminalId: id, page: 0, requestId: 'setup-barrier' }));
    await one.waitFor(m => m.type === 'terminal.history.error' && m.requestId === 'setup-barrier');
    assert.ok(one.messages.some(m => m.type === 'error' && m.code === 'unknown-terminal'));
    assert.deepEqual(writes, []);
    assert.equal(entry.listeners.size, 0);
  } finally {
    h.registry.resize = originalResize;
    h.registry.write = originalWrite;
    await h.cleanup();
  }
});

test('Actual backpressure recovery preserves replay order, input and revocation', { timeout: 10000 }, async () => {
  const h = await createHarness();
  const id = (await h.registry.open({ cwd: h.tempDir, kind: 'shell' })).terminalId;
  const entry = (h.registry as any).terminals.get(id);
  const originalCheckpoint = entry.buffer.checkpoint.bind(entry.buffer);
  const originalWrite = h.registry.write.bind(h.registry);
  const writes: string[] = [];
  h.registry.write = (terminalId, data) => { if (terminalId === id) writes.push(data); return originalWrite(terminalId, data); };
  const recoveryStarted = deferred();
  const recoveryRelease = deferred();
  const recoveryFinished = deferred();
  let signal: AbortSignal | undefined;
  let amount = 0;
  try {
    const one = await h.createSocket();
    const send = (message: object) => one.ws.send(JSON.stringify(message));
    send({ type: 'terminal.attach', terminalId: id, cols: 80, rows: 24 });
    await one.waitFor(m => m.type === 'terminal.replay' && m.terminalId === id);
    Object.defineProperty(one.server, 'bufferedAmount', { get: () => amount, configurable: true });
    entry.buffer.checkpoint = async (s?: AbortSignal) => {
      signal = s;
      const snapshot = await originalCheckpoint(s);
      recoveryStarted.resolve();
      try { await recoveryRelease.promise; return snapshot; }
      finally { recoveryFinished.resolve(); }
    };
    amount = 9 * 1024 * 1024;
    const suppressed = 'x'.repeat(300 * 1024) + 'SUPPRESSED';
    entry.buffer.push(suppressed);
    for (const listener of entry.listeners) listener(id, suppressed, entry.buffer.endOffset);
    amount = 0;
    await bounded(recoveryStarted.promise, 'actual high-water recovery');
    entry.buffer.push('AFTER-WATERMARK');
    for (const listener of entry.listeners) listener(id, 'AFTER-WATERMARK', entry.buffer.endOffset);
    send({ type: 'input', terminalId: id, data: 'DURING-RECOVERY' });
    send({ type: 'terminal.history.page', terminalId: id, page: 0, requestId: 'recovery-input-barrier' });
    await one.waitFor(m => m.requestId === 'recovery-input-barrier');
    assert.deepEqual(writes, ['DURING-RECOVERY']);
    recoveryRelease.resolve();
    await one.waitFor(m => m.type === 'terminal.output' && m.data.includes('AFTER-WATERMARK'));
    const replayIndices = one.messages.flatMap((m, i) => m.type === 'terminal.replay' && m.terminalId === id ? [i] : []);
    assert.equal(replayIndices.length, 2, 'Lagging-to-drained transition must invoke a real replay');
    const recovered = one.messages[replayIndices[1]!];
    assert.ok(recovered.data.includes('SUPPRESSED'));
    const liveIndex = one.messages.findIndex(m => m.type === 'terminal.output' && m.data.includes('AFTER-WATERMARK'));
    assert.ok(liveIndex > replayIndices[1]!);
    assert.ok(one.messages[liveIndex].offset > recovered.endOffset);
    assert.equal(entry.listeners.size, 1);

    // Repeat the actual suppression transition, this time revoke while replay waits.
    const secondStarted = deferred();
    const secondRelease = deferred();
    entry.buffer.checkpoint = async (s?: AbortSignal) => {
      signal = s;
      secondStarted.resolve();
      await recoveryRelease.promise;
      await secondRelease.promise;
      return originalCheckpoint(s);
    };
    try {
      amount = 9 * 1024 * 1024;
      const suppressedAgain = 'x'.repeat(300 * 1024) + 'SECOND-SUPPRESSED';
      entry.buffer.push(suppressedAgain);
      for (const listener of entry.listeners) listener(id, suppressedAgain, entry.buffer.endOffset);
      amount = 0;
      await bounded(secondStarted.promise, 'second backpressure recovery');
      send({ type: 'terminal.detach', terminalId: id });
      send({ type: 'terminal.history.page', terminalId: id, page: 0, requestId: 'recovery-detach-barrier' });
      await one.waitFor(m => m.requestId === 'recovery-detach-barrier');
      assert.equal(signal?.aborted, true);
      assert.equal(entry.listeners.size, 0);
      send({ type: 'terminal.attach', terminalId: id, cols: 90, rows: 25, sinceOffset: entry.buffer.endOffset });
      const next = await one.waitFor(m => m.type === 'terminal.replay' && m.cols === undefined && m.endOffset === entry.buffer.endOffset);
      assert.equal(next.reset, false);
      secondRelease.resolve();
      send({ type: 'terminal.history.page', terminalId: id, page: 0, requestId: 'new-recovery-barrier' });
      await one.waitFor(m => m.requestId === 'new-recovery-barrier');
      assert.equal(entry.listeners.size, 1, 'Cancelled recovery cannot detach the new lease');
      assert.equal(one.messages.filter(m => m.type === 'terminal.replay' && m.terminalId === id).length, 3);
    } finally { secondRelease.resolve(); }
  } finally {
    recoveryRelease.resolve();
    await bounded(recoveryFinished.promise, 'recovery completion').catch(() => {});
    entry.buffer.checkpoint = originalCheckpoint;
    h.registry.write = originalWrite;
    await h.cleanup();
  }
});

for (const limit of ['count', 'bytes'] as const) test(`Command ${limit} saturation rejects admission and releases pending replay`, { timeout: 10000 }, async () => {
  const h = await createHarness();
  const id = (await h.registry.open({ cwd: h.tempDir, kind: 'shell' })).terminalId;
  const entry = (h.registry as any).terminals.get(id);
  const started = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  const originalCheckpoint = entry.buffer.checkpoint.bind(entry.buffer);
  const originalWrite = h.registry.write;
  const writes: string[] = [];
  entry.buffer.checkpoint = async (s?: AbortSignal) => { signal = s; started.resolve(); await release.promise; return originalCheckpoint(s); };
  h.registry.write = (_id, data) => { writes.push(data); return true; };
  try {
    const one = await h.createSocket();
    one.ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: id, cols: 80, rows: 24 }));
    await bounded(started.promise, 'checkpoint entry');
    const closed = new Promise<number>(resolve => one.ws.once('close', code => resolve(code)));
    const serverClosed = new Promise<void>(resolve => one.server.once('close', () => resolve()));
    // Drive the real socket admission callback in one event turn, so kernel
    // packet boundaries cannot change whether the queue is full in this test.
    const emit = (data: string) => one.server.emit('message', Buffer.from(JSON.stringify({ type: 'input', terminalId: id, data })));
    if (limit === 'count') {
      for (let i = 0; i < 1024; i++) emit('ADMITTED-BEFORE-CLOSE');
      emit('REJECTED');
    } else emit('x'.repeat(2 * 1024 * 1024));
    assert.equal(await bounded(closed, 'overload close'), 1009);
    await bounded(serverClosed, 'server overload teardown');
    assert.deepEqual(writes, [], 'No queued command may execute after overload closes the socket');
    assert.equal(entry.listeners.size, 0);
    assert.equal(signal?.aborted, true);
  } finally {
    release.resolve();
    entry.buffer.checkpoint = originalCheckpoint;
    h.registry.write = originalWrite;
    await h.cleanup();
  }
});

test('Pending recovery output has a bounded backlog and closes with complete cleanup', { timeout: 10000 }, async () => {
  const h = await createHarness();
  const id = (await h.registry.open({ cwd: h.tempDir, kind: 'shell' })).terminalId;
  const entry = (h.registry as any).terminals.get(id);
  const started = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  const originalCheckpoint = entry.buffer.checkpoint.bind(entry.buffer);
  entry.buffer.checkpoint = async (s?: AbortSignal) => { signal = s; started.resolve(); await release.promise; return originalCheckpoint(s); };
  try {
    const one = await h.createSocket();
    one.ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: id, cols: 80, rows: 24 }));
    await bounded(started.promise, 'checkpoint entry');
    const closed = new Promise<number>(resolve => one.ws.once('close', code => resolve(code)));
    const serverClosed = new Promise<void>(resolve => one.server.once('close', () => resolve()));
    const overflow = 'x'.repeat(8 * 1024 * 1024 + 1);
    for (const listener of entry.listeners) listener(id, overflow, entry.buffer.endOffset + overflow.length);
    assert.equal(await bounded(closed, 'recovery backlog close'), 1013);
    await bounded(serverClosed, 'server backlog teardown');
    assert.equal(entry.listeners.size, 0);
    assert.equal(signal?.aborted, true);
    assert.equal(one.messages.some(m => m.type === 'terminal.replay' && m.terminalId === id), false);
  } finally {
    release.resolve();
    entry.buffer.checkpoint = originalCheckpoint;
    await h.cleanup();
  }
});

test('Repeated supersession cancels old replay operations while retaining exact FIFO input', { timeout: 10000 }, async () => {
  const h = await createHarness();
  const id = (await h.registry.open({ cwd: h.tempDir, kind: 'shell' })).terminalId;
  const entry = (h.registry as any).terminals.get(id);
  const originalCheckpoint = entry.buffer.checkpoint.bind(entry.buffer);
  const originalWrite = h.registry.write;
  const signals: AbortSignal[] = [];
  const writes: string[] = [];
  entry.buffer.checkpoint = (signal: AbortSignal) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  h.registry.write = (_id, data) => { writes.push(data); return true; };
  try {
    const one = await h.createSocket();
    for (let i = 0; i < 200; i++) {
      one.ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: id, cols: 80, rows: 24 }));
      one.ws.send(JSON.stringify({ type: 'input', terminalId: id, data: String(i) }));
      one.ws.send(JSON.stringify({ type: 'terminal.detach', terminalId: id }));
    }
    one.ws.send(JSON.stringify({ type: 'terminal.history.page', terminalId: id, page: 0, requestId: 'supersession-barrier' }));
    await one.waitFor(m => m.requestId === 'supersession-barrier');
    assert.deepEqual(writes, Array.from({ length: 200 }, (_, i) => String(i)));
    assert.equal(signals.length, 200);
    assert.ok(signals.every(signal => signal.aborted));
    assert.equal(entry.listeners.size, 0);
    assert.equal(one.messages.some(m => m.type === 'terminal.replay' && m.terminalId === id), false);
  } finally {
    entry.buffer.checkpoint = originalCheckpoint;
    h.registry.write = originalWrite;
    await h.cleanup();
  }
});

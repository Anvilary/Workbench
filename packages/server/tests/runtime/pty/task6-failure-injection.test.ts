import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

import { TerminalRegistry } from '../../../src/features/terminals/terminal-registry.js';
import { OpenTabsStore } from '../../../src/features/terminals/open-tabs-store.js';
import { createAgentRegistry } from '../../../src/agents/registry.js';
import { PtyHostClient } from '../../../src/pty-host/pty-host-client.js';
import { attachTerminalSocket } from '../../../src/transport/websocket/socket-server.js';
import { publishReadiness } from '../../../src/maw-host.js';
import { SettingsStore } from '../../../src/features/settings/settings-store.js';
import { ArchivedSessions } from '../../../src/features/history/archived-sessions.js';
import { WorktreeStore } from '../../../src/features/worktrees/store.js';
import { WorktreeLinks } from '../../../src/features/worktrees/links.js';
import { VaultCatalog } from '../../../src/features/vault/catalog.js';
import { SessionIndex } from '../../../src/features/history/session-index.js';
import { VaultService } from '../../../src/features/vault/service.js';
import { WorktreeService } from '../../../src/features/worktrees/service.js';
import { AppSettingsService } from '../../../src/features/settings/app-settings-service.js';
import { NotesStore } from '../../../src/features/notes/notes-store.js';
import { DraftStore } from '../../../src/features/composer/draft-store.js';
import { ConversationHub } from '../../../src/features/conversations/conversation-hub.js';
import { RepoHub } from '../../../src/features/git/repo-hub.js';
import { MemoryHub } from '../../../src/features/memory/memory-hub.js';
import { RemoteAccessService } from '../../../src/features/remote-access/remote-access-service.js';
import { RemoteDevicesStore } from '../../../src/features/remote-access/remote-devices-store.js';
import { AgencyWorkspaceStore } from '../../../src/features/workspaces/workspace-store.js';
import { AgencyProfileStore } from '../../../src/features/profiles/profile-store.js';
import { AgencySessionRuntime } from '../../../src/features/sessions/session-runtime.js';
import { SplitAgencySessionStore } from '../../../src/features/sessions/session-store.js';
import { AgencyNotificationStore } from '../../../src/features/notifications/notification-store.js';
import { TabActivityManager } from '../../../src/features/notifications/tab-activity-manager.js';
import { AgencyLayoutStore } from '../../../src/features/workspaces/layout-store.js';
import { BrowserTabAdapter } from '../../../src/features/browser/browser-tab-adapter.js';
import { BrowserTabStore } from '../../../src/features/browser/browser-tab-store.js';
import { BrowserProfileStore } from '../../../src/features/browser/browser-profile-store.js';
import { EditorTabAdapter } from '../../../src/features/editor/editor-tab-adapter.js';
import { EditorTabStore } from '../../../src/features/editor/editor-tab-store.js';
import { PasteStore } from '../../../src/features/composer/paste-store.js';
import { TerminalHistoryStore } from '../../../src/features/terminals/terminal-history-store.js';
import { WorkspaceMutex } from '../../../src/features/workspaces/workspace-lock.js';
import { encodeClientMessage, parseServerMessage, type ServerMessage } from '@agent-workbench/shared';
import { SERVER_SRC } from '../../helpers/paths.js';

const PTY_HOST_DIR = path.join(SERVER_SRC, 'pty-host');
const SUPERVISOR_SCRIPT = path.join(PTY_HOST_DIR, 'maw-ptyd.mjs');
const SYNTHETIC_AGENT_PATH = path.join(PTY_HOST_DIR, 'fixtures', 'synthetic-agent.mjs');

interface TestHarness {
  tmpBase: string;
  runtimeDir: string;
  configDir: string;
  socketPath: string;
  authPath: string;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<TestHarness> {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'maw-task6-'));
  const runtimeDir = path.join(tmpBase, 'runtime');
  const configDir = path.join(tmpBase, 'config');
  const socketPath = path.join(runtimeDir, 'ptyd.sock');
  const authPath = path.join(runtimeDir, 'ptyd.auth');
  const savedXdgConfigHome = process.env.XDG_CONFIG_HOME;

  await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(configDir, { recursive: true, mode: 0o700 });
  process.env.XDG_CONFIG_HOME = configDir;

  return {
    tmpBase,
    runtimeDir,
    configDir,
    socketPath,
    authPath,
    cleanup: async () => {
      try {
        if (fs.existsSync(socketPath) && fs.existsSync(authPath)) {
          const client = await PtyHostClient.connectOrSpawn({
            socketPath,
            authPath,
            autoSpawn: false,
            spawnTimeoutMs: 1000,
          });
          await client.shutdown(true).catch(() => {});
        }
      } catch {}
      if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
      await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function createTestBackend(harness: TestHarness, overrides?: { persistentPty?: boolean; socketPath?: string; authPath?: string }) {
  const token = randomUUID();
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'alive' }));
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address() as { port: number };
  const port = address.port;

  const settings = new SettingsStore(path.join(harness.configDir, 'settings.json'));
  await settings.load();

  const agents = createAgentRegistry([]);
  const store = new OpenTabsStore();
  await store.load();

  const archived = new ArchivedSessions();
  await archived.load();

  const worktreeStore = new WorktreeStore(path.join(harness.configDir, 'worktrees.json'));
  await worktreeStore.load();
  const worktreeLinks = new WorktreeLinks(worktreeStore);

  const catalog = new VaultCatalog();
  const index = new SessionIndex(agents, archived, catalog, worktreeLinks);
  const vault = new VaultService({ agents, index, archived, settings, catalog, platform: process.platform });

  const shellLocation = {
    file: process.execPath,
    args: [SYNTHETIC_AGENT_PATH],
    name: 'synthetic-shell',
  };

  const registry = new TerminalRegistry(
    agents,
    shellLocation,
    store,
    () => null,
    () => Promise.resolve(null),
    () => harness.runtimeDir + '/shell',
    {
      persistentPty: overrides?.persistentPty ?? true,
      supervisorScriptPath: SUPERVISOR_SCRIPT,
      socketPath: overrides?.socketPath ?? harness.socketPath,
      authPath: overrides?.authPath ?? harness.authPath,
    },
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
  const notes = new NotesStore(path.join(harness.configDir, 'notes.json'));
  await notes.load();
  const drafts = new DraftStore({ statePath: path.join(harness.configDir, 'drafts.json') });
  await drafts.load();

  const conversations = new ConversationHub(registry, agents);
  const repos = new RepoHub(registry);
  const memory = new MemoryHub(registry);
  const remote = new RemoteAccessService({
    settings,
    store: new RemoteDevicesStore(path.join(harness.configDir, 'devices.json')),
    listening: { port, fixed: false, fixedPortBusy: false },
  });
  await remote.load();

  const agencyWorkspaceStore = new AgencyWorkspaceStore(path.join(harness.configDir, 'agency-state.json'));
  await agencyWorkspaceStore.load();
  const agencyProfileStore = new AgencyProfileStore(path.join(harness.configDir, 'agency-profiles.json'));
  await agencyProfileStore.listDefinitions();
  const agencyNotificationStore = new AgencyNotificationStore(path.join(harness.configDir, 'agency-notifications.json'));
  await agencyNotificationStore.initialize();
  const agencyActivityManager = new TabActivityManager({
    notificationStore: agencyNotificationStore,
    storageDir: harness.configDir,
  });
  await agencyActivityManager.initialize();
  const agencyLayoutStore = new AgencyLayoutStore(path.join(harness.configDir, 'agency-layouts.json'));
  await agencyLayoutStore.initialize();
  const agencyBrowserProfileStore = new BrowserProfileStore(path.join(harness.configDir, 'agency-browser-profiles.json'));
  await agencyBrowserProfileStore.load();
  const agencyBrowserTabs = new BrowserTabAdapter({
    store: new BrowserTabStore(path.join(harness.configDir, 'agency-web-tabs.json')),
    workspaceStore: agencyWorkspaceStore,
  });
  await agencyBrowserTabs.restore();
  const agencyEditorTabs = new EditorTabAdapter({
    store: new EditorTabStore(path.join(harness.configDir, 'agency-editor-tabs.json')),
    workspaceStore: agencyWorkspaceStore,
    protectedDirsProvider: () => agents.protectedDirs(),
  });
  await agencyEditorTabs.restore();
  const pasteStore = new PasteStore(path.join(harness.configDir, 'pastes'));
  const historyBaseDir = path.join(harness.configDir, 'terminal-history');
  const workspaceLock = new WorkspaceMutex();
  const agencySessionStore = new SplitAgencySessionStore(path.join(harness.configDir, 'agency-sessions.json'));
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

  const url = `http://127.0.0.1:${port}/?token=${token}`;
  const detachReadiness = await publishReadiness(harness.runtimeDir, url, null);

  const detachSocket = attachTerminalSocket({
    httpServer,
    port,
    token,
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
    defaultCwd: harness.runtimeDir,
    vault,
    remote,
    worktrees,
    pasteStore,
    historyStoreFactory: (id) => new TerminalHistoryStore(id, { baseDir: historyBaseDir }),
    agencyWorkspaceStore,
    agencyProfileStore,
    agencyRuntime,
    agencyNotificationStore,
    agencyActivityManager,
    agencyLayoutStore,
    agencyBrowserTabs,
    agencyBrowserProfileStore,
    agencyEditorTabs,
    workspaceLock,
  });

  let closed = false;

  const disposeShared = async () => {
    await detachSocket();
    await detachReadiness();
    vault.dispose();
    conversations.disposeAll();
    repos.disposeAll();
    await memory.disposeAll().catch(() => {});
    agencyRuntime.dispose();
    agencyActivityManager.dispose();
    agencyNotificationStore.dispose();
    remote.dispose();
    await Promise.allSettled([
      store.flush(),
      archived.flush(),
      settings.flush(),
      notes.flush(),
      drafts.flush(),
      worktreeStore.flush(),
      remote.flush(),
      agencySessionStore.flush(),
      agencyWorkspaceStore.flush(),
      agencyProfileStore.flush(),
      agencyBrowserTabs.flush(),
      agencyBrowserProfileStore.flush(),
      agencyEditorTabs.flush(),
      agencyLayoutStore.flush(),
      agencyActivityManager.flush(),
      agencyNotificationStore.flush(),
    ]);
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  const shutdown = async () => {
    if (closed) return;
    closed = true;
    registry.disposeAll();
    await disposeShared();
  };

  const killUngraceful = async () => {
    if (closed) return;
    closed = true;
    const internalReg = registry as any;
    const rawClient = internalReg.client;
    internalReg.client = null;
    if (rawClient?.socket && !rawClient.socket.destroyed) {
      rawClient.socket.destroy();
    }
    await disposeShared();
  };

  return {
    port,
    token,
    registry,
    agencyRuntime,
    url,
    shutdown,
    killUngraceful,
  };
}

class TestClient {
  private ws!: WebSocket;
  messages: ServerMessage[] = [];
  outputChunks: { terminalId: string; data: string; offset?: number }[] = [];
  replays: { terminalId: string; data: string; reset?: boolean; startOffset?: number; endOffset?: number; truncated?: boolean }[] = [];

  async connect(port: number, token: string): Promise<void> {
    const url = `ws://127.0.0.1:${port}/ws?token=${token}`;
    this.ws = new WebSocket(url);

    this.ws.on('message', (raw: string) => {
      const msg = parseServerMessage(raw.toString());
      if (!msg) return;
      this.messages.push(msg);
      if (msg.type === 'terminal.output') {
        this.outputChunks.push({ terminalId: msg.terminalId, data: msg.data, offset: msg.offset });
      } else if (msg.type === 'terminal.replay') {
        this.replays.push({
          terminalId: msg.terminalId,
          data: msg.data,
          reset: msg.reset,
          startOffset: msg.startOffset,
          endOffset: msg.endOffset,
          truncated: msg.truncated,
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(msg: any): void {
    this.ws.send(encodeClientMessage(msg));
  }

  getOutput(): string {
    return this.outputChunks.map((c) => c.data).join('');
  }

  clear(): void {
    this.outputChunks = [];
    this.replays = [];
    this.messages = [];
  }

  async waitForOutput(pattern: string | RegExp, timeoutMs = 5000): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const all = this.getOutput();
      if (typeof pattern === 'string' ? all.includes(pattern) : pattern.test(all)) {
        return all;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timeout waiting for output matching ${pattern}. Got:\n${this.getOutput()}`);
  }

  async close(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
      await new Promise<void>((resolve) => this.ws.once('close', () => resolve()));
    }
  }
}

// ---------------------------------------------------------------------------
// TASK 6 TESTS
// ---------------------------------------------------------------------------

test('FAILURE INJECTION: child process exits with code while backend is down; exit tombstone is cleanly consumed on restart', async () => {
  const harness = await createHarness();
  let backend1 = await createTestBackend(harness);
  let supervisorClient: PtyHostClient | null = null;
  let backend2: any = null;

  try {
    supervisorClient = await PtyHostClient.connectOrSpawn({
      socketPath: harness.socketPath,
      authPath: harness.authPath,
      autoSpawn: false,
    });

    const desc = await backend1.registry.open({ cwd: harness.tmpBase, kind: 'shell' });
    const terminalId = desc.terminalId;
    const childPid = backend1.registry.pidOf(terminalId)!;

    // Detach backend 1 while child is still running
    await backend1.shutdown();

    // Now while backend is DOWN, instruct child to exit with code 42
    supervisorClient.write(terminalId, 'EXIT_WITH 42\n');

    // Wait for process to exit in OS
    let dead = false;
    const start = Date.now();
    while (Date.now() - start < 3000) {
      try {
        process.kill(childPid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        dead = true;
        break;
      }
    }
    assert.equal(dead, true, 'Child process must exit with code 42 while backend is offline');

    // Start backend 2: it must discover the tombstone on startup!
    backend2 = await createTestBackend(harness);

    const tombstone = backend2.registry.consumeTombstone(terminalId);
    assert.ok(tombstone !== null, 'Tombstone must be recorded and consumable by registry');
    assert.equal(tombstone.exitCode, 42, 'Tombstone exit code must match actual process exit code');
    assert.equal(tombstone.pid, childPid, 'Tombstone PID must match original child PID');
  } finally {
    if (backend2) await backend2.shutdown().catch(() => {});
    if (supervisorClient) await supervisorClient.shutdown(true).catch(() => {});
    await harness.cleanup();
  }
});

test('FAILURE INJECTION: output buffer overflow ring eviction triggers reset: true safely', async () => {
  const harness = await createHarness();
  let backend = await createTestBackend(harness);
  let client = new TestClient();

  try {
    const desc = await backend.registry.open({ cwd: harness.tmpBase, kind: 'shell' });
    const terminalId = desc.terminalId;

    await client.connect(backend.port, backend.token);
    client.send({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 });
    await client.waitForOutput('AGENT_READY');

    // Flood with 1MB to overflow default in-memory ring buffer limit (256KB)
    client.send({ type: 'input', terminalId, data: 'FLOOD_1MB\n' });
    await client.waitForOutput('FLOOD_DONE', 8000);

    // Reattach requesting an obsolete/evicted offset (sinceOffset = 0)
    // Server must detect that offset 0 has been evicted and reply with reset: true, truncated: true
    client.clear();
    client.send({ type: 'terminal.attach', terminalId, cols: 80, rows: 24, sinceOffset: 0 });

    await new Promise((r) => setTimeout(r, 200));
    const replayMsg = client.replays[0];
    assert.ok(replayMsg !== undefined, 'Must receive terminal.replay');
    assert.equal(replayMsg.reset, true, 'Replay with evicted offset must mandate terminal reset');
    assert.equal(replayMsg.truncated, true, 'Truncated flag must indicate buffer eviction');

    // Intentionally terminate session
    backend.registry.close(terminalId);
  } finally {
    await client.close().catch(() => {});
    await backend.shutdown().catch(() => {});
    await harness.cleanup();
  }
});

test('FAILURE INJECTION: wrong authentication token is rejected on WebSocket upgrade with 403', async () => {
  const harness = await createHarness();
  const backend = await createTestBackend(harness);

  try {
    const invalidWs = new WebSocket(`ws://127.0.0.1:${backend.port}/ws?token=wrong-invalid-token`);
    const status = await new Promise<number>((resolve, reject) => {
      invalidWs.once('unexpected-response', (_req, res) => {
        res.resume();
        invalidWs.terminate();
        resolve(res.statusCode ?? 0);
      });
      invalidWs.once('open', () => {
        invalidWs.terminate();
        reject(new Error('Should not connect with invalid token'));
      });
      invalidWs.once('error', reject);
    });
    assert.equal(status, 403, 'Invalid token must be rejected with HTTP 403');
  } finally {
    await backend.shutdown().catch(() => {});
    await harness.cleanup();
  }
});

test('FAILURE INJECTION: explicit in-process mode needs no supervisor', async () => {
  const harness = await createHarness();
  const backend = await createTestBackend(harness, {
    persistentPty: false,
  });

  try {
    assert.equal(backend.registry.isPersistent(), false, 'Registry should run in standard in-process mode');

    // Spawning must succeed using standard in-process node-pty
    const desc = await backend.registry.open({ cwd: harness.tmpBase, kind: 'shell' });
    assert.ok(desc.terminalId, 'Terminal must spawn successfully in in-process mode');
    assert.ok(desc.alive, 'Terminal must be marked alive');

    const pid = backend.registry.pidOf(desc.terminalId);
    assert.ok(typeof pid === 'number' && pid > 0, 'In-process child PID must exist');

    backend.registry.close(desc.terminalId);
  } finally {
    await backend.shutdown().catch(() => {});
    await harness.cleanup();
  }
});

test('FAILURE INJECTION: frontend disconnect and high-volume reconnect deduplicates properly', async () => {
  const harness = await createHarness();
  const backend = await createTestBackend(harness);
  const client1 = new TestClient();
  const client2 = new TestClient();

  try {
    const desc = await backend.registry.open({ cwd: harness.tmpBase, kind: 'shell' });
    const terminalId = desc.terminalId;

    await client1.connect(backend.port, backend.token);
    client1.send({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 });
    await client1.waitForOutput('AGENT_READY');

    client1.send({ type: 'input', terminalId, data: 'START_JOB token=stream-dedup\n' });
    await client1.waitForOutput('STEP 2 token=stream-dedup');

    // Record last offset received by client 1
    const lastChunk = client1.outputChunks[client1.outputChunks.length - 1];
    const sinceOffset = lastChunk?.offset;
    assert.ok(typeof sinceOffset === 'number' && sinceOffset > 0, 'Must have received monotonic offset');

    // Disconnect client 1
    await client1.close();

    // Connect client 2 simulating page reopen with sinceOffset
    await client2.connect(backend.port, backend.token);
    client2.send({ type: 'terminal.attach', terminalId, cols: 80, rows: 24, sinceOffset });

    await new Promise((r) => setTimeout(r, 200));
    const replayMsg = client2.replays[0];
    assert.ok(replayMsg !== undefined, 'Must receive terminal.replay');
    assert.equal(replayMsg.reset, false, 'Must be zero-reset incremental replay');
    assert.ok(replayMsg.endOffset! >= sinceOffset, 'End offset must advance');

    backend.registry.close(terminalId);
  } finally {
    await client1.close().catch(() => {});
    await client2.close().catch(() => {});
    await backend.shutdown().catch(() => {});
    await harness.cleanup();
  }
});

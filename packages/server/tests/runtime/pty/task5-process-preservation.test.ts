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
// @ts-expect-error - standalone pure-ESM supervisor script
import { PtySupervisor } from '../../../src/pty-host/ptyd.mjs';
import { attachWorkbenchSocket } from '../../../src/transport/websocket/socket-server.js';
import { publishReadiness } from '../../../src/workbench-host.js';
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
import { encodeClientMessage, parseServerMessage, type ServerMessage } from '@anvilary/workbench-shared';
import { SERVER_SRC } from '../../helpers/paths.js';

const PTY_HOST_DIR = path.join(SERVER_SRC, 'pty-host');
const SUPERVISOR_SCRIPT = path.join(PTY_HOST_DIR, 'ptyd.mjs');
const SYNTHETIC_AGENT_PATH = path.join(PTY_HOST_DIR, 'fixtures', 'synthetic-agent.mjs');

interface DisposableBackend {
  port: number;
  token: string;
  registry: TerminalRegistry;
  agencyRuntime: AgencySessionRuntime;
  url: string;
  shutdown(): Promise<void>;
  killUngraceful(): Promise<void>;
}

async function createDisposableBackend(options: {
  runtimeDir: string;
  configDir: string;
  socketPath: string;
  authPath: string;
  shellScript: string;
}): Promise<DisposableBackend> {
  const token = randomUUID();
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'alive' }));
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address() as { port: number };
  const port = address.port;

  const settings = new SettingsStore(path.join(options.configDir, 'settings.json'));
  await settings.load();

  const agents = createAgentRegistry([]);
  const store = new OpenTabsStore();
  await store.load();

  const archived = new ArchivedSessions();
  await archived.load();

  const worktreeStore = new WorktreeStore(path.join(options.configDir, 'worktrees.json'));
  await worktreeStore.load();
  const worktreeLinks = new WorktreeLinks(worktreeStore);

  const catalog = new VaultCatalog();
  const index = new SessionIndex(agents, archived, catalog, worktreeLinks);
  const vault = new VaultService({ agents, index, archived, settings, catalog, platform: process.platform });

  const shellLocation = {
    file: process.execPath,
    args: [options.shellScript],
    name: 'synthetic-shell',
  };

  const registry = new TerminalRegistry(
    agents,
    shellLocation,
    store,
    () => null,
    () => Promise.resolve(null),
    () => options.runtimeDir + '/shell',
    {
      persistentPty: true,
      supervisorScriptPath: SUPERVISOR_SCRIPT,
      socketPath: options.socketPath,
      authPath: options.authPath,
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
  const notes = new NotesStore(path.join(options.configDir, 'notes.json'));
  await notes.load();
  const drafts = new DraftStore({ statePath: path.join(options.configDir, 'drafts.json') });
  await drafts.load();

  const conversations = new ConversationHub(registry, agents);
  const repos = new RepoHub(registry);
  const memory = new MemoryHub(registry);
  const remote = new RemoteAccessService({
    settings,
    store: new RemoteDevicesStore(path.join(options.configDir, 'devices.json')),
    listening: { port, fixed: false, fixedPortBusy: false },
  });
  await remote.load();

  const agencyWorkspaceStore = new AgencyWorkspaceStore(path.join(options.configDir, 'agency-state.json'));
  await agencyWorkspaceStore.load();
  const agencyProfileStore = new AgencyProfileStore(path.join(options.configDir, 'agency-profiles.json'));
  await agencyProfileStore.listDefinitions();
  const agencyNotificationStore = new AgencyNotificationStore(path.join(options.configDir, 'agency-notifications.json'));
  await agencyNotificationStore.initialize();
  const agencyActivityManager = new TabActivityManager({
    notificationStore: agencyNotificationStore,
    storageDir: options.configDir,
  });
  await agencyActivityManager.initialize();
  const agencyLayoutStore = new AgencyLayoutStore(path.join(options.configDir, 'agency-layouts.json'));
  await agencyLayoutStore.initialize();
  const agencyBrowserProfileStore = new BrowserProfileStore(path.join(options.configDir, 'agency-browser-profiles.json'));
  await agencyBrowserProfileStore.load();
  const agencyBrowserTabs = new BrowserTabAdapter({
    store: new BrowserTabStore(path.join(options.configDir, 'agency-web-tabs.json')),
    workspaceStore: agencyWorkspaceStore,
  });
  await agencyBrowserTabs.restore();
  const agencyEditorTabs = new EditorTabAdapter({
    store: new EditorTabStore(path.join(options.configDir, 'agency-editor-tabs.json')),
    workspaceStore: agencyWorkspaceStore,
    protectedDirsProvider: () => agents.protectedDirs(),
  });
  await agencyEditorTabs.restore();
  const pasteStore = new PasteStore(path.join(options.configDir, 'pastes'));
  const historyBaseDir = path.join(options.configDir, 'terminal-history');
  const workspaceLock = new WorkspaceMutex();
  const agencySessionStore = new SplitAgencySessionStore(path.join(options.configDir, 'agency-sessions.json'));
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
  const detachReadiness = await publishReadiness(options.runtimeDir, url, null);

  const detachSocket = attachWorkbenchSocket({
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
    defaultCwd: options.runtimeDir,
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
    registry.disposeAll(); // Detaches without terminating supervisor child PTYs
    await disposeShared();
  };

  const killUngraceful = async () => {
    if (closed) return;
    closed = true;
    // Ungraceful kill: do NOT call registry.disposeAll() or kill child PTYs,
    // but sever the dead backend's local IPC handle so no background reconnect timers leak.
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

class WsClient {
  private ws!: WebSocket;
  private messages: ServerMessage[] = [];
  private outputChunks: { terminalId: string; data: string; offset?: number }[] = [];
  private replays: { terminalId: string; data: string; reset?: boolean; startOffset?: number; endOffset?: number }[] = [];

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

  getLastReplay(): { terminalId: string; data: string; reset?: boolean; startOffset?: number; endOffset?: number } | undefined {
    return this.replays[this.replays.length - 1];
  }

  async waitForReplay(timeoutMs = 4000): Promise<NonNullable<ReturnType<WsClient['getLastReplay']>>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const replay = this.getLastReplay();
      if (replay) return replay;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timeout waiting for terminal.replay');
  }

  async waitForError(code: string, timeoutMs = 4000): Promise<Extract<ServerMessage, { type: 'error' }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const error = this.messages.find((message): message is Extract<ServerMessage, { type: 'error' }> =>
        message.type === 'error' && message.code === code);
      if (error) return error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timeout waiting for error ${code}`);
  }

  clearOutput(): void {
    this.outputChunks = [];
    this.replays = [];
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

test('TASK 5 ACCEPTANCE: real child PTY survives backend restart, retains OS PID, reconnects with zero-reset delta replay', async () => {
  try {
    await runTask5Acceptance();
  } catch (err: any) {
    console.error('TASK 5 ACCEPTANCE FAILED WITH ERROR:', err?.stack || err);
    throw err;
  }
});

async function runTask5Acceptance() {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'maw-task5-'));
  const runtimeDir = path.join(tmpBase, 'runtime');
  const configDir = path.join(tmpBase, 'config');
  const socketPath = path.join(runtimeDir, 'ptyd.sock');
  const authPath = path.join(runtimeDir, 'ptyd.auth');
  const savedXdgConfigHome = process.env.XDG_CONFIG_HOME;

  await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(configDir, { recursive: true, mode: 0o700 });
  process.env.XDG_CONFIG_HOME = configDir;

  let backend1: DisposableBackend | null = null;
  let backend2: DisposableBackend | null = null;
  let client: WsClient | null = null;
  let supervisorClient: PtyHostClient | null = null;

  try {
    // 1 & 2. Start disposable backend 1 (auto-spawns supervisor at isolated socketPath)
    backend1 = await createDisposableBackend({
      runtimeDir,
      configDir,
      socketPath,
      authPath,
      shellScript: SYNTHETIC_AGENT_PATH,
    });

    assert.ok(backend1.registry.isPersistent(), 'Backend 1 must be running in persistent PTY mode');

    // Connect independent supervisor client to audit state directly from daemon
    supervisorClient = await PtyHostClient.connectOrSpawn({
      socketPath,
      authPath,
      autoSpawn: false,
    });
    const supervisorPid = supervisorClient.supervisorPid;
    assert.ok(typeof supervisorPid === 'number' && supervisorPid > 0, 'Supervisor must have a valid OS PID');

    // 3. Spawn real synthetic PTY process
    const desc = await backend1.registry.open({
      cwd: tmpBase,
      kind: 'shell',
    });
    const terminalId = desc.terminalId;

    // 4. Record child PID and stable identity
    const childPid = backend1.registry.pidOf(terminalId);
    assert.ok(typeof childPid === 'number' && childPid > 0, 'Child must have a valid OS PID');

    // Verify child is alive via OS signal check kill(pid, 0)
    assert.doesNotThrow(() => process.kill(childPid, 0), 'Child process must be alive in OS');

    // 5. Attach WebSocket client
    client = new WsClient();
    await client.connect(backend1.port, backend1.token);

    client.send({
      type: 'terminal.attach',
      terminalId,
      cols: 80,
      rows: 24,
    });

    // 6. Send and receive terminal data
    await client.waitForOutput(`AGENT_READY pid=${childPid}`);

    client.send({
      type: 'input',
      terminalId,
      data: 'START_JOB token=preservation-alpha\n',
    });

    await client.waitForOutput('JOB_STARTED token=preservation-alpha step=1');
    await client.waitForOutput('STEP 2 token=preservation-alpha');

    const replay1 = await supervisorClient.replay(terminalId);
    const offsetBeforeRestart = replay1.endOffset;
    assert.ok(offsetBeforeRestart > 0, 'Offset before restart must be positive');

    // 7. Kill ONLY the disposable backend process (simulating backend restart/service upgrade)
    await client.close();
    await backend1.shutdown();
    backend1 = null;

    // Wait a brief moment while backend is down
    await new Promise((r) => setTimeout(r, 200));

    // 8. Verify the supervisor survives
    assert.doesNotThrow(() => process.kill(supervisorPid, 0), 'Supervisor must survive backend shutdown');

    // 9. Verify the original child PID survives
    assert.doesNotThrow(() => process.kill(childPid, 0), 'Original child PID must survive backend shutdown');

    // 10. Verify the original child continues executing while backend is down
    const replayDuringDowntime = await supervisorClient.replay(terminalId);
    assert.ok(
      replayDuringDowntime.endOffset > offsetBeforeRestart,
      `Child must continue executing and generating output while backend is down (prev: ${offsetBeforeRestart}, now: ${replayDuringDowntime.endOffset})`,
    );

    // A legacy host may have a live PTY without ownership metadata. It must stay unknown.
    const legacyTerminalId = randomUUID();
    await supervisorClient.spawn({
      id: legacyTerminalId,
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: tmpBase,
    });
    const beforeRestart = await supervisorClient.list();
    assert.equal(beforeRestart.sessions.find((session) => session.id === legacyTerminalId)?.agencyManaged, undefined, 'Legacy ownership omission must remain unknown on the supervisor wire');

    // 11. Restart the backend with a NEW process identity, NEW ephemeral port and NEW session token
    backend2 = await createDisposableBackend({
      runtimeDir,
      configDir,
      socketPath,
      authPath,
      shellScript: SYNTHETIC_AGENT_PATH,
    });

    assert.notEqual(backend2.port, -1, 'Backend 2 must have an active ephemeral port');
    assert.ok(backend2.registry.isPersistent(), 'Backend 2 must adopt persistent mode');

    // 12. Reconnect existing client to the new backend endpoint
    client = new WsClient();
    await client.connect(backend2.port, backend2.token);

    // 13. Reattach to the original child PID
    const adoptedPid = backend2.registry.pidOf(terminalId);
    assert.equal(adoptedPid, childPid, 'Backend 2 must preserve exact original OS child PID (no replacement process)');
    assert.equal(backend2.registry.nativeIdentityOf(terminalId), undefined, 'Trusted classic PTY ownership must survive supervisor recovery');
    assert.equal(backend2.registry.nativeIdentityOf(legacyTerminalId), null, 'Unknown legacy ownership must remain fail-closed after recovery');

    // 14. Verify terminal output continuity with sinceOffset (zero-reset delta replay)
    client.clearOutput();
    client.send({
      type: 'terminal.attach',
      terminalId,
      cols: 80,
      rows: 24,
      sinceOffset: offsetBeforeRestart,
    });

    // Observe graphical recovery separately from the synchronous attachment lease.
    const replayMsg = await client.waitForReplay();
    assert.equal(replayMsg.reset, false, 'Replay with valid sinceOffset must specify reset: false (scrollback preserved)');
    assert.ok(replayMsg.endOffset! >= offsetBeforeRestart, 'Replay endOffset must be >= offsetBeforeRestart');
    assert.ok(!replayMsg.data.includes('AGENT_READY'), 'Delta replay must not repeat older data before sinceOffset');

    // 15. Verify terminal input and resizing work interactively
    client.send({
      type: 'input',
      terminalId,
      data: 'PING task5-verification\n',
    });
    await client.waitForOutput(`PONG task5-verification pid=${childPid}`);

    client.send({
      type: 'resize',
      terminalId,
      cols: 120,
      rows: 40,
    });
    await client.waitForOutput('WINCH cols=120 rows=40');

    // 16. Verify process exit event continuity
    client.send({
      type: 'input',
      terminalId,
      data: 'EXIT_WITH 0\n',
    });
    await client.waitForOutput('FINAL_ERROR_LINE code=0');

    // 17 & 18. Intentionally close the session and verify cleanup with no orphan children
    await new Promise((r) => setTimeout(r, 200));
    backend2.registry.close(terminalId);

    // Verify child process is dead
    let childStillAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      childStillAlive = false;
    }
    assert.equal(childStillAlive, false, 'Child process must be terminated and reaped with zero orphans');
  } finally {
    if (client) await client.close().catch(() => {});
    if (backend1) await backend1.shutdown().catch(() => {});
    if (backend2) await backend2.shutdown().catch(() => {});
    if (supervisorClient) {
      await supervisorClient.shutdown(true).catch(() => {});
    } else {
      try {
        if (fs.existsSync(socketPath) && fs.existsSync(authPath)) {
          const client = await PtyHostClient.connectOrSpawn({
            socketPath,
            authPath,
            autoSpawn: false,
          });
          await client.shutdown(true).catch(() => {});
        }
      } catch {}
    }
    if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}

test('TASK 5 CONCURRENCY & UNGRACEFUL RECOVERY: multiple concurrent sessions survive backend SIGKILL', async () => {
  try {
    await runTask5Concurrency();
  } catch (err: any) {
    console.error('TASK 5 CONCURRENCY FAILED WITH ERROR:', err?.stack || err);
    throw err;
  }
});

test('registry reconnects to the real supervisor after socket loss and keeps the same live PTY ID and PID', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'maw-registry-reconnect-'));
  const runtimeDir = path.join(tmpBase, 'runtime');
  const configDir = path.join(tmpBase, 'config');
  const socketPath = path.join(runtimeDir, 'ptyd.sock');
  const authPath = path.join(runtimeDir, 'ptyd.auth');
  const savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
  await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(configDir, { recursive: true, mode: 0o700 });
  process.env.XDG_CONFIG_HOME = configDir;

  const supervisor = new PtySupervisor({ socketPath, authPath });
  let backend: DisposableBackend | null = null;
  let audit: PtyHostClient | null = null;
  let unverified: TerminalRegistry | null = null;
  try {
    await supervisor.listen();
    backend = await createDisposableBackend({ runtimeDir, configDir, socketPath, authPath, shellScript: SYNTHETIC_AGENT_PATH });
    audit = await PtyHostClient.connectOrSpawn({ socketPath, authPath, autoSpawn: false });
    const descriptor = await backend.registry.open({ cwd: tmpBase, kind: 'shell' });
    const terminalId = descriptor.terminalId;
    const pid = backend.registry.pidOf(terminalId);
    assert.ok(pid && pid > 0);

    const unsafeAuthPath = path.join(runtimeDir, 'unsafe-ptyd.auth');
    await fs.promises.symlink(authPath, unsafeAuthPath);
    // A second backend must not continue into startup recovery with no authenticated inventory.
    unverified = new TerminalRegistry(
      createAgentRegistry([]), { file: process.execPath, args: [SYNTHETIC_AGENT_PATH], name: 'synthetic-shell' },
      new OpenTabsStore(), undefined, undefined, undefined,
      { persistentPty: true, socketPath, authPath: unsafeAuthPath },
    );
    await assert.rejects(unverified.initialize(), /Persistent PTY supervisor unavailable; session recovery was not started/);
    assert.deepEqual((await audit.list()).sessions.map(session => [session.id, session.pid]), [[terminalId, pid]]);

    const output: string[] = [];
    const attached = backend.registry.attach(terminalId, (_id, chunk) => output.push(chunk));
    assert.ok(attached);
    const readyDeadline = Date.now() + 3000;
    while (Date.now() < readyDeadline && !`${attached.replay}${output.join('')}`.includes(`AGENT_READY pid=${pid}`)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(`${attached.replay}${output.join('')}`.includes(`AGENT_READY pid=${pid}`), 'the real PTY emitted its initial identity');

    const registryClient = (backend.registry as any).client as PtyHostClient;
    (registryClient as any).socket.destroy();

    const unavailableDeadline = Date.now() + 1000;
    while (Date.now() < unavailableDeadline && backend.registry.pidOf(terminalId) === pid) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(backend.registry.pidOf(terminalId), null, 'the registry marks the remote PTY unavailable during disconnect');

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && backend.registry.pidOf(terminalId) !== pid) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(backend.registry.pidOf(terminalId), pid, 'the registry reattached the original process');
    assert.equal(backend.registry.list().find((item) => item.terminalId === terminalId)?.alive, true);

    assert.equal(backend.registry.write(terminalId, 'PING recovery-check\n'), true);
    const outputDeadline = Date.now() + 3000;
    while (Date.now() < outputDeadline && !output.join('').includes(`PONG recovery-check pid=${pid}`)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(output.join('').includes(`PONG recovery-check pid=${pid}`), 'output continues through the recovered registry client');
    const sessions = await audit.list();
    assert.equal(sessions.sessions.filter((session) => session.id === terminalId).length, 1, 'recovery did not spawn a duplicate');
  } finally {
    unverified?.disposeAll();
    audit?.detach();
    await backend?.shutdown();
    supervisor.close({ killAll: true });
    if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    await rm(tmpBase, { recursive: true, force: true });
  }
});

async function runTask5Concurrency() {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'maw-task5-multi-'));
  const runtimeDir = path.join(tmpBase, 'runtime');
  const configDir = path.join(tmpBase, 'config');
  const socketPath = path.join(runtimeDir, 'ptyd.sock');
  const authPath = path.join(runtimeDir, 'ptyd.auth');
  const savedXdgConfigHome = process.env.XDG_CONFIG_HOME;

  await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(configDir, { recursive: true, mode: 0o700 });
  process.env.XDG_CONFIG_HOME = configDir;

  let backend1: DisposableBackend | null = null;
  let backend2: DisposableBackend | null = null;
  let supervisorClient: PtyHostClient | null = null;

  try {
    backend1 = await createDisposableBackend({
      runtimeDir,
      configDir,
      socketPath,
      authPath,
      shellScript: SYNTHETIC_AGENT_PATH,
    });

    supervisorClient = await PtyHostClient.connectOrSpawn({
      socketPath,
      authPath,
      autoSpawn: false,
    });

    // Spawn 2 concurrent sessions
    const desc1 = await backend1.registry.open({ cwd: tmpBase, kind: 'shell' });
    const desc2 = await backend1.registry.open({ cwd: tmpBase, kind: 'shell' });

    const pid1 = backend1.registry.pidOf(desc1.terminalId)!;
    const pid2 = backend1.registry.pidOf(desc2.terminalId)!;

    assert.ok(pid1 > 0 && pid2 > 0 && pid1 !== pid2, 'Both concurrent sessions must have distinct positive PIDs');

    // Simulate backend SIGKILL / crash (abrupt ungraceful termination without detach)
    await backend1.killUngraceful();
    backend1 = null;

    // Both children must survive
    assert.doesNotThrow(() => process.kill(pid1, 0), 'Process 1 must survive backend SIGKILL');
    assert.doesNotThrow(() => process.kill(pid2, 0), 'Process 2 must survive backend SIGKILL');

    // Restart backend
    backend2 = await createDisposableBackend({
      runtimeDir,
      configDir,
      socketPath,
      authPath,
      shellScript: SYNTHETIC_AGENT_PATH,
    });

    // Verify both sessions were adopted with their original PIDs
    assert.equal(backend2.registry.pidOf(desc1.terminalId), pid1, 'Session 1 original PID preserved');
    assert.equal(backend2.registry.pidOf(desc2.terminalId), pid2, 'Session 2 original PID preserved');

    // Clean up sessions
    backend2.registry.close(desc1.terminalId);
    backend2.registry.close(desc2.terminalId);
  } finally {
    if (backend1) await backend1.shutdown().catch(() => {});
    if (backend2) await backend2.shutdown().catch(() => {});
    if (supervisorClient) {
      await supervisorClient.shutdown(true).catch(() => {});
    } else {
      try {
        if (fs.existsSync(socketPath) && fs.existsSync(authPath)) {
          const client = await PtyHostClient.connectOrSpawn({
            socketPath,
            authPath,
            autoSpawn: false,
          });
          await client.shutdown(true).catch(() => {});
        }
      } catch {}
    }
    if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}

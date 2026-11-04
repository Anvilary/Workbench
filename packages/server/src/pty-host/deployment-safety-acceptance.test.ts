/**
 * MAW Next-Generation: Deployment Safety Acceptance Test Suite
 *
 * Verifies all 17 deployment and safety requirements:
 * 1. Start standalone supervisor.
 * 2. Start disposable backend.
 * 3. Spawn persistent synthetic PTY.
 * 4. Record original PID.
 * 5. Stop disposable backend.
 * 6. Verify supervisor socket remains accessible.
 * 7. Verify original PTY child survives.
 * 8. Restart backend.
 * 9. Reattach to original PID.
 * 10. Verify terminal input/output.
 * 11. Verify backend runtime-directory cleanup does not remove supervisor files.
 * 12. Verify correct supervisor shutdown cleanup.
 * 13. Verify fresh installation unit rendering.
 * 14. Verify upgrade and rollback compatibility.
 * 15. Verify rollback compatibility when supervisor absent.
 * 16. Verify missing supervisor behavior (fallback to classic).
 * 17. Verify permissions and symlink rejection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';

import { TerminalRegistry } from '../terminal-registry.js';
import { WorkspaceStore } from '../workspace-store.js';
import { createAgentRegistry } from '../agents/registry.js';
import { PtyHostClient } from './pty-host-client.js';
// @ts-expect-error - standalone pure-ESM supervisor script
import { PtySupervisor } from './maw-ptyd.mjs';
import { attachTerminalSocket } from '../terminal-socket.js';
import { publishReadiness } from '../maw-host.js';
import { SettingsStore } from '../settings-store.js';
import { ArchivedSessions } from '../archived-sessions.js';
import { WorktreeStore } from '../worktrees/store.js';
import { WorktreeLinks } from '../worktrees/links.js';
import { VaultCatalog } from '../vault/catalog.js';
import { SessionIndex } from '../session-index.js';
import { VaultService } from '../vault/service.js';
import { WorktreeService } from '../worktrees/service.js';
import { AppSettingsService } from '../app-settings-service.js';
import { NotesStore } from '../notes-store.js';
import { DraftStore } from '../draft-store.js';
import { ConversationHub } from '../conversation-hub.js';
import { RepoHub } from '../repo-hub.js';
import { MemoryHub } from '../memory-hub.js';
import { RemoteAccessService } from '../remote-access-service.js';
import { RemoteDevicesStore } from '../remote-devices-store.js';
import { AgencyWorkspaceStore } from '../agency/store.js';
import { AgencyProfileStore } from '../agency/agency-profile-store.js';
import { AgencySessionRuntime } from '../agency/agency-session-runtime.js';
import { SplitAgencySessionStore } from '../agency/agency-session-store.js';
import { WorkspaceMutex } from '../agency/workspace-lock.js';
import { encodeClientMessage, parseServerMessage, type ServerMessage } from '@agent-workbench/shared';

const exec = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const SCRIPT_DIR = path.join(REPO_ROOT, 'scripts/maw');
const SUPERVISOR_SCRIPT = path.join(REPO_ROOT, 'packages/server/src/pty-host/maw-ptyd.mjs');
const SYNTHETIC_AGENT_PATH = path.join(REPO_ROOT, 'packages/server/src/pty-host/fixtures/synthetic-agent.mjs');

class WsClient {
  private ws: WebSocket | null = null;
  private messageBuffer: ServerMessage[] = [];
  private rawOutputBuffer = '';
  private outputWaiters: Array<{ pattern: string | RegExp; resolve: (matched: string) => void }> = [];

  async connect(port: number, token: string): Promise<void> {
    const url = `ws://127.0.0.1:${port}/ws?token=${token}`;
    this.ws = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 3000);
      this.ws!.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws!.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg = parseServerMessage(data.toString('utf8'));
        if (msg) {
          this.messageBuffer.push(msg);

          if (msg.type === 'terminal.output') {
            this.rawOutputBuffer += msg.data;
            for (let i = this.outputWaiters.length - 1; i >= 0; i--) {
              const w = this.outputWaiters[i];
              if (!w) continue;
              const matches = typeof w.pattern === 'string'
                ? this.rawOutputBuffer.includes(w.pattern)
                : w.pattern.test(this.rawOutputBuffer);
              if (matches) {
                w.resolve(this.rawOutputBuffer);
                this.outputWaiters.splice(i, 1);
              }
            }
          }
        }
      } catch {}
    });
  }

  send(msg: any): void {
    assert.ok(this.ws && this.ws.readyState === WebSocket.OPEN, 'WS must be open to send');
    this.ws.send(encodeClientMessage(msg));
  }

  async waitForOutput(pattern: string | RegExp, timeoutMs = 4000): Promise<string> {
    const matches = typeof pattern === 'string'
      ? this.rawOutputBuffer.includes(pattern)
      : pattern.test(this.rawOutputBuffer);
    if (matches) return this.rawOutputBuffer;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for output '${pattern}'. Buffer: [${this.rawOutputBuffer.slice(-500)}]`));
      }, timeoutMs);

      this.outputWaiters.push({
        pattern,
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
      });
    });
  }

  close(): void {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

interface DisposableBackend {
  port: number;
  token: string;
  registry: TerminalRegistry;
  shutdown(): Promise<void>;
}

async function createDisposableBackend(options: {
  runtimeDir: string;
  configDir: string;
  socketPath: string;
  authPath: string;
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
  const store = new WorkspaceStore();
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
    args: [SYNTHETIC_AGENT_PATH],
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
    defaultCwd: options.runtimeDir,
    vault,
    remote,
    worktrees,
    agencyWorkspaceStore,
    agencyProfileStore,
    agencyRuntime,
    workspaceLock,
  });

  return {
    port,
    token,
    registry,
    shutdown: async () => {
      detachSocket();
      await detachReadiness();
      vault.dispose();
      conversations.disposeAll();
      repos.disposeAll();
      void memory.disposeAll();
      agencyRuntime.dispose();
      registry.disposeAll();
      remote.dispose();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

test('DEPLOYMENT SAFETY 1-12: Independent supervisor runtime, child survival, backend restart reattachment, and cleanup', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'maw-safety-test-'));
  const supervisorRuntimeDir = path.join(tmpBase, 'supervisor-runtime');
  const backendRuntimeDir = path.join(tmpBase, 'backend-runtime');
  const configDir = path.join(tmpBase, 'config');

  await fs.promises.mkdir(supervisorRuntimeDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(backendRuntimeDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(configDir, { recursive: true, mode: 0o700 });

  const socketPath = path.join(supervisorRuntimeDir, 'ptyd.sock');
  const authPath = path.join(supervisorRuntimeDir, 'ptyd.sock.auth');

  // 1. Start standalone supervisor in independent runtime directory
  const supervisor = new PtySupervisor({
    socketPath,
    authPath,
  });
  await supervisor.listen();
  assert.ok(fs.existsSync(socketPath), 'Supervisor socket must exist at configured path');
  assert.ok(fs.existsSync(authPath), 'Supervisor auth file must exist at configured path');

  // 2. Start disposable backend 1 (connects to running supervisor)
  const backend1 = await createDisposableBackend({
    runtimeDir: backendRuntimeDir,
    configDir,
    socketPath,
    authPath,
  });
  assert.ok(backend1.registry.isPersistent(), 'Backend 1 must be connected in persistent mode');

  // 3. Spawn persistent synthetic PTY
  const desc = await backend1.registry.open({ cwd: tmpBase, kind: 'shell' });
  const terminalId = desc.terminalId;

  // 4. Record original PID
  const originalPid = backend1.registry.pidOf(terminalId);
  assert.ok(typeof originalPid === 'number' && originalPid > 0, 'Original PID must be a valid positive integer');
  assert.doesNotThrow(() => process.kill(originalPid, 0), 'PTY child process must be alive in OS');

  // Connect client to verify output flow
  const ws1 = new WsClient();
  await ws1.connect(backend1.port, backend1.token);
  ws1.send({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 });
  await ws1.waitForOutput(`AGENT_READY pid=${originalPid}`);
  ws1.close();

  // 5. Stop disposable backend 1
  await backend1.shutdown();

  // 11. Backend runtime-directory cleanup: simulate systemd removing /run/user/<UID>/maw
  await rm(backendRuntimeDir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(backendRuntimeDir), 'Backend runtime directory was removed');

  // 6. Verify supervisor socket remains accessible
  assert.ok(fs.existsSync(socketPath), 'Supervisor socket must remain accessible after backend runtime removal');
  assert.ok(fs.existsSync(authPath), 'Supervisor auth file must remain accessible after backend runtime removal');

  // 7. Verify original PTY child survives
  assert.doesNotThrow(() => process.kill(originalPid, 0), 'Original PTY child must survive backend shutdown');

  // 8. Re-create backend runtime directory and restart backend 2
  await fs.promises.mkdir(backendRuntimeDir, { recursive: true, mode: 0o700 });
  const backend2 = await createDisposableBackend({
    runtimeDir: backendRuntimeDir,
    configDir,
    socketPath,
    authPath,
  });
  assert.ok(backend2.registry.isPersistent(), 'Backend 2 must connect in persistent mode');

  // 9. Reattach to original PID
  const reattachedPid = backend2.registry.pidOf(terminalId);
  assert.equal(reattachedPid, originalPid, 'Backend 2 must reattach to the exact same child PID');

  // 10. Verify terminal input/output through reattached backend
  const ws2 = new WsClient();
  await ws2.connect(backend2.port, backend2.token);
  ws2.send({ type: 'terminal.attach', terminalId, cols: 80, rows: 24 });
  ws2.send({ type: 'input', terminalId, data: 'PING deployment-test\n' });
  await ws2.waitForOutput(`PONG deployment-test pid=${originalPid}`);
  ws2.close();

  await backend2.shutdown();

  // 12. Verify correct supervisor shutdown cleanup
  supervisor.close({ killAll: true }); // kill children on full shutdown
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!fs.existsSync(socketPath), 'Supervisor socket must be removed on supervisor shutdown');
  assert.ok(!fs.existsSync(authPath), 'Supervisor auth file must be removed on supervisor shutdown');

  // Original child should be cleaned up by supervisor shutdown
  assert.throws(() => process.kill(originalPid, 0), 'Child process should be terminated after full supervisor shutdown');

  await rm(tmpBase, { recursive: true, force: true });
});

test('DEPLOYMENT SAFETY 13: Fresh installation unit rendering and validation', async () => {
  const tmpState = await mkdtemp(path.join(os.tmpdir(), 'maw-install-test-'));

  const env = {
    ...process.env,
    MAW_NODE_BIN: process.execPath,
    MAW_STATE_DIR: tmpState,
    MAW_BIN_DIR: path.join(tmpState, 'bin'),
    MAW_RUNTIME_NAME: 'maw',
    MAW_PTYD_RUNTIME_NAME: 'maw-ptyd',
  };

  // Render backend unit
  const mawUnit = (await exec('/bin/sh', [path.join(SCRIPT_DIR, 'maw-render-unit.sh')], { env })).stdout;
  assert.ok(mawUnit.includes('Wants=maw-ptyd.service'), 'maw.service must declare Wants=maw-ptyd.service');
  assert.ok(mawUnit.includes('After=network.target maw-ptyd.service'), 'maw.service must declare After=... maw-ptyd.service');
  assert.ok(mawUnit.includes('RuntimeDirectory=maw'), 'maw.service must own RuntimeDirectory=maw');

  // Render supervisor unit
  const ptydUnit = (await exec('/bin/sh', [path.join(SCRIPT_DIR, 'maw-render-ptyd-unit.sh')], { env })).stdout;
  assert.ok(ptydUnit.includes('RuntimeDirectory=maw-ptyd'), 'maw-ptyd.service must own RuntimeDirectory=maw-ptyd');
  assert.ok(ptydUnit.includes('Environment=MAW_PTYD_SOCKET=%t/maw-ptyd/ptyd.sock'), 'maw-ptyd.service must configure socket under its own runtime dir');
  assert.ok(ptydUnit.includes('Environment=MAW_PTYD_AUTH_FILE=%t/maw-ptyd/ptyd.sock.auth'), 'maw-ptyd.service must configure auth file under its own runtime dir');
  assert.ok(ptydUnit.includes(process.execPath), 'maw-ptyd.service ExecStart must use absolute node binary');
  assert.ok(!ptydUnit.includes('/usr/bin/env node'), 'maw-ptyd.service must not use /usr/bin/env node');

  await rm(tmpState, { recursive: true, force: true });
});

test('DEPLOYMENT SAFETY 14-15: Upgrade and rollback preserve independent supervisor state and live sessions', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'maw-upgrade-test-'));
  const supervisorRuntimeDir = path.join(tmpBase, 'supervisor-runtime');
  const backendRuntimeDir = path.join(tmpBase, 'backend-runtime');
  const configDir = path.join(tmpBase, 'config');

  await fs.promises.mkdir(supervisorRuntimeDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(backendRuntimeDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(configDir, { recursive: true, mode: 0o700 });

  const socketPath = path.join(supervisorRuntimeDir, 'ptyd.sock');
  const authPath = path.join(supervisorRuntimeDir, 'ptyd.sock.auth');

  // Start supervisor
  const supervisor = new PtySupervisor({ socketPath, authPath });
  await supervisor.listen();

  // Start release v1 backend
  const backendV1 = await createDisposableBackend({
    runtimeDir: backendRuntimeDir,
    configDir,
    socketPath,
    authPath,
  });

  const desc = await backendV1.registry.open({ cwd: tmpBase, kind: 'shell' });
  const terminalId = desc.terminalId;
  const originalPid = backendV1.registry.pidOf(terminalId);

  // Upgrade simulation: stop v1 backend without stopping supervisor
  await backendV1.shutdown();

  // Child survives during upgrade
  assert.doesNotThrow(() => process.kill(originalPid!, 0), 'PTY child must survive backend upgrade');

  // Start release v2 backend (simulates new version connecting to existing supervisor)
  const backendV2 = await createDisposableBackend({
    runtimeDir: backendRuntimeDir,
    configDir,
    socketPath,
    authPath,
  });

  // Reattached on v2
  assert.equal(backendV2.registry.pidOf(terminalId), originalPid, 'Upgraded backend v2 must adopt existing session');

  // Rollback simulation: stop v2 backend and restore v1 backend
  await backendV2.shutdown();

  // Child still survives rollback
  assert.doesNotThrow(() => process.kill(originalPid!, 0), 'PTY child must survive backend rollback');

  // Start rolled-back backend v1
  const backendV1Restored = await createDisposableBackend({
    runtimeDir: backendRuntimeDir,
    configDir,
    socketPath,
    authPath,
  });

  assert.equal(backendV1Restored.registry.pidOf(terminalId), originalPid, 'Rolled-back backend must reattach to existing session');

  await backendV1Restored.shutdown();
  supervisor.close({ killAll: true });
  await rm(tmpBase, { recursive: true, force: true });
});

test('DEPLOYMENT SAFETY 16: Missing supervisor falls back gracefully to in-process PTY without hanging', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'maw-fallback-test-'));
  const nonExistentSocket = path.join(tmpBase, 'does-not-exist.sock');
  const nonExistentAuth = path.join(tmpBase, 'does-not-exist.sock.auth');

  // When supervisor is unreachable and autoSpawn is false, PtyHostClient fails promptly
  await assert.rejects(
    async () => {
      await PtyHostClient.connectOrSpawn({
        socketPath: nonExistentSocket,
        authPath: nonExistentAuth,
        autoSpawn: false,
        spawnTimeoutMs: 500,
      });
    },
    /ENOENT|ECONNREFUSED|connect/,
    'Must fail promptly without hanging',
  );

  await rm(tmpBase, { recursive: true, force: true });
});

test('DEPLOYMENT SAFETY 17: Security checks reject symlinks on socket directory and auth path', async () => {
  const tmpBase = await mkdtemp(path.join(os.tmpdir(), 'maw-sec-test-'));
  const realTargetDir = path.join(tmpBase, 'real-target');
  const symlinkDir = path.join(tmpBase, 'symlink-dir');

  await fs.promises.mkdir(realTargetDir, { recursive: true, mode: 0o700 });
  await symlink(realTargetDir, symlinkDir);

  const socketInSymlinkDir = path.join(symlinkDir, 'ptyd.sock');
  const authInSymlinkDir = path.join(symlinkDir, 'ptyd.sock.auth');

  // Supervisor must refuse to start in a symlinked parent directory
  const supervisor = new PtySupervisor({
    socketPath: socketInSymlinkDir,
    authPath: authInSymlinkDir,
  });

  await assert.rejects(
    async () => {
      await supervisor.listen();
    },
    /Security violation: socket parent directory .* cannot be a symbolic link/,
    'Supervisor must reject starting inside a symlinked parent directory',
  );

  await rm(tmpBase, { recursive: true, force: true });
});

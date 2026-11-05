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
          reject(new Error(`Timeout waiting for message matching predicate after ${timeoutMs}ms`));
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
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

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
    noAuth: true,
    agencyWorkspaceStore,
    agencyProfileStore,
    agencyRuntime,
    workspaceLock,
  });

  t.after(async () => {
    try { wsA.close(); } catch {}
    try { wsB.close(); } catch {}
    detachSocket();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    registry.disposeAll();
    await agencyRuntime.dispose();
  });

  // Client A connects
  const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    wsA.once('open', resolve);
    wsA.once('error', reject);
  });
  const waiterA = createWaiter(wsA);

  // Client B connects (unauthorized client)
  const wsB = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
});

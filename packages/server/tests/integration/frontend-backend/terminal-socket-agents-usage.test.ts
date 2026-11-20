import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { AgencySessionRuntime } from '../../../src/features/sessions/session-runtime.js';
import { SplitAgencySessionStore } from '../../../src/features/sessions/session-store.js';
import { WorkspaceMutex } from '../../../src/features/workspaces/workspace-lock.js';
import { AgentsUsageCollector } from '../../../src/agents/usage/collector.js';
import type { AgentsUsageSnapshot } from '@agent-workbench/shared';

const PORT_TOKEN = 'test-usage-token-xyz';

async function createTestHarness(mockCollector: AgentsUsageCollector) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-socket-usage-'));
  const httpServer = createServer(express());
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;

  const settings = new SettingsStore(path.join(tempDir, 'settings.json'));
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
    agencyProfileStore,
    agencyRuntime,
    workspaceLock: new WorkspaceMutex(),
    agentsUsageCollector: mockCollector,
  });

  return {
    port,
    cleanup: async () => {
      await detach();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

test('Agents Usage WebSocket: dispatches agents.usage.get and receives snapshot', async () => {
  const mockSnapshot: AgentsUsageSnapshot = {
    aggregated: {
      totalProfiles: 12,
      availableProfiles: 12,
      missingProfiles: 0,
      totalTokens: 123456,
      totalInputTokens: 100000,
      totalOutputTokens: 23456,
      totalCachedTokens: 5000,
      totalCostUSD: 2.75,
      lastRefresh: Date.now(),
      status: 'ok',
    },
    providers: [
      {
        provider: 'OpenAI',
        profileCount: 3,
        availableCount: 3,
        totalTokens: 50000,
        status: 'healthy',
      },
    ],
    profiles: [],
  };

  const mockCollector = {
    getSnapshot: async (_force?: boolean) => mockSnapshot,
  } as unknown as AgentsUsageCollector;

  const { port, cleanup } = await createTestHarness(mockCollector);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${PORT_TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  try {
    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'agents.usage.snapshot') {
          resolve(parsed);
        }
      });
    });

    ws.send(
      JSON.stringify({
        type: 'agents.usage.get',
        requestId: 'req-test-99',
        forceRefresh: true,
      }),
    );

    const res = await responsePromise;
    assert.equal(res.type, 'agents.usage.snapshot');
    assert.equal(res.requestId, 'req-test-99');
    assert.equal(res.usage.aggregated.totalTokens, 123456);
    assert.equal(res.usage.aggregated.totalCostUSD, 2.75);
    assert.equal(res.usage.providers.length, 1);
    assert.equal(res.usage.providers[0].provider, 'OpenAI');
  } finally {
    ws.close();
    await cleanup();
  }
});

test('Agents Usage WebSocket: handles collection failure with agents.usage.failed', async () => {
  const mockCollector = {
    getSnapshot: async (_force?: boolean) => {
      throw new Error('Telemetry database lock contention');
    },
  } as unknown as AgentsUsageCollector;

  const { port, cleanup } = await createTestHarness(mockCollector);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${PORT_TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  try {
    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'agents.usage.failed') {
          resolve(parsed);
        }
      });
    });

    ws.send(
      JSON.stringify({
        type: 'agents.usage.get',
        requestId: 'req-fail-00',
      }),
    );

    const res = await responsePromise;
    assert.equal(res.type, 'agents.usage.failed');
    assert.equal(res.requestId, 'req-fail-00');
    assert.ok(res.error.includes('Telemetry database lock contention'));
  } finally {
    ws.close();
    await cleanup();
  }
});

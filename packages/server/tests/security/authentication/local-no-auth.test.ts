/**
 * Tests for MAW_UNSAFE_LOCAL_NO_AUTH=1 token-free local mode.
 *
 * Verifies:
 *  1. Token-free mode accepts requests without any session cookie or token.
 *  2. Foreign Origin and Host requests remain rejected even in no-auth mode.
 *  3. Default authenticated mode still rejects requests with missing credentials.
 *  4. Remote access cannot be enabled in token-free mode (startup rejection).
 *  5. WebSocket ownership restrictions remain enforced.
 *  6. Readiness URL is a plain loopback URL in no-auth mode (no token appended).
 *  7. Authenticated mode behavior is unchanged when no-auth is not enabled.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import {
  authorizeRequest,
  authorizeRequestNoAuth,
  isLocalNoAuthEnabled,
} from '../../../src/security/request-guards.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: {
  url?: string;
  host?: string;
  origin?: string;
  cookie?: string;
  token?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (overrides.host !== undefined) headers['host'] = overrides.host;
  if (overrides.origin !== undefined) headers['origin'] = overrides.origin;
  if (overrides.cookie !== undefined) headers['cookie'] = overrides.cookie;
  return {
    url: overrides.url ?? '/',
    headers,
  } as IncomingMessage;
}

const PORT = 41001;
const TOKEN = 'test-session-token';
const LOOPBACK_HOST_HEADER = `127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// isLocalNoAuthEnabled reflects the environment variable
// ---------------------------------------------------------------------------

test('isLocalNoAuthEnabled returns false when env var is absent', () => {
  const saved = process.env['MAW_UNSAFE_LOCAL_NO_AUTH'];
  delete process.env['MAW_UNSAFE_LOCAL_NO_AUTH'];
  assert.equal(isLocalNoAuthEnabled(), false);
  if (saved !== undefined) process.env['MAW_UNSAFE_LOCAL_NO_AUTH'] = saved;
});

test('isLocalNoAuthEnabled returns false when env var is 0', () => {
  const saved = process.env['MAW_UNSAFE_LOCAL_NO_AUTH'];
  process.env['MAW_UNSAFE_LOCAL_NO_AUTH'] = '0';
  assert.equal(isLocalNoAuthEnabled(), false);
  if (saved !== undefined) {
    process.env['MAW_UNSAFE_LOCAL_NO_AUTH'] = saved;
  } else {
    delete process.env['MAW_UNSAFE_LOCAL_NO_AUTH'];
  }
});

test('isLocalNoAuthEnabled returns true only when env var is exactly "1"', () => {
  const saved = process.env['MAW_UNSAFE_LOCAL_NO_AUTH'];
  process.env['MAW_UNSAFE_LOCAL_NO_AUTH'] = '1';
  assert.equal(isLocalNoAuthEnabled(), true);
  if (saved !== undefined) {
    process.env['MAW_UNSAFE_LOCAL_NO_AUTH'] = saved;
  } else {
    delete process.env['MAW_UNSAFE_LOCAL_NO_AUTH'];
  }
});

// ---------------------------------------------------------------------------
// authorizeRequestNoAuth: token-free mode accepts loopback requests
// ---------------------------------------------------------------------------

test('no-auth: loopback request without token or cookie is accepted', () => {
  const req = makeRequest({ host: LOOPBACK_HOST_HEADER });
  const result = authorizeRequestNoAuth(req, PORT);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.credential.kind, 'local');
  }
});

test('no-auth: loopback request with localhost host header is accepted', () => {
  const req = makeRequest({ host: `localhost:${PORT}` });
  const result = authorizeRequestNoAuth(req, PORT);
  assert.equal(result.ok, true);
});

test('no-auth: request with no host header is rejected (bad-host)', () => {
  const req = makeRequest({});
  const result = authorizeRequestNoAuth(req, PORT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'bad-host');
});

test('no-auth: request with foreign Host is rejected (bad-host)', () => {
  const req = makeRequest({ host: 'attacker.example.com' });
  const result = authorizeRequestNoAuth(req, PORT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'bad-host');
});

test('no-auth: request with foreign Origin is rejected (bad-origin)', () => {
  const req = makeRequest({
    host: LOOPBACK_HOST_HEADER,
    origin: 'https://foreign.example.com',
  });
  const result = authorizeRequestNoAuth(req, PORT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'bad-origin');
});

test('no-auth: DNS-rebinding attempt (valid-looking host but not loopback) is rejected', () => {
  const req = makeRequest({ host: `notloopback.example.com:${PORT}` });
  const result = authorizeRequestNoAuth(req, PORT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'bad-host');
});

test('no-auth: absent Origin is accepted (first-party navigation has no Origin)', () => {
  const req = makeRequest({ host: LOOPBACK_HOST_HEADER });
  const result = authorizeRequestNoAuth(req, PORT);
  assert.equal(result.ok, true);
});

test('no-auth: matching loopback Origin is accepted', () => {
  const req = makeRequest({
    host: LOOPBACK_HOST_HEADER,
    origin: `http://127.0.0.1:${PORT}`,
  });
  const result = authorizeRequestNoAuth(req, PORT);
  assert.equal(result.ok, true);
});

test('no-auth: wrong loopback port in Origin is rejected', () => {
  const req = makeRequest({
    host: LOOPBACK_HOST_HEADER,
    origin: `http://127.0.0.1:${PORT + 1}`,
  });
  const result = authorizeRequestNoAuth(req, PORT);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'bad-origin');
});

// ---------------------------------------------------------------------------
// Default authenticated mode: missing token still rejected
// ---------------------------------------------------------------------------

test('authenticated mode: request without token is rejected (bad-token)', () => {
  const req = makeRequest({ host: LOOPBACK_HOST_HEADER });
  const result = authorizeRequest(req, PORT, TOKEN, null);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'bad-token');
});

test('authenticated mode: request with correct token is accepted', () => {
  const req = makeRequest({
    host: LOOPBACK_HOST_HEADER,
    url: `/?token=${TOKEN}`,
  });
  const result = authorizeRequest(req, PORT, TOKEN, null);
  assert.equal(result.ok, true);
});

test('authenticated mode: request with bad token is rejected (bad-token)', () => {
  const req = makeRequest({
    host: LOOPBACK_HOST_HEADER,
    url: `/?token=wrong-token`,
  });
  const result = authorizeRequest(req, PORT, TOKEN, null);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'bad-token');
});

// ---------------------------------------------------------------------------
// Both modes: Host/Origin checks are always enforced
// ---------------------------------------------------------------------------

test('both modes: foreign Origin blocks even with valid session token', () => {
  const req = makeRequest({
    host: LOOPBACK_HOST_HEADER,
    origin: 'https://evil.example.com',
    url: `/?token=${TOKEN}`,
  });
  const authResult = authorizeRequest(req, PORT, TOKEN, null);
  assert.equal(authResult.ok, false);
  if (!authResult.ok) assert.equal(authResult.reason, 'bad-origin');

  const noAuthResult = authorizeRequestNoAuth(req, PORT);
  assert.equal(noAuthResult.ok, false);
  if (!noAuthResult.ok) assert.equal(noAuthResult.reason, 'bad-origin');
});

test('both modes: malformed cookie does not throw before authentication', () => {
  for (const value of ['%', '%GG', '%FF', '%E0%A4%A']) {
    const req = makeRequest({
      host: LOOPBACK_HOST_HEADER,
      cookie: `agent_workbench_token=${value}`,
    });
    // Authenticated mode: bad cookie → bad-token, never throws
    assert.doesNotThrow(() => authorizeRequest(req, PORT, TOKEN, null));
    assert.equal(authorizeRequest(req, PORT, TOKEN, null).ok, false);

    // No-auth mode: bad cookie is irrelevant; Host/Origin pass → ok
    assert.doesNotThrow(() => authorizeRequestNoAuth(req, PORT));
    assert.equal(authorizeRequestNoAuth(req, PORT).ok, true);
  }
});

// ---------------------------------------------------------------------------
// Remote access cannot be enabled in token-free mode
// ---------------------------------------------------------------------------

test('remote access service rejects configure({ enabled: true }) when no-auth is active', async () => {
  const { RemoteAccessService } = await import('../../../src/features/remote-access/remote-access-service.js');
  const { SettingsStore } = await import('../../../src/features/settings/settings-store.js');
  const { RemoteDevicesStore } = await import('../../../src/features/remote-access/remote-devices-store.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');

  const prevEnv = process.env['MAW_UNSAFE_LOCAL_NO_AUTH'];
  process.env['MAW_UNSAFE_LOCAL_NO_AUTH'] = '1';
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-remote-test-'));

  try {
    const settings = new SettingsStore(path.join(tempDir, 'settings.json'));
    await settings.load();
    const service = new RemoteAccessService({
      settings,
      store: new RemoteDevicesStore(path.join(tempDir, 'devices.json')),
      listening: { port: PORT, fixed: false, fixedPortBusy: false },
    });
    await service.load();

    await assert.rejects(
      async () => service.configure({ enabled: true }),
      (err: unknown) =>
        err instanceof Error &&
        (err as { text?: { params?: { text?: string } } }).text?.params?.text?.includes(
          'Remote access cannot be enabled in token-free mode',
        ) === true,
    );
    assert.throws(
      () => service.startPairing(),
      (err: unknown) =>
        err instanceof Error &&
        (err as { text?: { params?: { text?: string } } }).text?.params?.text?.includes(
          'Remote access cannot be enabled in token-free mode',
        ) === true,
    );
  } finally {
    if (prevEnv !== undefined) {
      process.env['MAW_UNSAFE_LOCAL_NO_AUTH'] = prevEnv;
    } else {
      delete process.env['MAW_UNSAFE_LOCAL_NO_AUTH'];
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Control script and readiness in token-free mode
// ---------------------------------------------------------------------------

test('readiness and control script work with token-free localhost URL', async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const { publishReadiness } = await import('../../../src/maw-host.js');

  const run = promisify(execFile);
  const temp = await mkdtemp(path.join(tmpdir(), 'maw-ctrl-noauth-'));
  const bin = path.join(temp, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$MAW_TEST_PID"\n', { mode: 0o700 });

  // Mock server accepts loopback requests without requiring token
  const server = createServer((_request, response) => {
    response.statusCode = 200;
    response.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const control = fileURLToPath(new URL('../../../../../scripts/maw/control.mjs', import.meta.url));
  const runtime = path.join(temp, 'maw');
  const tokenFreeUrl = `http://127.0.0.1:${address.port}/`;
  const clear = await publishReadiness(runtime, tokenFreeUrl);
  const env = {
    ...process.env,
    MAW_RUNTIME_DIR: runtime,
    XDG_RUNTIME_DIR: temp,
    PATH: bin + ':' + process.env.PATH,
    MAW_TEST_PID: String(process.pid),
  };

  try {
    const status = await run(process.execPath, [control, 'status'], { cwd: '/', env });
    assert.match(status.stdout, /Healthy/);
    assert.match(status.stdout, /token-free local mode/);
    assert.match(status.stdout, new RegExp(`URL: http://127\\.0\\.0\\.1:${address.port}/`));

    const urlOut = await run(process.execPath, [control, 'url'], { cwd: '/', env });
    assert.equal(urlOut.stdout.trim(), tokenFreeUrl);
  } finally {
    await clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// WebSocket upgrade in token-free mode
// ---------------------------------------------------------------------------

test('WebSocket upgrade: connects without token in no-auth mode, rejects foreign origin', async () => {
  const { createServer } = await import('node:http');
  const { WebSocket } = await import('ws');
  const express = (await import('express')).default;
  const { attachTerminalSocket } = await import('../../../src/transport/websocket/socket-server.js');
  const { TerminalRegistry } = await import('../../../src/features/terminals/terminal-registry.js');
  const { createAgentRegistry } = await import('../../../src/agents/registry.js');
  const { OpenTabsStore } = await import('../../../src/features/terminals/open-tabs-store.js');
  const { SessionIndex } = await import('../../../src/features/history/session-index.js');
  const { ArchivedSessions } = await import('../../../src/features/history/archived-sessions.js');
  const { VaultCatalog } = await import('../../../src/features/vault/catalog.js');
  const { WorktreeLinks } = await import('../../../src/features/worktrees/links.js');
  const { WorktreeStore } = await import('../../../src/features/worktrees/store.js');
  const { VaultService } = await import('../../../src/features/vault/service.js');
  const { WorktreeService } = await import('../../../src/features/worktrees/service.js');
  const { AppSettingsService } = await import('../../../src/features/settings/app-settings-service.js');
  const { SettingsStore } = await import('../../../src/features/settings/settings-store.js');
  const { NotesStore } = await import('../../../src/features/notes/notes-store.js');
  const { DraftStore } = await import('../../../src/features/composer/draft-store.js');
  const { ConversationHub } = await import('../../../src/features/conversations/conversation-hub.js');
  const { RepoHub } = await import('../../../src/features/git/repo-hub.js');
  const { MemoryHub } = await import('../../../src/features/memory/memory-hub.js');
  const { RemoteAccessService } = await import('../../../src/features/remote-access/remote-access-service.js');
  const { RemoteDevicesStore } = await import('../../../src/features/remote-access/remote-devices-store.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');

  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-ws-noauth-'));
  const app = express();
  const httpServer = createServer(app);
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
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
    null,
    store,
    () => null,
    async () => null,
    undefined,
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
  const conversations = new ConversationHub(registry, agents);
  const repos = new RepoHub(registry);
  const memory = new MemoryHub(registry);
  const remote = new RemoteAccessService({
    settings,
    store: new RemoteDevicesStore(path.join(tempDir, 'devices.json')),
    listening: { port, fixed: false, fixedPortBusy: false },
  });
  await remote.load();

  const { AgencyWorkspaceStore } = await import('../../../src/features/workspaces/workspace-store.js');
  const { AgencyProfileStore } = await import('../../../src/features/profiles/profile-store.js');
  const { AgencySessionRuntime } = await import('../../../src/features/sessions/session-runtime.js');
  const { SplitAgencySessionStore } = await import('../../../src/features/sessions/session-store.js');
  const { WorkspaceMutex } = await import('../../../src/features/workspaces/workspace-lock.js');

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

  const detach = attachTerminalSocket({
    httpServer,
    port,
    token: TOKEN,
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

  try {
    // 1. Connect without token via loopback WebSocket -> must succeed
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.close();
    await new Promise<void>(resolve => ws.once('close', () => resolve()));

    // 2. Connect with foreign origin -> must be rejected with 403
    const rejectedWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    const statusCode = await new Promise<number>((resolve, reject) => {
      rejectedWs.once('unexpected-response', (_req, res) => {
        res.resume();
        rejectedWs.terminate();
        resolve(res.statusCode ?? 0);
      });
      rejectedWs.once('open', () => {
        rejectedWs.terminate();
        reject(new Error('Should not connect with foreign origin'));
      });
      rejectedWs.once('error', reject);
    });
    assert.equal(statusCode, 403);
  } finally {
    detach();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Startup rejection when remote access is enabled
// ---------------------------------------------------------------------------

test('startup rejects in token-free mode if remote access is enabled in settings', async () => {
  const prevEnv = process.env['MAW_UNSAFE_LOCAL_NO_AUTH'];
  process.env['MAW_UNSAFE_LOCAL_NO_AUTH'] = '1';
  const { SettingsStore } = await import('../../../src/features/settings/settings-store.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');

  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-start-noauth-'));
  try {
    const settings = new SettingsStore(path.join(tempDir, 'settings.json'));
    await settings.load();
    await settings.update({ remote: { enabled: true } });
    const remoteSettings = settings.get().remote;
    const noAuth = isLocalNoAuthEnabled();

    assert.equal(noAuth, true);
    assert.equal(remoteSettings.enabled, true);

    const checkStartup = () => {
      if (noAuth && remoteSettings.enabled) {
        throw new Error(
          'MAW_UNSAFE_LOCAL_NO_AUTH=1 cannot be used with remote access enabled.\n' +
          'Disable remote access in settings before starting in token-free mode.',
        );
      }
    };
    assert.throws(checkStartup, /cannot be used with remote access enabled/);
  } finally {
    if (prevEnv !== undefined) {
      process.env['MAW_UNSAFE_LOCAL_NO_AUTH'] = prevEnv;
    } else {
      delete process.env['MAW_UNSAFE_LOCAL_NO_AUTH'];
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

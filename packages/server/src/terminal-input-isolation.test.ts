/**
 * Input isolation at the WebSocket boundary.
 *
 * Real HTTP/WebSocket server, real TerminalRegistry and real PTYs. Each PTY runs a
 * raw-mode script that reports exactly the bytes it receives (`RX:<json>`), so tty
 * echo cannot hide or fake a delivery.
 *
 * Invariants proved here:
 *  - A socket can write only to terminals it has attached (explicit grant).
 *  - Another socket attaching a terminal does not grant this socket anything.
 *  - detach and terminal.close revoke the grant.
 *  - A new socket (reconnect) starts with no grants until it attaches again.
 *  - Unrelated PTYs never receive bytes, and the intended PTY receives them exactly once.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const RAW_ECHO_SHELL = `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('READY\\n');
process.stdin.on('data', (chunk) => process.stdout.write('RX:' + JSON.stringify(chunk.toString()) + '\\n'));
setInterval(() => {}, 1 << 30);
`;

const PORT_TOKEN = 'input-isolation-token';

async function harness() {
  const { createServer } = await import('node:http');
  const { WebSocket } = await import('ws');
  const express = (await import('express')).default;
  const { attachTerminalSocket } = await import('./terminal-socket.js');
  const { TerminalRegistry } = await import('./terminal-registry.js');
  const { createAgentRegistry } = await import('./agents/registry.js');
  const { WorkspaceStore } = await import('./workspace-store.js');
  const { SessionIndex } = await import('./session-index.js');
  const { ArchivedSessions } = await import('./archived-sessions.js');
  const { VaultCatalog } = await import('./vault/catalog.js');
  const { WorktreeLinks } = await import('./worktrees/links.js');
  const { WorktreeStore } = await import('./worktrees/store.js');
  const { VaultService } = await import('./vault/service.js');
  const { WorktreeService } = await import('./worktrees/service.js');
  const { AppSettingsService } = await import('./app-settings-service.js');
  const { SettingsStore } = await import('./settings-store.js');
  const { NotesStore } = await import('./notes-store.js');
  const { DraftStore } = await import('./draft-store.js');
  const { ConversationHub } = await import('./conversation-hub.js');
  const { RepoHub } = await import('./repo-hub.js');
  const { MemoryHub } = await import('./memory-hub.js');
  const { RemoteAccessService } = await import('./remote-access-service.js');
  const { RemoteDevicesStore } = await import('./remote-devices-store.js');
  const { AgencyWorkspaceStore } = await import('./agency/store.js');
  const { AgencyProfileStore } = await import('./agency/agency-profile-store.js');
  const { AgencySessionRuntime } = await import('./agency/agency-session-runtime.js');
  const { SplitAgencySessionStore } = await import('./agency/agency-session-store.js');
  const { WorkspaceMutex } = await import('./agency/workspace-lock.js');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');

  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-input-isolation-'));
  // A script file, not `-e`: the registry may append shell flags that node would misread.
  const shellScript = path.join(tempDir, 'raw-echo-shell.cjs');
  await writeFile(shellScript, RAW_ECHO_SHELL);
  const httpServer = createServer(express());
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
    { file: process.execPath, args: [shellScript], name: 'synthetic-shell' },
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

  const detach = attachTerminalSocket({
    httpServer, port, token: PORT_TOKEN, appSettings, registry, index, archived, notes, drafts,
    conversations: new ConversationHub(registry, agents), repos: new RepoHub(registry), memory: new MemoryHub(registry),
    agents, defaultCwd: tempDir, vault, remote, worktrees, noAuth: true,
    agencyWorkspaceStore, agencyProfileStore, agencyRuntime, workspaceLock: new WorkspaceMutex(),
  });

  // Everything each PTY has printed, observed at registry level (independent of any socket grant).
  const received = new Map<string, string>();
  const observe = (terminalId: string) => {
    received.set(terminalId, '');
    const attached = registry.attach(terminalId as never, (id: string, chunk: string) => {
      received.set(id, (received.get(id) ?? '') + chunk);
    });
    // Output produced before the observer attached arrives as replay, not as a live chunk.
    if (attached !== null) received.set(terminalId, (received.get(terminalId) ?? '') + attached.replay);
  };
  const rx = (terminalId: string) => [...(received.get(terminalId) ?? '').matchAll(/RX:("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1] as string) as string);

  const open = async () => {
    const descriptor = await registry.open({ cwd: tempDir, kind: 'shell' });
    observe(descriptor.terminalId);
    await waitFor(() => (received.get(descriptor.terminalId) ?? '').includes('READY'), () => `PTY ready; got ${JSON.stringify(received.get(descriptor.terminalId))}`);
    return descriptor.terminalId as string;
  };

  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const send = (message: object) => ws.send(JSON.stringify(message));
    return { ws, send };
  };

  const cleanup = async () => {
    detach();
    for (const descriptor of registry.list()) registry.close(descriptor.terminalId);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  };

  return { open, connect, rx, cleanup, registry };
}

async function waitFor(check: () => boolean, label: string | (() => string), timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for: ${typeof label === 'function' ? label() : label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

test('input reaches only terminals this socket attached; unattached and foreign-attached PTYs receive nothing', { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    const a = await h.open();
    const b = await h.open();
    const one = await h.connect();
    const two = await h.connect();

    // Socket one attached only A. Input addressed to B (stale or foreign id) must be dropped.
    one.send({ type: 'terminal.attach', terminalId: a, cols: 80, rows: 24 });
    one.send({ type: 'input', terminalId: b, data: 'LEAK-TO-B' });
    one.send({ type: 'input', terminalId: a, data: 'TO-A-1' });
    await waitFor(() => h.rx(a).join('').includes('TO-A-1'), 'A receives its input');

    // Socket two attaching B gives socket one no right to write to B.
    two.send({ type: 'terminal.attach', terminalId: b, cols: 80, rows: 24 });
    one.send({ type: 'input', terminalId: b, data: 'LEAK-VIA-FOREIGN-ATTACH' });
    two.send({ type: 'input', terminalId: b, data: 'TO-B-1' });
    await waitFor(() => h.rx(b).join('').includes('TO-B-1'), 'B receives input from the socket that attached it');
    await settle();

    assert.equal(h.rx(a).join(''), 'TO-A-1', 'A received exactly its own input, once');
    assert.equal(h.rx(b).join(''), 'TO-B-1', 'B received only input from the socket that attached it');

    one.ws.close();
    two.ws.close();
  } finally {
    await h.cleanup();
  }
});

test('detach and terminal.close revoke the grant; a reconnected socket has none until it attaches again', { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    const a = await h.open();
    const first = await h.connect();

    first.send({ type: 'terminal.attach', terminalId: a, cols: 80, rows: 24 });
    first.send({ type: 'input', terminalId: a, data: 'BEFORE-DETACH' });
    await waitFor(() => h.rx(a).join('').includes('BEFORE-DETACH'), 'input while attached');

    first.send({ type: 'terminal.detach', terminalId: a });
    first.send({ type: 'input', terminalId: a, data: 'AFTER-DETACH' });
    await settle();
    assert.equal(h.rx(a).join(''), 'BEFORE-DETACH', 'input after detach is dropped');

    // Re-attach restores the grant and does not duplicate delivery.
    first.send({ type: 'terminal.attach', terminalId: a, cols: 80, rows: 24 });
    first.send({ type: 'input', terminalId: a, data: 'AFTER-REATTACH' });
    await waitFor(() => h.rx(a).join('').includes('AFTER-REATTACH'), 'input after re-attach');
    first.ws.close();
    await new Promise((resolve) => first.ws.once('close', resolve));

    // Reconnect: a fresh socket has no grants, so a keystroke sent before re-attach is dropped.
    const second = await h.connect();
    second.send({ type: 'input', terminalId: a, data: 'BEFORE-REATTACH' });
    second.send({ type: 'terminal.attach', terminalId: a, cols: 80, rows: 24 });
    second.send({ type: 'input', terminalId: a, data: 'AFTER-RECONNECT-ATTACH' });
    await waitFor(() => h.rx(a).join('').includes('AFTER-RECONNECT-ATTACH'), 'input after reconnect and attach');
    await settle();

    assert.deepEqual(h.rx(a), ['BEFORE-DETACH', 'AFTER-REATTACH', 'AFTER-RECONNECT-ATTACH']);
    second.ws.close();
  } finally {
    await h.cleanup();
  }
});

test('rapid attach/detach churn across two terminals never routes bytes to the wrong PTY', { timeout: 60000 }, async () => {
  const h = await harness();
  try {
    const a = await h.open();
    const b = await h.open();
    const sock = await h.connect();
    const rounds = 25;

    for (let i = 0; i < rounds; i += 1) {
      const [on, off] = i % 2 === 0 ? [a, b] : [b, a];
      sock.send({ type: 'terminal.attach', terminalId: on, cols: 80, rows: 24 });
      sock.send({ type: 'terminal.detach', terminalId: off });
      sock.send({ type: 'input', terminalId: on, data: `ON-${i};` });
      sock.send({ type: 'input', terminalId: off, data: `OFF-${i};` });
    }
    sock.send({ type: 'terminal.attach', terminalId: a, cols: 80, rows: 24 });
    sock.send({ type: 'input', terminalId: a, data: 'DONE-A' });
    await waitFor(() => h.rx(a).join('').includes('DONE-A'), 'final marker on A');
    await settle(500);

    const gotA = h.rx(a).join('');
    const gotB = h.rx(b).join('');
    assert.equal(/OFF-/.test(gotA + gotB), false, 'input addressed to a detached terminal is never delivered');
    for (let i = 0; i < rounds; i += 1) {
      const target = i % 2 === 0 ? gotA : gotB;
      const other = i % 2 === 0 ? gotB : gotA;
      assert.ok(target.includes(`ON-${i};`), `ON-${i} reached its intended PTY`);
      assert.ok(!other.includes(`ON-${i};`), `ON-${i} did not reach the other PTY`);
    }
    sock.ws.close();
  } finally {
    await h.cleanup();
  }
});

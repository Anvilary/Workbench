import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalRegistry, RemotePtySession } from './terminal-registry.js';

function registryWithEntry(client: any, session: any, id = 'terminal-1') {
  const registry = new TerminalRegistry({} as any, null, {} as any);
  const entry = {
    descriptor: { terminalId: id, alive: false, sleeping: false, exitCode: null, launchedAt: null },
    session,
    buffer: { seed: () => {}, dispose: () => {} },
    listeners: new Set(),
    stopWatchingActivity: null,
    launchHook: { exit: () => {}, cancel: () => {} },
  };
  const internal = registry as any;
  internal.client = client;
  internal.terminals.set(id, entry);
  internal.order.push(id);
  return { registry, entry, internal };
}

test('registry reconnect reconciles the same live terminal ID and PID with one bounded recovery loop', async () => {
  let reconnects = 0;
  const client = {
    reconnect: async () => {
      reconnects++;
      return { sessions: [{ id: 'terminal-1', pid: 4321, alive: true, cwd: '/tmp', createdAt: new Date().toISOString() }], tombstones: [] };
    },
    replay: async () => ({ data: '', startOffset: 0, endOffset: 0, truncated: false, screen: null }),
    kill: async () => {},
    detach: () => {},
  };
  const { registry, entry } = registryWithEntry(client, new RemotePtySession(client as any, 'terminal-1', 4321, '/tmp'));
  await Promise.all([
    (registry as any).recoverSupervisor(client),
    (registry as any).recoverSupervisor(client),
    (registry as any).recoverSupervisor(client),
  ]);
  assert.equal(reconnects, 1);
  assert.equal(entry.descriptor.alive, true);
  assert.equal(entry.session.id, 'terminal-1');
  assert.equal(entry.session.pid, 4321);
  registry.disposeAll();
});

test('registry reconnect marks snapshot tombstones dead instead of preserving stale live state', async () => {
  const client = {
    reconnect: async () => ({ sessions: [], tombstones: [{ id: 'terminal-1', pid: 4321, exitCode: 7, signal: null, exitedAt: new Date().toISOString(), startOffset: 0, endOffset: 10 }] }),
    detach: () => {},
  };
  let exited = false;
  const { registry, entry } = registryWithEntry(client, null);
  entry.descriptor.alive = false;
  entry.descriptor.exitCode = null;
  entry.launchHook.exit = () => { exited = true; };
  await (registry as any).recoverSupervisor(client);
  assert.equal(entry.descriptor.alive, false);
  assert.equal(entry.descriptor.exitCode, 7);
  assert.equal(entry.session, null);
  assert.equal(exited, true);
  registry.disposeAll();
});

test('an authenticated empty snapshot settles an unconfirmed PTY without inventing an exit code', async () => {
  const client = {
    reconnect: async () => ({ sessions: [], tombstones: [] }),
    detach: () => {},
  };
  const { registry, entry, internal } = registryWithEntry(client, null);
  Object.assign(entry, { supervisorUnconfirmed: true });
  let result: number | null | undefined;
  registry.on('exit', (_id, code) => { result = code; });
  assert.equal(registry.isSupervisorSessionUnconfirmed('terminal-1'), true);
  await internal.recoverSupervisor(client);
  assert.equal(registry.isSupervisorSessionUnconfirmed('terminal-1'), false);
  assert.equal(result, null);
  registry.disposeAll();
});

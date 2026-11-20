import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { ProjectId, WorkspaceId } from '@agent-workbench/shared';
import { TerminalRegistry, RemotePtySession } from '../../../src/features/terminals/terminal-registry.js';
import { AgencySessionRuntime } from '../../../src/features/sessions/session-runtime.js';

function registryWithEntry(client: any, session: any, id = 'terminal-1') {
  const registry = new TerminalRegistry({} as any, null, { save: () => {} } as any);
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

test('P1 B-05: failed kill keeps registry entry intact and allows stop retry without permanent stopping wedge', async () => {
  const terminalId = randomUUID();
  const sessionId = randomUUID();
  const workspaceId = randomUUID() as WorkspaceId;
  const tabId = randomUUID();

  let killAttempts = 0;
  let failKill = true;
  const client: any = {
    kill: async (id: string) => {
      killAttempts++;
      if (failKill) throw new Error('Connection closed by supervisor');
      // Simulate maw-ptyd emitting exit after kill succeeds
      queueMicrotask(() => {
        const entry = (registry as any).terminals.get(id);
        if (entry) {
          entry.session = null;
          entry.supervisorUnconfirmed = false;
          entry.descriptor = { ...entry.descriptor, alive: false, exitCode: 0 };
        }
        registry.emit('exit', id, 0, null);
      });
      return { op: 'killed', reqId: 'r', id };
    },
    reconnect: async () => { throw new Error('still disconnected'); },
    reapTombstone: () => {},
    detach: () => {},
  };

  const remoteSession = new RemotePtySession(client, terminalId, 9999, process.cwd());
  const { registry, internal } = registryWithEntry(client, remoteSession, terminalId);
  internal.terminals.get(terminalId).descriptor.alive = true;

  const runtime = new AgencySessionRuntime({
    registry,
    workspaces: {
      protectedDirectories: () => [],
      withSessionReservation: async (_id, fn) => fn({
        id: workspaceId,
        projectId: randomUUID() as ProjectId,
        name: 'WS',
        cwd: process.cwd(),
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        doneAt: null,
      }),
    },
    profiles: { resolveLaunch: async () => { throw new Error('unused'); } },
    store: {
      load: async () => [{
        id: sessionId,
        workspaceId,
        kind: 'terminal',
        lifecycle: 'running',
        activity: 'unknown',
        terminalId,
        nativeSessionId: null,
        profileId: null,
        selectedModel: null,
        selectedEffort: null,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        exitCode: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tab: { id: tabId, name: null, order: 0, current: true, selected: true, closedAt: null },
      }] as any,
      save: async () => {},
      flush: async () => {},
    } as any,
  });
  await runtime.initialize();

  // First stop fails because kill RPC fails: entry must NOT be deleted!
  await assert.rejects(() => runtime.stop(sessionId as any), /termination could not be confirmed/i);
  assert.equal(killAttempts, 1);
  assert.equal(internal.terminals.has(terminalId), true, 'Registry entry must not be deleted on failed kill');
  assert.equal(runtime.get(sessionId as any)?.lifecycle, 'stopping');

  // Retry stop once supervisor recovers: must NOT short-circuit on 'stopping'
  failKill = false;
  await runtime.stop(sessionId as any);
  assert.equal(killAttempts, 2, 'Retry stop on stopping session must re-attempt kill');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runtime.get(sessionId as any)?.lifecycle, 'exited');
  assert.equal(internal.terminals.has(terminalId), false, 'Registry entry cleaned up once exit confirmed');

  runtime.dispose();
  registry.disposeAll();
});

test('P1 B-05: stopping during maw-ptyd disconnect settles automatically when supervisor reconnects', async () => {
  const terminalId = randomUUID();
  const sessionId = randomUUID();
  const workspaceId = randomUUID() as WorkspaceId;
  const tabId = randomUUID();

  let killCount = 0;
  let reconnected = false;
  const client: any = {
    kill: async (id: string) => {
      killCount++;
      queueMicrotask(() => {
        const entry = (registry as any).terminals.get(id);
        if (entry) {
          entry.session = null;
          entry.supervisorUnconfirmed = false;
          entry.descriptor = { ...entry.descriptor, alive: false, exitCode: 143 };
        }
        registry.emit('exit', id, 143, null);
      });
      return { op: 'killed', reqId: 'r', id };
    },
    reconnect: async () => {
      if (!reconnected) throw new Error('still down');
      return {
        sessions: [{ id: terminalId, pid: 7777, alive: true, cwd: process.cwd(), createdAt: new Date().toISOString() }],
        tombstones: [],
      };
    },
    replay: async () => ({ data: '', startOffset: 0, endOffset: 0, truncated: false, screen: null }),
    reapTombstone: () => {},
    detach: () => {},
  };

  const { registry, entry, internal } = registryWithEntry(client, null, terminalId);
  Object.assign(entry, { supervisorUnconfirmed: true });

  const runtime = new AgencySessionRuntime({
    registry,
    workspaces: {
      protectedDirectories: () => [],
      withSessionReservation: async (_id, fn) => fn({
        id: workspaceId,
        projectId: randomUUID() as ProjectId,
        name: 'WS',
        cwd: process.cwd(),
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        doneAt: null,
      }),
    },
    profiles: { resolveLaunch: async () => { throw new Error('unused'); } },
    store: {
      load: async () => [{
        id: sessionId,
        workspaceId,
        kind: 'terminal',
        lifecycle: 'running',
        activity: 'unknown',
        terminalId,
        nativeSessionId: null,
        profileId: null,
        selectedModel: null,
        selectedEffort: null,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        exitCode: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tab: { id: tabId, name: null, order: 0, current: true, selected: true, closedAt: null },
      }] as any,
      save: async () => {},
      flush: async () => {},
    } as any,
  });
  await runtime.initialize();

  // Stop while supervisor is disconnected -> unconfirmed, entry preserved with pendingKill
  await assert.rejects(() => runtime.stop(sessionId as any), /termination could not be confirmed/i);
  assert.equal(internal.terminals.has(terminalId), true);
  assert.equal((entry as any).pendingKill, true);
  assert.equal(runtime.get(sessionId as any)?.lifecycle, 'stopping');

  // Supervisor comes back online with the PTY still alive -> adoptSupervisorSession must auto-kill it
  reconnected = true;
  await internal.recoverSupervisor(client);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(killCount, 1, 'Supervisor reconnect must automatically kill pendingKill PTY');
  assert.equal(runtime.get(sessionId as any)?.lifecycle, 'exited');
  assert.equal(internal.terminals.has(terminalId), false);

  runtime.dispose();
  registry.disposeAll();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AgencyWorkspace, ProjectId, WorkspaceId } from '@agent-workbench/shared';
import { TerminalRegistry } from '../../../src/terminal-registry.js';
import { AgencySessionRuntime, type AgencyWorkspaceSource } from '../../../src/agency/agency-session-runtime.js';
import { PtyHostClient } from '../../../src/pty-host/pty-host-client.js';

function createMockStore() {
  return {
    load: async () => ({ version: 1 as const, activeTabId: null, tabs: [] }),
    save: async () => {},
  };
}

function createMockAgents() {
  return {
    get: () => null,
    defaultAgent: () => null,
  };
}

function createMockRegistry(options?: { persistentPty?: boolean }) {
  const store = createMockStore();
  const agents = createMockAgents();
  const shell = { file: '/bin/bash', args: [], name: 'bash' };
  const registry = new TerminalRegistry(
    agents as any,
    shell,
    store as any,
    () => null,
    async () => null,
    () => '',
    { persistentPty: options?.persistentPty ?? false },
  );
  return registry;
}

function createMockEntry(overrides?: any) {
  return {
    descriptor: {
      terminalId: randomUUID(),
      alive: false,
      sleeping: false,
      exitCode: null,
      launchedAt: null,
      kind: 'shell',
      ...overrides?.descriptor,
    },
    session: overrides?.session ?? null,
    launching: overrides?.launching ?? false,
    supervisorUnconfirmed: overrides?.supervisorUnconfirmed ?? false,
    agencyManaged: overrides?.agencyManaged ?? false,
    listeners: new Set(),
    buffer: { dispose: () => {}, seed: () => {}, read: () => '' },
    launchHook: { cancel: () => {}, exit: () => {} },
    stopWatchingActivity: null,
    ...overrides,
  };
}

test('activeCount only counts alive, launching, or unconfirmed terminals', () => {
  const registry = createMockRegistry();
  const internal = registry as any;

  // Add 10 exited terminals
  for (let i = 0; i < 10; i++) {
    const id = `dead-${i}`;
    internal.terminals.set(id, createMockEntry({
      descriptor: { terminalId: id, alive: false, sleeping: false, exitCode: 0, launchedAt: null, kind: 'shell' },
    }));
  }

  // Add 5 sleeping terminals
  for (let i = 0; i < 5; i++) {
    const id = `sleeping-${i}`;
    internal.terminals.set(id, createMockEntry({
      descriptor: { terminalId: id, alive: false, sleeping: true, exitCode: null, launchedAt: null, kind: 'agent' },
    }));
  }

  // Add 3 live terminals
  for (let i = 0; i < 3; i++) {
    const id = `live-${i}`;
    internal.terminals.set(id, createMockEntry({
      descriptor: { terminalId: id, alive: true, sleeping: false, exitCode: null, launchedAt: Date.now(), kind: 'shell' },
      session: { pid: 1000 + i, dispose: () => {} },
    }));
  }

  // Add 1 launching terminal
  const launchingId = 'launching-1';
  internal.terminals.set(launchingId, createMockEntry({
    descriptor: { terminalId: launchingId, alive: false, sleeping: false, exitCode: null, launchedAt: null, kind: 'shell' },
    launching: true,
  }));

  // Add 2 unconfirmed supervisor terminals
  for (let i = 0; i < 2; i++) {
    const id = `unconfirmed-${i}`;
    internal.terminals.set(id, createMockEntry({
      descriptor: { terminalId: id, alive: false, sleeping: false, exitCode: null, launchedAt: null, kind: 'agent' },
      supervisorUnconfirmed: true,
    }));
  }

  assert.equal(internal.terminals.size, 21);
  // Active count must be 3 (live) + 1 (launching) + 2 (unconfirmed) = 6
  assert.equal(registry.activeCount(), 6);
  registry.disposeAll();
});

test('open rejects when active capacity is full, but allows opening when slots are available despite exited terminals', async () => {
  const registry = createMockRegistry();
  const internal = registry as any;

  // Populate 42 terminals where 41 are exited and 1 is active
  for (let i = 0; i < 41; i++) {
    const id = `dead-${i}`;
    internal.terminals.set(id, createMockEntry({
      descriptor: { terminalId: id, alive: false, sleeping: false, exitCode: 0, launchedAt: null, kind: 'shell' },
    }));
  }
  const liveId = 'live-0';
  internal.terminals.set(liveId, createMockEntry({
    descriptor: { terminalId: liveId, alive: true, sleeping: false, exitCode: null, launchedAt: Date.now(), kind: 'shell' },
    session: { pid: 9999, dispose: () => {} },
  }));

  assert.equal(internal.terminals.size, 42);
  assert.equal(registry.activeCount(), 1);

  // Now populate up to 42 active terminals
  for (let i = 1; i < 42; i++) {
    const id = `live-${i}`;
    internal.terminals.set(id, createMockEntry({
      descriptor: { terminalId: id, alive: true, sleeping: false, exitCode: null, launchedAt: Date.now(), kind: 'shell' },
      session: { pid: 10000 + i, dispose: () => {} },
    }));
  }

  assert.equal(registry.activeCount(), 42);

  // Attempting to open when activeCount is 42 must throw too-many-terminals
  await assert.rejects(
    registry.open({ cwd: process.cwd(), kind: 'shell' }),
    (err: any) => err.code === 'too-many-terminals',
  );

  registry.disposeAll();
});

test('wake rejects with too-many-terminals when active count is at maximum', async () => {
  const registry = createMockRegistry();
  const internal = registry as any;

  // Add 42 active terminals
  for (let i = 0; i < 42; i++) {
    const id = `live-${i}`;
    internal.terminals.set(id, createMockEntry({
      descriptor: { terminalId: id, alive: true, sleeping: false, exitCode: null, launchedAt: Date.now(), kind: 'agent' },
      session: { pid: 20000 + i, dispose: () => {} },
    }));
  }

  // Add 1 sleeping terminal
  const sleepId = 'sleeping-target';
  internal.terminals.set(sleepId, createMockEntry({
    descriptor: { terminalId: sleepId, alive: false, sleeping: true, exitCode: null, launchedAt: null, kind: 'agent' },
  }));

  await assert.rejects(
    registry.wake(sleepId),
    (err: any) => err.code === 'too-many-terminals',
  );

  registry.disposeAll();
});

test('recoverSupervisor preserves unconfirmed terminals on retry exhaustion, preventing duplicate native sessions until authoritative observation or closure', async () => {
  const registry = createMockRegistry();
  const internal = registry as any;

  const mockClient = {
    reconnect: async () => {
      throw new Error('Connection refused');
    },
    detach: () => {},
  };
  internal.client = mockClient;

  const terminalId = 'unconfirmed-fail-test';
  let exitedEmitted = false;
  let exitSignalEmitted = false;
  internal.terminals.set(terminalId, createMockEntry({
    descriptor: {
      terminalId,
      alive: false,
      sleeping: false,
      exitCode: null,
      launchedAt: Date.now(),
      kind: 'agent',
      sessionId: 'conv-1234',
      agent: 'codex',
    },
    supervisorUnconfirmed: true,
    launchHook: { exit: () => { exitedEmitted = true; }, cancel: () => {} },
  }));
  internal.order.push(terminalId);

  registry.on('exit', (id) => {
    if (id === terminalId) exitSignalEmitted = true;
  });

  // Speed up timeouts for test
  const originalSetTimeout = global.setTimeout;
  (global as any).setTimeout = (fn: any) => setImmediate(fn);
  try {
    await internal.recoverSupervisor(mockClient);
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  const entry = internal.terminals.get(terminalId);
  // Must preserve unconfirmed state; not falsely marked dead
  assert.equal(entry.supervisorUnconfirmed, true);
  assert.equal(entry.descriptor.alive, false);
  assert.equal(exitedEmitted, false);
  assert.equal(exitSignalEmitted, false);
  assert.equal(registry.activeCount(), 1);

  // Unconfirmed terminal must prevent duplicate native conversation controller adoption
  const hasController = registry.list().some((term) =>
    (term.alive || registry.isSupervisorSessionUnconfirmed?.(term.terminalId)) &&
    term.kind === 'agent' && term.agent === 'codex' && term.sessionId === 'conv-1234',
  );
  assert.equal(hasController, true, 'Unconfirmed session must block duplicate native conversation controller');

  // Authoritative observation via successful reconnect settling the session
  const authoritativeClient = {
    reconnect: async () => ({
      sessions: [],
      tombstones: [{ id: terminalId, pid: 12345, exitCode: 137, signal: 9, exitedAt: new Date().toISOString() }],
    }),
    detach: () => {},
  };
  internal.client = authoritativeClient;
  await internal.recoverSupervisor(authoritativeClient);

  assert.equal(entry.supervisorUnconfirmed, false);
  assert.equal(entry.descriptor.alive, false);
  assert.equal(entry.descriptor.exitCode, 137);
  assert.equal(exitedEmitted, true);
  assert.equal(exitSignalEmitted, true);
  assert.equal(registry.activeCount(), 0, 'Capacity reclaimed once exit is authoritatively confirmed');

  registry.disposeAll();
});

test('Agency tabAction close on an exited session reclaims registry terminal slot', async () => {
  const registry = createMockRegistry();
  const internal = registry as any;

  const terminalId = randomUUID();
  let closeCalledWith: string | null = null;
  const originalClose = registry.close.bind(registry);
  registry.close = (id: string) => {
    closeCalledWith = id;
    return originalClose(id);
  };

  internal.terminals.set(terminalId, createMockEntry({
    descriptor: { terminalId, alive: false, sleeping: false, exitCode: 0, launchedAt: null, kind: 'shell' },
    agencyManaged: true,
  }));
  internal.order.push(terminalId);

  const workspaceId = randomUUID();
  const tabId = randomUUID();
  const sessionId = randomUUID();

  const workspace: AgencyWorkspace = {
    id: workspaceId as WorkspaceId,
    projectId: randomUUID() as ProjectId,
    name: 'Test WS',
    cwd: process.cwd(),
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    doneAt: null,
  };

  const workspaceSource: AgencyWorkspaceSource = {
    protectedDirectories: () => [],
    withSessionReservation: async (_wsId, fn) => fn(workspace),
  };

  const runtime = new AgencySessionRuntime({
    registry,
    workspaces: workspaceSource,
    profiles: { resolveLaunch: async () => ({} as any), resolveModelChoice: async () => ({} as any) } as any,
    store: {
      load: async () => [{
        id: sessionId,
        workspaceId: workspaceId as WorkspaceId,
        kind: 'terminal',
        lifecycle: 'exited',
        activity: 'offline',
        terminalId,
        nativeSessionId: null,
        profileId: null,
        selectedModel: null,
        selectedEffort: null,
        startedAt: null,
        stoppedAt: null,
        updatedAt: new Date().toISOString(),
        tab: { id: tabId, order: 0, current: true, selected: true, closedAt: null },
      }] as any,
      save: async () => {},
      flush: async () => {},
    } as any,
  });

  await runtime.initialize();

  // The tab is exited. Now user closes it.
  await runtime.tabAction(workspaceId as WorkspaceId, tabId, 'close');

  // Verify registry.close was called for terminalId
  assert.equal(closeCalledWith, terminalId);
  // Verify it is no longer in registry
  assert.equal(internal.terminals.has(terminalId), false);

  runtime.dispose();
  registry.disposeAll();
});

test('Agency onExit invokes registry.close even if persistence throws', async () => {
  const registry = createMockRegistry();
  const internal = registry as any;

  const terminalId = randomUUID();
  let closeCalled = false;
  registry.close = (id: string) => {
    if (id === terminalId) closeCalled = true;
    return true;
  };

  const workspaceId = randomUUID();
  const tabId = randomUUID();
  const sessionId = randomUUID();

  const workspace: AgencyWorkspace = {
    id: workspaceId as WorkspaceId,
    projectId: randomUUID() as ProjectId,
    name: 'Test WS',
    cwd: process.cwd(),
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    doneAt: null,
  };

  const workspaceSource: AgencyWorkspaceSource = {
    protectedDirectories: () => [],
    withSessionReservation: async (_wsId, fn) => fn(workspace),
  };

  let failSaves = false;
  const runtime = new AgencySessionRuntime({
    registry,
    workspaces: workspaceSource,
    profiles: { resolveLaunch: async () => ({} as any), resolveModelChoice: async () => ({} as any) } as any,
    store: {
      load: async () => [{
        id: sessionId,
        workspaceId: workspaceId as WorkspaceId,
        kind: 'terminal',
        lifecycle: 'running',
        activity: 'idle',
        terminalId,
        nativeSessionId: null,
        profileId: null,
        selectedModel: null,
        selectedEffort: null,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        updatedAt: new Date().toISOString(),
        tab: { id: tabId, order: 0, current: true, selected: true, closedAt: null },
      }] as any,
      save: async () => {
        if (failSaves) throw new Error('Disk full simulation');
      },
      flush: async () => {},
    } as any,
  });

  internal.terminals.set(terminalId, createMockEntry({
    descriptor: { terminalId, alive: true, sleeping: false, exitCode: null, launchedAt: Date.now(), kind: 'shell' },
    session: { pid: 30000, dispose: () => {} },
    agencyManaged: true,
  }));

  await runtime.initialize();

  // Now enable failure on subsequent save attempts
  failSaves = true;

  // Simulate PTY exit event
  (runtime as any).onExit(terminalId, 0);

  // Wait a turn for promise resolution
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Verify registry.close was invoked despite the save error
  assert.equal(closeCalled, true);

  runtime.dispose();
  registry.disposeAll();
});

test('Agency initialize reclaims dead orphaned agency terminals from registry', async () => {
  const registry = createMockRegistry();
  const internal = registry as any;

  const deadOrphanId = randomUUID();
  let closedOrphan = false;
  const originalClose = registry.close.bind(registry);
  registry.close = (id: string) => {
    if (id === deadOrphanId) closedOrphan = true;
    return originalClose(id);
  };

  internal.terminals.set(deadOrphanId, createMockEntry({
    descriptor: { terminalId: deadOrphanId, alive: false, sleeping: false, exitCode: 1, launchedAt: null, kind: 'agent' },
    agencyManaged: true,
  }));
  internal.order.push(deadOrphanId);

  const workspace: AgencyWorkspace = {
    id: randomUUID() as WorkspaceId,
    projectId: randomUUID() as ProjectId,
    name: 'Test WS',
    cwd: process.cwd(),
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    doneAt: null,
  };

  const workspaceSource: AgencyWorkspaceSource = {
    protectedDirectories: () => [],
    withSessionReservation: async (_wsId, fn) => fn(workspace),
  };

  const runtime = new AgencySessionRuntime({
    registry,
    workspaces: workspaceSource,
    profiles: { resolveLaunch: async () => ({} as any), resolveModelChoice: async () => ({} as any) } as any,
    store: {
      load: async () => [] as any, // No agency sessions recorded
      save: async () => {},
      flush: async () => {},
    } as any,
  });

  await runtime.initialize();

  assert.equal(closedOrphan, true);
  assert.equal(internal.terminals.has(deadOrphanId), false);

  runtime.dispose();
  registry.disposeAll();
});

test('Agency create rolls back and closes opened terminal if subsequent initialization throws', async () => {
  const registry = createMockRegistry();
  const internal = registry as any;

  const spawnedTerminalId = randomUUID();
  let closeCalled = false;
  registry.open = async (options: any) => {
    internal.terminals.set(spawnedTerminalId, createMockEntry({
      descriptor: { terminalId: spawnedTerminalId, alive: true, sleeping: false, exitCode: null, launchedAt: Date.now(), kind: 'shell' },
      agencyManaged: true,
    }));
    return {
      terminalId: spawnedTerminalId,
      kind: 'shell',
      agent: null,
      cwd: options.cwd,
      sessionId: '',
      label: '',
      resumed: false,
      createdAt: Date.now(),
      alive: true,
      exitCode: null,
      sleeping: false,
      launchedAt: Date.now(),
      worktree: null,
      review: false,
    };
  };

  registry.close = (id: string) => {
    if (id === spawnedTerminalId) {
      closeCalled = true;
      internal.terminals.delete(spawnedTerminalId);
      return true;
    }
    return false;
  };

  const workspaceId = randomUUID();
  const workspace: AgencyWorkspace = {
    id: workspaceId as WorkspaceId,
    projectId: randomUUID() as ProjectId,
    name: 'Test WS',
    cwd: process.cwd(),
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    doneAt: null,
  };

  const workspaceSource: AgencyWorkspaceSource = {
    protectedDirectories: () => [],
    withSessionReservation: async (_wsId, fn) => fn(workspace),
  };

  let saveCount = 0;
  const runtime = new AgencySessionRuntime({
    registry,
    workspaces: workspaceSource,
    profiles: { resolveLaunch: async () => ({} as any), resolveModelChoice: async () => ({} as any) } as any,
    store: {
      load: async () => [] as any,
      save: async () => {
        saveCount++;
        // Fail on the save that happens immediately after registry.open
        if (saveCount === 2) throw new Error('Persistence failure during create after open');
      },
      flush: async () => {},
    } as any,
  });

  await runtime.initialize();

  await assert.rejects(
    runtime.create({
      workspaceId,
      kind: 'terminal',
      cols: 80,
      rows: 24,
    } as any),
  );

  assert.equal(closeCalled, true);
  assert.equal((runtime as any).byTerminal.has(spawnedTerminalId), false);
  assert.equal(internal.terminals.has(spawnedTerminalId), false);

  runtime.dispose();
  registry.disposeAll();
});

test('inFlightOpens reserves capacity atomically across concurrent open calls', async () => {
  const registry = createMockRegistry();
  const internal = registry as any;

  // Add 41 active terminals (limit is 42)
  for (let i = 0; i < 41; i++) {
    const id = `live-${i}`;
    internal.terminals.set(id, createMockEntry({
      descriptor: { terminalId: id, alive: true, sleeping: false, exitCode: null, launchedAt: Date.now(), kind: 'shell' },
      session: { pid: 40000 + i, dispose: () => {} },
    }));
  }

  assert.equal(registry.activeCount(), 41);

  // Intercept worktreeFor to add an async yield
  const originalWorktree = internal.worktreeFor.bind(internal);
  internal.worktreeFor = async (kind: any, cwd: any) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return originalWorktree(kind, cwd);
  };

  // Mock spawn so it succeeds without real PTY
  internal.spawn = async (entry: any) => {
    entry.descriptor.alive = true;
    entry.session = { pid: 99999, dispose: () => {} };
    return true;
  };

  // Launch two opens concurrently. Only one should succeed; the second must fail with too-many-terminals
  const results = await Promise.allSettled([
    registry.open({ cwd: process.cwd(), kind: 'shell' }),
    registry.open({ cwd: process.cwd(), kind: 'shell' }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as PromiseRejectedResult).reason?.code, 'too-many-terminals');

  registry.disposeAll();
});

test('closing an unconfirmed supervisor terminal immediately reclaims terminal capacity', () => {
  const registry = createMockRegistry();
  const internal = registry as any;

  const terminalId = 'unconfirmed-close-test';
  internal.terminals.set(terminalId, createMockEntry({
    descriptor: { terminalId, alive: false, sleeping: false, exitCode: null, launchedAt: Date.now(), kind: 'agent' },
    supervisorUnconfirmed: true,
  }));
  internal.order.push(terminalId);

  assert.equal(registry.activeCount(), 1);

  // Closing unconfirmed terminal immediately removes it and reclaims capacity
  const closed = registry.close(terminalId);
  assert.equal(closed, true);
  assert.equal(registry.activeCount(), 0);
  assert.equal(internal.terminals.has(terminalId), false);

  registry.disposeAll();
});

test('PtyHostClient.connectOrSpawn rejects connecting to production supervisor socket in test environment without isolated path', async () => {
  const savedSocket = process.env.MAW_PTYD_SOCKET;
  const savedRuntimeDir = process.env.MAW_PTYD_RUNTIME_DIR;
  delete process.env.MAW_PTYD_SOCKET;
  delete process.env.MAW_PTYD_RUNTIME_DIR;

  try {
    await assert.rejects(
      PtyHostClient.connectOrSpawn({}),
      (err: any) => {
        assert.match(err.message, /Refusing to connect to production PTY supervisor socket in test environment/);
        return true;
      },
    );
  } finally {
    if (savedSocket !== undefined) process.env.MAW_PTYD_SOCKET = savedSocket;
    if (savedRuntimeDir !== undefined) process.env.MAW_PTYD_RUNTIME_DIR = savedRuntimeDir;
  }
});

test('TerminalRegistry constructor defaults persistentPty to false in test runner even if MAW_PERSISTENT_PTY is set', () => {
  const savedPersistent = process.env.MAW_PERSISTENT_PTY;
  process.env.MAW_PERSISTENT_PTY = '1';

  try {
    const registry = new TerminalRegistry(
      createMockAgents() as any,
      null,
      createMockStore() as any,
      () => null,
      async () => null,
      () => '',
    );
    assert.equal((registry as any).persistentPty, false);
    registry.disposeAll();
  } finally {
    if (savedPersistent !== undefined) {
      process.env.MAW_PERSISTENT_PTY = savedPersistent;
    } else {
      delete process.env.MAW_PERSISTENT_PTY;
    }
  }
});


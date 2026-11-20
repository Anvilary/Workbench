import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  ClassicWorkbenchLifecycle,
  type ClassicWorkbenchServices,
} from '../../../src/features/history/classic-workbench-lifecycle.js';

function createMockServices() {
  let indexStarted = 0;
  let vaultStarted = 0;
  let vaultDisposed = 0;
  let watchSessionsCalled = 0;
  let stopWatchCalled = 0;

  const mockIndex = {
    start: async () => {
      indexStarted += 1;
    },
    refreshPath: async () => {},
  } as any;

  const mockVault = {
    start: () => {
      vaultStarted += 1;
    },
    dispose: () => {
      vaultDisposed += 1;
    },
  } as any;

  const mockConversations = new EventEmitter() as any;
  const mockAgents = { all: () => [] } as any;

  const mockWatchSessions = () => {
    watchSessionsCalled += 1;
    return () => {
      stopWatchCalled += 1;
    };
  };

  const services: ClassicWorkbenchServices = {
    index: mockIndex,
    vault: mockVault,
    conversations: mockConversations,
    agents: mockAgents,
  };

  return {
    services,
    mockWatchSessions,
    mockConversations,
    getCounts: () => ({
      indexStarted,
      vaultStarted,
      vaultDisposed,
      watchSessionsCalled,
      stopWatchCalled,
    }),
  };
}

test('ClassicWorkbenchLifecycle: defaults to lazy (no startup calls on creation)', () => {
  const { services, mockWatchSessions, getCounts } = createMockServices();

  const lifecycle = new ClassicWorkbenchLifecycle(services, {
    watchSessionsFn: mockWatchSessions as any,
  });

  assert.equal(lifecycle.isStarted(), false);
  assert.equal(lifecycle.isStarting(), false);

  const counts = getCounts();
  assert.equal(counts.indexStarted, 0);
  assert.equal(counts.vaultStarted, 0);
  assert.equal(counts.watchSessionsCalled, 0);

  lifecycle.dispose();
});

test('ClassicWorkbenchLifecycle: ensureStarted() initializes services idempotently', async () => {
  const { services, mockWatchSessions, mockConversations, getCounts } = createMockServices();

  const lifecycle = new ClassicWorkbenchLifecycle(services, {
    watchSessionsFn: mockWatchSessions as any,
  });

  // Call ensureStarted() concurrently
  const p1 = lifecycle.ensureStarted();
  const p2 = lifecycle.ensureStarted();
  assert.equal(lifecycle.isStarting(), true);

  await Promise.all([p1, p2]);

  assert.equal(lifecycle.isStarted(), true);
  assert.equal(lifecycle.isStarting(), false);

  const counts = getCounts();
  assert.equal(counts.indexStarted, 1);
  assert.equal(counts.vaultStarted, 1);
  assert.equal(counts.watchSessionsCalled, 1);

  // Subsequent call does nothing
  await lifecycle.ensureStarted();
  assert.equal(getCounts().indexStarted, 1);

  // Check event wiring
  assert.equal(mockConversations.listenerCount('historyGrew'), 1);

  // Dispose shuts down cleanly
  lifecycle.dispose();
  assert.equal(getCounts().stopWatchCalled, 1);
  assert.equal(getCounts().vaultDisposed, 1);
  assert.equal(mockConversations.listenerCount('historyGrew'), 0);
  assert.equal(lifecycle.isStarted(), false);
});

test('ClassicWorkbenchLifecycle: eager option starts immediately', async () => {
  const { services, mockWatchSessions, getCounts } = createMockServices();

  const lifecycle = new ClassicWorkbenchLifecycle(services, {
    eager: true,
    watchSessionsFn: mockWatchSessions as any,
  });

  await lifecycle.ensureStarted();

  assert.equal(lifecycle.isStarted(), true);
  const counts = getCounts();
  assert.equal(counts.indexStarted, 1);
  assert.equal(counts.vaultStarted, 1);
  assert.equal(counts.watchSessionsCalled, 1);

  lifecycle.dispose();
});

test('ClassicWorkbenchLifecycle: prevents start after dispose', async () => {
  const { services, mockWatchSessions } = createMockServices();

  const lifecycle = new ClassicWorkbenchLifecycle(services, {
    watchSessionsFn: mockWatchSessions as any,
  });

  lifecycle.dispose();
  await assert.rejects(
    () => lifecycle.ensureStarted(),
    /Cannot start ClassicWorkbenchLifecycle after disposal/,
  );
});

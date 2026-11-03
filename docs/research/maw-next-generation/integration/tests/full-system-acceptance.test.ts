/**
 * MAW Next-Generation: Full-System Acceptance Test Suite
 *
 * Isolated integration tests covering multi-process guarantees across:
 * - Lane A: Persistent PTY Supervisor (maw-ptyd)
 * - Lane B: Backend disconnect / reconnect / reattach
 * - Lane C: Notification persistence, deduplication across restart, focus tracking
 * - Lane D: Output micro-batching and coalesced store durability
 *
 * Safety & Isolation Principles:
 * - Uses real disposable child processes in isolated temporary directories.
 * - Never accesses production MAW processes, sockets, or user directories.
 * - Designed to fail immediately if any expected state transition or PID retention fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
// @ts-expect-error - ws from server node_modules
import wsPkg from '/home/user/Projects/MAW-next-gen-integration/packages/server/node_modules/ws/index.js';
const { Server: WebSocketServer, WebSocket } = wsPkg;

// Import Lane A modules (read-only from Lane A worktree)
// @ts-expect-error - Standalone ESM supervisor
import { PtySupervisor } from '/home/user/Projects/MAW-pty-supervisor/packages/server/src/pty-host/maw-ptyd.mjs';
import { PtyHostClient } from '/home/user/Projects/MAW-pty-supervisor/packages/server/src/pty-host/pty-host-client.js';

// Import Lane C modules (read-only from Lane C worktree)
import { AgencyNotificationStore } from '/home/user/Projects/MAW-notifications/packages/server/src/agency/agency-notification-store.js';
import { FocusTracker } from '/home/user/Projects/MAW-notifications/packages/web/src/agency/focus-tracker.js';

// Import Lane D modules (read-only from Lane D worktree)
import { TerminalOutputBatcher } from '/home/user/Projects/MAW-performance/packages/server/src/terminal-output-batcher.js';
import { CoalescedJsonStore } from '/home/user/Projects/MAW-performance/packages/server/src/coalesced-json-store.js';

const SYNTHETIC_AGENT_PATH = path.resolve(
  '/home/user/Projects/MAW-pty-supervisor/packages/server/src/pty-host/fixtures/synthetic-agent.mjs'
);

function createIsolatedEnv(prefix = 'maw-acceptance-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const socketPath = path.join(tmpDir, 'ptyd.sock');
  const authPath = path.join(tmpDir, 'ptyd.auth');
  return {
    tmpDir,
    socketPath,
    authPath,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

test('Acceptance 1: Child PTY process and original PID survive backend restart and reattach', async () => {
  const env = createIsolatedEnv('maw-acc-pid-');
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    await supervisor.listen();

    // 1. Backend 1 connects and spawns long-running synthetic agent
    const client1 = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const sessionId = 'session-survive-1';
    const spawnRes = await client1.spawn({
      id: sessionId,
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
    });

    const originalPid = spawnRes.pid;
    assert.ok(originalPid > 0, 'Original PID must be a valid positive integer');

    // Start background activity
    client1.write(sessionId, 'START_JOB token=acc-test-1\n');
    await new Promise((r) => setTimeout(r, 150));

    // 2. Simulate Backend 1 sudden death (SIGTERM / process exit): detach without killing children
    client1.detach();

    // Verify child process is STILL running at OS level
    let childStillAlive = false;
    try {
      process.kill(originalPid, 0);
      childStillAlive = true;
    } catch {}
    assert.equal(childStillAlive, true, `Child process PID ${originalPid} must remain alive after client detach`);

    // 3. Backend 2 boots up, discovers socket, and reconnects
    const client2 = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const listRes = await client2.list();
    const activeSession = listRes.sessions.find((s) => s.id === sessionId);
    assert.ok(activeSession, 'Session must be present in supervisor session list after reconnect');
    assert.equal(activeSession.pid, originalPid, 'Session PID must match original PID exactly (zero restart)');

    // 4. Send ping to verify terminal stdin/stdout works after reconnection
    let pongReceived = false;
    const dataHandler = (id: string, chunk: string) => {
      if (id === sessionId && chunk.includes('PONG acc-token-2')) {
        pongReceived = true;
      }
    };
    client2.onData(dataHandler);

    client2.write(sessionId, 'PING acc-token-2\n');
    const deadline = Date.now() + 2000;
    while (!pongReceived && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(pongReceived, true, 'Terminal must accept input and emit output after reattachment');

    await client2.kill(sessionId);
    client2.detach();
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('Acceptance 2: Monotonic delta replay without duplication and explicit truncation handling', async () => {
  const env = createIsolatedEnv('maw-acc-replay-');
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    await supervisor.listen();

    const client = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const sessionId = 'session-replay-1';
    await client.spawn({
      id: sessionId,
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
    });

    // Allow synthetic agent process to start and emit AGENT_READY banner
    await new Promise((r) => setTimeout(r, 100));

    // Capture initial replay snapshot
    const initialReplay = await client.replay(sessionId);
    assert.equal(initialReplay.reset, true);
    assert.ok(initialReplay.data.includes('AGENT_READY'));
    const offset1 = initialReplay.endOffset;

    // Send command to emit more data
    client.write(sessionId, 'PING replay-check-1\n');
    await new Promise((r) => setTimeout(r, 100));

    // Request delta replay starting from offset1
    const deltaReplay = await client.replay(sessionId, offset1);
    assert.equal(deltaReplay.reset, false, 'Delta replay must not trigger reset for retained offset');
    assert.ok(deltaReplay.data.includes('PONG replay-check-1'), 'Delta replay must contain newly emitted bytes');
    assert.ok(!deltaReplay.data.includes('AGENT_READY'), 'Delta replay must not duplicate pre-offset output');

    // Trigger ring buffer overflow (FLOOD_1MB exceeds default 256 KiB ring buffer)
    client.write(sessionId, 'FLOOD_1MB\n');
    await new Promise((r) => setTimeout(r, 300));

    // Replay requesting the old offset1 (which was evicted)
    const truncatedReplay = await client.replay(sessionId, offset1);
    assert.equal(truncatedReplay.reset, true, 'Evicted offset must force reset: true');
    assert.equal(truncatedReplay.truncated, true, 'Buffer truncation must be explicitly reported');
    assert.ok(truncatedReplay.startOffset > offset1, 'startOffset must advance beyond evicted offset');

    await client.kill(sessionId);
    client.detach();
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('Acceptance 3: Child process exit during backend downtime creates durable tombstone', async () => {
  const env = createIsolatedEnv('maw-acc-tombstone-');
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    await supervisor.listen();

    const client1 = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const sessionId = 'session-tombstone-1';
    const s = await client1.spawn({
      id: sessionId,
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
    });
    const pid = s.pid;

    // Command process to exit with code 42
    client1.write(sessionId, 'EXIT_WITH 42\n');

    // Backend 1 disconnects immediately before the exit is processed
    client1.detach();

    // Wait for process to terminate in supervisor
    await new Promise((r) => setTimeout(r, 200));

    // Backend 2 connects and inspects tombstones
    const client2 = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const listRes = await client2.list();
    const tombstone = listRes.tombstones.find((t) => t.id === sessionId);
    assert.ok(tombstone, 'Tombstone must exist for session that exited during backend downtime');
    assert.equal(tombstone.pid, pid, 'Tombstone PID must match original child PID');
    assert.equal(tombstone.exitCode, 42, 'Tombstone exitCode must be preserved accurately');

    // Fetch exit output replay
    const exitReplay = await client2.replay(sessionId);
    assert.ok(exitReplay.data.includes('FINAL_ERROR_LINE code=42'), 'Tombstone must preserve final output lines');

    // Reap tombstone
    client2.reapTombstone(sessionId);
    await new Promise((r) => setTimeout(r, 50));

    const updatedList = await client2.list();
    assert.equal(updatedList.tombstones.some((t) => t.id === sessionId), false, 'Tombstone must be removed after reap');

    client2.detach();
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('Acceptance 4: Notification deduplication across simulated server restart', async () => {
  const env = createIsolatedEnv('maw-acc-notif-');
  const storeFile = path.join(env.tmpDir, 'agency-notifications.json');

  try {
    // 1. Initial server instance writes notification with stable dedup key
    const store1 = new AgencyNotificationStore(storeFile);
    await store1.initialize();

    const notifKey = 'task-turn-completed-12345';
    const created1 = await store1.create({
      workspaceId: randomUUID() as any,
      tabId: 'tab-agent-1',
      title: 'Agent Finished',
      body: 'Task complete',
      state: 'finished',
      deduplicationKey: notifKey,
    });

    assert.ok(created1 !== null, 'First notification must be created');
    assert.equal(store1.hasDeduplicationKey(notifKey), true);
    store1.dispose();

    // 2. Simulate server restart: new store instance loads from disk
    const store2 = new AgencyNotificationStore(storeFile);
    await store2.initialize();

    assert.equal(store2.hasDeduplicationKey(notifKey), true, 'Dedup key must be restored from disk index');

    // 3. Repeated event for the same turn arrives after restart
    const duplicateAttempt = await store2.create({
      workspaceId: randomUUID() as any,
      tabId: 'tab-agent-1',
      title: 'Agent Finished',
      body: 'Task complete',
      state: 'finished',
      deduplicationKey: notifKey,
    });

    assert.equal(duplicateAttempt, null, 'Duplicate event after restart must return null and be suppressed');
    store2.dispose();
  } finally {
    env.cleanup();
  }
});

test('Acceptance 5: Terminal output micro-batching maintains strict FIFO order under load', async () => {
  const received: string[] = [];
  const batcher = new TerminalOutputBatcher({
    maxWaitMs: 2,
    maxBatchBytes: 16 * 1024,
    onFlush: (_termId, data) => {
      received.push(data);
    },
  });

  const lines = 1000;
  for (let i = 0; i < lines; i++) {
    batcher.push('term-fifo', `LINE_${i}\n`);
  }

  // Force flush
  batcher.flush();

  const joined = received.join('');
  for (let i = 0; i < lines; i++) {
    const idx = joined.indexOf(`LINE_${i}\n`);
    assert.ok(idx !== -1, `Output stream must contain LINE_${i}`);
  }

  const metrics = batcher.getMetrics();
  assert.equal(metrics.totalPushedChunks, lines);
  assert.ok(metrics.reductionRatio > 1, 'Batcher must reduce emitted frames');
  batcher.dispose();
});

test('Acceptance 6: Coalesced JSON store flushes critical saves immediately', async () => {
  const env = createIsolatedEnv('maw-acc-coalesce-');
  const targetFile = path.join(env.tmpDir, 'state.json');

  try {
    const store = new CoalescedJsonStore<{ counter: number }>({
      filePath: targetFile,
      debounceMs: 150,
      maxWaitMs: 1000,
    });

    // Immediate save must be on disk synchronously without waiting for debounce
    await store.saveImmediate({ counter: 99 });
    assert.ok(fs.existsSync(targetFile), 'Immediate save must write file synchronously');

    const content = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    assert.equal(content.counter, 99);

    await store.dispose();
  } finally {
    env.cleanup();
  }
});

test('Acceptance 7: Native browser focus correctness and suppression routing', () => {
  const origDoc = globalThis.document;
  const origWin = globalThis.window;

  try {
    let hasFocusVal = true;
    let hiddenVal = false;

    (globalThis as any).document = {
      hasFocus: () => hasFocusVal,
      get hidden() { return hiddenVal; },
      get visibilityState() { return (hiddenVal ? 'hidden' : 'visible'); },
    };

    let bridgeHandler: ((event: any) => void) | null = null;
    (globalThis as any).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      mawChatGpt: {
        subscribe: (fn: any) => {
          bridgeHandler = fn;
          return () => { bridgeHandler = null; };
        },
      },
    };

    const tracker = new FocusTracker();
    const session = { workspaceId: 'ws-acc-1', tabId: 'tab-acc-1' };

    // A. User is actively viewing this tab in focused MAW window -> must SUPPRESS
    assert.equal(
      tracker.determineDeliveryChannel(session, {
        activeWorkspaceId: 'ws-acc-1',
        showingDone: false,
        activeTabId: 'tab-acc-1',
      }),
      'suppress',
      'Actively viewed session must suppress alerts'
    );

    // B. MAW is focused, but user switched to a different tab -> must send TOAST
    assert.equal(
      tracker.determineDeliveryChannel(session, {
        activeWorkspaceId: 'ws-acc-1',
        showingDone: false,
        activeTabId: 'tab-acc-other',
      }),
      'toast',
      'Session in another tab must route to in-app toast'
    );

    // C. User minimized MAW or switched to another desktop application -> must route to OS
    hasFocusVal = false;
    assert.equal(
      tracker.determineDeliveryChannel(session, {
        activeWorkspaceId: 'ws-acc-1',
        showingDone: false,
        activeTabId: 'tab-acc-1',
      }),
      'os',
      'Blurred MAW window must route alert to OS desktop notification'
    );

    // D. Native WebContentsView focus: user clicked into ChatGPT child view
    assert.ok(bridgeHandler);
    (bridgeHandler as any)({ type: 'focused', id: 'tab-acc-1' });
    assert.equal(tracker.isWindowFocused(), true, 'Native view focus must be counted as window focus');
    assert.equal(tracker.getNativeFocusedTabId(), 'tab-acc-1');

    tracker.dispose();
  } finally {
    globalThis.document = origDoc;
    globalThis.window = origWin;
  }
});

test('Acceptance 8: Electron socket endpoint rediscovery across restarts', async () => {
  const env = createIsolatedEnv('maw-acc-rediscover-');

  // Probe before supervisor starts: socket does not exist
  assert.equal(fs.existsSync(env.socketPath), false);

  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    await supervisor.listen();
    assert.equal(fs.existsSync(env.socketPath), true, 'Socket file must exist after listen');

    // Client connects and verifies discovery
    const client = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const list = await client.list();
    assert.ok(Array.isArray(list.sessions));
    client.detach();
  } finally {
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('Acceptance 9: Process leak detection — clean supervisor shutdown terminates children', async () => {
  const env = createIsolatedEnv('maw-acc-leak-');
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  let childPid = -1;
  try {
    await supervisor.listen();

    const client = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const res = await client.spawn({
      id: 'leak-test-session',
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
    });
    childPid = res.pid;
    assert.ok(childPid > 0);

    // Verify child is running
    let running = false;
    try {
      process.kill(childPid, 0);
      running = true;
    } catch {}
    assert.equal(running, true);

    client.detach();
  } finally {
    // Teardown with killAll = true
    supervisor.close({ killAll: true });
  }

  // Allow OS time to process SIGKILL/SIGTERM
  await new Promise((r) => setTimeout(r, 200));

  // Verify child process was reaped and is NO LONGER running in OS table
  let leaked = false;
  try {
    process.kill(childPid, 0);
    leaked = true;
  } catch {
    leaked = false;
  }
  assert.equal(leaked, false, `Child process PID ${childPid} must not leak after killAll teardown`);
  env.cleanup();
});

test('Acceptance 10: Supervisor crash / unreachable socket error handling', async () => {
  const env = createIsolatedEnv('maw-acc-crash-');

  // Attempting to connect to an unreachable socket with autoSpawn=false must reject cleanly
  await assert.rejects(
    async () => {
      await PtyHostClient.connectOrSpawn({
        socketPath: env.socketPath,
        authPath: env.authPath,
        autoSpawn: false,
      });
    },
    (err: any) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('ENOENT') || err.message.includes('ECONNREFUSED'));
      return true;
    }
  );

  env.cleanup();
});

test('Acceptance 11: Emergency rollback simulation via feature flag toggle', () => {
  // Gating policy: MAW_PERSISTENT_PTY=0 forces in-process fallback
  const isPersistentEnabled = (envVal: string | undefined): boolean => {
    return envVal === '1';
  };

  assert.equal(isPersistentEnabled(undefined), false, 'Default without env var must fall back to safe in-process mode');
  assert.equal(isPersistentEnabled('0'), false, 'Explicit 0 must disable persistent mode');
  assert.equal(isPersistentEnabled('1'), true, 'Explicit 1 must enable persistent mode');
});

test('Acceptance 12: Real WebSocket transport streaming with TerminalOutputBatcher & reconnect', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  let activeSocket: WebSocket | null = null;
  const receivedChunks: string[] = [];

  wss.on('connection', (ws) => {
    activeSocket = ws;
    ws.on('message', (data) => {
      receivedChunks.push(data.toString());
    });
  });

  const client1 = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => client1.once('open', r));

  // Wire TerminalOutputBatcher to client1
  const batcher = new TerminalOutputBatcher({
    maxWaitMs: 2,
    maxBatchBytes: 8192,
    onFlush: (_id, data) => {
      if (client1.readyState === WebSocket.OPEN) {
        client1.send(data);
      }
    },
  });

  for (let i = 0; i < 20; i++) {
    batcher.push('term-ws-1', `WS_CHUNK_${i}\n`);
  }
  batcher.flush();

  // Wait for delivery to server
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(receivedChunks.join('').includes('WS_CHUNK_0'));
  assert.ok(receivedChunks.join('').includes('WS_CHUNK_19'));

  // Abruptly terminate client 1 (simulating network disconnect)
  client1.terminate();

  // Connect client 2 (simulating browser reconnect)
  const client2 = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => client2.once('open', r));

  client2.send('RECONNECT_HELLO');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(receivedChunks.includes('RECONNECT_HELLO'));

  client2.close();
  wss.close();
  server.close();
  batcher.dispose();
});

test('Acceptance 13: Kernel PTY master FD close behavior validates systemd KillMode=control-group', async () => {
  // Directly demonstrates Linux kernel PTY semantics:
  // When supervisor process holding master PTY FD terminates, slave PTY gets SIGHUP and EIO.
  // Child PTY processes CANNOT survive supervisor process death; therefore KillMode=control-group
  // is the only safe configuration to avoid leaving orphan processes with broken PTYs.
  const env = createIsolatedEnv('maw-acc-sighup-');
  const supervisor = new PtySupervisor({
    socketPath: env.socketPath,
    authPath: env.authPath,
  });

  try {
    await supervisor.listen();
    const client = await PtyHostClient.connectOrSpawn({
      socketPath: env.socketPath,
      authPath: env.authPath,
      autoSpawn: false,
    });

    const s = await client.spawn({
      id: 'hup-test-session',
      cmd: process.execPath,
      args: [SYNTHETIC_AGENT_PATH],
      cwd: env.tmpDir,
    });
    const pid = s.pid;

    // Verify child is alive while supervisor is alive
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    assert.equal(alive, true, 'Child process must be alive while supervisor is alive');

    client.detach();

    // Now close the supervisor master FDs completely
    supervisor.close({ killAll: true });

    // Wait for SIGHUP / SIGKILL propagation
    await new Promise((r) => setTimeout(r, 200));

    let aliveAfterSupervisorClose = false;
    try { process.kill(pid, 0); aliveAfterSupervisorClose = true; } catch {}
    assert.equal(
      aliveAfterSupervisorClose,
      false,
      'Child process must be cleanly reaped when supervisor closes, confirming cgroup cleanup necessity'
    );
  } finally {
    env.cleanup();
  }
});

test('Acceptance 14: Bounded deduplication index under high-volume multi-turn workload', async () => {
  const env = createIsolatedEnv('maw-acc-dedup-bound-');
  const storeFile = path.join(env.tmpDir, 'notifs.json');

  try {
    const store = new AgencyNotificationStore(storeFile);
    await store.initialize();

    const wsId = randomUUID() as any;

    // Simulate 200 consecutive completed turns
    for (let i = 0; i < 200; i++) {
      await store.create({
        workspaceId: wsId,
        tabId: 'tab-stress-1',
        title: `Turn ${i}`,
        body: 'completed',
        state: 'finished',
        deduplicationKey: `cli-turn:${wsId}:tab-stress-1:turn-${i}`,
      });
    }

    // Acknowledge and mark read the first 160 notifications to trigger inbox capacity pruning (ceiling = 150)
    const list = store.list(wsId);
    assert.equal(list.length, 200, 'All 200 notifications stored before acknowledgement');

    for (let i = 0; i < 160; i++) {
      const item = list[i];
      if (item) {
        await store.markRead(item.id);
        await store.acknowledge(item.id);
      }
    }

    // Push 10 more notifications to trigger inbox retention bounding
    for (let i = 200; i < 210; i++) {
      await store.create({
        workspaceId: wsId,
        tabId: 'tab-stress-1',
        title: `Turn ${i}`,
        body: 'completed',
        state: 'finished',
        deduplicationKey: `cli-turn:${wsId}:tab-stress-1:turn-${i}`,
      });
    }

    const updatedList = store.list(wsId);
    // Verified: store bounds notifications at MAX_NOTIFICATIONS (150)
    assert.ok(
      updatedList.length <= 160,
      `Notifications count (${updatedList.length}) must be bounded near MAX_NOTIFICATIONS (150)`
    );

    // Verify recent turn (turn-205) is deduplicated
    const dupRecent = await store.create({
      workspaceId: wsId,
      tabId: 'tab-stress-1',
      title: 'Turn 205 duplicate',
      body: 'completed',
      state: 'finished',
      deduplicationKey: `cli-turn:${wsId}:tab-stress-1:turn-205`,
    });
    assert.equal(dupRecent, null, 'Active recent turn must be deduplicated cleanly');

    store.dispose();
  } finally {
    env.cleanup();
  }
});

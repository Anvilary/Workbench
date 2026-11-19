import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
// @ts-expect-error - standalone pure-ESM supervisor script
import { PtySupervisor, SupervisorOutputBuffer } from '../../../src/pty-host/maw-ptyd.mjs';
import { PtyHostClient } from '../../../src/pty-host/pty-host-client.js';
import { MAX_PAYLOAD_SIZE, PTY_PROTOCOL_VERSION } from '../../../src/pty-host/pty-host-types.js';

test('P0 D-01: maw-ptyd chunks oversize replay_data frames and PtyHostClient reassembles cleanly', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-d01-chunk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const socketPath = path.join(dir, 'ptyd.sock');
  const authPath = path.join(dir, 'ptyd.auth');
  const supervisor = new PtySupervisor({ socketPath, authPath, killChildrenOnExit: true });
  const { tokenHex } = await supervisor.listen();
  t.after(() => supervisor.close({ killAll: true }));

  const client = await PtyHostClient.connectOrSpawn({
    socketPath,
    authPath,
    authToken: tokenHex,
    autoSpawn: false,
  });
  t.after(() => client.detach());

  await client.spawn({
    id: 'oversize-replay',
    cmd: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: dir,
    cols: 80,
    rows: 24,
  });

  // Construct a large screen snapshot + raw ring payload whose combined JSON exceeds 1 MiB.
  // Include multi-byte UTF-8 characters so chunk boundaries split across UTF-8 sequences.
  const hugeScreen = ('\x1b[38;5;196mhello-utf8-✓-🚀-\x1b[0m\r\n').repeat(30_000);
  assert.ok(Buffer.byteLength(JSON.stringify(hugeScreen), 'utf8') > MAX_PAYLOAD_SIZE);

  const session = supervisor.sessions.get('oversize-replay')!;
  assert.ok(session);
  session.buffer.push('ring-chunk-✓-αβγ-'.repeat(4000));
  const origSnapshot = session.buffer.state.snapshot.bind(session.buffer.state);
  session.buffer.state.snapshot = async () => ({
    data: hugeScreen,
    cols: 80,
    rows: 24,
  });
  t.after(() => {
    session.buffer.state.snapshot = origSnapshot;
  });

  // Verify every NDJSON frame emitted by supervisor stays strictly below MAX_PAYLOAD_SIZE.
  const rawFrameSizes: number[] = [];
  const origSendRaw = supervisor._sendRaw.bind(supervisor);
  supervisor._sendRaw = (sock: any, payload: string) => {
    rawFrameSizes.push(Buffer.byteLength(payload, 'utf8'));
    return origSendRaw(sock, payload);
  };

  const replayed = await client.replay('oversize-replay');
  assert.equal(replayed.reset, true);
  assert.equal(replayed.screen?.data, hugeScreen);
  assert.equal(replayed.screen?.cols, 80);
  assert.equal(replayed.screen?.rows, 24);
  assert.ok(replayed.data.includes('ring-chunk-✓-αβγ-'));
  assert.ok(rawFrameSizes.length > 1, `Expected multiple chunked frames, got ${rawFrameSizes.length}`);
  for (const frameSize of rawFrameSizes) {
    assert.ok(frameSize < MAX_PAYLOAD_SIZE, `Frame size ${frameSize} exceeded MAX_PAYLOAD_SIZE`);
  }
});

test('P0 D-01: PtyHostClient handles oversize frame without uncaught exception', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-d01-oversize-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const socketPath = path.join(dir, 'rogue.sock');
  const tokenHex = 'a'.repeat(64);
  const authPath = path.join(dir, 'rogue.auth');

  let uncaught: unknown = null;
  const onUncaught = (err: unknown) => { uncaught = err; };
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));

  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.op === 'hello') {
          socket.write(JSON.stringify({
            op: 'snapshot',
            reqId: msg.reqId,
            version: PTY_PROTOCOL_VERSION,
            pid: process.pid,
            sessions: [],
            tombstones: [],
          }) + '\n');
        } else if (msg.op === 'replay') {
          // Deliberately transmit an unchunked oversize line (> 1 MiB)
          const payload = 'X'.repeat(MAX_PAYLOAD_SIZE + 4096);
          socket.write(JSON.stringify({ op: 'replay_data', reqId: msg.reqId, dataB64: payload }) + '\n');
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const client = await PtyHostClient.connectOrSpawn({
    socketPath,
    authPath,
    authToken: tokenHex,
    autoSpawn: false,
  });
  t.after(() => client.detach());

  await assert.rejects(
    () => client.replay('any-session'),
    /maximum protocol line size/i,
  );
  // Allow event loop tick to confirm no uncaught exception was thrown
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(uncaught, null, 'Oversize frame must never crash via uncaughtException');
});

test('A-11/D-04: SupervisorOutputBuffer head-pointer eviction preserves offsets and slices', () => {
  const buf = new SupervisorOutputBuffer(100);
  try {
    for (let i = 0; i < 300; i++) {
      buf.push(`line-${String(i).padStart(3, '0')}\n`);
    }
    assert.equal(buf.truncated, true);
    assert.ok(buf.sizeBytes <= 100);
    assert.equal(buf.endOffset, 300 * 9);
    assert.equal(buf.startOffset, buf.endOffset - buf.sizeBytes);
    const full = buf.read();
    assert.equal(Buffer.byteLength(full, 'utf8'), buf.sizeBytes);

    const midOffset = buf.startOffset + 18;
    const sliced = buf.sliceFrom(midOffset);
    assert.equal(sliced.reset, false);
    assert.equal(Buffer.byteLength(sliced.data, 'utf8'), buf.endOffset - midOffset);
    assert.ok(full.endsWith(sliced.data));
  } finally {
    buf.state.dispose();
  }
});

test('A-11/D-04: tombstone cap, resize NaN/float rejection, duplicate kill timer cleanup, snapshot error recovery, and disconnected request timer cleanup', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-a11-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const socketPath = path.join(dir, 'ptyd.sock');
  const authPath = path.join(dir, 'ptyd.auth');
  const supervisor = new PtySupervisor({
    socketPath,
    authPath,
    maxTombstones: 3,
    killChildrenOnExit: true,
  });
  const { tokenHex } = await supervisor.listen();
  t.after(() => supervisor.close({ killAll: true }));

  const client = await PtyHostClient.connectOrSpawn({
    socketPath,
    authPath,
    authToken: tokenHex,
    autoSpawn: false,
  });
  t.after(() => client.detach());

  // 1. Tombstone cap: spawn 5 short-lived sessions and verify tombstones stay capped at 3
  // with oldest-exited tombstones evicted first.
  const exitOrder: string[] = [];
  const waitExits = new Promise<void>((resolve) => {
    client.onExit((ev) => {
      exitOrder.push(ev.id);
      if (exitOrder.length === 5) resolve();
    });
  });
  for (let i = 0; i < 5; i++) {
    await client.spawn({
      id: `short-${i}`,
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: dir,
      cols: 80,
      rows: 24,
    });
  }
  await waitExits;
  assert.equal(supervisor.tombstones.size, 3, 'Tombstones must be capped at maxTombstones');
  assert.equal(supervisor.tombstones.has(exitOrder[0]!), false);
  assert.equal(supervisor.tombstones.has(exitOrder[1]!), false);
  assert.equal(supervisor.tombstones.has(exitOrder[2]!), true);
  assert.equal(supervisor.tombstones.has(exitOrder[3]!), true);
  assert.equal(supervisor.tombstones.has(exitOrder[4]!), true);

  // 2. Spawn a live session for resize validation, snapshot error recovery, and duplicate kill
  await client.spawn({
    id: 'live-1',
    cmd: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: dir,
    cols: 80,
    rows: 24,
  });
  const liveSession = supervisor.sessions.get('live-1')!;
  assert.ok(liveSession);

  // Resize with NaN / float / negative must be rejected without mutating session cols/rows
  for (const [badCols, badRows] of [[NaN, 24], [80, NaN], [80.5, 24], [80, 24.2], [Infinity, 24], [-1, 24]] as const) {
    client.resize('live-1', badCols, badRows);
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(liveSession.cols, 80);
  assert.equal(liveSession.rows, 24);

  // 3. Snapshot error during replay must not hang reqId
  liveSession.buffer.push('fallback-raw-data');
  const origSnap = liveSession.buffer.state.snapshot.bind(liveSession.buffer.state);
  liveSession.buffer.state.snapshot = async () => {
    throw new Error('simulated snapshot failure');
  };
  const fallbackReplay = await client.replay('live-1');
  assert.equal(fallbackReplay.reset, true);
  assert.equal(fallbackReplay.screen, undefined);
  assert.ok(fallbackReplay.data.includes('fallback-raw-data'));
  liveSession.buffer.state.snapshot = origSnap;

  // 4. Duplicate kill must replace (not leak) killTimer
  await client.kill('live-1', 'SIGCONT'); // non-terminating signal
  const firstTimer = liveSession.killTimer;
  assert.ok(firstTimer !== null);
  await client.kill('live-1', 'SIGTERM');
  const secondTimer = liveSession.killTimer;
  assert.notEqual(secondTimer, firstTimer);

  // Wait for live-1 to exit cleanly
  await new Promise<void>((resolve) => {
    const off = client.onExit((ev) => {
      if (ev.id === 'live-1') {
        off();
        resolve();
      }
    });
    if (!supervisor.sessions.has('live-1')) {
      off();
      resolve();
    }
  });
  assert.equal(liveSession.killTimer, null);

  // 5. Request on disconnected client must reject immediately via _rawSend and clean up timer
  const disconnected = new Promise<void>((resolve) => {
    client.onDisconnect(() => resolve());
  });
  client.detach();
  await disconnected;
  await assert.rejects(() => client.list(), /socket is not connected/);
  assert.equal((client as any).pendingRequests.size, 0);
});

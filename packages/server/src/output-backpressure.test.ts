import assert from 'node:assert/strict';
import test from 'node:test';
import type { TerminalId } from '@agent-workbench/shared';
import { OutputBackpressure } from './output-backpressure.js';

const T1 = 't1' as TerminalId, T2 = 't2' as TerminalId;

test('N-3: output stops queuing above high water and resyncs skipped terminals once drained', async () => {
  const socket = { bufferedAmount: 0, readyState: 1, OPEN: 1 };
  const resynced: TerminalId[][] = [];
  const bp = new OutputBackpressure(socket, ids => resynced.push([...ids]), 100, 10, 5);
  assert.equal(bp.shouldSend(T1), true);
  socket.bufferedAmount = 101;
  assert.equal(bp.shouldSend(T1), false, 'over high water: skipped');
  assert.equal(bp.shouldSend(T2), false);
  socket.bufferedAmount = 50;
  assert.equal(bp.shouldSend(T1), false, 'once lagging, stays skipped until resync (no partial interleave)');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(resynced, [], 'not drained below low water yet');
  socket.bufferedAmount = 5;
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(resynced, [[T1, T2]]);
  assert.equal(bp.shouldSend(T1), true, 'normal streaming after resync');
  bp.dispose();
});

test('N-3: a detached terminal is never resynced; a closed socket stops the timer without resync', async () => {
  const socket = { bufferedAmount: 1000, readyState: 1, OPEN: 1 };
  const resynced: TerminalId[][] = [];
  const bp = new OutputBackpressure(socket, ids => resynced.push([...ids]), 100, 10, 5);
  bp.shouldSend(T1); bp.shouldSend(T2);
  bp.forget(T2);
  socket.bufferedAmount = 0;
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(resynced, [[T1]]);
  bp.shouldSend(T1);   // fine now
  socket.bufferedAmount = 1000; bp.shouldSend(T1);
  socket.readyState = 3;
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(resynced, [[T1]], 'no resync onto a closed socket');
  assert.equal(bp.isLagging(T1), false);
});

test('forgetting the final lagging terminal releases the recovery timer immediately', () => {
  const socket = { bufferedAmount: 1000, readyState: 1, OPEN: 1 };
  const bp = new OutputBackpressure(socket, () => assert.fail('Revoked terminals cannot recover'), 100, 10, 5);
  try {
    assert.equal(bp.shouldSend(T1), false);
    assert.ok((bp as any).timer);
    bp.forget(T1);
    assert.equal((bp as any).timer, null);
    assert.equal(bp.isLagging(T1), false);
  } finally { bp.dispose(); }
});

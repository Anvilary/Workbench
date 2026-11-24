import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalOutputBatcher } from '../../../src/transport/websocket/terminal-output-batcher.js';
import type { TerminalId } from '@agent-workbench/shared';

const tId = (id: string) => id as TerminalId;

test('TerminalOutputBatcher: flushes after timer elapsed for single chunk', async () => {
  const flushed: Array<{ id: TerminalId; data: string }> = [];
  const batcher = new TerminalOutputBatcher({
    maxWaitMs: 5,
    onFlush: (id, data) => flushed.push({ id, data }),
  });

  batcher.push(tId('term-1'), 'hello world');
  assert.equal(flushed.length, 0, 'Should not flush immediately');

  await new Promise((r) => setTimeout(r, 15));
  assert.equal(flushed.length, 1);
  const f0 = flushed[0];
  assert.ok(f0);
  assert.equal(f0.id, 'term-1');
  assert.equal(f0.data, 'hello world');

  batcher.dispose();
});

test('TerminalOutputBatcher: coalesces multiple rapid chunks into a single frame with FIFO order', async () => {
  const flushed: Array<{ id: TerminalId; data: string }> = [];
  const batcher = new TerminalOutputBatcher({
    maxWaitMs: 10,
    onFlush: (id, data) => flushed.push({ id, data }),
  });

  batcher.push(tId('term-1'), 'chunk-1;');
  batcher.push(tId('term-1'), 'chunk-2;');
  batcher.push(tId('term-1'), 'chunk-3;');

  assert.equal(flushed.length, 0);

  await new Promise((r) => setTimeout(r, 20));

  assert.equal(flushed.length, 1);
  const f0 = flushed[0];
  assert.ok(f0);
  assert.equal(f0.data, 'chunk-1;chunk-2;chunk-3;');

  const metrics = batcher.getMetrics();
  assert.equal(metrics.totalPushedChunks, 3);
  assert.equal(metrics.totalFlushedFrames, 1);
  assert.equal(metrics.reductionRatio, 3.0);

  batcher.dispose();
});

test('TerminalOutputBatcher: flushes immediately when byte threshold is exceeded', () => {
  const flushed: Array<{ id: TerminalId; data: string }> = [];
  const batcher = new TerminalOutputBatcher({
    maxWaitMs: 50,
    maxBatchBytes: 100, // Small threshold for testing
    onFlush: (id, data) => flushed.push({ id, data }),
  });

  const chunk60 = 'a'.repeat(60);
  batcher.push(tId('term-1'), chunk60);
  assert.equal(flushed.length, 0, '60 bytes < 100 bytes, wait for timer');

  const chunk50 = 'b'.repeat(50);
  batcher.push(tId('term-1'), chunk50); // 60 + 50 = 110 >= 100
  assert.equal(flushed.length, 1, 'Should flush immediately upon exceeding maxBatchBytes');
  const f0 = flushed[0];
  assert.ok(f0);
  assert.equal(f0.data, chunk60 + chunk50);

  const metrics = batcher.getMetrics();
  assert.equal(metrics.immediateByteFlushes, 1);

  batcher.dispose();
});

test('TerminalOutputBatcher: isolates multiple terminals independently', async () => {
  const flushed: Array<{ id: TerminalId; data: string }> = [];
  const batcher = new TerminalOutputBatcher({
    maxWaitMs: 5,
    onFlush: (id, data) => flushed.push({ id, data }),
  });

  batcher.push(tId('term-1'), 't1-data');
  batcher.push(tId('term-2'), 't2-data');

  assert.equal(batcher.pendingBytes(tId('term-1')), 7);
  assert.equal(batcher.pendingBytes(tId('term-2')), 7);

  // Manually flush term-1
  batcher.flush(tId('term-1'));
  assert.equal(flushed.length, 1);
  const f0 = flushed[0];
  assert.ok(f0);
  assert.equal(f0.id, 'term-1');
  assert.equal(batcher.hasPending(tId('term-1')), false);
  assert.equal(batcher.hasPending(tId('term-2')), true);

  await new Promise((r) => setTimeout(r, 15));
  assert.equal(flushed.length, 2);
  const f1 = flushed[1];
  assert.ok(f1);
  assert.equal(f1.id, 'term-2');
  assert.equal(batcher.hasPending(tId('term-2')), false);

  batcher.dispose();
});

test('TerminalOutputBatcher: clear() discards pending buffer without flushing', async () => {
  const flushed: Array<{ id: TerminalId; data: string }> = [];
  const batcher = new TerminalOutputBatcher({
    maxWaitMs: 10,
    onFlush: (id, data) => flushed.push({ id, data }),
  });

  batcher.push(tId('term-1'), 'to be cleared');
  assert.equal(batcher.hasPending(tId('term-1')), true);

  batcher.clear(tId('term-1'));
  assert.equal(batcher.hasPending(tId('term-1')), false);

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(flushed.length, 0, 'No flush should have occurred');

  batcher.dispose();
});

test('TerminalOutputBatcher: preserves and repairs split ANSI and UTF-8 multi-byte sequences', async () => {
  const flushed: Array<{ id: TerminalId; data: string }> = [];
  const batcher = new TerminalOutputBatcher({
    maxWaitMs: 10,
    onFlush: (id, data) => flushed.push({ id, data }),
  });

  // ANSI RGB color code split across 3 chunks
  batcher.push(tId('term-1'), '\x1b[38;2;');
  batcher.push(tId('term-1'), '255;128;');
  batcher.push(tId('term-1'), '0mColored Text\x1b[0m\n');

  // UTF-8 emoji split or multi-character string
  batcher.push(tId('term-1'), '🚀 Rocket: ');
  batcher.push(tId('term-1'), 'Status OK\n');

  batcher.flush(tId('term-1'));

  assert.equal(flushed.length, 1);
  const f0 = flushed[0];
  assert.ok(f0);
  assert.equal(
    f0.data,
    '\x1b[38;2;255;128;0mColored Text\x1b[0m\n🚀 Rocket: Status OK\n',
  );

  batcher.dispose();
});

test('TerminalOutputBatcher: high-throughput flood benchmark assertion', () => {
  const flushed: Array<{ id: TerminalId; data: string }> = [];
  const batcher = new TerminalOutputBatcher({
    maxWaitMs: 2,
    maxBatchBytes: 64 * 1024,
    onFlush: (id, data) => flushed.push({ id, data }),
  });

  const totalLines = 10_000;
  const lineChunk = 'line: 0123456789abcdef0123456789abcdef0123456789abcdef\n'; // 56 bytes

  // Warm up V8 JIT outside the timed measurement so shared CI runners do not
  // include initial compilation overhead in the 10k-line throughput window.
  const warmup = new TerminalOutputBatcher({
    maxWaitMs: 2,
    maxBatchBytes: 64 * 1024,
    onFlush: () => {},
  });
  for (let i = 0; i < 2_000; i++) {
    warmup.push(tId('term-warmup'), lineChunk);
  }
  warmup.dispose();

  const start = performance.now();
  for (let i = 0; i < totalLines; i++) {
    batcher.push(tId('term-1'), lineChunk);
  }
  batcher.flush(tId('term-1'));
  const duration = performance.now() - start;

  const totalBytes = totalLines * lineChunk.length; // 560,000 bytes (~546 KiB)
  const metrics = batcher.getMetrics();

  // Assert frame reduction: 10,000 chunks batched into <= 15 frames!
  assert.ok(
    metrics.totalFlushedFrames <= 15,
    `Expected <= 15 frames for 10k chunks, got ${metrics.totalFlushedFrames}`,
  );
  assert.ok(
    metrics.reductionRatio >= 500,
    `Expected >= 500x reduction ratio, got ${metrics.reductionRatio}`,
  );

  // Assert throughput (> 500,000 lines/sec)
  const linesPerSec = (totalLines / duration) * 1000;
  assert.ok(linesPerSec > 500_000, `Expected > 500k lines/s, got ${Math.round(linesPerSec)}`);

  // Assert data integrity: total characters flushed matches input
  const totalFlushedChars = flushed.reduce((sum, f) => sum + f.data.length, 0);
  assert.equal(totalFlushedChars, totalBytes);

  batcher.dispose();
});

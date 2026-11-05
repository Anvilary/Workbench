import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TerminalHistoryStore } from './terminal-history-store.js';

test('Disk Retention and Recovery: Quotas, Active Segment Protection, Memory Bounded Queue, and Fault Resilience', async (t) => {
  const baseDir = path.join(tmpdir(), `maw-retention-test-${randomUUID()}`);
  await mkdir(baseDir, { recursive: true });
  t.after(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, {
    baseDir,
    maxSegmentLines: 50,
    maxQueueBytes: 10 * 1024, // 10 KB cap for test verification
    retentionPolicy: {
      maxTotalLines: 120, // Max 120 lines total
    },
  });
  t.after(async () => {
    await store.dispose();
  });

  // 1. Write 200 lines across 4 segments (50 lines per segment)
  for (let i = 0; i < 200; i++) {
    store.push(`line-${String(i).padStart(4, '0')}\n`);
  }
  await store.flush();

  // Pruning during flush should have enforced maxTotalLines = 120
  // With 50 lines per segment, pruning oldest segments leaves segments 2 and 3 (100 lines) or similar <= 120 lines
  assert.ok(store.totalLines <= 120, `totalLines must be <= 120, got ${store.totalLines}`);
  assert.ok(store.prunedLines > 0, `prunedLines must be > 0, got ${store.prunedLines}`);
  assert.equal(store.totalLines + store.prunedLines, 200, 'Sum of remaining + pruned lines must equal total produced');

  // Verify that active segment (seg-3.bin) is still present
  const files = await readdir(path.join(baseDir, terminalId));
  const segmentFiles = files.filter((f) => f.startsWith('seg-') && f.endsWith('.bin'));
  assert.ok(segmentFiles.includes('seg-3.bin'), 'Active latest segment must never be pruned');

  // 2. Active Session Protection: verify that even with an extreme quota of 1 line,
  // the active segment is never pruned while the session is alive.
  const pruneExtreme = await store.prune({ maxTotalLines: 1 });
  assert.ok(pruneExtreme.remainingSegments >= 1, 'Store must always retain at least 1 segment (the active segment)');
  assert.ok(store.totalLines > 0, 'Active segment lines must remain intact');

  // 3. Backpressure and Memory Queue Cap Verification
  // Push 50 KB of data into a store with 10 KB maxQueueBytes without flushing
  const floodStore = new TerminalHistoryStore(randomUUID(), {
    baseDir,
    maxQueueBytes: 10 * 1024, // 10 KB hard cap
  });
  t.after(async () => {
    await floodStore.dispose();
  });

  const bigChunk = 'x'.repeat(2048) + '\n'; // 2 KB chunk
  for (let i = 0; i < 25; i++) { // 25 * 2 KB = 50 KB total
    floodStore.push(bigChunk);
  }

  // Verify memory queue bytes remained strictly <= 10 KB
  assert.ok(floodStore.pendingQueueBytes <= 10 * 1024, `queueBytes (${floodStore.pendingQueueBytes}) must be <= 10 KB cap`);

  // Flush remaining buffer
  await floodStore.flush();

  // 4. Fault Resilience and Crash Recovery: verify index.json validity
  const indexPath = path.join(baseDir, terminalId, 'index.json');
  const indexContent = await readFile(indexPath, 'utf8');
  const parsedIndex = JSON.parse(indexContent);
  assert.equal(parsedIndex.terminalId, terminalId);
  assert.equal(parsedIndex.version, 1);
  assert.ok(Array.isArray(parsedIndex.segments));
  assert.equal(typeof parsedIndex.totalLines, 'number');
});

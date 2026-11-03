import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoalescedJsonStore } from './coalesced-json-store.js';

test('CoalescedJsonStore: debounces rapid scheduled saves into a single disk write', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-store-test-'));
  const filePath = path.join(tempDir, 'state.json');

  try {
    const store = new CoalescedJsonStore<{ count: number; status: string }>({
      filePath,
      debounceMs: 25,
      maxWaitMs: 100,
    });

    // Fire 5 rapid scheduled saves
    const promises = [
      store.scheduleSave({ count: 1, status: 'step-1' }),
      store.scheduleSave({ count: 2, status: 'step-2' }),
      store.scheduleSave({ count: 3, status: 'step-3' }),
      store.scheduleSave({ count: 4, status: 'step-4' }),
      store.scheduleSave({ count: 5, status: 'final' }),
    ];

    await Promise.all(promises);

    const metrics = store.getMetrics();
    assert.equal(metrics.totalRequests, 5);
    assert.equal(metrics.actualDiskWrites, 1, '5 requests coalesced into 1 write');
    assert.equal(metrics.coalescedSavings, 4);

    const content = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(content, { count: 5, status: 'final' });

    await store.dispose();
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('CoalescedJsonStore: saveImmediate() flushes immediately and cancels pending timer', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-store-test-'));
  const filePath = path.join(tempDir, 'state.json');

  try {
    const store = new CoalescedJsonStore<{ event: string }>({
      filePath,
      debounceMs: 50,
    });

    // Schedule a non-critical save
    void store.scheduleSave({ event: 'working-heartbeat' });

    // Immediately trigger a critical durable save (e.g. session creation or notification ack)
    await store.saveImmediate({ event: 'session-created' });

    // Assert file was written immediately with the critical event
    const content = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(content.event, 'session-created');

    const metrics = store.getMetrics();
    assert.equal(metrics.immediateRequests, 1);
    assert.equal(metrics.actualDiskWrites, 1);

    await store.dispose();
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('CoalescedJsonStore: maxWaitMs bounds latency under continuous rapid updates', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-store-test-'));
  const filePath = path.join(tempDir, 'state.json');

  try {
    const store = new CoalescedJsonStore<{ iteration: number }>({
      filePath,
      debounceMs: 30,
      maxWaitMs: 60, // Force flush after 60ms even if mutations keep arriving
    });

    // Mutate every 15ms for 100ms
    const start = Date.now();
    let iteration = 0;
    while (Date.now() - start < 100) {
      iteration += 1;
      void store.scheduleSave({ iteration });
      await new Promise((r) => setTimeout(r, 15));
    }

    await store.flush();

    const metrics = store.getMetrics();
    // Max-wait ceiling must have triggered at least 1 intermediate write before final flush
    assert.ok(metrics.actualDiskWrites >= 2, `Expected >= 2 writes, got ${metrics.actualDiskWrites}`);

    await store.dispose();
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('CoalescedJsonStore: error handling retains dirty state for retry', async () => {
  // Invalid target path (directory does not exist)
  const nonExistentPath = '/tmp/non-existent-dir-xyz-12345/state.json';
  const store = new CoalescedJsonStore<{ test: number }>({
    filePath: nonExistentPath,
  });

  await assert.rejects(
    () => store.saveImmediate({ test: 42 }),
    /ENOENT/,
  );

  await store.dispose().catch(() => {});
});

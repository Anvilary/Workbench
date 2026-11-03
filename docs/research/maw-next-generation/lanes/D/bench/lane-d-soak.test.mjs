import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../..');
const serverRoot = path.join(repoRoot, 'packages/server');
const bundlePath = path.join(serverRoot, 'dist/index.mjs');

const { TerminalOutputBatcher } = await import(path.join(serverRoot, 'src/terminal-output-batcher.ts'));
const { CoalescedJsonStore } = await import(path.join(serverRoot, 'src/coalesced-json-store.ts'));

test('Soak & Stress: 10 concurrent terminals pumping parallel output streams', async () => {
  const terminalCount = 10;
  const linesPerTerm = 2_000;
  const chunkText = 'parallel-stream-data-payload-1234567890\n';

  const received = new Map();
  for (let i = 0; i < terminalCount; i++) {
    received.set(`term-${i}`, []);
  }

  const batcher = new TerminalOutputBatcher({
    maxWaitMs: 2,
    maxBatchBytes: 32 * 1024,
    onFlush: (id, data) => {
      received.get(id)?.push(data);
    },
  });

  // Pump all 10 terminals simultaneously
  const promises = [];
  for (let i = 0; i < terminalCount; i++) {
    const termId = `term-${i}`;
    promises.push(
      (async () => {
        for (let line = 0; line < linesPerTerm; line++) {
          batcher.push(termId, `[${termId}:${line}] ${chunkText}`);
          if (line % 500 === 0) {
            await new Promise((r) => setTimeout(r, 1));
          }
        }
      })(),
    );
  }

  await Promise.all(promises);
  batcher.flush();

  // Verify each terminal received all lines with strict FIFO order
  for (let i = 0; i < terminalCount; i++) {
    const termId = `term-${i}`;
    const allData = (received.get(termId) || []).join('');
    const lineMatches = allData.match(new RegExp(`\\[${termId}:(\\d+)\\]`, 'g')) || [];
    assert.equal(
      lineMatches.length,
      linesPerTerm,
      `Terminal ${termId} should receive exactly ${linesPerTerm} lines`,
    );

    // Verify ordering
    let lastIndex = -1;
    for (const match of lineMatches) {
      const numMatch = match.match(/:(\d+)\]/);
      const idx = Number(numMatch && numMatch[1] ? numMatch[1] : -1);
      assert.equal(idx, lastIndex + 1, `Ordering must be sequential for ${termId}`);
      lastIndex = idx;
    }
  }

  const metrics = batcher.getMetrics();
  assert.ok(metrics.reductionRatio >= 10, `Expected >= 10x frame reduction, got ${metrics.reductionRatio}`);
  batcher.dispose();
});

test('Soak & Stress: 50,000-line massive output flood bounds memory and batches frames', () => {
  const totalLines = 50_000;
  const lineChunk = 'flood-line: ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n'; // 48 bytes
  const totalBytesExpected = totalLines * lineChunk.length; // ~2.4 MB

  let flushedFrames = 0;
  let totalCharsFlushed = 0;

  const batcher = new TerminalOutputBatcher({
    maxWaitMs: 2,
    maxBatchBytes: 64 * 1024,
    onFlush: (id, data) => {
      flushedFrames += 1;
      totalCharsFlushed += data.length;
      assert.ok(
        data.length <= 64 * 1024 + 1024,
        `Flushed frame size (${data.length}) should not exceed bounded ceiling`,
      );
    },
  });

  const start = performance.now();
  for (let i = 0; i < totalLines; i++) {
    batcher.push('term-flood', lineChunk);
  }
  batcher.flush('term-flood');
  const duration = performance.now() - start;

  assert.equal(totalCharsFlushed, totalBytesExpected, 'Zero bytes lost during massive flood');
  assert.ok(
    flushedFrames <= 60,
    `Expected <= 60 frames for 50k lines, got ${flushedFrames}`,
  );

  const throughputMiB = (totalBytesExpected / (1024 * 1024)) / (duration / 1000);
  assert.ok(throughputMiB >= 15.0, `Expected >= 15 MiB/s throughput, got ${throughputMiB.toFixed(2)}`);

  batcher.dispose();
});

test('Soak: 25 rapid tab open/close cycles clean up all internal queues and state', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'maw-soak-tabs-'));
  const filePath = path.join(tempDir, 'state.json');

  try {
    const store = new CoalescedJsonStore({
      filePath,
      debounceMs: 15,
      maxWaitMs: 50,
    });

    const batcher = new TerminalOutputBatcher({
      maxWaitMs: 5,
      onFlush: () => {},
    });

    for (let cycle = 0; cycle < 25; cycle++) {
      const tabId = `tab-cycle-${cycle}`;
      // Open tab -> critical immediate save
      await store.saveImmediate({ action: 'open', tabId, ts: Date.now() });

      // Simulate output burst
      batcher.push(tabId, 'initial tab output\n');
      batcher.push(tabId, 'more output\n');

      // Intermediate status update -> scheduled debounced save
      void store.scheduleSave({ action: 'working', tabId, ts: Date.now() });

      // Close tab -> clear batcher and critical immediate save
      batcher.clear(tabId);
      assert.equal(batcher.hasPending(tabId), false, 'Tab buffer should be empty after clear');
      await store.saveImmediate({ action: 'close', tabId, ts: Date.now() });
    }

    await store.flush();
    const metrics = store.getMetrics();
    assert.equal(metrics.immediateRequests, 50); // 25 opens + 25 closes

    await store.dispose();
    batcher.dispose();
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('Soak & Lifecycle: disposable server starts, stops, and restarts cleanly in same environment', async () => {
  const tempHome = await mkdtemp(path.join(tmpdir(), 'maw-soak-restart-'));

  try {
    const env = {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      XDG_DATA_HOME: path.join(tempHome, '.local/share'),
      AGENT_WORKBENCH_NO_OPEN: '1',
      AGENT_WORKBENCH_NO_RESTORE: '1',
      MAW_EAGER_CLASSIC: '0',
    };

    const spawnServer = () => {
      const child = spawn(process.execPath, [bundlePath, '--prod'], {
        cwd: serverRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Timeout starting server'));
        }, 15000);

        const onData = (chunk) => {
          output += chunk.toString();
          const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s]+)/);
          if (match && match[1] && match[2]) {
            clearTimeout(timeout);
            resolve({ port: Number(match[1]), token: match[2], pid: child.pid });
          }
        };

        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        });
      });

      return { child, ready };
    };

    // 1. First run
    const s1 = spawnServer();
    const r1 = await s1.ready;
    assert.ok(r1.port > 0);
    s1.child.kill('SIGTERM');
    await new Promise((r) => s1.child.on('exit', r));

    // 2. Second run in same directory (restarting)
    const s2 = spawnServer();
    const r2 = await s2.ready;
    assert.ok(r2.port > 0);
    s2.child.kill('SIGTERM');
    await new Promise((r) => s2.child.on('exit', r));
  } finally {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  }
});

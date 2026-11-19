// Run with the server's tsx loader. The same workload measures enqueue and checkpoint completion.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { OutputBuffer as CurrentOutputBuffer } from '../../packages/server/src/output-buffer.ts';

const { OutputBuffer } = process.env.MAW_OUTPUT_BUFFER_MODULE
  ? await import(process.env.MAW_OUTPUT_BUFFER_MODULE)
  : { OutputBuffer: CurrentOutputBuffer };
const totalBytes = Number(process.env.TOTAL_MIB ?? 16) * 1024 * 1024;
const repetitions = Number(process.env.REPS ?? 3);
assert.ok(Number.isInteger(repetitions) && repetitions > 0 && Number.isFinite(totalBytes) && totalBytes >= 65536);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function run(chunkBytes, bytesBudget = totalBytes) {
  assert.ok(chunkBytes >= 2);
  const buffer = new OutputBuffer();
  const marker = 'checkpoint-end';
  const chunk = 'x'.repeat(chunkBytes - 2) + '\r\n';
  const chunks = Math.max(1, Math.floor(bytesBudget / chunkBytes));
  try {
    const started = performance.now();
    for (let index = 0; index < chunks; index++) buffer.push(chunk);
    const enqueued = performance.now();
    buffer.push(marker);
    const checkpoint = await buffer.checkpoint();
    assert.equal(buffer.endOffset, chunks * chunkBytes + marker.length);
    assert.ok(checkpoint.data.includes(marker));
    return { enqueueMs: enqueued - started, completionMs: performance.now() - started, chunks };
  } finally {
    buffer.dispose();
  }
}

// Warm up JIT and buffer paths before timing so single-rep checks are not cold-start skewed.
await run(4096, Math.min(totalBytes, 262144));

console.log('chunkBytes | impl | enqueue ms | checkpoint completion ms | enqueue MiB/s (median run)');
for (const chunkBytes of [16, 64, 256, 4096, 65536]) {
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition++) runs.push(await run(chunkBytes));
  const medianEnqueueMs = median(runs.map((r) => r.enqueueMs));
  const medianCompletionMs = median(runs.map((r) => r.completionMs));
  const chunks = runs[0].chunks;
  const throughput = Math.round((chunks * chunkBytes) / 1048576 / (Math.max(medianEnqueueMs, 0.001) / 1000));
  console.log(`${chunkBytes} | OutputBuffer | ${medianEnqueueMs.toFixed(1)} | ${medianCompletionMs.toFixed(1)} | ${throughput}`);
}

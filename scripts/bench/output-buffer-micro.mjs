// Run with the server's tsx loader. The same workload measures enqueue and checkpoint completion.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { OutputBuffer as CurrentOutputBuffer } from '../../packages/server/src/output-buffer.ts';

const { OutputBuffer } = process.env.MAW_OUTPUT_BUFFER_MODULE
  ? await import(process.env.MAW_OUTPUT_BUFFER_MODULE)
  : { OutputBuffer: CurrentOutputBuffer };
const totalBytes = Number(process.env.TOTAL_MIB ?? 16) * 1024 * 1024;
const repetitions = Number(process.env.REPS ?? 3);
assert.ok(Number.isInteger(repetitions) && repetitions > 0 && totalBytes >= 65536);

async function run(chunkBytes) {
  const buffer = new OutputBuffer();
  const marker = 'checkpoint-end';
  const chunk = 'x'.repeat(chunkBytes - 2) + '\r\n';
  const chunks = Math.floor(totalBytes / chunkBytes);
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

console.log('chunkBytes | impl | enqueue ms | checkpoint completion ms | enqueue MiB/s (median run)');
for (const chunkBytes of [16, 64, 256, 4096, 65536]) {
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition++) runs.push(await run(chunkBytes));
  runs.sort((a, b) => a.enqueueMs - b.enqueueMs);
  const middle = runs[Math.floor(runs.length / 2)];
  const throughput = Math.round(middle.chunks * chunkBytes / 1048576 / (middle.enqueueMs / 1000));
  console.log(`${chunkBytes} | OutputBuffer | ${middle.enqueueMs.toFixed(1)} | ${middle.completionMs.toFixed(1)} | ${throughput}`);
}

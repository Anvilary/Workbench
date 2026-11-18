// Microbenchmark: OutputBuffer.push() (256 KiB replay ring) under different PTY chunk sizes.
// Run: node --import ./packages/server/node_modules/tsx/dist/loader.mjs scripts/bench/output-buffer-micro.mjs
import { OutputBuffer } from '../../packages/server/src/output-buffer.ts';

class RingAlt {
  constructor(limit = 256 * 1024) { this.limit = limit; this.chunks = []; this.sizes = []; this.head = 0; this.size = 0; this.truncated = false; this.alt = false; }
  push(chunk) {
    if (!chunk.length) return;
    if (chunk.includes('\x1b[?1049h') || chunk.includes('\x1b[?47h')) this.alt = true;
    if (chunk.includes('\x1b[?1049l') || chunk.includes('\x1b[?47l')) this.alt = false;
    const b = Buffer.byteLength(chunk, 'utf8');
    this.chunks.push(chunk); this.sizes.push(b); this.size += b;
    while (this.size > this.limit && this.head < this.chunks.length) {
      const oldest = this.sizes[this.head];
      if (this.size - oldest >= this.limit) { this.chunks[this.head] = undefined; this.size -= oldest; this.head++; }
      else break;
      this.truncated = true;
    }
    if (this.head > 4096 && this.head * 2 > this.chunks.length) { this.chunks = this.chunks.slice(this.head); this.sizes = this.sizes.slice(this.head); this.head = 0; }
  }
}

function run(Ctor, chunkBytes, total) {
  const chunk = ('x'.repeat(Math.max(1, chunkBytes - 2))) + '\r\n';
  const n = Math.floor(total / chunkBytes);
  const b = new Ctor();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) b.push(chunk);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms: +ms.toFixed(1), nsPerPush: Math.round(ms * 1e6 / n), mbPerSec: +((n * chunkBytes) / 1048576 / (ms / 1000)).toFixed(0) };
}
const TOTAL = Number(process.env.TOTAL_MIB ?? 16) * 1024 * 1024;
const REPS = Number(process.env.REPS ?? 3);
console.log('chunkBytes | impl | ms | ns/push | MiB/s   (TOTAL_MIB through a 256 KiB ring; best of REPS)');
for (const cb of [16, 64, 256, 4096, 65536]) {
  for (const [name, C] of [['OutputBuffer(current)', OutputBuffer], ['RingAlt(head index)', RingAlt]]) {
    let best = null; for (let r = 0; r < REPS; r++) { const x = run(C, cb, TOTAL); if (!best || x.ms < best.ms) best = x; }
    console.log(`${String(cb).padStart(9)} | ${name.padEnd(21)} | ${String(best.ms).padStart(8)} | ${String(best.nsPerPush).padStart(7)} | ${best.mbPerSec}`);
  }
}

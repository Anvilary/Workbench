import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ASYNC_SMAPS_MIN_PIDS, prefetchSmaps, readProcessSmaps, readProcessSmapsAsync } from '../../../src/performance/resource-monitor.mjs';

const ROLLUP = (pss) => `Rss:  ${pss * 2} kB\nPss:  ${pss} kB\nShared_Clean: 10 kB\nShared_Dirty: 5 kB\nPrivate_Clean: 20 kB\nPrivate_Dirty: 30 kB\nSwapPss: 7 kB\n`;

async function fakeProc(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maw-smaps-'));
  for (const [pid, files] of Object.entries(entries)) {
    await mkdir(path.join(root, String(pid)));
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(root, String(pid), name), body);
  }
  return root;
}

test('async smaps reading returns exactly what the synchronous reader returns', async () => {
  const root = await fakeProc({ 100: { smaps_rollup: ROLLUP(1000) }, 101: { status: 'Name: x\nVmRSS:   4096 kB\n' } });
  try {
    for (const pid of [100, 101, 999]) assert.deepEqual(await readProcessSmapsAsync(pid, root), readProcessSmaps(pid, root), `pid ${pid}`);
    const parsed = readProcessSmaps(100, root);
    assert.equal(parsed.pssBytes, 1000 * 1024);
    assert.equal(parsed.privateBytes, 50 * 1024);
    assert.equal(parsed.sharedBytes, 15 * 1024);
    assert.equal(parsed.swapPssBytes, 7 * 1024);
    assert.equal(readProcessSmaps(101, root).pssBytes, 4096 * 1024, 'falls back to VmRSS');
    assert.equal(readProcessSmaps(999, root).isAvailable, false, 'vanished process is reported unavailable, not thrown');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prefetchSmaps covers every pid above the threshold, tolerates vanished pids, and dedupes', async () => {
  const entries = {};
  for (let pid = 200; pid < 200 + ASYNC_SMAPS_MIN_PIDS + 4; pid++) entries[pid] = { smaps_rollup: ROLLUP(pid) };
  const root = await fakeProc(entries);
  try {
    const pids = [...Object.keys(entries).map(Number), 200, 200, 99999, -1, 0, 1.5, NaN];
    const result = await prefetchSmaps(pids, root, 3);
    assert.equal(result.size, Object.keys(entries).length + 1, 'valid pids plus the vanished 99999; invalid values dropped');
    assert.equal(result.get(205).pssBytes, 205 * 1024);
    assert.equal(result.get(99999).isAvailable, false);
    for (const [pid, value] of result) assert.deepEqual(value, readProcessSmaps(pid, root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('small pid sets are not prefetched, so the synchronous path (cheaper under load) is used', async () => {
  const root = await fakeProc({ 300: { smaps_rollup: ROLLUP(1) } });
  try {
    assert.equal((await prefetchSmaps([300], root)).size, 0);
    assert.equal((await prefetchSmaps(Array.from({ length: ASYNC_SMAPS_MIN_PIDS - 1 }, (_, i) => 300 + i), root)).size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prefetch keeps the event loop responsive while reading many processes', async () => {
  const entries = {};
  for (let pid = 400; pid < 400 + 200; pid++) entries[pid] = { smaps_rollup: ROLLUP(pid) };
  const root = await fakeProc(entries);
  try {
    let ticks = 0; const timer = setInterval(() => { ticks += 1; }, 1);
    await prefetchSmaps(Object.keys(entries).map(Number), root);
    clearInterval(timer);
    assert.ok(ticks >= 1, 'timers fire while the prefetch is in flight');
  } finally { await rm(root, { recursive: true, force: true }); }
});

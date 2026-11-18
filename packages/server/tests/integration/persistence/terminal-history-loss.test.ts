import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TerminalHistoryStore } from '../../../src/terminal-history-store.js';

test('history loss accounting bounds UTF-8 chunks and newline-free output', async (t) => {
  const baseDir = path.join(tmpdir(), `maw-history-loss-${randomUUID()}`);
  await mkdir(baseDir, { recursive: true });
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, { baseDir, maxQueueBytes: 16 });
  store.push('🚀'.repeat(20));
  assert.ok(store.pendingQueueBytes <= 16);
  await store.flush();
  assert.ok(store.droppedBytes > 0);
  assert.equal(store.isIncomplete, true);
  const page = await store.getPage(0);
  assert.equal(page.incomplete, true);
  assert.equal(page.droppedBytes, store.droppedBytes);
  await store.dispose();
});

test('segment names stay unique after pruning and reopening', async (t) => {
  const baseDir = path.join(tmpdir(), `maw-history-segments-${randomUUID()}`);
  await mkdir(baseDir, { recursive: true });
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const terminalId = randomUUID();
  const options = { baseDir, maxSegmentLines: 1, retentionPolicy: { maxTotalLines: 1 } };
  const first = new TerminalHistoryStore(terminalId, options);
  first.push('one\n');
  await first.flush();
  await first.prune({ maxTotalLines: 1 });
  await first.dispose();

  const reopened = new TerminalHistoryStore(terminalId, options);
  reopened.push('two\n');
  await reopened.flush();
  const files = await readdir(path.join(baseDir, terminalId));
  const index = JSON.parse(await readFile(path.join(baseDir, terminalId, 'index.json'), 'utf8'));
  assert.equal(new Set(index.segments.map((s: { file: string }) => s.file)).size, index.segments.length);
  assert.ok(files.includes('seg-1.bin'));
  await reopened.dispose();
});

test('deleteAll waits for an in-flight flush and prevents later pushes', async (t) => {
  const baseDir = path.join(tmpdir(), `maw-history-lifecycle-${randomUUID()}`);
  await mkdir(baseDir, { recursive: true });
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const terminalId = randomUUID();
  const store = new TerminalHistoryStore(terminalId, { baseDir });
  store.push('before delete\n');
  const flush = store.flush();
  const deletion = store.deleteAll();
  store.push('after delete\n');
  await Promise.all([flush, deletion]);
  assert.equal(store.totalLines, 0);
  assert.equal(await store.diskUsageBytes(), 0);
});

test('segment byte limits rotate before later lines and account for oversized lines', async (t) => {
  const baseDir = path.join(tmpdir(), `maw-history-byte-cap-${randomUUID()}`);
  await mkdir(baseDir, { recursive: true });
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const store = new TerminalHistoryStore(randomUUID(), { baseDir, maxSegmentBytes: 6 });
  store.push('12345\n123456789\nabcde\n');
  await store.flush();
  assert.deepEqual((await store.getPage(0)).lines, ['12345', 'abcde']);
  assert.equal(store.droppedBytes, Buffer.byteLength('123456789\n'));
  assert.ok(store.isIncomplete);
  await store.dispose();
});

test('partial lines and the queue share a UTF-8 byte budget', async t => {
  const baseDir = path.join(tmpdir(), `maw-history-partial-${randomUUID()}`);
  const store = new TerminalHistoryStore(randomUUID(), { baseDir, maxQueueBytes: 8 });
  t.after(async () => { await store.dispose(); await rm(baseDir, { recursive: true, force: true }); });
  store.push('abcdef');
  await store.flush(false);
  store.push('🚀');
  assert.equal(store.pendingQueueBytes, 8);
  await store.flush();
  assert.deepEqual((await store.getPage(0)).lines, ['cdef🚀']);
  assert.equal(store.droppedBytes, 2);
});

test('loss remains visible after reopen and unreadable segments are not repeatedly counted as dropped', async t => {
  const { rename } = await import('node:fs/promises');
  const baseDir = path.join(tmpdir(), `maw-history-missing-${randomUUID()}`);
  const id = randomUUID();
  const store = new TerminalHistoryStore(id, { baseDir });
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  store.push('retained\n');
  await store.flush();
  const file = path.join(baseDir, id, 'seg-0.bin');
  await rename(file, file + '.saved');
  assert.equal((await store.getPage(0)).incomplete, true);
  assert.equal((await store.getPage(0)).droppedBytes, 0, 'a read failure is not proof bytes were dropped before persistence');
  await rename(file + '.saved', file);
  await store.dispose();
  const reopened = new TerminalHistoryStore(id, { baseDir });
  assert.equal((await reopened.getPage(0)).incomplete, true);
  assert.deepEqual((await reopened.getPage(0)).lines, ['retained']);
  await reopened.dispose();
});

test('a failed index commit rolls back appended bytes and reports the lost batch', async t => {
  const { writeFile } = await import('node:fs/promises');
  const baseDir = path.join(tmpdir(), `maw-history-rollback-${randomUUID()}`);
  const id = randomUUID();
  const store = new TerminalHistoryStore(id, { baseDir });
  t.after(async () => { await store.dispose(); await rm(baseDir, { recursive: true, force: true }); });
  store.push('committed\n');
  await store.flush();
  const indexPath = path.join(baseDir, id, 'index.json');
  const originalIndex = await readFile(indexPath);
  await rm(indexPath);
  await mkdir(indexPath);
  store.push('uncommitted\n');
  await store.flush();
  assert.equal(await readFile(path.join(baseDir, id, 'seg-0.bin'), 'utf8'), 'committed\n');
  assert.equal(store.droppedBytes, Buffer.byteLength('uncommitted\n'));
  await rm(indexPath, { recursive: true });
  await writeFile(indexPath, originalIndex);
  await store.flush();
  store.push('next\n');
  await store.flush();
  assert.deepEqual((await store.getPage(0)).lines, ['committed', 'next']);
  await store.dispose();
  const reopened = new TerminalHistoryStore(id, { baseDir });
  assert.equal(reopened.isIncomplete, true);
  assert.equal(reopened.droppedBytes, Buffer.byteLength('uncommitted\n'));
  await reopened.dispose();
});

test('pruning commits metadata before unlinking any segment', async t => {
  const baseDir = path.join(tmpdir(), `maw-history-prune-atomic-${randomUUID()}`);
  const id = randomUUID();
  const store = new TerminalHistoryStore(id, { baseDir, maxSegmentLines: 1 });
  t.after(async () => { await store.dispose(); await rm(baseDir, { recursive: true, force: true }); });
  store.push('one\ntwo\n');
  await store.flush();
  // Fault only the atomic commit, leaving all old segment files intact.
  const internals = store as unknown as { writeIndexAtomic(): Promise<void> };
  const commit = internals.writeIndexAtomic.bind(store);
  internals.writeIndexAtomic = async () => { throw new Error('injected index failure'); };
  await assert.rejects(store.prune({ maxTotalLines: 0 }), /injected index failure/);
  internals.writeIndexAtomic = commit;
  assert.equal(store.totalLines, 2);
  assert.equal((await readdir(path.join(baseDir, id))).filter(name => name.endsWith('.bin')).length, 2);
  assert.deepEqual((await store.getPage(0)).lines, ['one', 'two']);
});

test('dispose stops new input immediately and drains a flush already in progress', async t => {
  const baseDir = path.join(tmpdir(), `maw-history-dispose-${randomUUID()}`);
  const id = randomUUID();
  const store = new TerminalHistoryStore(id, { baseDir });
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const internals = store as unknown as { performSingleFlush(force: boolean): Promise<void> };
  const perform = internals.performSingleFlush.bind(store);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  internals.performSingleFlush = async force => { entered(); await gate; await perform(force); };
  store.push('before\n');
  const flushing = store.flush();
  await started;
  const closing = store.dispose();
  store.push('after\n');
  release();
  await Promise.all([flushing, closing]);
  const reopened = new TerminalHistoryStore(id, { baseDir });
  assert.deepEqual((await reopened.getPage(0)).lines, ['before']);
  await reopened.dispose();
});

test('malformed indexes fail closed without overwriting segments', async t => {
  const { writeFile } = await import('node:fs/promises');
  const baseDir = path.join(tmpdir(), `maw-history-corrupt-${randomUUID()}`);
  const id = randomUUID();
  const directory = path.join(baseDir, id);
  await mkdir(directory, { recursive: true });
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'seg-0.bin'), 'evidence\n');
  await writeFile(path.join(directory, 'index.json'), '{broken');
  assert.throws(() => new TerminalHistoryStore(id, { baseDir }), /Corrupt history index/);
  assert.equal(await readFile(path.join(directory, 'seg-0.bin'), 'utf8'), 'evidence\n');
});

test('invalid quota values are rejected and segment permissions protect terminal content', async t => {
  const { stat } = await import('node:fs/promises');
  const baseDir = path.join(tmpdir(), `maw-history-policy-${randomUUID()}`);
  const id = randomUUID();
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  for (const invalid of [NaN, Infinity, -1, 1.5]) {
    assert.throws(() => new TerminalHistoryStore(id, { baseDir, retentionPolicy: { maxDiskBytes: invalid } }));
    assert.throws(() => new TerminalHistoryStore(id, { baseDir, maxSegmentLines: invalid }));
  }
  const store = new TerminalHistoryStore(id, { baseDir, retentionPolicy: {} });
  store.push('private output\n');
  await store.flush();
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(baseDir, id))).mode & 0o077, 0);
    assert.equal((await stat(path.join(baseDir, id, 'seg-0.bin'))).mode & 0o077, 0);
    assert.equal((await stat(path.join(baseDir, id, 'index.json'))).mode & 0o077, 0);
  }
  await assert.rejects(store.prune({ maxTotalLines: NaN }));
  await store.dispose();
});

test('reopen reconciles an uncommitted crash tail before appending new output', async t => {
  const { appendFile } = await import('node:fs/promises');
  const baseDir = path.join(tmpdir(), `maw-history-crash-tail-${randomUUID()}`);
  const id = randomUUID();
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const first = new TerminalHistoryStore(id, { baseDir });
  first.push('a\n');
  await first.dispose();
  await appendFile(path.join(baseDir, id, 'seg-0.bin'), 'uncommitted\n');
  const reopened = new TerminalHistoryStore(id, { baseDir });
  reopened.push('b\n');
  await reopened.flush();
  const page = await reopened.getPage(0);
  assert.deepEqual(page.lines, ['a', 'b']);
  assert.equal(page.incomplete, true);
  assert.equal(page.droppedBytes, Buffer.byteLength('uncommitted\n'));
  await reopened.dispose();
});

test('a fail-closed transition drains concurrent queued output without hanging flush', async t => {
  const baseDir = path.join(tmpdir(), `maw-history-failclosed-${randomUUID()}`);
  const store = new TerminalHistoryStore(randomUUID(), { baseDir });
  t.after(async () => { await store.dispose(); await rm(baseDir, { recursive: true, force: true }); });
  const internals = store as unknown as { pruneUnlocked(): Promise<unknown> };
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  internals.pruneUnlocked = async () => { entered(); await gate; throw new Error('injected prune failure'); };
  store.push('committed\n');
  const flushing = store.flush();
  await started;
  store.push('pending\n');
  release();
  await flushing;
  assert.equal(store.pendingQueueBytes, 0);
  assert.equal(store.droppedBytes, Buffer.byteLength('pending\n'));
  assert.equal(store.isIncomplete, true);
  await store.dispose();
});

test('byte quotas remain enforced across repeated prune, append and reopen cycles', async t => {
  const { stat } = await import('node:fs/promises');
  const baseDir = path.join(tmpdir(), `maw-history-quota-cycles-${randomUUID()}`);
  const id = randomUUID();
  const options = { baseDir, maxSegmentBytes: 20, retentionPolicy: { maxDiskBytes: 50 } };
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  let store = new TerminalHistoryStore(id, options);
  for (let i = 0; i < 12; i++) {
    store.push(`line-${String(i).padStart(4, '0')}\n`);
    await store.flush();
    await store.dispose();
    store = new TerminalHistoryStore(id, options);
    const index = JSON.parse(await readFile(path.join(baseDir, id, 'index.json'), 'utf8'));
    const bytes = await Promise.all(index.segments.map((seg: { file: string }) => stat(path.join(baseDir, id, seg.file))));
    assert.ok(bytes.reduce((sum: number, entry: { size: number }) => sum + entry.size, 0) <= 50);
    assert.equal((await store.getPage(0, 1, 'backward')).lines[0], `line-${String(i).padStart(4, '0')}`);
  }
  await store.dispose();
});

test('age retention runs on reads even when no further output arrives', async t => {
  const baseDir = path.join(tmpdir(), `maw-history-age-${randomUUID()}`);
  const store = new TerminalHistoryStore(randomUUID(), { baseDir, retentionPolicy: { maxAgeMs: 1 } });
  t.after(async () => { await store.dispose(); await rm(baseDir, { recursive: true, force: true }); });
  store.push('expires\n');
  await store.flush();
  await new Promise(resolve => setTimeout(resolve, 20));
  const page = await store.getPage(0);
  assert.equal(page.totalLines, 0);
  assert.equal(page.prunedLines, 1);
});

test('deletion clears pending loss metadata without recreating the directory later', async t => {
  const { access } = await import('node:fs/promises');
  const baseDir = path.join(tmpdir(), `maw-history-delete-loss-${randomUUID()}`);
  const id = randomUUID();
  const store = new TerminalHistoryStore(id, { baseDir, maxQueueBytes: 4 });
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  store.push('oversized');
  assert.equal(store.isIncomplete, true);
  await store.deleteAll();
  await store.flush();
  assert.deepEqual((await store.getPage(0)).lines, []);
  await assert.rejects(access(path.join(baseDir, id)));
});

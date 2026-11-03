import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, appendFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexTurnWatcher, type CodexNativeTurn } from './turn-watcher.js';

test('CodexTurnWatcher caches resolved path, detects size deltas without re-discovery, and recovers on rotation/truncation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-cache-test-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'codex-cache-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const sessionId = randomUUID();
  const launchedAt = Date.now();
  const turns: CodexNativeTurn[] = [];

  const sessionDir = path.join(root, 'sessions', '2026', '11', '03');
  await mkdir(sessionDir, { recursive: true });
  const file = path.join(sessionDir, `rollout-2026-11-03T00-00-00-${sessionId}.jsonl`);

  const line = (type: string, payload: object, time = launchedAt + 10) =>
    JSON.stringify({ type, payload, timestamp: new Date(time).toISOString() }) + '\n';
  const event = (type: string, id: string, extra = {}, time = launchedAt + 10) =>
    line('event_msg', { type, turn_id: id, ...extra }, time);

  // 1. Initial creation with session_meta
  await writeFile(file, line('session_meta', { id: sessionId, cwd: root }) + event('task_started', 'turn-1'));

  const watcher = new CodexTurnWatcher({
    home: root,
    cwd: root,
    sessionId,
    launchedAt,
    onTurn: (turn) => turns.push(turn),
  });
  t.after(() => watcher.dispose());

  // First poll discovers path and processes turn-1
  await watcher.poll();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.phase, 'working');
  assert.equal(turns[0]?.taskId, `${sessionId}:turn-1`);

  // 2. Poll when file has no new bytes: returns immediately, does not invent new turns
  await watcher.poll();
  await watcher.poll();
  assert.equal(turns.length, 1);

  // 3. Append completion: detected via size delta
  await appendFile(file, event('task_complete', 'turn-1'));
  await watcher.poll();
  assert.equal(turns.length, 2);
  assert.equal(turns[1]?.phase, 'finished');

  // 4. File truncation / replacement (e.g. log rotation or rewind):
  // When file is overwritten with smaller size, watcher resets offset and re-verifies metadata
  await writeFile(file, line('session_meta', { id: sessionId, cwd: root }) + event('task_started', 'turn-2'));
  await watcher.poll();
  assert.equal(turns.length, 3);
  assert.equal(turns[2]?.phase, 'working');
  assert.equal(turns[2]?.taskId, `${sessionId}:turn-2`);

  // Complete turn-2
  await appendFile(file, event('task_complete', 'turn-2'));
  await watcher.poll();
  assert.equal(turns.length, 4);
  assert.equal(turns[3]?.phase, 'finished');

  // 5. Temporary disappearance (file rename) followed by recovery
  const backup = path.join(root, 'temp-backup.jsonl');
  await rename(file, backup);
  await watcher.poll();
  // Evidence lost emitted for any active turn (currently 0 active)
  assert.equal(turns.length, 4);

  // Move back and add turn-3
  await rename(backup, file);
  await appendFile(file, event('task_started', 'turn-3'));
  await watcher.poll();
  assert.equal(turns.length, 5);
  assert.equal(turns[4]?.phase, 'working');
  assert.equal(turns[4]?.taskId, `${sessionId}:turn-3`);

  // 6. Security boundary: symlink pointing outside root must be rejected
  await rm(file);
  const foreignFile = path.join(outside, 'outside-rollout.jsonl');
  await writeFile(foreignFile, line('session_meta', { id: sessionId, cwd: root }) + event('task_started', 'escaped'));
  await symlink(foreignFile, file);
  await watcher.poll();
  // Active turn becomes unknown upon evidence loss; escaped turn is rejected
  assert.equal(turns.length, 6);
  assert.equal(turns[5]?.phase, 'unknown');
  assert.equal(turns.some(t => t.taskId.includes('escaped')), false, 'escaped symlink must not be read');
});

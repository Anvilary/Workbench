import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DomainError,
  SerialQueue,
  UnsupportedSchemaVersionError,
  isCanonicalAbsolutePath,
  isIsoUtcTimestamp,
  isNullableTimestamp,
  isPrintableName,
  isRecord,
  isValidRequestId,
  isValidTimestamp,
  isValidUuid,
  loadWithBackupRecovery,
  writeSnapshotWithBackup,
} from '../../../src/shared/index.js';

test('SerialQueue preserves FIFO execution order and isolates task rejections', async () => {
  const queue = new SerialQueue();
  const events: string[] = [];

  const first = queue.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    events.push('first');
    return 1;
  });

  const failing = queue.run(async () => {
    events.push('second-fail');
    throw new Error('boom');
  });

  const third = queue.run(async () => {
    events.push('third');
    return 3;
  });

  assert.equal(await first, 1);
  await assert.rejects(failing, /boom/);
  assert.equal(await third, 3);
  await queue.flush();
  assert.deepEqual(events, ['first', 'second-fail', 'third']);
});

test('DomainError and UnsupportedSchemaVersionError preserve error names and codes', () => {
  const err = new DomainError('invalid-input', 'bad input');
  assert.equal(err.name, 'DomainError');
  assert.equal(err.code, 'invalid-input');

  const schemaErr = new UnsupportedSchemaVersionError('layout', 99);
  assert.equal(schemaErr.name, 'UnsupportedSchemaVersionError');
  assert.equal(schemaErr.code, 'unsupported-schema');
  assert.match(schemaErr.message, /Unsupported layout schema version: 99/);
});

test('loadWithBackupRecovery and writeSnapshotWithBackup handle empty, backup recovery, and schema failure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'maw-srv-shared-'));
  const filePath = path.join(dir, 'state.json');

  try {
    const initial = await loadWithBackupRecovery({
      filePath,
      parse: (raw) => JSON.parse(raw),
      emptyValue: () => ({ version: 1, items: [] }),
    });
    assert.deepEqual(initial, { value: { version: 1, items: [] }, recoveredFromBackup: false });

    await writeSnapshotWithBackup({ filePath, content: JSON.stringify({ version: 1, count: 1 }) });
    await writeSnapshotWithBackup({ filePath, content: JSON.stringify({ version: 1, count: 2 }) });

    // Corrupt primary and ensure backup recovery succeeds and quarantines primary.
    await writeFile(filePath, '{not-json', 'utf8');
    let quarantined: string | null = null;
    const recovered = await loadWithBackupRecovery({
      filePath,
      parse: (raw) => JSON.parse(raw),
      onQuarantine: (q) => {
        quarantined = q;
      },
    });
    assert.equal(recovered.recoveredFromBackup, true);
    assert.deepEqual(recovered.value, { version: 1, count: 1 });
    assert.ok(quarantined && existsSync(quarantined));

    // Future schema version must never fall back to `.bak`.
    await writeFile(filePath, JSON.stringify({ version: 999 }), 'utf8');
    await assert.rejects(
      () =>
        loadWithBackupRecovery({
          filePath,
          parse: (raw) => {
            const parsed = JSON.parse(raw) as { version: number };
            if (parsed.version > 1) throw new UnsupportedSchemaVersionError('test', parsed.version);
            return parsed;
          },
          isUnsupportedSchemaError: (e) => e instanceof UnsupportedSchemaVersionError,
        }),
      UnsupportedSchemaVersionError,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validation primitives validate UUIDs, timestamps, names, paths, and request IDs', () => {
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);

  assert.equal(isValidUuid('11111111-1111-4111-8111-111111111111'), true);
  assert.equal(isValidUuid('not-a-uuid'), false);

  assert.equal(isIsoUtcTimestamp('2026-11-18T12:00:00.000Z'), true);
  assert.equal(isIsoUtcTimestamp('2026-11-18T12:00:00Z'), false);
  assert.equal(isValidTimestamp('2026-11-18T12:00:00Z'), true);
  assert.equal(isNullableTimestamp(null), true);
  assert.equal(isNullableTimestamp('invalid'), false);

  assert.equal(isPrintableName('Workspace A'), true);
  assert.equal(isPrintableName('  padded '), false);
  assert.equal(isPrintableName('line\nbreak'), false);

  assert.equal(isCanonicalAbsolutePath('/home/user/project'), true);
  assert.equal(isCanonicalAbsolutePath('/home/user/../project'), false);
  assert.equal(isCanonicalAbsolutePath('relative/path'), false);

  assert.equal(isValidRequestId('req-123'), true);
  assert.equal(isValidRequestId(''), false);
  assert.equal(isValidRequestId('bad\u0007id'), false);
});

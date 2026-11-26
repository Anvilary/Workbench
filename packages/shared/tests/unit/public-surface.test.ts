import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as shared from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const expected: string[] = JSON.parse(readFileSync(path.join(here, 'fixtures/public-runtime-exports.json'), 'utf8'));

test('the runtime export surface of @anvilary/workbench-shared is stable', () => {
  const actual = Object.keys(shared).sort();
  const missing = expected.filter((name) => !actual.includes(name));
  const added = actual.filter((name) => !expected.includes(name));
  assert.deepEqual(missing, [], 'public exports were removed; clients and server depend on them');
  assert.deepEqual(
    added,
    [],
    'new public exports must be added to tests/unit/fixtures/public-runtime-exports.json on purpose',
  );
});

test('wire constants keep their values', () => {
  assert.equal(shared.PROTOCOL_VERSION, 8);
  assert.equal(shared.WS_PATH, '/ws');
  assert.equal(shared.TOKEN_QUERY_PARAM, 'token');
});

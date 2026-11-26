import test from 'node:test';
import assert from 'node:assert/strict';
import { findHomePaths, isBinary, parseAllowlist } from './privacy-gate.mjs';

// Built at runtime so this file does not trip the gate it tests.
const H = '/' + 'home';
const U = '/' + 'Users';

test('flags personal Linux and macOS home paths', () => {
  const found = findHomePaths(`cd ${H}/jdoe/project\nopen "${U}/Jane.Doe/Library/x"\n`);
  assert.deepEqual(found.map((f) => [f.line, f.match]), [
    [1, `${H}/jdoe/`],
    [2, `${U}/Jane.Doe/`],
  ]);
  assert.equal(found[0].column, 4);
});

test('accepts generic placeholder home names', () => {
  for (const name of ['user', 'runner', 'example', 'test', 'ubuntu', 'node']) {
    assert.deepEqual(findHomePaths(`/home/${name}/x and /Users/${name}/y`), []);
  }
});

test('ignores home segments inside URLs and longer paths, and non-path text', () => {
  assert.deepEqual(findHomePaths('https://example.com/home/alice/page'), []);
  assert.deepEqual(findHomePaths('/srv/data/home/alice/'), []);
  assert.deepEqual(findHomePaths('/home/ alone, /home/$USER/x, /home/<name>/x, ~/x, /home/alice'), []);
});

test('a custom allowlist of names is honoured', () => {
  assert.deepEqual(findHomePaths(`${H}/ci/x`, new Set(['ci'])), []);
  assert.equal(findHomePaths(`${H}/ci/x`, new Set()).length, 1);
});

test('binary detection and allowlist parsing', () => {
  assert.equal(isBinary(Buffer.from([0x89, 0x50, 0x00, 0x47])), true);
  assert.equal(isBinary(Buffer.from(`${H}/alice/ plain text`)), false);
  assert.deepEqual([...parseAllowlist('# comment\n\ndocs/a.md\n  docs/b.md  \n')], ['docs/a.md', 'docs/b.md']);
});

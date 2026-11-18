import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalPathCandidate } from '../../../src/agency/split/terminal-path.mjs';

const cwd = '/work/demo';

test('relative paths, spaces, and one pair of quotes resolve inside the workspace', () => {
  assert.deepEqual(terminalPathCandidate('src/app.ts', cwd), {
    ok: true, relative: 'src/app.ts', absolute: '/work/demo/src/app.ts',
  });
  assert.deepEqual(terminalPathCandidate('"notes/my file.md"', cwd), {
    ok: true, relative: 'notes/my file.md', absolute: '/work/demo/notes/my file.md',
  });
  assert.deepEqual(terminalPathCandidate('/work/demo/lib/a.ts', cwd), {
    ok: true, relative: 'lib/a.ts', absolute: '/work/demo/lib/a.ts',
  });
});

test('traversal, home shortcuts, and shell syntax are rejected', () => {
  assert.equal(terminalPathCandidate('../outside', cwd).ok, false);
  assert.equal(terminalPathCandidate('/work/other', cwd).ok, false);
  assert.equal(terminalPathCandidate('~/secret', cwd).ok, false);
  assert.equal(terminalPathCandidate('file.txt; rm -rf /', cwd).ok, false);
  assert.equal(terminalPathCandidate('https://example.com/a', cwd).ok, false);
  assert.equal(terminalPathCandidate('a\nb', cwd).ok, false);
});

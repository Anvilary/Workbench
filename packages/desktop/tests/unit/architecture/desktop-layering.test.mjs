import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const SRC = path.join(DESKTOP_ROOT, 'src');
const files = (dir) => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? files(full) : full.endsWith('.mjs') ? [full] : [];
});
const modules = files(SRC);
const importsOf = (file) => [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
const area = (file) => path.relative(SRC, file).split(path.sep)[0];
const resolved = (file, spec) => {
  const target = path.resolve(path.dirname(file), spec);
  return existsSync(target) ? target : null;
};

test('only the composition entry point and the PIN dialog import Electron directly', () => {
  // The dialog module creates its own BrowserWindow for the security key PIN prompt.
  const offenders = modules.filter((file) => importsOf(file).includes('electron')).map((f) => path.relative(DESKTOP_ROOT, f));
  assert.deepEqual(offenders, ['src/security/webauthn/dialog.mjs']);
  assert.match(readFileSync(path.join(DESKTOP_ROOT, 'main.mjs'), 'utf8'), /from 'electron'/);
});

test('main.mjs stays a composition entry point', () => {
  const lines = readFileSync(path.join(DESKTOP_ROOT, 'main.mjs'), 'utf8').split('\n').length;
  assert.ok(lines < 120, `main.mjs has ${lines} lines; behavior belongs in src/`);
});

test('modules depend on policy and sibling areas only in the allowed direction', () => {
  const allowed = {
    app: new Set(['app', 'ipc', 'gpu', 'security']),
    browser: new Set(['browser', 'security', 'performance']),
    ipc: new Set(['ipc']),
    performance: new Set(['performance']),
    security: new Set(['security']),
    gpu: new Set(['gpu']),
  };
  const violations = [];
  for (const file of modules) {
    for (const spec of importsOf(file)) {
      if (!spec.startsWith('.')) continue;
      const target = resolved(file, spec);
      if (!target || !target.startsWith(SRC + path.sep)) continue;
      if (!allowed[area(file)]?.has(area(target))) violations.push(`${path.relative(SRC, file)} -> ${path.relative(SRC, target)}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the frozen desktop entry paths exist', () => {
  for (const relative of ['main.mjs', 'preload.cjs', 'policy.mjs', 'src/gpu/graphics-policy.mjs']) {
    assert.ok(existsSync(path.join(DESKTOP_ROOT, relative)), relative);
  }
});

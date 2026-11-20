import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { WEB_SRC } from '../../helpers/paths.mjs';

const files = (dir) => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? files(full) : /\.(tsx?|mts|mjs)$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
});
const sources = files(WEB_SRC);

function resolve(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  const stem = base.replace(/\.(js|jsx|mjs)$/, '');
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, base, path.join(stem, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const edges = [];
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?\sfrom\s*)?['"](\.[^'"]*)['"]/g)) {
    const to = resolve(file, m[5]);
    if (to) edges.push({ from: file, to, typeOnly: m[3] !== undefined });
  }
}
const area = (file) => {
  const parts = path.relative(WEB_SRC, file).split(path.sep);
  if (parts.length === 1) return '(root)';
  return parts[0] === 'features' ? `features/${parts[1]}` : parts[0];
};
const rel = (f) => path.relative(WEB_SRC, f);
const violations = (rule) => edges.filter((e) => area(e.from) !== area(e.to) && rule(area(e.from), area(e.to))).map((e) => `${rel(e.from)} -> ${rel(e.to)}`);

test('shared, connection and i18n never depend on features or the app shell', () => {
  assert.deepEqual(violations((from, to) => ['shared', 'connection', 'i18n'].includes(from) && (to.startsWith('features/') || to === 'app')), []);
});

test('features never depend on the app shell', () => {
  assert.deepEqual(violations((from, to) => from.startsWith('features/') && to === 'app'), []);
});

test('the connection layer only depends on shared code', () => {
  assert.deepEqual(violations((from, to) => from === 'connection' && !['shared', 'i18n'].includes(to)), []);
});

test('no feature directory exists only to re-export other modules', () => {
  const offenders = [];
  for (const file of sources.filter((f) => path.basename(f).startsWith('index.'))) {
    const body = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'));
    if (body.every((l) => /^(export|\}|\s)/.test(l) && /from\s|^\}|^\s|^export \{/.test(l))) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, []);
});

test('value imports contain no cycles', () => {
  const graph = new Map(sources.map((f) => [f, []]));
  for (const e of edges) if (!e.typeOnly) graph.get(e.from).push(e.to);
  const state = new Map();
  const stack = [];
  const cycles = [];
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) cycles.push([...stack.slice(stack.indexOf(next)), next].map(rel).join(' -> '));
      else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const f of sources) if (!state.has(f)) visit(f);
  assert.deepEqual(cycles, []);
});

test('the entry points that the build and the desktop shell load still exist', () => {
  for (const relative of ['main.tsx', 'styles.css', 'app/WorkbenchRoot.tsx', 'app/workbench.css']) {
    assert.ok(existsSync(path.join(WEB_SRC, relative)), relative);
  }
});

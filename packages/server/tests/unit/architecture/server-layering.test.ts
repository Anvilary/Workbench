import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SERVER_SRC } from '../../helpers/paths.js';

/** Static view of the server's source tree: which area imports which, and whether value imports form a cycle. */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|mts)$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
  });
}

function resolveImport(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier);
  const stem = base.replace(/\.(js|mjs)$/, '');
  for (const candidate of [`${stem}.ts`, `${stem}.mts`, base, path.join(stem, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface Edge { from: string; to: string; typeOnly: boolean }

const files = sourceFiles(SERVER_SRC);
const edges: Edge[] = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/(^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?\sfrom\s*)?['"](\.[^'"]*)['"]/g)) {
    const to = resolveImport(file, match[5]!);
    if (to !== null) edges.push({ from: file, to, typeOnly: match[3] !== undefined });
  }
}

/** `features/terminals`, `transport`, `agents`, `(root)` for index.ts and workbench-host.ts. */
function area(file: string): string {
  const parts = path.relative(SERVER_SRC, file).split(path.sep);
  if (parts.length === 1) return '(root)';
  return parts[0] === 'features' ? `features/${parts[1]}` : parts[0]!;
}

function violations(rule: (from: string, to: string) => boolean): string[] {
  return edges
    .filter((edge) => area(edge.from) !== area(edge.to) && rule(area(edge.from), area(edge.to)))
    .map((edge) => `${path.relative(SERVER_SRC, edge.from)} -> ${path.relative(SERVER_SRC, edge.to)}`);
}

test('features never depend on the transport layer', () => {
  assert.deepEqual(violations((from, to) => from.startsWith('features/') && to === 'transport'), []);
});

test('shared foundations depend on nothing else in the server', () => {
  assert.deepEqual(violations((from) => from === 'shared'), []);
});

test('bootstrap helpers only use shared foundations', () => {
  assert.deepEqual(violations((from, to) => from === 'bootstrap' && to !== 'shared'), []);
});

test('the persistent PTY host does not depend on application features or the transport', () => {
  assert.deepEqual(violations((from, to) => from === 'pty-host' && to !== 'pty-host' && to !== 'shared'), []);
});

test('security policy depends only on the remote access ledger', () => {
  assert.deepEqual(violations((from, to) => from === 'security' && to !== 'features/remote-access' && to !== 'shared'), []);
});

test('agent adapters reach only the composer and file helpers they share with the features', () => {
  const allowed = new Set(['features/composer', 'features/files', 'shared', 'pty-host']);
  assert.deepEqual(violations((from, to) => from === 'agents' && !allowed.has(to)), []);
});

test('only the entry points and the transport compose the whole application', () => {
  const composers = new Set(['(root)', 'transport']);
  const wide = new Map<string, Set<string>>();
  for (const edge of edges) {
    const from = area(edge.from);
    if (!from.startsWith('features/') || area(edge.to) === from) continue;
    (wide.get(from) ?? wide.set(from, new Set()).get(from)!).add(area(edge.to));
  }
  for (const [from, targets] of wide) {
    assert.ok(!composers.has(from));
    assert.ok(targets.size <= 7, `${from} depends on ${targets.size} other areas: ${[...targets].join(', ')}`);
  }
});

test('value imports contain no cycles', () => {
  const graph = new Map<string, string[]>();
  for (const file of files) graph.set(file, []);
  for (const edge of edges) if (!edge.typeOnly) graph.get(edge.from)!.push(edge.to);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const cycles: string[] = [];
  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) cycles.push([...stack.slice(stack.indexOf(next)), next].map((f) => path.relative(SERVER_SRC, f)).join(' -> '));
      else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const file of files) if (!state.has(file)) visit(file);
  assert.deepEqual(cycles, []);
});

test('the frozen entry points still exist where the launcher and updater look for them', () => {
  for (const relative of ['index.ts', 'workbench-host.ts', 'pty-host/ptyd.mjs', 'pty-host/terminal-state.mjs']) {
    assert.ok(existsSync(path.join(SERVER_SRC, relative)), relative);
  }
});

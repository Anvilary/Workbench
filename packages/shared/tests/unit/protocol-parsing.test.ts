import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeClientMessage, encodeServerMessage, parseClientMessage, parseServerMessage } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_DIR = path.join(here, '../../src/protocol');

interface GoldenRow { kind: 'client' | 'server'; raw: string; expected: unknown }
// Frozen from the parsers as they behaved before the protocol was split into message families.
const golden: GoldenRow[] = JSON.parse(readFileSync(path.join(here, 'fixtures/protocol-golden.json'), 'utf8'));

const parse = { client: parseClientMessage, server: parseServerMessage } as const;

test('golden messages parse exactly as before the protocol split', () => {
  assert.ok(golden.length > 300, 'golden fixture should be substantial');
  for (const row of golden) {
    const actual = parse[row.kind](row.raw);
    assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), row.expected, `${row.kind} ${row.raw}`);
  }
});

test('golden fixture covers every message family on both directions', () => {
  const valid = golden.filter((row) => row.expected !== null);
  const prefixes = (kind: string): Set<string> =>
    new Set(valid.filter((row) => row.kind === kind).map((row) => String((JSON.parse(row.raw) as { type: string }).type).split('.')[0] ?? ''));
  for (const family of ['terminal', 'agent', 'conversation', 'git', 'files', 'notes', 'memory', 'vault', 'remote', 'worktree', 'agents', 'picker', 'session', 'search', 'agency']) {
    assert.ok(prefixes('client').has(family), `client family ${family} missing from golden fixture`);
  }
  for (const family of ['hello', 'terminal', 'conversation', 'agent', 'agents', 'composer', 'memory', 'notes', 'vault', 'worktree', 'plan', 'agency']) {
    assert.ok(prefixes('server').has(family), `server family ${family} missing from golden fixture`);
  }
});

test('unknown types, non objects and malformed JSON are rejected by both parsers', () => {
  for (const raw of ['', '{', 'null', '[]', '7', '"input"', '{}', '{"type":7}', '{"type":"no.such.message"}', '{"type":"agency.no.such"}']) {
    assert.equal(parseClientMessage(raw), null, `client ${raw}`);
    assert.equal(parseServerMessage(raw), null, `server ${raw}`);
  }
});

test('encoders serialize messages as plain JSON', () => {
  for (const row of golden) {
    if (row.expected === null) continue;
    const message = parse[row.kind](row.raw);
    assert.ok(message);
    const encoded = row.kind === 'client' ? encodeClientMessage(message as never) : encodeServerMessage(message as never);
    assert.equal(encoded, JSON.stringify(message));
  }
});

test('each message type is owned by exactly one family parser', async () => {
  const parsers: Record<'client' | 'server', Array<[string, (record: Record<string, unknown>) => unknown]>> = { client: [], server: [] };
  for (const file of readdirSync(PROTOCOL_DIR).filter((name) => name.endsWith('-messages.ts') && !name.startsWith('agency'))) {
    const module = (await import(pathToFileURL(path.join(PROTOCOL_DIR, file)).href)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) {
      const match = /^parse(Client|Server)[A-Za-z]+Message$/.exec(name);
      if (match && typeof value === 'function') {
        parsers[match[1] === 'Client' ? 'client' : 'server'].push([`${file}:${name}`, value as (record: Record<string, unknown>) => unknown]);
      }
    }
  }
  assert.ok(parsers.client.length >= 14 && parsers.server.length >= 14, 'family parsers should be discovered');
  for (const row of golden) {
    const record = JSON.parse(row.raw) as Record<string, unknown>;
    if (typeof record['type'] !== 'string' || record['type'].startsWith('agency.')) continue;
    const owners = parsers[row.kind].filter(([, parseFamily]) => parseFamily(record) !== undefined).map(([name]) => name);
    assert.equal(owners.length, 1, `${row.kind} ${String(record['type'])} owned by ${owners.join(', ') || 'nobody'}`);
  }
});

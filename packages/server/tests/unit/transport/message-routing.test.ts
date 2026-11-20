import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT, SERVER_SRC } from '../../helpers/paths.js';
import { dispatchClientMessage, routedMessageTypes } from '../../../src/transport/websocket/dispatch.js';
import type { FullContext } from '../../../src/transport/websocket/handler-context.js';

interface GoldenRow { kind: 'client' | 'server'; raw: string; expected: unknown }
const golden: GoldenRow[] = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'packages/shared/tests/unit/fixtures/protocol-golden.json'), 'utf8'),
);

test('every client message type the protocol accepts has a handler', () => {
  const routed = routedMessageTypes();
  const accepted = new Set<string>();
  for (const row of golden) {
    if (row.kind !== 'client' || row.expected === null) continue;
    accepted.add(String((JSON.parse(row.raw) as { type: unknown }).type));
  }
  assert.ok(accepted.size > 80, 'the golden fixture should cover most client message types');
  const unrouted = [...accepted].filter((type) => !routed.has(type));
  assert.deepEqual(unrouted, [], 'accepted message types without a handler would be silently ignored');
});

test('handler modules own disjoint message types and route table matches them', async () => {
  const dir = path.join(SERVER_SRC, 'transport/websocket/handlers');
  const owners = new Map<string, string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('-handler.ts'))) {
    const module = (await import(path.join(dir, file))) as Record<string, unknown>;
    const lists = Object.entries(module).filter(([name, value]) => name.endsWith('MessageTypes') && Array.isArray(value));
    assert.equal(lists.length, 1, `${file} must export exactly one *MessageTypes list`);
    for (const type of lists[0]![1] as string[]) {
      assert.equal(owners.get(type), undefined, `${type} is owned by both ${owners.get(type)} and ${file}`);
      owners.set(type, file);
    }
  }
  assert.deepEqual([...owners.keys()].sort(), [...routedMessageTypes()].sort());
});

test('workspace messages are routed by the agency prefix families, not by exact type guesses', () => {
  const routed = routedMessageTypes();
  for (const type of [
    'agency.project.create', 'agency.workspace.done', 'agency.webTab.create', 'agency.editorTab.open',
    'agency.notification.done', 'agency.layout.save', 'agency.session.create', 'agency.profile.create',
    'agency.browserProfile.create',
  ]) assert.ok(routed.has(type), type);
});

test('dispatch hands a message to its handler with the context and does nothing for an unknown type', async () => {
  const calls: string[] = [];
  const ctx = {
    gitSubscriptions: new Set<string>(),
    repos: { refresh: (terminalId: string) => calls.push(`refresh:${terminalId}`) },
    send: () => undefined,
    sendError: () => undefined,
    sendPathError: () => undefined,
    socket: {},
  } as unknown as FullContext;
  await dispatchClientMessage({ type: 'git.refresh', terminalId: 't-1' } as never, ctx);
  assert.deepEqual(calls, ['refresh:t-1']);
  await dispatchClientMessage({ type: 'not.a.message' } as never, ctx);
  assert.deepEqual(calls, ['refresh:t-1']);
});

test('a failing handler rejects the dispatch so the connection can serialize the error', async () => {
  const ctx = {
    gitSubscriptions: new Set<string>(),
    repos: { refresh: () => { throw new Error('boom'); } },
    send: () => undefined,
    sendError: () => undefined,
    sendPathError: () => undefined,
    socket: {},
  } as unknown as FullContext;
  await assert.rejects(dispatchClientMessage({ type: 'git.refresh', terminalId: 't-1' } as never, ctx), /boom/);
});

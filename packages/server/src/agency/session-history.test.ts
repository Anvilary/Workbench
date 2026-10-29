/**
 * P-1: closed-tab history is retained (memory + disk + paged request) but excluded from live snapshots and
 * from the per-change rewrite of the live session file.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgencyRuntimeSession } from '@agent-workbench/shared';
import { parseAgencyClientMessage, parseAgencyServerMessage } from '@agent-workbench/shared';
import { AgencySessionStore, SplitAgencySessionStore, isLiveSession } from './agency-session-store.js';
import { AgencySessionRuntime } from './agency-session-runtime.js';

const WS_A = randomUUID();
const WS_B = randomUUID();

function row(options: { open: boolean; workspaceId?: string; superseded?: boolean; at?: string }): AgencyRuntimeSession {
  const at = options.at ?? new Date().toISOString();
  return {
    id: randomUUID(), workspaceId: options.workspaceId ?? WS_A, kind: 'terminal', profileId: null, nativeSessionId: null,
    selectedModel: null, selectedEffort: null, terminalId: null,
    lifecycle: 'exited', activity: 'offline', createdAt: at, updatedAt: at, startedAt: at, stoppedAt: at, exitCode: 0,
    tab: { id: randomUUID(), name: null, terminalNumber: 1, order: 0, selected: false, current: !options.superseded,
      closedAt: options.open || options.superseded ? null : at },
  } as unknown as AgencyRuntimeSession;
}

async function temp(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'maw-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('classification: open current tabs and active processes are live; closed and superseded are history', () => {
  assert.equal(isLiveSession(row({ open: true })), true);
  assert.equal(isLiveSession(row({ open: false })), false);
  assert.equal(isLiveSession(row({ open: false, superseded: true })), false);
  assert.equal(isLiveSession({ ...row({ open: false }), lifecycle: 'running' } as AgencyRuntimeSession), true, 'active process is never hidden');
});

test('split store: live file holds only live rows; history is rewritten only when history changes', async t => {
  const dir = await temp(t);
  const store = new SplitAgencySessionStore(path.join(dir, 'agency-sessions.json'));
  const live = [row({ open: true }), row({ open: true, workspaceId: WS_B })];
  const history = Array.from({ length: 300 }, () => row({ open: false }));
  await store.save([...live, ...history]);
  const liveFile = JSON.parse(await readFile(path.join(dir, 'agency-sessions.json'), 'utf8'));
  const historyFile = JSON.parse(await readFile(path.join(dir, 'agency-sessions-history.json'), 'utf8'));
  assert.equal(liveFile.sessions.length, 2);
  assert.equal(historyFile.sessions.length, 300);

  const before = await stat(path.join(dir, 'agency-sessions-history.json'));
  await new Promise(r => setTimeout(r, 20));
  const renamed = { ...live[0]!, tab: { ...live[0]!.tab!, name: 'renamed' }, updatedAt: new Date().toISOString() } as AgencyRuntimeSession;
  await store.save([renamed, live[1]!, ...history]);   // same history objects
  const after = await stat(path.join(dir, 'agency-sessions-history.json'));
  assert.equal(after.mtimeMs, before.mtimeMs, 'history file untouched by a live-only change');
  assert.equal(after.ino, before.ino);

  const closed = { ...renamed, tab: { ...renamed.tab!, closedAt: new Date().toISOString() } } as AgencyRuntimeSession;
  await store.save([closed, live[1]!, ...history]);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'agency-sessions-history.json'), 'utf8')).sessions.length, 301);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'agency-sessions.json'), 'utf8')).sessions.length, 1);

  const reloaded = await new SplitAgencySessionStore(path.join(dir, 'agency-sessions.json')).load();
  assert.equal(reloaded.length, 302, 'nothing lost across restart');
});

test('split store: closed history wins equal timestamps; strictly newer live state remains authoritative', async t => {
  const dir = await temp(t);
  const file = path.join(dir, 'agency-sessions.json');
  const closed = row({ open: false, at: '2026-10-29T10:00:00.000Z' });
  await new AgencySessionStore(path.join(dir, 'agency-sessions-history.json')).save([closed]);
  for (const at of ['2026-10-29T09:59:59.999Z', closed.updatedAt, '2026-10-29T10:00:00.001Z']) {
    const live = { ...closed, tab: { ...closed.tab!, closedAt: null }, updatedAt: at } as AgencyRuntimeSession;
    await new AgencySessionStore(file).save([live]);
    const [loaded] = await new SplitAgencySessionStore(file).load();
    assert.equal(loaded!.tab!.closedAt, at > closed.updatedAt ? null : closed.tab!.closedAt);
  }
});

for (const advanceClock of [false, true]) {
  test(`runtime close: crash after history write preserves closures across restart (${advanceClock ? 'newer' : 'equal'} timestamps)`, async t => {
    const dir = await temp(t);
    const file = path.join(dir, 'agency-sessions.json');
    const historyFile = path.join(dir, 'agency-sessions-history.json');
    const at = '2026-10-29T10:00:00.000Z';
    const first = row({ open: true, at });
    first.tab!.selected = true;
    const second = row({ open: true, at });
    const survivor = row({ open: true, at });
    const active = { ...row({ open: true, workspaceId: WS_B, at }), lifecycle: 'running', stoppedAt: null } as AgencyRuntimeSession;
    const history = [row({ open: false, at }), row({ open: false, superseded: true, at })];
    const rows = [first, second, survivor, active, ...history];
    await new SplitAgencySessionStore(file).save(rows);

    // Exit the child at the actual live-store save boundary. The real split store has already committed
    // history, and process.exit prevents runtime error handling or shutdown from saving anything else.
    const script = `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { EventEmitter } from 'node:events';
      import { AgencySessionRuntime } from ${JSON.stringify(new URL('./agency-session-runtime.ts', import.meta.url).href)};
      import { AgencySessionStore, SplitAgencySessionStore } from ${JSON.stringify(new URL('./agency-session-store.ts', import.meta.url).href)};
      mock.timers.enable({ apis: ['Date'], now: ${Date.parse(at)} });
      const registry = Object.assign(new EventEmitter(), {
        open: async () => { throw new Error('unexpected launch'); }, get: () => null, has: () => false,
        list: () => [], close: () => true, activityOf: () => 'unknown',
      });
      const runtime = new AgencySessionRuntime({ registry, store: new SplitAgencySessionStore(${JSON.stringify(file)}),
        profiles: { resolveLaunch: async () => { throw new Error('unexpected launch'); } },
        workspaces: { protectedDirectories: () => [], withSessionReservation: async (_, action) => action(null) },
      });
      await runtime.initialize();
      mock.timers.setTime(${Date.parse(at) + 1000});
      await runtime.tabAction(${JSON.stringify(WS_A)}, ${JSON.stringify(second.tab!.id)}, 'select');
      assert.equal(runtime.get(${JSON.stringify(second.id)}).updatedAt, new Date().toISOString(), 'selection timestamps changed rows');
      await runtime.tabAction(${JSON.stringify(WS_A)}, ${JSON.stringify(first.tab!.id)}, 'close');
      assert.equal(runtime.get(${JSON.stringify(first.id)}).updatedAt, new Date().toISOString(), 'close timestamps changed rows');
      ${advanceClock ? `mock.timers.setTime(${Date.parse(at) + 1001});` : ''}
      const save = AgencySessionStore.prototype.save;
      AgencySessionStore.prototype.save = function (sessions) {
        if (this.file === ${JSON.stringify(file)}) process.exit(73);
        return save.call(this, sessions);
      };
      await runtime.tabAction(${JSON.stringify(WS_A)}, ${JSON.stringify(second.tab!.id)}, 'close');
      throw new Error('crash boundary was not reached');
    `;
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script]),
      (error: unknown) => { assert.equal((error as { code: number; stderr: string }).code, 73, (error as { stderr: string }).stderr); return true; });

    const staleLive = await new AgencySessionStore(file).load();
    const committedHistory = await new AgencySessionStore(historyFile).load();
    const staleSecond = staleLive.find(s => s.id === second.id)!;
    const closedSecond = committedHistory.find(s => s.id === second.id)!;
    assert.equal(staleSecond.tab!.closedAt, null, 'live file still contains the pre-close row');
    assert.equal(closedSecond.updatedAt, closedSecond.tab!.closedAt);
    assert.equal(Date.parse(closedSecond.updatedAt) - Date.parse(staleSecond.updatedAt), advanceClock ? 1 : 0);
    for (const previous of history) assert.deepEqual(committedHistory.find(s => s.id === previous.id), previous);

    // Two complete initializations also exercise the first post-crash repair save and another restart.
    for (let restart = 0; restart < 2; restart++) {
      const registry = Object.assign(new EventEmitter(), {
        open: async () => { throw new Error('unexpected launch'); }, get: () => null, has: () => false,
        list: () => [], close: () => true, activityOf: () => 'unknown' as const,
      });
      const runtime = new AgencySessionRuntime({
        registry: registry as unknown as ConstructorParameters<typeof AgencySessionRuntime>[0]['registry'],
        store: new SplitAgencySessionStore(file),
        profiles: { resolveLaunch: async () => { throw new Error('unexpected launch'); } },
        workspaces: { protectedDirectories: () => [], withSessionReservation: async (_, action) => action(null) },
      });
      t.after(() => runtime.dispose());
      await runtime.initialize();
      assert.equal(runtime.list().length, rows.length, 'every live and historical record survives');
      assert.deepEqual(new Set(runtime.liveList().map(s => s.id)), new Set([survivor.id, active.id]));
      assert.equal(runtime.get(active.id)!.recovery?.status, 'pending', 'active sibling remains eligible for normal recovery');
      for (const closed of [first, second]) {
        assert.ok(runtime.get(closed.id)!.tab!.closedAt);
        assert.notEqual(runtime.get(closed.id)!.recovery?.status, 'pending');
      }
      for (const previous of history) assert.deepEqual(runtime.get(previous.id), previous);
      runtime.dispose();
    }
  });
}

test('split store: legacy single-file history migrates on first save without loss; corrupt history recovers from backup', async t => {
  const dir = await temp(t);
  const file = path.join(dir, 'agency-sessions.json');
  const rows = [row({ open: true }), ...Array.from({ length: 20 }, () => row({ open: false }))];
  await new AgencySessionStore(file).save(rows);   // what an older build wrote
  const store = new SplitAgencySessionStore(file);
  const loaded = await store.load();
  assert.equal(loaded.length, 21);
  await store.save(loaded);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).sessions.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'agency-sessions-history.json'), 'utf8')).sessions.length, 20);

  // Second history save creates a validated backup; then corrupt the primary history file.
  const extra = row({ open: false });
  await store.save([...loaded, extra]);
  await copyFile(path.join(dir, 'agency-sessions-history.json'), path.join(dir, 'keep.json'));
  await writeFile(path.join(dir, 'agency-sessions-history.json'), '{ corrupt');
  const recovered = await new SplitAgencySessionStore(file).load();
  assert.ok(recovered.length >= 21, 'backup recovery keeps history');
});

test('single-file downgrade leaves split history untouched and a later upgrade retains both generations', async t => {
  const dir = await temp(t);
  const file = path.join(dir, 'agency-sessions.json');
  const historyFile = path.join(dir, 'agency-sessions-history.json');
  const live = row({ open: true });
  const history = [row({ open: false }), row({ open: false, superseded: true })];
  const split = new SplitAgencySessionStore(file);
  await split.save([live, ...history]);
  await split.save([live, ...history, row({ open: false })]);
  const before = await Promise.all([readFile(historyFile), readFile(historyFile + '.bak')]);
  const single = new AgencySessionStore(file);
  assert.deepEqual(await single.load(), [live], 'older release sees the live file only');
  const closedDuringDowngrade = row({ open: false });
  await single.save([live, closedDuringDowngrade]);
  assert.deepEqual(await Promise.all([readFile(historyFile), readFile(historyFile + '.bak')]), before, 'dormant history and backup are byte-identical');
  const upgraded = new SplitAgencySessionStore(file);
  const restored = await upgraded.load();
  assert.equal(restored.length, 5);
  assert.deepEqual(restored.find(s => s.id === live.id), live);
  for (const previous of [...history, closedDuringDowngrade]) assert.deepEqual(restored.find(s => s.id === previous.id), previous);
  await upgraded.save(restored);
  assert.deepEqual(await new AgencySessionStore(file).load(), [live]);
  assert.equal((await new SplitAgencySessionStore(file).load()).length, 5);
});

test('runtime: snapshots carry live rows only; history is paged newest-first and workspace-scoped', async t => {
  const dir = await temp(t);
  const rows = [
    row({ open: true }), row({ open: true, workspaceId: WS_B }),
    ...Array.from({ length: 120 }, (_, i) => row({ open: false, at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() })),
    row({ open: false, workspaceId: WS_B }),
  ];
  const store = new SplitAgencySessionStore(path.join(dir, 'agency-sessions.json'));
  await store.save(rows);
  const registry = Object.assign(new EventEmitter(), {
    open: async () => { throw new Error('no launch'); }, get: () => null, has: () => false, list: () => [],
    close: () => undefined, activityOf: () => 'unknown',
  });
  const runtime = new AgencySessionRuntime({
    registry: registry as unknown as ConstructorParameters<typeof AgencySessionRuntime>[0]['registry'],
    store,
    profiles: { resolveLaunch: async () => { throw new Error('no launch'); } },
    workspaces: { protectedDirectories: () => [], withSessionReservation: async () => { throw new Error('unused'); } },
  });
  await runtime.initialize();
  assert.equal(runtime.list().length, 123, 'history retained in memory');
  assert.equal(runtime.liveList().length, 2);
  assert.equal(runtime.liveList(WS_A as never).length, 1);
  const first = runtime.history({ workspaceId: WS_A as never, limit: 50 });
  assert.equal(first.total, 120);
  assert.equal(first.sessions.length, 50);
  assert.ok(first.sessions[0]!.tab!.closedAt! > first.sessions[49]!.tab!.closedAt!, 'newest first');
  const last = runtime.history({ workspaceId: WS_A as never, offset: 100, limit: 50 });
  assert.equal(last.sessions.length, 20);
  assert.equal(runtime.history({ workspaceId: WS_B as never }).total, 1);
  const bytes = Buffer.byteLength(JSON.stringify({ type: 'agency.sessions.snapshot', requestId: '', sessions: runtime.liveList() }));
  assert.ok(bytes < 4000, `live snapshot ${bytes} B`);
  await runtime.dispose?.();
});

test('protocol: history request is bounded and validated; reply parses', () => {
  const requestId = 'r';
  assert.deepEqual(parseAgencyClientMessage({ type: 'agency.sessions.history', requestId }), { type: 'agency.sessions.history', requestId, offset: 0, limit: 50 });
  assert.equal(parseAgencyClientMessage({ type: 'agency.sessions.history', requestId, limit: 1000 }), null);
  assert.equal(parseAgencyClientMessage({ type: 'agency.sessions.history', requestId, offset: -1 }), null);
  assert.equal(parseAgencyClientMessage({ type: 'agency.sessions.history', requestId, workspaceId: '../x' }), null);
  assert.equal(parseAgencyClientMessage({ type: 'agency.sessions.history', requestId, cwd: '/' }), null);
  const reply = { type: 'agency.sessions.history', requestId, sessions: [], total: 7, offset: 0 };
  assert.deepEqual(parseAgencyServerMessage(reply), reply);
});

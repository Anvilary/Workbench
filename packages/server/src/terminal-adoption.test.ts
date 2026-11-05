import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalRegistry } from './terminal-registry.js';
import { PtyHostClient } from './pty-host/pty-host-client.js';
import { OutputBuffer } from './output-buffer.js';

for (const existing of [false, true]) test(`adoption stages output across snapshot cutoff (${existing ? 'existing' : 'new'} entry)`, async () => {
  const original = PtyHostClient.connectOrSpawn;
  let emitData: (id: string, data: string, offset: number) => void = () => {};
  let resolveReplay: ((value: object) => void) | undefined;
  const observed: object[] = [];
  const fake = {
    snapshot: { sessions: [{ id: 'adopt', alive: true, pid: 1, cwd: '/tmp', createdAt: new Date().toISOString() }], tombstones: [] },
    onData(fn: typeof emitData) { emitData = fn; }, onExit() {}, detach() {},
    replay() { return new Promise<object>(resolve => { resolveReplay = resolve; }); },
  };
  // Deliberately fake the host boundary only. initialize/adoption and both replay
  // paths below execute the real registry and real headless terminal checkpoint.
  PtyHostClient.connectOrSpawn = async () => fake as unknown as PtyHostClient;
  const registry = new TerminalRegistry({} as never, null, {} as never, undefined, undefined, undefined, { persistentPty: true });
  if (existing) {
    const buffer = new OutputBuffer();
    buffer.push('STALE');
    (registry as any).terminals.set('adopt', {
      descriptor: { terminalId: 'adopt', alive: false }, session: null, buffer,
      listeners: new Set([(_id: string, data: string, offset: number) => observed.push({ data, offset })]),
      size: { cols: 80, rows: 24 }, launchHook: { cancel() {} }, stopWatchingActivity: null,
    });
  }
  try {
    const initialized = registry.initialize();
    while (!resolveReplay) await new Promise(resolve => setImmediate(resolve));
    emitData('adopt', 'BASE', 4);
    emitData('adopt', '🧪LATE', 12);
    emitData('adopt', '界', 15);
    resolveReplay!({ data: 'BASE🧪', startOffset: 0, endOffset: 8, truncated: false,
      screen: { data: 'BASE🧪', cols: 80, rows: 24 } });
    await initialized;
    const raw = registry.attach('adopt', () => {});
    assert.equal(raw?.replay, 'BASE🧪LATE界');
    assert.equal(raw?.endOffset, 15);
    const screen = await registry.renderingReplay('adopt', () => {});
    assert.ok(screen?.replay.includes('BASE🧪LATE界'));
    assert.equal(screen?.endOffset, 15);
    if (existing) assert.deepEqual(observed, [{ data: 'LATE', offset: 12 }, { data: '界', offset: 15 }]);
  } finally {
    registry.disposeAll();
    PtyHostClient.connectOrSpawn = original;
  }
});

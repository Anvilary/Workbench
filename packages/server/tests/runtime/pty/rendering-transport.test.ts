import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error - standalone pure-ESM supervisor script
import { PtySupervisor } from '../../../src/pty-host/maw-ptyd.mjs';
import { PtyHostClient } from '../../../src/pty-host/pty-host-client.js';
import { TerminalState } from '../../../src/pty-host/terminal-state.mjs';

test('burst rendering checkpoint retains modes and preserves resize and snapshot order', async () => {
  const state = new TerminalState();
  try {
    state.push('before alternate\x1b[?1049h');
    for (let chunk = 0; chunk < 9000; chunk++) state.push('x'.repeat(80));
    state.resize(92, 28);
    state.push('\r\nBEFORE_CHECKPOINT');
    const snapshot = state.snapshot();
    state.push('\r\nAFTER_CHECKPOINT');
    const captured = await snapshot;
    assert.equal(captured.cols, 92);
    assert.equal(captured.rows, 28);
    assert.match(captured.data, /before alternate.*\x1b\[\?1049h/s);
    assert.match(captured.data, /BEFORE_CHECKPOINT/);
    assert.doesNotMatch(captured.data, /AFTER_CHECKPOINT/);
    assert.match((await state.snapshot()).data, /AFTER_CHECKPOINT/);
  } finally {
    state.dispose();
  }
});

function isolatedHost() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-render-transport-'));
  return {
    tmpDir,
    socketPath: path.join(tmpDir, 'host.sock'),
    authPath: path.join(tmpDir, 'host.auth'),
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, description: string, timeoutMs = 5000) {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await delay(20);
  assert.ok(predicate(), `Timed out waiting for ${description}`);
}

async function startHost() {
  const env = isolatedHost();
  const supervisor = new PtySupervisor({ socketPath: env.socketPath, authPath: env.authPath });
  await supervisor.listen();
  const client = await PtyHostClient.connectOrSpawn({ socketPath: env.socketPath, authPath: env.authPath, autoSpawn: false });
  return { env, supervisor, client };
}

async function spawnScript(client: PtyHostClient, cwd: string, id: string, script: string, cols = 80, rows = 24) {
  return client.spawn({ id, sessionId: `render-${id}`, cmd: process.execPath, args: ['-e', script], cwd, cols, rows });
}

test('PTY transport preserves UTF-8 and split true-color ANSI sequences across writes', async () => {
  const { env, supervisor, client } = await startHost();
  try {
    let received = '';
    client.onData((id, chunk) => { if (id === 'utf8-ansi') received += chunk; });
    await spawnScript(client, env.tmpDir, 'utf8-ansi', [
      "const a=Buffer.from('UTF8: café 🧪\\n');",
      "process.stdout.write(a.subarray(0, 10));",
      "setTimeout(()=>process.stdout.write(a.subarray(10, 13)), 40);",
      "setTimeout(()=>process.stdout.write(a.subarray(13)), 60);",
      "setTimeout(()=>process.stdout.write(Buffer.from([0x1b,0x5b,0x33,0x38,0x3b])), 80);",
      "setTimeout(()=>process.stdout.write(Buffer.from('2;255;128;64mRGB_MARK\\x1b[0m')), 120);",
      "setTimeout(()=>process.exit(0), 200);",
    ].join(''));
    await until(() => received.includes('RGB_MARK'), 'split UTF-8 and ANSI output');
    assert.ok(received.includes('UTF8: café 🧪'));
    assert.ok(!received.includes('\uFFFD'), 'split multibyte characters must not be replaced');
    assert.deepEqual(Buffer.from(received.slice(0, received.indexOf('\x1b')), 'utf8'), Buffer.from('UTF8: café 🧪\r\n', 'utf8'));
    assert.ok(received.includes('\x1b[38;2;255;128;64mRGB_MARK\x1b[0m'));
  } finally {
    client.detach();
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('host client decodes replay checkpoint JSON split inside a raw Unicode character', async () => {
  const { env, supervisor, client } = await startHost();
  try {
    const reqId = 'split-checkpoint-utf8';
    let resolveReplay!: (value: unknown) => void;
    const replayResult = new Promise<unknown>((resolve) => { resolveReplay = resolve; });
    (client as any)._registerPending(reqId, resolveReplay, (error: Error) => { throw error; });
    const message = JSON.stringify({
      op: 'replay_data', reqId, id: 'unicode-screen', reset: true,
      startOffset: 0, endOffset: 0, dataB64: '', truncated: false,
      screen: { data: 'SCREEN café 🧪', cols: 80, rows: 24 },
    }) + '\n';
    const bytes = Buffer.from(message, 'utf8');
    const splitAt = bytes.indexOf(Buffer.from('é', 'utf8')) + 1;
    (client as any)._onData(bytes.subarray(0, splitAt));
    (client as any)._onData(bytes.subarray(splitAt));
    const replay = await replayResult as { screen: { data: string; cols: number; rows: number } };
    assert.deepEqual(replay.screen, { data: 'SCREEN café 🧪', cols: 80, rows: 24 });
  } finally {
    client.detach();
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('parallel PTYs keep output and resize checkpoints isolated', async () => {
  const { env, supervisor, client } = await startHost();
  try {
    const output = new Map<string, string>([['left', ''], ['right', '']]);
    client.onData((id, chunk) => { if (output.has(id)) output.set(id, output.get(id)! + chunk); });
    const script = "process.stdout.write('READY\\n');process.on('SIGWINCH',()=>process.stdout.write('SIZE='+process.stdout.columns+'x'+process.stdout.rows+'\\n'));process.stdin.on('data',()=>{});";
    await spawnScript(client, env.tmpDir, 'left', script, 80, 24);
    await spawnScript(client, env.tmpDir, 'right', script, 100, 30);
    await until(() => output.get('left')!.includes('READY') && output.get('right')!.includes('READY'), 'both PTYs ready');
    client.resize('left', 121, 37);
    client.resize('right', 91, 29);
    await until(() => output.get('left')!.includes('SIZE=121x37') && output.get('right')!.includes('SIZE=91x29'), 'independent PTY resize reports');
    let left = await client.replay('left');
    let right = await client.replay('right');
    const resizeStart = Date.now();
    while ((left.screen?.cols !== 121 || left.screen?.rows !== 37 || right.screen?.cols !== 91 || right.screen?.rows !== 29) && Date.now() - resizeStart < 3000) {
      await delay(25);
      left = await client.replay('left');
      right = await client.replay('right');
    }
    assert.deepEqual([left.screen?.cols, left.screen?.rows], [121, 37]);
    assert.deepEqual([right.screen?.cols, right.screen?.rows], [91, 29]);
  } finally {
    client.detach();
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

test('reattached TUI checkpoint survives raw ring truncation and resumes exact raw deltas', async () => {
  const { env, supervisor, client } = await startHost();
  let adopted: PtyHostClient | undefined;
  try {
    const id = 'large-tui';
    const script = [
      "process.stdout.write('BOOT\\n');",
      "setTimeout(()=>{process.stdout.write('\\x1b[?1049h\\x1b[2J');",
      "for(let i=0;i<7000;i++) process.stdout.write('\\x1b['+((i%20)+1)+';1H\\x1b[38;2;12;34;56mFRAME_'+i+'_'+('x'.repeat(35))+'\\x1b[0m');",
      "process.stdout.write('\\x1b[10;1HFINAL_TUI_MARK\\x1b[0m');}, 80);",
      "process.stdin.on('data',d=>{if(d.toString().includes('CONTINUE')) process.stdout.write('AFTER_REATTACH_DELTA');});",
    ].join('');
    await spawnScript(client, env.tmpDir, id, script, 100, 30);
    let output = '';
    client.onData((session, chunk) => { if (session === id) output += chunk; });
    await until(() => output.includes('FINAL_TUI_MARK'), 'large TUI output');
    const before = await client.replay(id);
    assert.equal(before.reset, true);
    assert.ok(before.endOffset > 262_144, 'raw output watermark should pass the replay ring capacity');
    assert.ok(before.truncated);
    assert.ok(Buffer.byteLength(before.data, 'utf8') <= 262_144 + 8, 'raw replay is capped at 256 KiB plus optional alternate-screen prefix');
    client.detach();

    adopted = await PtyHostClient.connectOrSpawn({ socketPath: env.socketPath, authPath: env.authPath, autoSpawn: false });
    const checkpoint = await adopted.replay(id);
    assert.equal(checkpoint.reset, true);
    assert.ok(checkpoint.screen, 'reset replay carries a terminal checkpoint');
    assert.deepEqual([checkpoint.screen.cols, checkpoint.screen.rows], [100, 30]);
    assert.ok(checkpoint.screen.data.includes('FINAL_TUI_MARK'), 'checkpoint contains the rendered final TUI marker');
    assert.ok(checkpoint.endOffset > checkpoint.startOffset);

    const watermark = checkpoint.endOffset;
    let resumedOutput = '';
    adopted.onData((session, chunk) => { if (session === id) resumedOutput += chunk; });
    adopted.write(id, 'CONTINUE\n');
    await until(() => resumedOutput.includes('AFTER_REATTACH_DELTA'), 'post-reattach PTY output');
    const delta = await adopted.replay(id, watermark);
    assert.equal(delta.reset, false, 'the checkpoint watermark remains a valid raw replay offset');
    assert.equal(delta.sinceOffset, watermark);
    assert.ok(delta.data.includes('AFTER_REATTACH_DELTA'));
    assert.equal(delta.endOffset - watermark, Buffer.byteLength(delta.data, 'utf8'), 'raw endOffset advances by exactly the raw delta byte count');
  } finally {
    adopted?.detach();
    supervisor.close({ killAll: true });
    env.cleanup();
  }
});

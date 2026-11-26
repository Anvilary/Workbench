// Remount fidelity: what a client gets back when it unmounts its xterm and reattaches.
//
// The browser never reads the supervisor ring directly. It attaches over the socket,
// the registry answers with `renderingReplay` (terminal-registry.ts), and that is
// either the registry's own TerminalState checkpoint (`reset:true`, when the requested
// offset was evicted) or a raw byte delta from `sliceFrom` (`reset:false`). These tests
// drive the real registry OutputBuffer with the output of a real PTY on an isolated
// supervisor, apply the answer to a headless terminal exactly as the web client does,
// and compare that terminal against a reference fed the entire raw stream.
//
// Run: tsx --test packages/server/tests/runtime/pty/terminal-remount-fidelity.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import headless from '@xterm/headless';
// @ts-expect-error - standalone pure-ESM supervisor script
import { PtySupervisor } from '../../../src/pty-host/maw-ptyd.mjs';
import { PtyHostClient } from '../../../src/pty-host/pty-host-client.js';
import { OutputBuffer } from '../../../src/features/terminals/output-buffer.js';

const COLS = 90;
const ROWS = 26;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, description: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) await delay(20);
  assert.ok(predicate(), `Timed out waiting for ${description}`);
}

function isolatedHost() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maw-remount-fidelity-'));
  return {
    tmpDir,
    socketPath: path.join(tmpDir, 'host.sock'),
    authPath: path.join(tmpDir, 'host.auth'),
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

async function startHost() {
  const env = isolatedHost();
  const supervisor = new PtySupervisor({ socketPath: env.socketPath, authPath: env.authPath });
  await supervisor.listen();
  const client = await PtyHostClient.connectOrSpawn({
    socketPath: env.socketPath,
    authPath: env.authPath,
    autoSpawn: false,
  });
  return { env, supervisor, client };
}

/**
 * A TUI driven over stdin so the test controls exactly what happens while the client
 * is detached: alternate screen, cursor addressing, SGR (truecolor, 256 color, bold,
 * italic, inverse) and UTF-8 characters whose bytes are deliberately split across
 * separate writes, so the PTY read boundary falls inside a multibyte sequence.
 */
const TUI_SCRIPT = [
  "const w=(s)=>process.stdout.write(s);",
  "const raw=(b)=>process.stdout.write(Buffer.from(b));",
  "w('normal line one\\r\\nnormal line two\\r\\n');",
  "w('\\x1b[?1049h\\x1b[2J\\x1b[H');",
  "for(let r=1;r<=12;r++){w('\\x1b['+r+';1H\\x1b[38;2;'+(r*7%256)+';'+(r*13%256)+';64m\\x1b[1mROW_'+r+'\\x1b[0m \\x1b[38;5;'+(100+r)+'\\x1b[3mdim\\x1b[0m \\x1b[7minv\\x1b[0m');}",
  // Split multibyte characters across writes: cafe-acute, a CJK glyph and an emoji.
  "const u=Buffer.from('caf\\u00e9 \\u6f22 \\ud83e\\uddea END');",
  "w('\\x1b[14;1H');",
  "let i=0;const feed=()=>{if(i>=u.length){w('\\x1b[16;1HREADY_ONE');return;}const n=1+(i%3);raw(u.subarray(i,i+n));i+=n;setTimeout(feed,6);};feed();",
  "let line=0;",
  "process.stdin.on('data',(d)=>{const s=d.toString();",
  "if(s.includes('BURST')){",
  "  for(let k=0;k<4200;k++){const r=(k%10)+17;w('\\x1b['+r+';1H\\x1b[38;2;'+(k%256)+';'+((k*3)%256)+';'+((k*7)%256)+'mB'+k+'_'+'y'.repeat(50)+'\\x1b[0m');}",
  "  w('\\x1b[20;1HBURST_DONE');}",
  "if(s.includes('SMALL')){line++;w('\\x1b['+(22+(line%2))+';1H\\x1b[38;2;9;99;199m\\x1b[1mSMALL_'+line+'_caf\\u00e9_\\u6f22_\\ud83e\\uddea\\x1b[0m SMALL_OK_'+line);}",
  "if(s.includes('FINAL')){w('\\x1b[25;1H\\x1b[4mFINAL_MARK\\x1b[0m\\x1b[12;7H');}",
  "});",
].join('');

interface ClientReplay {
  readonly reset: boolean;
  readonly data: string;
  readonly truncated: boolean;
  readonly endOffset: number;
  readonly cols?: number;
  readonly rows?: number;
}

/** The server side of an attach, as `renderingReplay` builds it for a socket. */
async function renderingReplay(buffer: OutputBuffer, sinceOffset?: number): Promise<ClientReplay> {
  const start = buffer.startOffset;
  const end = buffer.endOffset;
  if (sinceOffset === undefined || sinceOffset < start || sinceOffset > end) {
    const checkpoint = await buffer.checkpoint();
    return {
      reset: true,
      data: checkpoint.data,
      truncated: buffer.isTruncated(),
      endOffset: checkpoint.endOffset,
      cols: checkpoint.cols,
      rows: checkpoint.rows,
    };
  }
  const slice = buffer.sliceFrom(sinceOffset);
  if (!slice.reset) {
    return { reset: false, data: slice.data, truncated: slice.truncated, endOffset: slice.endOffset };
  }
  const checkpoint = await buffer.checkpoint();
  return {
    reset: true,
    data: checkpoint.data,
    truncated: slice.truncated,
    endOffset: checkpoint.endOffset,
    cols: checkpoint.cols,
    rows: checkpoint.rows,
  };
}

const write = (term: any, data: string): Promise<void> =>
  new Promise((resolve) => term.write(data, () => resolve()));

/**
 * The client side of an attach. Mirrors `TerminalOutput` in
 * packages/web/src/features/terminals/terminal-output.ts: CAN to abandon any partial
 * escape sequence, reset (or the soft reset that keeps scrollback), resize to the
 * checkpoint geometry, write, resize back. Offset-order and exactly-once handling of
 * `output()` is covered by that module's own unit tests; this helper only applies a
 * replay frame.
 */
async function applyReplay(term: any, replay: ClientReplay): Promise<void> {
  if (!replay.reset) {
    await write(term, replay.data);
    return;
  }
  const { cols, rows } = term;
  const preserveScrollback = replay.truncated && term.buffer.normal.baseY > 0;
  await write(term, '\x18');
  if (preserveScrollback) await write(term, '\x1b[!p\x1b[?1049l\r\n');
  else term.reset();
  if (replay.cols && replay.rows) term.resize(replay.cols, replay.rows);
  await write(term, replay.data);
  if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
}

function newTerminal(): any {
  return new (headless as any).Terminal({ cols: COLS, rows: ROWS, scrollback: 42_000, allowProposedApi: true });
}

interface CellSnapshot {
  readonly chars: string;
  readonly width: number;
  readonly fg: number;
  readonly bg: number;
  readonly flags: string;
}

function screenCells(term: any): CellSnapshot[][] {
  const buffer = term.buffer.active;
  const rows: CellSnapshot[][] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const cells: CellSnapshot[] = [];
    for (let x = 0; x < term.cols; x++) {
      const cell = line?.getCell(x);
      cells.push({
        chars: cell ? cell.getChars() : '',
        width: cell ? cell.getWidth() : 1,
        fg: cell ? cell.getFgColor() : -1,
        bg: cell ? cell.getBgColor() : -1,
        flags: cell
          ? `${cell.isBold() ? 'b' : ''}${cell.isItalic() ? 'i' : ''}${cell.isInverse() ? 'v' : ''}${cell.isUnderline() ? 'u' : ''}`
          : '',
      });
    }
    rows.push(cells);
  }
  return rows;
}

function screenText(term: any): string {
  return screenCells(term)
    // Wide glyphs own a trailing zero-width cell: skipping it keeps the text readable.
    .map((row) => row.filter((cell) => cell.width > 0).map((cell) => cell.chars || ' ').join('').replace(/\s+$/, ''))
    .join('\n');
}

/** Every visible cell, the cursor and the active buffer type must match the reference. */
function assertScreenMatches(restored: any, reference: any, label: string): void {
  assert.equal(restored.buffer.active.type, reference.buffer.active.type, `${label}: active buffer type`);
  assert.equal(restored.cols, reference.cols, `${label}: cols`);
  assert.equal(restored.rows, reference.rows, `${label}: rows`);
  const got = screenCells(restored);
  const want = screenCells(reference);
  for (let y = 0; y < want.length; y++) {
    for (let x = 0; x < want[y]!.length; x++) {
      assert.deepEqual(got[y]![x], want[y]![x], `${label}: cell mismatch at row ${y} col ${x}\n--- restored ---\n${screenText(restored)}\n--- reference ---\n${screenText(reference)}`);
    }
  }
  assert.equal(restored.buffer.active.cursorX, reference.buffer.active.cursorX, `${label}: cursorX`);
  assert.equal(restored.buffer.active.cursorY, reference.buffer.active.cursorY, `${label}: cursorY`);
}

/**
 * Wires a real PTY to a registry OutputBuffer (what the backend does for every chunk)
 * plus a reference terminal fed the whole raw stream, and a client terminal whose feed
 * can be switched off to emulate an unmounted or unsubscribed view.
 */
async function fidelityRig() {
  const { env, supervisor, client } = await startHost();
  const id = 'remount-fidelity';
  const buffer = new OutputBuffer();
  const reference = newTerminal();
  let clientTerm: any = newTerminal();
  let attachedOffset: number | undefined;
  let subscribed = true;
  let raw = '';
  const pendingReference: Promise<void>[] = [];

  client.onData((session, chunk) => {
    if (session !== id) return;
    raw += chunk;
    buffer.push(chunk);
    pendingReference.push(write(reference, chunk));
    if (subscribed) {
      const offset = buffer.endOffset;
      pendingReference.push(write(clientTerm, chunk).then(() => { attachedOffset = offset; }));
    }
  });

  // The registry sizes the checkpoint terminal to the PTY before spawning it
  // (terminal-registry.ts:1074); without that the checkpoint would be 80x24.
  buffer.resize(COLS, ROWS);

  await client.spawn({
    id,
    sessionId: `fidelity-${id}`,
    cmd: process.execPath,
    args: ['-e', TUI_SCRIPT],
    cwd: env.tmpDir,
    cols: COLS,
    rows: ROWS,
  });

  return {
    env,
    supervisor,
    client,
    id,
    buffer,
    reference,
    get clientTerm() { return clientTerm; },
    get raw() { return raw; },
    get attachedOffset() { return attachedOffset; },
    settle: async () => { await Promise.all(pendingReference.splice(0, pendingReference.length)); },
    detach: () => { subscribed = false; },
    reattach: () => { subscribed = true; },
    remount: () => {
      clientTerm.dispose();
      clientTerm = newTerminal();
    },
    cleanup: () => {
      clientTerm.dispose();
      reference.dispose();
      buffer.dispose();
      client.detach();
      supervisor.close({ killAll: true });
      env.cleanup();
    },
  };
}

test('remount after more than 256 KiB of hidden output restores the alternate screen cell for cell', async () => {
  const rig = await fidelityRig();
  try {
    await until(() => rig.raw.includes('READY_ONE'), 'initial TUI paint');
    await rig.settle();
    const offsetWhileVisible = rig.attachedOffset;
    assert.ok(offsetWhileVisible !== undefined, 'the attached view tracked a byte offset');
    assert.ok(screenText(rig.clientTerm).includes('café 漢 🧪 END'), 'split multibyte characters reached the live view');

    // The view unmounts its xterm: PTY keeps running, output keeps filling the ring.
    rig.detach();
    rig.remount();
    rig.client.write(rig.id, 'BURST\n');
    await until(() => rig.raw.includes('BURST_DONE'), 'hidden burst beyond the ring capacity');
    rig.client.write(rig.id, 'FINAL\n');
    await until(() => rig.raw.includes('FINAL_MARK'), 'post-burst marker');
    await rig.settle();

    const hiddenBytes = rig.buffer.endOffset - offsetWhileVisible;
    assert.ok(hiddenBytes > 262_144, `hidden output must exceed the 256 KiB ring (was ${hiddenBytes})`);
    assert.ok(rig.buffer.isTruncated(), 'the ring evicted history while the view was unmounted');

    const replay = await renderingReplay(rig.buffer, offsetWhileVisible);
    assert.equal(replay.reset, true, 'an evicted offset must answer reset:true with a screen checkpoint');
    assert.deepEqual([replay.cols, replay.rows], [COLS, ROWS]);

    rig.reattach();
    await applyReplay(rig.clientTerm, replay);
    await rig.settle();

    assertScreenMatches(rig.clientTerm, rig.reference, 'checkpoint restore');
    assert.equal(rig.clientTerm.buffer.active.type, 'alternate', 'the TUI must come back on the alternate screen');
    const restored = screenText(rig.clientTerm);
    assert.ok(restored.includes('FINAL_MARK'), 'the restored screen carries the last TUI paint');
    assert.ok(restored.includes('café 漢 🧪 END'), 'split multibyte characters survive the checkpoint');
    assert.ok(!restored.includes('�'), 'no replacement characters in the restored screen');

    // Documented bound, not a fidelity failure: scrollback evicted from the 256 KiB ring
    // cannot come back from a screen checkpoint. Only the visible screen is restored.
    assert.ok(rig.reference.buffer.normal.length >= rig.clientTerm.buffer.normal.length);
  } finally {
    rig.cleanup();
  }
});

test('reattach with a small hidden gap replays raw bytes from sinceOffset without a reset', async () => {
  const rig = await fidelityRig();
  try {
    await until(() => rig.raw.includes('READY_ONE'), 'initial TUI paint');
    await rig.settle();
    const offsetWhileVisible = rig.attachedOffset;
    assert.ok(offsetWhileVisible !== undefined);

    // Output subscription dropped while the xterm instance stays mounted.
    rig.detach();
    for (let i = 0; i < 3; i++) {
      rig.client.write(rig.id, 'SMALL\n');
      await until(() => rig.raw.includes(`SMALL_OK_${i + 1}`), `small hidden write ${i + 1}`);
    }
    rig.client.write(rig.id, 'FINAL\n');
    await until(() => rig.raw.includes('FINAL_MARK'), 'post-gap marker');
    await rig.settle();

    const hiddenBytes = rig.buffer.endOffset - offsetWhileVisible;
    assert.ok(hiddenBytes > 0 && hiddenBytes < 262_144, `the gap must stay inside the ring (was ${hiddenBytes})`);

    const replay = await renderingReplay(rig.buffer, offsetWhileVisible);
    assert.equal(replay.reset, false, 'a retained offset replays raw bytes, no reset');
    assert.equal(
      replay.endOffset - offsetWhileVisible,
      Buffer.byteLength(replay.data, 'utf8'),
      'the delta advances the offset by exactly its raw byte count',
    );

    rig.reattach();
    await applyReplay(rig.clientTerm, replay);
    await rig.settle();

    assertScreenMatches(rig.clientTerm, rig.reference, 'small-gap replay');
    assert.equal(rig.clientTerm.buffer.active.type, 'alternate', 'the gap replay must not leave the alternate screen');
    const restored = screenText(rig.clientTerm);
    assert.ok(restored.includes('SMALL_OK_3'));
    assert.ok(restored.includes('café 漢 🧪 END'));
    assert.ok(!restored.includes('�'), 'split multibyte characters stay intact across the gap');
  } finally {
    rig.cleanup();
  }
});

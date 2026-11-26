import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TerminalOutput } from '../../../src/features/terminals/terminal-output.ts';
import path from 'node:path';
import { SERVER_ROOT } from '../../helpers/paths.mjs';
const require = createRequire(path.join(SERVER_ROOT, 'package.json'));
const { Terminal } = require('@xterm/headless');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await tick(); }
  assert.fail('Timed out draining terminal output');
}
function text(term) {
  const b = term.buffer.active;
  return Array.from({ length: b.length }, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\n');
}

test('a reset waits for queued output and subsequent live data waits for the checkpoint', async () => {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const lane = new TerminalOutput(term);
  try {
    lane.output('old\x1b[38;2;', 12);
    lane.replay({ type: 'terminal.replay', terminalId: 'a', reset: true, truncated: true,
      data: 'RECOVERED', endOffset: 100, cols: 40, rows: 10 });
    lane.output('-LIVE', 105);
    await until(() => text(term).includes('RECOVERED-LIVE'));
    assert.equal(text(term).includes('old'), false);
    assert.deepEqual([term.cols, term.rows], [80, 24]);
  } finally { lane.dispose(); term.dispose(); }
});

test('overlapping batched deltas are deduplicated in UTF-8 bytes independently per terminal', async () => {
  const terms = [0, 1].map(() => new Terminal({ cols: 80, rows: 24, allowProposedApi: true }));
  const lanes = terms.map(term => new TerminalOutput(term));
  try {
    lanes[0].output('🚀', 4);
    lanes[0].output('🚀界A', 8);
    lanes[0].replay({ type: 'terminal.replay', terminalId: 'a', reset: false, truncated: false, data: '🚀界A', endOffset: 8 });
    lanes[1].output('BACKGROUND', 10);
    await until(() => text(terms[0]).includes('🚀界A') && text(terms[1]).includes('BACKGROUND'));
    assert.equal(text(terms[0]).trim(), '🚀界A');
    assert.equal(text(terms[1]).trim(), 'BACKGROUND');
  } finally { lanes.forEach(l => l.dispose()); terms.forEach(t => t.dispose()); }
});

test('25,000 ordered lines preserve 20,000-line scrollback; delta recovery keeps the viewport', async () => {
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 20000, allowProposedApi: true });
  const lane = new TerminalOutput(term);
  try {
    let offset = 0;
    for (let start = 0; start < 25000; start += 1000) {
      const data = Array.from({ length: 1000 }, (_, i) => `LINE-${start + i}\r\n`).join('');
      offset += Buffer.byteLength(data);
      lane.output(data, offset);
    }
    await until(() => text(term).includes('LINE-24999'));
    assert.equal(term.buffer.normal.length, 20000 + 24);
    term.scrollToLine(500);
    lane.replay({ type: 'terminal.replay', terminalId: 'a', reset: false, truncated: true,
      data: 'CAUGHT-UP', endOffset: offset + 9 });
    await until(() => text(term).includes('CAUGHT-UP'));
    assert.equal(term.buffer.active.viewportY, 500);
  } finally { lane.dispose(); term.dispose(); }
});

test('D-03: truncated reset replay after deep scrollback preserves existing scrollback history', async () => {
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 20000, allowProposedApi: true });
  const lane = new TerminalOutput(term);
  try {
    let offset = 0;
    for (let start = 0; start < 5000; start += 1000) {
      const data = Array.from({ length: 1000 }, (_, i) => `HIST-${start + i}\r\n`).join('');
      offset += Buffer.byteLength(data);
      lane.output(data, offset);
    }
    await until(() => text(term).includes('HIST-4999'));
    assert.ok(term.buffer.normal.baseY >= 4900, 'scrollback populated before reconnect');

    lane.replay({
      type: 'terminal.replay',
      terminalId: 'a',
      reset: true,
      truncated: true,
      data: 'RECONNECTED-AFTER-GAP\r\n',
      endOffset: offset + 500_000,
      cols: 80,
      rows: 24,
    });
    await until(() => text(term).includes('RECONNECTED-AFTER-GAP'));
    const full = text(term);
    assert.ok(full.includes('HIST-0'), 'Earliest scrollback line preserved across >256 KiB reconnect');
    assert.ok(full.includes('HIST-4999'), 'Pre-disconnect output preserved');
    assert.ok(full.includes('RECONNECTED-AFTER-GAP'), 'Post-reconnect replay rendered');
    assert.ok(term.buffer.normal.baseY >= 4900, 'Scrollback depth retained');
  } finally { lane.dispose(); term.dispose(); }
});

test('split UTF-8 multibyte boundary overlap does not throw, lose characters, or corrupt output', async () => {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const lane = new TerminalOutput(term);
  try {
    // 4-byte UTF-8 character (🚀 = F0 9F 9A 80).
    // Simulate previous offset landing inside continuation bytes (overlap = 1, 2, 3)
    lane.output('PRE-', 4);
    // Incoming: '🚀END\n', 4 + 4 = 8 bytes. offset = 11.
    // startOffset = 11 - 8 = 3. overlap = 4 - 3 = 1.
    // bytes[1] is 0x9F (continuation byte).
    lane.output('🚀END\n', 11);
    await until(() => text(term).includes('PRE-🚀END'));
    assert.ok(text(term).includes('PRE-🚀END'), '4-byte emoji preserved across split boundary without crash');

    // 3-byte UTF-8 box-drawing character (─ = E2 94 80).
    // Current offset is 11.
    // Incoming: '─BOX\n', 3 + 4 = 7 bytes. offset = 16.
    // startOffset = 16 - 7 = 9. overlap = 11 - 9 = 2.
    // bytes[2] is 0x80 (continuation byte).
    lane.output('─BOX\n', 16);
    await until(() => text(term).includes('─BOX'));
    assert.ok(text(term).includes('─BOX'), '3-byte box drawing character preserved across split boundary');

    // 2-byte UTF-8 character (ñ = C3 B1).
    // Current offset is 16.
    // Incoming: 'ñandú\n', 2 + 3 + 2 + 1 = 8 bytes (ñ, a, n, d, ú, \n). offset = 23.
    // startOffset = 23 - 8 = 15. overlap = 16 - 15 = 1.
    // bytes[1] is 0xB1 (continuation byte).
    lane.output('ñandú\n', 23);
    await until(() => text(term).includes('ñandú'));
    assert.ok(text(term).includes('ñandú'), '2-byte accented character preserved across split boundary');
  } finally { lane.dispose(); term.dispose(); }
});

test('duplicate output and older offsets are completely ignored', async () => {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const lane = new TerminalOutput(term);
  try {
    lane.output('INITIAL-', 8);
    lane.output('INITIAL-', 8); // exact duplicate offset
    lane.output('OLD-', 4); // older offset
    lane.output('NEXT\n', 13);
    await until(() => text(term).includes('INITIAL-NEXT'));
    const rendered = text(term);
    assert.equal((rendered.match(/INITIAL-/g) || []).length, 1, 'Duplicate chunk rendered exactly once');
    assert.equal(rendered.includes('OLD-'), false, 'Older offset completely dropped');
  } finally { lane.dispose(); term.dispose(); }
});

test('reconnection with overlapping replay followed by live stream does not duplicate or drop characters', async () => {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const lane = new TerminalOutput(term);
  try {
    // Initial live output
    lane.output('BEFORE-DISCONNECT\r\n', 19);
    await until(() => text(term).includes('BEFORE-DISCONNECT'));

    // Incremental replay (reset: false) carrying overlap across boundary
    lane.replay({
      type: 'terminal.replay',
      terminalId: 'reconnect-term',
      reset: false,
      truncated: false,
      data: 'BEFORE-DISCONNECT\r\nREPLAYED-DELTA-🚀\r\n',
      endOffset: 40,
    });

    // Immediate live output with partial overlap against replay endOffset
    lane.output('REPLAYED-DELTA-🚀\r\nLIVE-POST-RECONNECT\r\n', 61);
    await until(() => text(term).includes('LIVE-POST-RECONNECT'));

    const rendered = text(term);
    assert.equal((rendered.match(/BEFORE-DISCONNECT/g) || []).length, 1, 'Initial line never duplicated');
    assert.equal((rendered.match(/REPLAYED-DELTA-🚀/g) || []).length, 1, 'Replayed emoji delta never duplicated');
    assert.ok(rendered.includes('LIVE-POST-RECONNECT'), 'Post-reconnect live stream rendered');
  } finally { lane.dispose(); term.dispose(); }
});

test('concurrent terminals handle interleaved split-boundary frames independently without cross-talk', async () => {
  const termA = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const termB = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const laneA = new TerminalOutput(termA);
  const laneB = new TerminalOutput(termB);
  try {
    laneA.output('A-START-', 8);
    laneB.output('B-START-', 8);

    // Interleave split-boundary outputs
    laneA.output('🚀-TERM-A\n', 17); // start = 17 - 10 = 7, overlap = 8 - 7 = 1 (split at F0 9F)
    laneB.output('界-TERM-B\n', 17); // start = 17 - 10 = 7, overlap = 8 - 7 = 1 (split at E7 95)

    await until(() => text(termA).includes('A-START-🚀-TERM-A') && text(termB).includes('B-START-界-TERM-B'));

    assert.equal(text(termA).includes('TERM-B'), false, 'Terminal A free of Terminal B output');
    assert.equal(text(termB).includes('TERM-A'), false, 'Terminal B free of Terminal A output');
  } finally {
    laneA.dispose(); termA.dispose();
    laneB.dispose(); termB.dispose();
  }
});

/*
  Remount out of the warm set (WB-05): the lane starts with no offset, so the attach
  asks for a full checkpoint, and output already in flight for the old attachment can
  arrive while the checkpoint is being parsed. Every byte must land exactly once and in
  offset order, including a frame that straddles the checkpoint watermark.
*/
test('remount applies the checkpoint and in-flight frames exactly once in offset order', async () => {
  const term = new Terminal({ cols: 90, rows: 26, allowProposedApi: true });
  const lane = new TerminalOutput(term);
  try {
    assert.equal(lane.offset, undefined, 'a remounted lane has no watermark, so attach omits sinceOffset');
    // Frames queued for the previous attachment, below the checkpoint watermark.
    lane.output('STALE-A', 40);
    lane.output('STALE-B', 60);
    lane.replay({ type: 'terminal.replay', terminalId: 'a', reset: true, truncated: false,
      data: '\x1b[?1049h\x1b[HSCREEN-café-漢', endOffset: 100, cols: 90, rows: 26 });
    assert.equal(lane.offset, 100);
    lane.output('DROPPED', 90); // below the watermark: already inside the checkpoint
    lane.output('DROPPED', 100); // exactly at the watermark
    const straddle = Buffer.from('-xyzLIVE', 'utf8'); // bytes 97..104, four of them already applied
    lane.output(straddle.toString('utf8'), 104);
    lane.output('-TAIL', 109);
    await until(() => text(term).includes('LIVE-TAIL'));
    const rendered = text(term);
    assert.equal(rendered.includes('STALE'), false, 'pre-checkpoint frames never reach the screen');
    assert.equal(rendered.includes('DROPPED'), false, 'frames at or below the watermark are dropped');
    assert.equal((rendered.match(/LIVE/g) || []).length, 1, 'the straddling frame is applied once');
    assert.equal(rendered.includes('SCREEN-café-漢LIVE-TAIL'), true, 'the checkpoint and the delta join seamlessly');
    assert.equal(rendered.includes('�'), false);
    assert.equal(lane.offset, 109);
    assert.equal(term.buffer.active.type, 'alternate', 'the checkpoint restored the alternate screen');
  } finally { lane.dispose(); term.dispose(); }
});

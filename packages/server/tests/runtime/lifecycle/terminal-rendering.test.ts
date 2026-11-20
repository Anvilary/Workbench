import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { TerminalState } from '../../../src/pty-host/terminal-state.mjs';
import { OutputBuffer } from '../../../src/features/terminals/output-buffer.js';

const { Terminal } = headless;
const drain = (term: InstanceType<typeof Terminal>) => new Promise<void>((resolve) => term.write('', resolve));
function view(term: InstanceType<typeof Terminal>) {
  const b = term.buffer.active;
  return {
    type: b.type, cursor: [b.cursorX, b.cursorY], modes: term.modes,
    lines: Array.from({ length: term.rows }, (_, y) => {
      const line = b.getLine(b.baseY + y)!;
      return Array.from({ length: term.cols }, (_, x) => {
        const c = line.getCell(x)!;
        return [c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(), c.isBold()];
      });
    }),
  };
}

test('checkpoints preserve split VT sequences, RGB cells, cursor and alternate screens', async () => {
  const fixtures = [
    '\x1b[38;2;120;40;230mRGB\x1b[0m',
    '\x1b[2;4HCURSOR\x1b[1A\x1b[2D!',
    '\x1b[?1049h\x1b[2J\x1b[HAPP\x1b[?1049l',
    '\x1b]0;window title\x1b\\TEXT',
    '\x1bPignored payload\x1b\\TEXT',
    '\x9b38;2;12;34;56mC1\x9b0m',
    '\x9d0;title\x9cTEXT',
    '\x1b[?6h\x1b[3;4HFOO',
    '\x1b]0;foo\x1b[31mRED',
    '\x1bPignored\x1b[31mRED',
    '\x1b[?2004h\x1b[?1049h\x1b[?2004lALT',
    '\x1b[2;4r\x1b[?1049hALT',
    '\x1b[2;4r\x1b[?1049h\x1b[1;5rALT\x1b[?1049l',
    '\x1b[2;4r\x1b[1;1rREGION',
    '\x1b[2;4r\x1b[?25l\x1b[!pRESET',
  ];
  for (const fixture of fixtures) for (let split = 0; split <= fixture.length; split++) {
    const state = new TerminalState(40, 8);
    const reference = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    const restored = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    try {
      const initial = 'normal shell\r\n';
      state.push(initial + fixture.slice(0, split));
      const checkpoint = await state.snapshot();
      reference.write(initial + fixture);
      restored.write(checkpoint.data);
      restored.write(fixture.slice(split));
      await Promise.all([drain(reference), drain(restored)]);
      assert.deepEqual(view(restored), view(reference), `split ${split}: ${JSON.stringify(fixture)}`);
    } finally { state.dispose(); reference.dispose(); restored.dispose(); }
  }
});

test('checkpoint watermarks exclude later output and preserve dimensions after queued resizing', async () => {
  const buffer = new OutputBuffer(64);
  try {
    buffer.resize(93, 31);
    buffer.push('before');
    const pending = buffer.checkpoint();
    buffer.resize(51, 11);
    buffer.push('after');
    const snapshot = await pending;
    assert.deepEqual([snapshot.cols, snapshot.rows, snapshot.endOffset], [93, 31, 6]);
    assert.equal(buffer.sliceFrom(snapshot.endOffset).data, 'after');
    const next = await buffer.checkpoint();
    assert.deepEqual([next.cols, next.rows, next.endOffset], [51, 11, 11]);
  } finally { buffer.dispose(); }
});

test('stateful recovery after ring overflow preserves TUI cells, normal buffer and scroll margins', async () => {
  const buffer = new OutputBuffer(64);
  const reference = new Terminal({ cols: 40, rows: 8, scrollback: 1000, allowProposedApi: true });
  const restored = new Terminal({ cols: 40, rows: 8, scrollback: 1000, allowProposedApi: true });
  try {
    buffer.resize(40, 8);
    const data = 'shell\r\n' + '\x1b[?1049h\x1b[2J\x1b[H' +
      Array.from({ length: 12000 }, (_, i) => `\x1b[2;3H\x1b[38;2;10;20;30mframe ${i} 🚀界`).join('') +
      '\x1b[2;7r\x1b[4;5H\x1b[?25l';
    buffer.push(data);
    reference.write(data);
    const snapshot = await buffer.checkpoint();
    assert.ok(buffer.isTruncated());
    assert.ok(snapshot.data.length < 10000);
    restored.write(snapshot.data);
    await Promise.all([drain(reference), drain(restored)]);
    assert.deepEqual(view(restored), view(reference));
    const future = '\x1b[7;1Hscroll\r\nnext\x1b[?1049lRESTORED';
    reference.write(future); restored.write(future);
    await Promise.all([drain(reference), drain(restored)]);
    assert.deepEqual(view(restored), view(reference));
  } finally { buffer.dispose(); reference.dispose(); restored.dispose(); }
});

test('invalid UTF-8 replay offsets reset; generated legacy prefixes never shift raw offsets', () => {
  const buffer = new OutputBuffer(64);
  try {
    buffer.push('🚀OK');
    assert.equal(buffer.sliceFrom(1).reset, true);
    buffer.seed('\x1b[?1049h' + 'x'.repeat(20), 100, 120, true);
    assert.equal(buffer.startOffset, 100);
    assert.equal(buffer.sliceFrom(110).data, 'x'.repeat(10));
    buffer.push('界');
    assert.equal(buffer.sliceFrom(120).data, '界');
  } finally { buffer.dispose(); }
});

test('long UTF-8 lines and a following write survive a checkpoint at wrapped-column boundaries', async () => {
  for (const length of [320, 321, 10000]) {
    const state = new TerminalState(40, 8);
    const reference = new Terminal({ cols: 40, rows: 8, scrollback: 1000, allowProposedApi: true });
    const restored = new Terminal({ cols: 40, rows: 8, scrollback: 1000, allowProposedApi: true });
    try {
      const data = '界🚀'.repeat(length);
      state.push(data); reference.write(data);
      restored.write((await state.snapshot()).data);
      reference.write('!NEXT'); restored.write('!NEXT');
      await Promise.all([drain(reference), drain(restored)]);
      assert.deepEqual(view(restored), view(reference), `long-line length ${length}`);
    } finally { state.dispose(); reference.dispose(); restored.dispose(); }
  }
});

test('snapshot cancellation releases waiters without disposing the terminal or other snapshots', async () => {
  const state = new TerminalState(80, 24);
  const abort = new AbortController();
  try {
    state.push('VALID');
    const cancelled = state.snapshot(abort.signal);
    const rejected = assert.rejects(cancelled, { name: 'AbortError' });
    abort.abort();
    await rejected;
    assert.equal((state as any).waiters.size, 0, 'Cancelled snapshot owns no retained waiter');
    const current = await state.snapshot();
    assert.ok(current.data.includes('VALID'));
    assert.equal((state as any).waiters.size, 0);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(state.snapshot(alreadyAborted.signal), { name: 'AbortError' });
    assert.equal((state as any).waiters.size, 0);
  } finally { state.dispose(); }
});

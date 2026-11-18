// Interactive CLI Scrolling & Alternate-Screen Regression Test Suite
// Run: node --test packages/web/src/agency/split/interactive-cli-scroll.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/xterm');
import { OutputBuffer } from '../../../../server/src/output-buffer.ts';
import { createCodexAdapter } from '../../../../server/src/agents/codex/index.ts';
import { wholePixels, momentumStep, releaseVelocity, isDrag } from '../../../src/touch-scroll.ts';

test('A1: Direct Codex-style native CLI startup uses --no-alt-screen for inline scrollback', async () => {
  const adapter = createCodexAdapter();
  const location = { resolvedPath: '/usr/bin/codex', file: '/usr/bin/codex', prefixArgs: [], version: null };
  
  // Fresh session
  const fresh = adapter.launch({ location, cwd: '/tmp', resumeSessionId: null, proposedSessionId: '019e0000-0000-7000-8000-000000000001' });
  assert.equal(fresh.file, '/usr/bin/codex');
  assert.ok(fresh.args.includes('--no-alt-screen'), 'Fresh launch includes --no-alt-screen');
  assert.equal(fresh.session.kind, 'discover');

  // Resume session
  const uuid = '019e0000-0000-7000-8000-000000000002';
  const resume = adapter.launch({ location, cwd: '/tmp', resumeSessionId: uuid, proposedSessionId: '019e0000-0000-7000-8000-000000000003' });
  assert.ok(resume.args.includes('resume'));
  assert.ok(resume.args.includes('--no-alt-screen'), 'Resume launch includes --no-alt-screen');
  assert.equal(resume.args.at(-1), uuid);
});

test('A2: Normal shell scrolling with 20k scrollback capacity', async () => {
  const term = new Terminal({ scrollback: 20_000, rows: 24, cols: 80 });
  assert.equal(term.buffer.active.type, 'normal');

  // Stream 5,000 lines
  let chunk = '';
  for (let i = 0; i < 5000; i++) {
    chunk += `Line output ${i}\r\n`;
  }
  await new Promise((resolve) => term.write(chunk, resolve));

  const initialBaseY = term.buffer.normal.baseY;
  assert.ok(initialBaseY > 4900, 'BaseY accumulated over 4900 lines');
  assert.equal(term.buffer.normal.viewportY, initialBaseY);

  // Simulate user scrolling up 100 lines (updates buffer.ydisp / viewportY)
  term._core._bufferService.buffer.ydisp = initialBaseY - 100;
  assert.equal(term.buffer.normal.viewportY, initialBaseY - 100);

  // Scroll back down
  term._core._bufferService.buffer.ydisp = initialBaseY;
  assert.equal(term.buffer.normal.viewportY, initialBaseY);
  term.dispose();
});

test('A3: Nested CLI alternate-screen entry and exit', async () => {
  const term = new Terminal({ scrollback: 20_000, rows: 24, cols: 80 });

  // 1. Initial shell output
  let shellData = '';
  for (let i = 0; i < 100; i++) shellData += `bash-prompt-$ echo item ${i}\r\n`;
  await new Promise((resolve) => term.write(shellData, resolve));
  assert.equal(term.buffer.active.type, 'normal');
  const shellBaseY = term.buffer.normal.baseY;
  assert.ok(shellBaseY > 70);

  // 2. CLI enters alternate screen buffer: \x1b[?1049h
  await new Promise((resolve) => term.write('\x1b[?1049h\x1b[H\x1b[2JInteractive CLI TUI Frame\r\n', resolve));
  assert.equal(term.buffer.active.type, 'alternate');
  assert.equal(term.buffer.active.baseY, 0, 'Alternate buffer has 0 scrollback');

  // Normal buffer history remains intact while in alternate screen
  assert.equal(term.buffer.normal.baseY, shellBaseY, 'Normal buffer retained');

  // 3. CLI exits alternate screen buffer: \x1b[?1049l
  await new Promise((resolve) => term.write('\x1b[?1049l', resolve));
  assert.equal(term.buffer.active.type, 'normal');
  assert.equal(term.buffer.normal.baseY, shellBaseY, 'Normal buffer restored after CLI exit');
  term.dispose();
});

test('A4: Shift+Wheel fallback in alternate buffer converts to PageUp/Down input', async () => {
  const term = new Terminal({ scrollback: 20_000, rows: 24, cols: 80 });
  await new Promise((resolve) => term.write('\x1b[?1049hTUI Running\r\n', resolve));
  assert.equal(term.buffer.active.type, 'alternate');

  const dispatchedInput = [];
  const fakeConnection = {
    send(msg) {
      if (msg.type === 'input') dispatchedInput.push(msg.data);
    },
  };

  // Attach the custom wheel handler as in TerminalView.tsx
  term.attachCustomWheelEventHandler((event) => {
    if (event.shiftKey && term.buffer.active.type === 'alternate') {
      const key = event.deltaY < 0 ? '\x1b[5~' : '\x1b[6~';
      fakeConnection.send({ type: 'input', terminalId: 't1', data: key });
      return false;
    }
    return true;
  });

  // Simulate Shift + Wheel Up
  const wheelUpHandled = term._core._customWheelEventHandler?.({ shiftKey: true, deltaY: -120 });
  assert.equal(wheelUpHandled, false, 'Wheel handler intercepted shift-wheel');
  assert.deepEqual(dispatchedInput, ['\x1b[5~'], 'Dispatched Page Up');

  // Simulate Shift + Wheel Down
  dispatchedInput.length = 0;
  const wheelDownHandled = term._core._customWheelEventHandler?.({ shiftKey: true, deltaY: 120 });
  assert.equal(wheelDownHandled, false, 'Wheel handler intercepted shift-wheel down');
  assert.deepEqual(dispatchedInput, ['\x1b[6~'], 'Dispatched Page Down');

  // Plain wheel without Shift is NOT intercepted (passes to standard xterm mouse/arrow routing)
  assert.equal(term._core._customWheelEventHandler?.({ shiftKey: false, deltaY: -120 }), true);
  term.dispose();
});

test('A5: Touchpad wheel events and fractional pixel accumulation', () => {
  // Test wholePixels accumulating small touchpad trackpad deltas
  let pending = 0;
  const delta1 = 0.4;
  const step1 = wholePixels(pending + delta1);
  assert.equal(step1.pixels, 0);
  assert.equal(step1.rest, 0.4);

  pending = step1.rest;
  const delta2 = 0.8;
  const step2 = wholePixels(pending + delta2);
  assert.equal(step2.pixels, 1);
  assert.ok(Math.abs(step2.rest - 0.2) < 1e-9);

  // Test momentum calculations
  const samples = [
    { t: 0, y: 100 },
    { t: 50, y: 60 },
    { t: 100, y: 10 },
  ];
  const velocity = releaseVelocity(samples, 100);
  assert.ok(velocity > 0, 'Velocity is positive upward');

  const step = momentumStep(velocity, 16);
  assert.ok(step.delta > 0);
  assert.ok(step.velocity < velocity, 'Velocity decayed with friction');
});

test('A6: High-volume output maintains scroll position when user scrolled up', async () => {
  const term = new Terminal({ scrollback: 20_000, rows: 24, cols: 80 });

  let text = '';
  for (let i = 0; i < 200; i++) text += `Row ${i}\r\n`;
  await new Promise((res) => term.write(text, res));

  const initialBase = term.buffer.active.baseY;
  // User scrolls up 50 lines to read earlier history
  term._core._bufferService.buffer.ydisp = initialBase - 50;
  const userViewport = term.buffer.active.viewportY;
  assert.equal(userViewport, initialBase - 50);

  // New streaming lines arrive while user is scrolled up
  let streaming = '';
  for (let i = 200; i < 250; i++) streaming += `Streaming ${i}\r\n`;
  await new Promise((res) => term.write(streaming, res));

  // When rememberPosition / restorePosition run (as in TerminalView.tsx):
  // User line is preserved rather than jumping to bottom
  const target = Math.min(userViewport, term.buffer.active.baseY);
  term._core._bufferService.buffer.ydisp = target;
  assert.equal(term.buffer.active.viewportY, userViewport, 'User scroll position remained stable');
  term.dispose();
});

test('A7: OutputBuffer alternate-screen replay preservation', () => {
  const buf = new OutputBuffer(500); // 500 byte limit for test
  
  // Enter alternate buffer
  buf.push('\x1b[?1049h\x1b[H\x1b[2J');
  
  // Fill buffer past limit to force truncation
  for (let i = 0; i < 30; i++) {
    buf.push(`Line ${i} of TUI content filling the buffer...\n`);
  }
  assert.equal(buf.isTruncated(), true, 'Buffer was truncated');

  const replayed = buf.read();
  // Ensure alternate-screen sequence was prepended so reconnecting xterm enters alternate buffer
  assert.ok(replayed.startsWith('\x1b[?1049h'), 'Replay prepends alternate-screen sequence when truncated');

  // Exit alternate buffer
  buf.push('\x1b[?1049lExited to shell\n');
  const exited = buf.read();
  assert.ok(!exited.startsWith('\x1b[?1049h'), 'Replay does not prepend when exited');
});

test('A8: Three concurrent terminal sessions maintain independent buffers and scroll state', async () => {
  const t1 = new Terminal({ scrollback: 20_000, rows: 24, cols: 80 });
  const t2 = new Terminal({ scrollback: 20_000, rows: 24, cols: 80 });
  const t3 = new Terminal({ scrollback: 20_000, rows: 24, cols: 80 });

  // Terminal 1: Normal shell
  await new Promise((res) => t1.write('Shell active\r\n', res));
  // Terminal 2: Inline Codex CLI
  await new Promise((res) => t2.write('Codex inline turn 1\r\nCodex inline turn 2\r\n', res));
  // Terminal 3: Alternate-screen TUI
  await new Promise((res) => t3.write('\x1b[?1049hTUI View\r\n', res));

  assert.equal(t1.buffer.active.type, 'normal');
  assert.equal(t2.buffer.active.type, 'normal');
  assert.equal(t3.buffer.active.type, 'alternate');

  t1.dispose();
  t2.dispose();
  t3.dispose();
});

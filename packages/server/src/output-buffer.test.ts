import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputBuffer } from './output-buffer.js';

test('OutputBuffer: empty buffer initialization and offsets', () => {
  const buf = new OutputBuffer(1024);
  assert.equal(buf.startOffset, 0);
  assert.equal(buf.endOffset, 0);
  assert.equal(buf.isTruncated(), false);
  assert.equal(buf.read(), '');

  const slice = buf.sliceFrom();
  assert.equal(slice.reset, true);
  assert.equal(slice.startOffset, 0);
  assert.equal(slice.endOffset, 0);
  assert.equal(slice.data, '');
});

test('OutputBuffer: pushes single chunk and increments monotonic offsets', () => {
  const buf = new OutputBuffer(1024);
  buf.push('hello world');

  const byteLen = Buffer.byteLength('hello world', 'utf8');
  assert.equal(buf.startOffset, 0);
  assert.equal(buf.endOffset, byteLen);
  assert.equal(buf.read(), 'hello world');
  assert.equal(buf.snapshot(), 'hello world');

  // Caught up check
  const caughtUp = buf.sliceFrom(byteLen);
  assert.equal(caughtUp.reset, false);
  assert.equal(caughtUp.data, '');
  assert.equal(caughtUp.startOffset, 0);
  assert.equal(caughtUp.endOffset, byteLen);

  // Partial delta check
  const delta = buf.sliceFrom(6);
  assert.equal(delta.reset, false);
  assert.equal(delta.data, 'world');
  assert.equal(delta.startOffset, 0);
  assert.equal(delta.endOffset, byteLen);
});

test('OutputBuffer: incremental delta slicing across multiple chunks', () => {
  const buf = new OutputBuffer(1024);
  const part1 = 'First line\n';
  const part2 = 'Second line\n';
  const part3 = 'Third line\n';

  buf.push(part1);
  const offsetAfter1 = buf.endOffset;
  assert.equal(offsetAfter1, Buffer.byteLength(part1, 'utf8'));

  buf.push(part2);
  const offsetAfter2 = buf.endOffset;
  assert.equal(offsetAfter2, offsetAfter1 + Buffer.byteLength(part2, 'utf8'));

  buf.push(part3);
  const offsetAfter3 = buf.endOffset;
  assert.equal(offsetAfter3, offsetAfter2 + Buffer.byteLength(part3, 'utf8'));

  // Replay from offsetAfter1 should give parts 2 and 3 without reset
  const sliceFrom1 = buf.sliceFrom(offsetAfter1);
  assert.equal(sliceFrom1.reset, false);
  assert.equal(sliceFrom1.data, part2 + part3);
  assert.equal(sliceFrom1.startOffset, 0);
  assert.equal(sliceFrom1.endOffset, offsetAfter3);

  // Replay from offsetAfter2 should give part 3 only
  const sliceFrom2 = buf.sliceFrom(offsetAfter2);
  assert.equal(sliceFrom2.reset, false);
  assert.equal(sliceFrom2.data, part3);

  // Replay from offsetAfter3 (caught up)
  const sliceFrom3 = buf.sliceFrom(offsetAfter3);
  assert.equal(sliceFrom3.reset, false);
  assert.equal(sliceFrom3.data, '');
});

test('OutputBuffer: ring buffer overflow, eviction, and forced reset on evicted offset', () => {
  // Budget of 64 bytes
  const buf = new OutputBuffer(64);

  // Push 4 chunks of 20 bytes each = 80 bytes total pushed
  buf.push('0123456789abcdefghij'); // 0..20
  buf.push('0123456789abcdefghij'); // 20..40
  buf.push('0123456789abcdefghij'); // 40..60
  buf.push('0123456789abcdefghij'); // 60..80

  assert.equal(buf.endOffset, 80);
  assert.equal(buf.isTruncated(), true);
  // Retained size must be <= 64 bytes
  assert.ok(buf.startOffset >= 80 - 64, `startOffset ${buf.startOffset} must be >= 16`);
  assert.ok(buf.startOffset <= 80);

  // Requesting offset 10 (which was evicted) MUST return reset: true
  const evicted = buf.sliceFrom(10);
  assert.equal(evicted.reset, true);
  assert.equal(evicted.truncated, true);
  assert.equal(evicted.data, buf.read());

  // Requesting offset 70 (which is retained) MUST return reset: false with exact 10 bytes
  const retained = buf.sliceFrom(70);
  assert.equal(retained.reset, false);
  assert.equal(Buffer.byteLength(retained.data, 'utf8'), 10);
  assert.equal(retained.data, 'abcdefghij');
});

test('OutputBuffer: UTF-8 multi-byte characters and surrogate pairs', () => {
  // Budget 32 bytes
  const buf = new OutputBuffer(32);
  const emojiStr = '🚀🛸🎉🔥'; // Each emoji is 4 UTF-8 bytes = 16 bytes
  buf.push(emojiStr);
  assert.equal(buf.endOffset, 16);
  assert.equal(buf.startOffset, 0);

  // Replay from byte 8 (skipping first 2 emojis)
  const slice = buf.sliceFrom(8);
  assert.equal(slice.reset, false);
  assert.equal(slice.data, '🎉🔥');

  // Push more to trigger truncation with emojis
  buf.push('——' + emojiStr + '——');
  assert.equal(buf.isTruncated(), true);
  const currentContent = buf.read();
  assert.ok(Buffer.byteLength(currentContent, 'utf8') <= 32);
  // Must be valid UTF-8 without replacement char or cut surrogates
  assert.ok(!currentContent.includes('\uFFFD'));
});

test('OutputBuffer: alternate screen sequence preservation on truncation', () => {
  const buf = new OutputBuffer(100);
  buf.push('\x1b[?1049h\x1b[H\x1b[2J');
  for (let i = 0; i < 10; i++) {
    buf.push(`line ${i}: some TUI text to fill buffer\n`);
  }
  assert.equal(buf.isTruncated(), true);
  const content = buf.read();
  assert.ok(content.startsWith('\x1b[?1049h'), 'Must prepend alternate screen escape sequence');

  // Exiting alternate screen clears prepending requirement
  buf.push('\x1b[?1049lBack to main screen\n');
  const mainContent = buf.read();
  assert.ok(!mainContent.startsWith('\x1b[?1049h'), 'Must not prepend alternate screen once exited');
});

test('OutputBuffer: clear() deterministically resets all state', () => {
  const buf = new OutputBuffer(100);
  buf.push('some test data\n');
  assert.ok(buf.endOffset > 0);

  buf.clear();
  assert.equal(buf.startOffset, 0);
  assert.equal(buf.endOffset, 0);
  assert.equal(buf.isTruncated(), false);
  assert.equal(buf.read(), '');
});

test('OutputBuffer: seed() restores supervisor replay state with monotonic offsets', () => {
  const buf = new OutputBuffer(1024);
  buf.seed('previous output from supervisor\n', 500, 532, true);

  assert.equal(buf.read(), 'previous output from supervisor\n');
  assert.equal(buf.endOffset, 532);
  assert.equal(buf.isTruncated(), true);

  // Slicing from before startOffset triggers reset
  const evicted = buf.sliceFrom(400);
  assert.equal(evicted.reset, true);
  assert.equal(evicted.data, 'previous output from supervisor\n');

  // Slicing from current endOffset returns delta ''
  const current = buf.sliceFrom(532);
  assert.equal(current.reset, false);
  assert.equal(current.data, '');

  // Pushing new data increments monotonic offsets
  buf.push('new line\n');
  assert.equal(buf.endOffset, 532 + 9);
  const delta = buf.sliceFrom(532);
  assert.equal(delta.reset, false);
  assert.equal(delta.data, 'new line\n');
});

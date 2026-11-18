import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TerminalOutput } from '../../../src/terminal-output.ts';
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

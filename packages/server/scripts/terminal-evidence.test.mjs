import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ansiGreen, executed, interrupted, exited, rejectedUpgrade } from './terminal-evidence.mjs';

test('echo-only input cannot prove execution or ANSI rendering', () => {
  const echo = "printf '\\033[32m%s%s\\033[0m\\n' 'EXECUTED_' 'GREEN'\r\n";
  assert.equal(executed(echo, 'EXECUTED_GREEN'), false);
  assert.equal(ansiGreen(echo, 'EXECUTED_GREEN'), false);
  assert.equal(ansiGreen('EXECUTED_GREEN', 'EXECUTED_GREEN'), false);
  assert.equal(ansiGreen('\x1b[32mEXECUTED_GREEN\x1b[0m\r\n', 'EXECUTED_GREEN'), true);
});
test('Ctrl+C requires completed command with interrupt status', () => {
  assert.equal(interrupted('^C'), false);
  assert.equal(interrupted("printf '%s%s:%s\\n' 'INTERRUPT_' 'STATUS' \"$?\""), false);
  assert.equal(interrupted('INTERRUPT_STATUS:0\r\n'), false);
  assert.equal(interrupted('INTERRUPT_STATUS:130\r\n'), true);
});
test('missing/null/unsupported signal or incorrect code cannot prove exit', () => {
  for (const row of [{}, { exitCode: null }, { exitSignal: undefined }, { exitSignal: 15 }, { exitCode: '42' }]) {
    assert.equal(exited({ lifecycle: 'exited', ...row }), false);
  }
  assert.equal(exited({ lifecycle: 'exited', exitCode: 0 }, 42), false);
  assert.equal(exited({ lifecycle: 'exited', exitCode: 42 }, 42), true);
});
test('only the exact HTTP refusal proves WebSocket authorization', async () => {
  class FixtureSocket extends EventEmitter {
    constructor(event, _options) {
      super();
      queueMicrotask(() => event === 'error' ? this.emit('error', new Error('ECONNREFUSED')) :
        event === 'open' ? this.emit('open') :
        this.emit('unexpected-response', {}, { statusCode: Number(event), resume() {} }));
    }
    terminate() {}
  }
  await assert.rejects(rejectedUpgrade(FixtureSocket, 'error', {}), /ECONNREFUSED/);
  await assert.rejects(rejectedUpgrade(FixtureSocket, '401', {}), /Expected HTTP 403/);
  await assert.rejects(rejectedUpgrade(FixtureSocket, 'open', {}), /successful upgrade/);
  assert.equal(await rejectedUpgrade(FixtureSocket, '403', {}), true);
});

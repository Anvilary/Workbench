import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNEL, DEFAULT_BROWSER_PROFILE_ID } from '../../../policy.mjs';
import { registerCommandRouter } from '../../../src/ipc/command-router.mjs';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const ORIGIN = 'http://127.0.0.1:4100';

function harness() {
  const calls = [];
  let handler = null;
  const shell = { id: 'shell-contents', mainFrame: { id: 'main' } };
  const controller = new Proxy({}, {
    get: (_target, name) => (...args) => { calls.push([String(name), ...args]); return { from: String(name) }; },
  });
  registerCommandRouter({
    ipcMain: { handle: (channel, fn) => { assert.equal(channel, CHANNEL); handler = fn; } },
    win: { webContents: shell },
    dialog: {},
    backend: { current: () => new URL(`${ORIGIN}/`), readiness: async () => ({}), takePendingShellStorage: () => null },
    controller,
    performance: new Proxy({}, { get: (_t, name) => () => { calls.push(['performance', String(name)]); return { ok: true }; } }),
    clipboardCommands: { copyFile: () => 0, writeText: () => 0, readText: () => 0 },
  });
  const trusted = { sender: shell, senderFrame: { ...shell.mainFrame, url: `${ORIGIN}/` } };
  Object.defineProperty(trusted.senderFrame, 'id', { value: 'main' });
  trusted.senderFrame = shell.mainFrame;
  shell.mainFrame.url = `${ORIGIN}/`;
  return { call: (event, command) => handler(event, command), trusted, calls, shell };
}

test('a request from anything but the shell page on the backend origin is refused', async () => {
  const { call, trusted, calls } = harness();
  const foreign = { ...trusted, senderFrame: { ...trusted.senderFrame, url: 'https://evil.example/' } };
  await assert.rejects(call(foreign, { type: 'layout', views: [] }), /Invalid desktop request/);
  const otherSender = { sender: { id: 'a-browser-view' }, senderFrame: trusted.senderFrame };
  await assert.rejects(call(otherSender, { type: 'retain', ids: [] }), /Invalid desktop request/);
  assert.deepEqual(calls, []);
});

test('a command that fails validation never reaches an owner', async () => {
  const { call, trusted, calls } = harness();
  await assert.rejects(call(trusted, { type: 'open', id: 'not-a-uuid', url: 'https://chatgpt.com/' }), /Invalid desktop request/);
  await assert.rejects(call(trusted, { type: 'delete-profile', profileId: DEFAULT_BROWSER_PROFILE_ID }), /Invalid desktop request/);
  await assert.rejects(call(trusted, { type: 'definitely-not-a-command' }), /Invalid desktop request/);
  await assert.rejects(call(trusted, null), /Invalid desktop request/);
  assert.deepEqual(calls, []);
});

test('validated commands are routed to the owner of the resource', async () => {
  const { call, trusted, calls } = harness();
  await call(trusted, { type: 'retain', ids: [UUID] });
  await call(trusted, { type: 'open', id: UUID, url: 'https://chatgpt.com/' });
  await call(trusted, { type: 'performance-pause' });
  assert.deepEqual(calls.map((entry) => entry.slice(0, 2).map((x) => (typeof x === 'object' ? x.type : x))), [
    ['retain', 'retain'],
    ['open', 'open'],
    ['performance', 'pause'],
  ]);
});

test('inherited object keys are not commands', async () => {
  const { call, trusted } = harness();
  for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    await assert.rejects(call(trusted, { type }), /Invalid desktop request/);
  }
});

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
  await call(trusted, { type: 'inspect-page', id: UUID, x: 100, y: 200 });
  await call(trusted, { type: 'get-available-spellcheck-languages' });
  await call(trusted, { type: 'get-spellcheck-status' });
  await call(trusted, { type: 'update-spellcheck-settings', enabled: true, languages: ['en-US', 'pt-PT'] });
  await call(trusted, { type: 'list-custom-dictionary-words', profileId: 'work-1' });
  await call(trusted, { type: 'add-custom-dictionary-word', word: 'customterm', profileId: 'work-1' });
  await call(trusted, { type: 'remove-custom-dictionary-word', word: 'customterm', profileId: 'work-1' });
  await call(trusted, { type: 'reconcile-custom-dictionary', customWordsByProfile: { main: ['anvilary'] } });
  assert.deepEqual(calls.map((entry) => entry.slice(0, 2).map((x) => (typeof x === 'object' && x !== null && 'type' in x ? x.type : x))), [
    ['retain', 'retain'],
    ['open', 'open'],
    ['performance', 'pause'],
    ['inspectPage', 'inspect-page'],
    ['getAvailableSpellCheckerLanguages'],
    ['getSpellCheckStatus'],
    ['applySpellCheckSettings', 'update-spellcheck-settings'],
    ['listCustomDictionaryWords', 'work-1'],
    ['addCustomDictionaryWord', 'customterm'],
    ['removeCustomDictionaryWord', 'customterm'],
    ['reconcileCustomDictionary', { main: ['anvilary'] }],
  ]);
  assert.equal(calls.at(-3)[2], 'work-1');
  assert.equal(calls.at(-2)[2], 'work-1');
});

test('inherited object keys are not commands', async () => {
  const { call, trusted } = harness();
  for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    await assert.rejects(call(trusted, { type }), /Invalid desktop request/);
  }
});

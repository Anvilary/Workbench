import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddedUrl, externalUrl, serviceUrl, trustedSender, validCommand, nativeBounds } from './policy.mjs';
const id = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';
test('exact HTTPS navigation and initial ChatGPT URL allowlist', () => {
  for (const url of ['https://chatgpt.com/', 'https://auth.openai.com/log-in', 'https://accounts.google.com/o/oauth2/auth', 'https://appleid.apple.com/auth/authorize']) assert.equal(embeddedUrl(url), true, url);
  for (const url of ['http://chatgpt.com/', 'https://chatgpt.com.evil.com', 'https://evil.com/?chatgpt.com', 'https://chatgpt.com:444/', 'https://user@chatgpt.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'https://chatgpt.com./', 'https://127.0.0.1/']) assert.equal(embeddedUrl(url), false, url);
  assert.equal(validCommand({ type: 'open', id, url: 'https://auth.openai.com/' }), false);
  assert.equal(validCommand({ type: 'open', id, url: 'https://chatgpt.com/', preload: 'anything' }), false);
  assert.equal(validCommand({ type: 'open', id, url: 'https://chatgpt.com/' }), true);
  assert.equal(validCommand({ type: 'open', id: [id], url: 'https://chatgpt.com/' }), false);
  assert.equal(embeddedUrl('https://chatgpt.com/\npath'), false);
});
test('external browser boundary rejects local hosts, credentials, ports and protocols', () => {
  assert.equal(externalUrl('https://help.openai.com/'), true);
  for (const url of ['https://localhost/', 'https://foo.local/', 'https://192.168.1.1/', 'https://[::1]/', 'https://2130706433/', 'https://host.internal/', 'https://user:pass@example.com/', 'mailto:a@b.com', 'http://public.com/', 'https://host.test/', 'https://public.com:9000/']) assert.equal(externalUrl(url), false, url);
});
test('only one configured loopback origin and its main frame can send IPC', () => {
  assert.equal(serviceUrl('http://127.0.0.1:3000/?token=example').origin, 'http://127.0.0.1:3000');
  for (const url of ['https://remote.com/', 'http://localhost:3000/', 'http://127.0.0.1:3000/other', 'http://u:p@127.0.0.1:3000/', 'http://127.0.0.1/']) assert.throws(() => serviceUrl(url));
  const contents = { mainFrame: { url: 'http://127.0.0.1:3000/' } };
  assert.equal(trustedSender({ sender: contents, senderFrame: contents.mainFrame }, contents, 'http://127.0.0.1:3000'), true);
  for (const event of [{ sender: {}, senderFrame: contents.mainFrame }, { sender: contents, senderFrame: { url: contents.mainFrame.url } }]) assert.equal(trustedSender(event, contents, 'http://127.0.0.1:3000'), false);
  contents.mainFrame.url = 'https://chatgpt.com/';
  assert.equal(trustedSender({ sender: contents, senderFrame: contents.mainFrame }, contents, 'http://127.0.0.1:3000'), false);
});
test('bounds fail closed for invalid payloads, stale viewport, clipping and zoom', () => {
  const command = { type: 'layout', id, bounds: { x: 200, y: 80, width: 800, height: 620 }, viewport: { width: 1000, height: 700 } };
  assert.equal(validCommand(command), true);
  assert.deepEqual(nativeBounds(command, [1250, 875], 1.25), { x: 250, y: 100, width: 1000, height: 775 });
  assert.equal(nativeBounds(command, [900, 700], 1), null);
  assert.equal(nativeBounds({ ...command, bounds: { ...command.bounds, x: 300 } }, [1000, 700], 1), null);
  for (const patch of [{ id: '../../etc' }, { id: {} }, { bounds: { ...command.bounds, x: -1 } }, { bounds: { ...command.bounds, width: NaN } }, { viewport: { width: Infinity, height: 700 } }, { action: 'exec' }]) assert.equal(validCommand({ ...command, ...patch }), false);
  assert.equal(nativeBounds({ ...command, id: null }, [1000, 700], 1), null);
});

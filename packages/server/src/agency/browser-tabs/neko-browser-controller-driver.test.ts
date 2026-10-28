import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { NekoBrowserControllerDriver } from './neko-browser-controller-driver.js';
import { BrowserEngineUnavailableError } from './browser-controller-driver.js';

const token = 'generated-test-controller-token-at-least-32-characters';
const owner = { tabId: '00000000-0000-4000-8000-000000000001', workspaceId: '00000000-0000-4000-8000-000000000002' };

test('Neko driver: sends authenticated ownership on every managed operation and observes validated URLs', async (t) => {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let observedUrl = 'https://chatgpt.com/c/observed';
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: request.method!, path: request.url!, body });
    response.setHeader('Content-Type', 'application/json');
    const path = request.url!.split('?')[0];
    const result = path === '/managed/tabs' ? request.method === 'GET' ? { id: 'real-target', found: true } : { id: 'real-target', created: true }
      : request.method === 'GET' ? { id: 'real-target', verified: true, url: observedUrl }
      : path!.endsWith('/activate') ? { id: 'real-target', activated: true }
      : path!.endsWith('/navigate') ? { id: 'real-target', navigated: true, url: body.url }
      : { id: 'real-target', closed: true };
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, token };
  const driver = new NekoBrowserControllerDriver(options);
  await assert.rejects(driver.activateTarget('unverified'), BrowserEngineUnavailableError);
  const target = await driver.openTarget('https://chatgpt.com/', owner);
  const restarted = new NekoBrowserControllerDriver(options);
  assert.equal(await restarted.verifyTargetOwnership(target.targetRef, owner), true);
  assert.equal(await restarted.findOwnedTarget(owner), target.targetRef);
  await restarted.activateTarget(target.targetRef);
  await restarted.navigateTarget(target.targetRef, 'https://chatgpt.com/c/next');
  assert.equal(await restarted.getTargetUrl(target.targetRef), observedUrl);
  observedUrl = 'https://accounts.google.com/login';
  assert.equal(await restarted.getTargetUrl(target.targetRef), null);
  await restarted.closeTarget(target.targetRef);
  assert.deepEqual(requests.filter((request) => request.method !== 'GET').map((request) => request.body.metadata), [owner, owner, owner, owner]);
  assert.equal(requests.every((request) => request.path.startsWith('/managed/tabs')), true);
});

test('Neko driver: authentication and malformed responses fail explicitly instead of proving absence', async (t) => {
  let status = 401;
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: token, id: 'target', verified: 'yes' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const driver = new NekoBrowserControllerDriver({ baseUrl: `http://127.0.0.1:${address.port}`, token });
  for (const next of [401, 503, 200]) {
    status = next;
    await assert.rejects(driver.verifyTargetOwnership('target', owner), (error: unknown) => {
      assert.ok(error instanceof BrowserEngineUnavailableError);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  }
});

test('Neko driver: rejects remote endpoints, URL credentials and missing authentication', () => {
  for (const baseUrl of ['http://evil.invalid:9223', 'http://user:pass@127.0.0.1:9223', 'http://127.0.0.1:9223/path']) {
    assert.throws(() => new NekoBrowserControllerDriver({ baseUrl, token }), BrowserEngineUnavailableError);
  }
  assert.throws(() => new NekoBrowserControllerDriver({ token: '' }), BrowserEngineUnavailableError);
});

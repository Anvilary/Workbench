import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { authorizeRequest, DEVICE_COOKIE, TOKEN_COOKIE, TOKEN_HEADER } from '../security.js';
import { mountNekoViewer, NEKO_VIEWER_PATH } from './neko-viewer.js';

const MAW_TOKEN = 'test-maw-token-never-forward';
const NEKO_PASSWORD = 'test-neko-password-never-return';
const NEKO_SESSION = 'test-neko-session-never-return';
const DEVICE = 'test-device-never-forward';
const AUTH = { cookie: `${TOKEN_COOKIE}=${MAW_TOKEN}` };
const QUERY = '?workspaceId=workspace-one&tabId=tab-one';

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise(resolve => server.close(() => resolve()));
}

function get(port: number, path: string, headers: Record<string, string> = AUTH, method = 'GET') {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function fixture(t: import('node:test').TestContext, options: {
  password?: string;
  admin?: boolean;
  canHost?: boolean;
  clipboard?: boolean;
  shareMedia?: boolean;
  cookieEnabled?: boolean;
  validateSelectedTab?: (workspaceId: string, tabId: string) => boolean | Promise<boolean>;
  upstreamUrl?: string;
} = {}) {
  const requests: Array<{ url: string; method: string; headers: IncomingHttpHeaders; body: string }> = [];
  let reachable = true;
  let deviceRevoked = false;
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: request.url!, method: request.method!, headers: request.headers, body });
    if (!reachable) { response.writeHead(503); response.end('private upstream failure'); return; }
    if (request.url === NEKO_VIEWER_PATH + '/api/login') {
      assert.deepEqual(JSON.parse(body), { username: 'MAW viewer', password: NEKO_PASSWORD });
      if (options.cookieEnabled !== false) response.setHeader('Set-Cookie', `NEKO_SESSION=${NEKO_SESSION}; HttpOnly; Path=/`);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: 'viewer-one', profile: {
        is_admin: options.admin ?? false, can_login: true, can_watch: true, can_connect: true,
        can_host: options.canHost ?? true, can_access_clipboard: options.clipboard ?? false, can_share_media: options.shareMedia ?? false,
      }, state: {} }));
    } else if (request.url === NEKO_VIEWER_PATH + '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Set-Cookie', 'unrelated-upstream-cookie=must-not-leak; Path=/');
      response.end('<!DOCTYPE html><html><head><script type="module" src="./assets/neko.js"></script></head><body><div id="app">Genuine Neko client fixture</div></body></html>');
    } else if (request.url === NEKO_VIEWER_PATH + '/api/whoami') {
      assert.equal(request.headers.cookie, `NEKO_SESSION=${NEKO_SESSION}`);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: 'viewer-one', token: NEKO_SESSION, extra_data: { secret: 'do-not-return' }, profile: { is_admin: false }, state: {} }));
    } else if (request.url === NEKO_VIEWER_PATH + '/assets/neko.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end('window.realNekoFixture = true;');
    } else if ([NEKO_VIEWER_PATH + '/api/room/control/request', NEKO_VIEWER_PATH + '/api/room/control/release'].includes(request.url!)) {
      assert.equal(request.headers.cookie, `NEKO_SESSION=${NEKO_SESSION}`);
      response.writeHead(204); response.end();
    } else { response.writeHead(404); response.end('private not found'); }
  });
  const upstreamWs = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (request, socket, head) => {
    requests.push({ url: request.url!, method: request.method!, headers: request.headers, body: '' });
    upstreamWs.handleUpgrade(request, socket, head, ws => {
      ws.send(JSON.stringify({ event: 'system/init', payload: { fixture: true } }));
      ws.on('message', (message, binary) => ws.send(message, { binary }));
    });
  });
  const upstreamPort = await listen(upstream);
  const app = express();
  const server = createServer(app);
  const port = await listen(server);
  const remote = { verifier: () => ({ match: (credential: string) => credential === DEVICE && !deviceRevoked ? { id: 'paired-device' } : null }) };
  // Match production middleware ordering. The proxy additionally checks auth for
  // defense in depth and separately checks WebSocket upgrades.
  app.use((request, response, next) => {
    const auth = authorizeRequest(request, port, MAW_TOKEN, remote.verifier());
    if (!auth.ok) { response.status(auth.reason === 'bad-token' ? 401 : 403).end(); return; }
    next();
  });
  const proxy = mountNekoViewer({
    app, httpServer: server, port, token: MAW_TOKEN, remote,
    env: { NEKO_VIEWER_URL: options.upstreamUrl ?? `http://127.0.0.1:${upstreamPort}`, NEKO_PASSWORD: options.password ?? NEKO_PASSWORD },
    validateSelectedTab: options.validateSelectedTab,
  });
  app.use((_request, response) => response.status(418).send('UI fallback'));
  t.after(async () => {
    proxy.dispose();
    for (const ws of upstreamWs.clients) ws.terminate();
    upstreamWs.close();
    await Promise.all([close(server), close(upstream)]);
  });
  async function enter(headers: Record<string, string> = AUTH) {
    const response = await get(port, NEKO_VIEWER_PATH + '/' + QUERY, headers);
    const proxyCookie = response.headers['set-cookie']?.find(cookie => cookie.startsWith('maw_neko_viewer='))?.split(';', 1)[0];
    return { response, headers: { ...headers, cookie: [headers['cookie'], proxyCookie].filter(Boolean).join('; ') } };
  }
  return { port, requests, enter, proxy, setReachable: (value: boolean) => { reachable = value; }, revokeDevice: () => { deviceRevoked = true; } };
}

test('viewer: genuine prefixed client, server-owned non-admin login, and no upstream credentials in HTML/cookies', async t => {
  const { port, requests, enter } = await fixture(t);
  const { response, headers } = await enter({ ...AUTH, authorization: 'Bearer browser-controller-secret', [TOKEN_HEADER]: MAW_TOKEN });
  assert.equal(response.status, 200);
  assert.match(response.body, /Genuine Neko client fixture/);
  assert.match(response.body, /agency\.browser\.viewer\.ready/);
  assert.match(response.body, /getVideoTracks/);
  assert.match(response.body, /track\.readyState === 'live'/);
  assert.equal(response.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['set-cookie']![0]!, /HttpOnly; SameSite=Strict/);
  for (const secret of [MAW_TOKEN, NEKO_PASSWORD, NEKO_SESSION, 'browser-controller-secret', 'must-not-leak']) {
    assert.ok(!response.body.includes(secret));
    assert.ok(!JSON.stringify(response.headers).includes(secret));
  }
  assert.equal(requests[0]?.url, NEKO_VIEWER_PATH + '/api/login');
  assert.equal(requests[0]?.headers.cookie, undefined);
  assert.equal(requests[1]?.headers.cookie, `NEKO_SESSION=${NEKO_SESSION}`);
  for (const request of requests) {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers[TOKEN_HEADER], undefined);
    assert.ok(!JSON.stringify(request.headers).includes(MAW_TOKEN));
  }
  const asset = await get(port, NEKO_VIEWER_PATH + '/assets/neko.js?token=untrusted&password=untrusted', headers);
  assert.equal(asset.status, 200);
  assert.equal(asset.body, 'window.realNekoFixture = true;');
  assert.equal(requests.at(-1)?.url, NEKO_VIEWER_PATH + '/assets/neko.js');
  const whoami = await get(port, NEKO_VIEWER_PATH + '/api/whoami', headers);
  assert.deepEqual(JSON.parse(whoami.body), { id: 'viewer-one', profile: { is_admin: false }, state: {} });
  assert.ok(!whoami.body.includes(NEKO_SESSION));
});

test('viewer: URL endpoint is scoped to selected workspace/tab and does not contact Neko', async t => {
  const { port, requests } = await fixture(t, { validateSelectedTab: async (workspace, tab) => workspace === 'workspace-one' && tab === 'tab-one' });
  const response = await get(port, NEKO_VIEWER_PATH + QUERY);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { url: NEKO_VIEWER_PATH + '/' + QUERY, workspaceId: 'workspace-one', tabId: 'tab-one' });
  assert.equal((await get(port, NEKO_VIEWER_PATH + '?workspaceId=workspace-one&tabId=wrong')).status, 409);
  assert.equal((await get(port, NEKO_VIEWER_PATH)).status, 400);
  assert.equal((await get(port, NEKO_VIEWER_PATH + '/?workspaceId=workspace-one&tabId=wrong')).status, 409);
  assert.equal(requests.length, 0);
});

test('viewer: credential-bearing entry URLs are redirected before client JavaScript can interpret them', async t => {
  const { port, requests } = await fixture(t);
  const response = await get(port, NEKO_VIEWER_PATH + '/' + QUERY + '&token=browser-token&pwd=browser-password');
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, NEKO_VIEWER_PATH + '/' + QUERY);
  assert.ok(!response.body.includes('browser-token'));
  assert.ok(!response.body.includes('browser-password'));
  assert.equal(requests.length, 0);
});

test('viewer: all HTTP resources require MAW auth, a valid Host, and a valid Origin', async t => {
  const { port, requests } = await fixture(t);
  for (const path of ['', '/', '/status', '/assets/neko.js', '/api/whoami']) {
    assert.equal((await get(port, NEKO_VIEWER_PATH + path, {})).status, 401);
    assert.equal((await get(port, NEKO_VIEWER_PATH + path, { ...AUTH, host: 'evil.example' })).status, 403);
    assert.equal((await get(port, NEKO_VIEWER_PATH + path, { ...AUTH, origin: 'http://evil.example' })).status, 403);
  }
  assert.equal(requests.length, 0);
});

test('viewer: block administrative, controller, CDP, transfer, traversal, and login routes before upstream', async t => {
  const { port, requests, enter } = await fixture(t);
  const { headers } = await enter();
  const count = requests.length;
  for (const path of ['/api/login', '/api/logout', '/api/members', '/api/sessions', '/api/room/settings', '/api/room/clipboard/', '/api/room/upload/drop', '/api/filetransfer', '/json/version', '/json/list', '/tabs', '/ws', '/metrics', '/debug/pprof', '/assets/../api/login', '/assets/%2e%2e/api/login', '/assets/foo%2fbar.js']) {
    assert.equal((await get(port, NEKO_VIEWER_PATH + path, headers)).status, 404, path);
  }
  assert.equal((await get(port, NEKO_VIEWER_PATH + '/api/login', headers, 'POST')).status, 405);
  assert.equal(requests.length, count);
});

test('viewer: reject admin, noninteractive, clipboard, sharing, and token-only profiles without returning upstream secrets', async t => {
  for (const options of [{ admin: true }, { cookieEnabled: false }, { canHost: false }, { clipboard: true }, { shareMedia: true }]) {
    const { enter } = await fixture(t, options);
    const { response } = await enter();
    assert.equal(response.status, 502);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.deepEqual(JSON.parse(response.body), { error: 'Neko viewer unavailable' });
  }
});

test('viewer: ordinary non-admin control request/release use server credentials while admin controls stay blocked', async t => {
  const { port, requests, enter } = await fixture(t);
  const { headers } = await enter();
  for (const action of ['request', 'release']) {
    assert.equal((await get(port, NEKO_VIEWER_PATH + '/api/room/control/' + action, headers, 'POST')).status, 204);
    const upstream = requests.at(-1)!;
    assert.equal(upstream.method, 'POST');
    assert.equal(upstream.body, '{}');
    assert.equal(upstream.headers.cookie, `NEKO_SESSION=${NEKO_SESSION}`);
  }
  const count = requests.length;
  for (const action of ['take', 'reset', 'give/other-user']) {
    assert.equal((await get(port, NEKO_VIEWER_PATH + '/api/room/control/' + action, headers, 'POST')).status, 405);
  }
  assert.equal(requests.length, count);
});

test('viewer: paired devices are supported, proxy cookies are bound to MAW identity, and revocation is honored', async t => {
  const { port, enter, revokeDevice } = await fixture(t);
  const { response, headers } = await enter({ cookie: `${DEVICE_COOKIE}=${DEVICE}` });
  assert.equal(response.status, 200);
  assert.equal((await get(port, NEKO_VIEWER_PATH + '/api/whoami', headers)).status, 200);
  const viewerCookie = headers.cookie.split('; ').find(value => value.startsWith('maw_neko_viewer='));
  assert.equal((await get(port, NEKO_VIEWER_PATH + '/api/whoami', { cookie: AUTH.cookie + '; ' + viewerCookie })).status, 401);
  revokeDevice();
  assert.equal((await get(port, NEKO_VIEWER_PATH + '/api/whoami', headers)).status, 401);
});

test('viewer: disabled/unavailable status contains no infrastructure addresses or secrets', async t => {
  const disabled = await fixture(t, { password: '' });
  const status = await get(disabled.port, NEKO_VIEWER_PATH + '/status');
  assert.deepEqual(JSON.parse(status.body), { configured: false, ready: false, url: NEKO_VIEWER_PATH + '/', reason: 'not-configured' });
  assert.equal((await get(disabled.port, NEKO_VIEWER_PATH + '/' + QUERY)).status, 503);
  assert.equal(disabled.requests.length, 0);
  const enabled = await fixture(t);
  assert.deepEqual(JSON.parse((await get(enabled.port, NEKO_VIEWER_PATH + '/status')).body), { configured: true, ready: true, url: NEKO_VIEWER_PATH + '/' });
  enabled.setReachable(false);
  assert.deepEqual(JSON.parse((await get(enabled.port, NEKO_VIEWER_PATH + '/status')).body), { configured: true, ready: false, url: NEKO_VIEWER_PATH + '/', reason: 'unavailable' });
  assert.equal((await enabled.enter()).response.body, '{"error":"Neko viewer unavailable"}');
});

test('viewer: refuse remote, credentialed, or control-service upstream URLs', async t => {
  for (const upstreamUrl of ['http://evil.example:8085', 'http://user:secret@127.0.0.1:8085', 'http://127.0.0.1:9222', 'http://127.0.0.1:9223', 'http://127.0.0.1:8085/json', 'file:///tmp/neko']) {
    const { port, requests } = await fixture(t, { upstreamUrl });
    assert.equal(JSON.parse((await get(port, NEKO_VIEWER_PATH + '/status')).body).configured, false, upstreamUrl);
    assert.equal(requests.length, 0);
  }
});

function rejectedUpgrade(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.on('unexpected-response', (_request, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!); });
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected authorized upgrade')); });
    ws.on('error', () => {});
  });
}

test('viewer: signaling upgrade authenticates Host/Origin/MAW identity before contacting upstream', async t => {
  const { port, requests, enter } = await fixture(t);
  const { headers } = await enter();
  const count = requests.length;
  assert.equal(await rejectedUpgrade(port, NEKO_VIEWER_PATH + '/api/ws', {}), 401);
  assert.equal(await rejectedUpgrade(port, NEKO_VIEWER_PATH + '/api/ws', { ...headers, origin: 'http://evil.example' }), 403);
  assert.equal(await rejectedUpgrade(port, NEKO_VIEWER_PATH + '/api/ws', { ...headers, host: 'evil.example' }), 403);
  assert.equal(await rejectedUpgrade(port, NEKO_VIEWER_PATH + '/api/ws', AUTH), 401);
  assert.equal(await rejectedUpgrade(port, NEKO_VIEWER_PATH + '/ws', headers), 404);
  assert.equal(requests.length, count);
});

test('viewer: genuine WebSocket signaling is tunneled with only the server-owned Neko cookie', async t => {
  const { port, requests, enter, proxy } = await fixture(t);
  const { headers } = await enter();
  const ws = new WebSocket(`ws://127.0.0.1:${port}${NEKO_VIEWER_PATH}/api/ws?token=browser-token&pwd=browser-password`, { headers: { ...headers, authorization: 'Bearer controller-secret', [TOKEN_HEADER]: MAW_TOKEN } });
  t.after(() => ws.terminate());
  const first = await new Promise<string>((resolve, reject) => { ws.once('message', data => resolve(data.toString())); ws.once('error', reject); });
  assert.deepEqual(JSON.parse(first), { event: 'system/init', payload: { fixture: true } });
  const upgrade = requests.at(-1)!;
  assert.equal(upgrade.url, NEKO_VIEWER_PATH + '/api/ws');
  assert.equal(upgrade.headers.cookie, `NEKO_SESSION=${NEKO_SESSION}`);
  assert.equal(upgrade.headers.authorization, undefined);
  assert.equal(upgrade.headers[TOKEN_HEADER], undefined);
  assert.ok(!JSON.stringify(upgrade).includes(MAW_TOKEN));
  const reply = new Promise<string>(resolve => ws.once('message', data => resolve(data.toString())));
  ws.send('{"event":"signal/request","payload":{}}');
  assert.equal(await reply, '{"event":"signal/request","payload":{}}');
  const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
  proxy.dispose();
  await closed;
});

test('viewer: selected-tab validation is repeated for HTTP API requests and WebSocket upgrades', async t => {
  let selected = true;
  const { port, enter } = await fixture(t, { validateSelectedTab: () => selected });
  const { headers } = await enter();
  selected = false;
  assert.equal((await get(port, NEKO_VIEWER_PATH + '/api/whoami', headers)).status, 409);
  assert.equal(await rejectedUpgrade(port, NEKO_VIEWER_PATH + '/api/ws', headers), 409);
});

test('viewer: established signaling is closed when its selected tab or paired-device authorization is revoked', async t => {
  for (const revoke of ['selection', 'device']) {
    let selected = true;
    const { port, enter, revokeDevice } = await fixture(t, { validateSelectedTab: () => selected });
    const { headers } = await enter({ cookie: `${DEVICE_COOKIE}=${DEVICE}` });
    const ws = new WebSocket(`ws://127.0.0.1:${port}${NEKO_VIEWER_PATH}/api/ws`, { headers });
    t.after(() => ws.terminate());
    await new Promise<void>((resolve, reject) => { ws.once('message', () => resolve()); ws.once('error', reject); });
    const closed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Revoked viewer socket remained connected')), 3_000);
      ws.once('close', () => { clearTimeout(timeout); resolve(); });
    });
    if (revoke === 'selection') selected = false;
    else revokeDevice();
    await closed;
  }
});

test('viewer: readiness requires real playing media and is revoked on stall, ended tracks, and iframe teardown', async t => {
  const { enter } = await fixture(t);
  const { response } = await enter();
  const script = response.body.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const messages: Array<{ data: { type: string; workspaceId: string; tabId: string }; origin: string }> = [];
  const events = new Map<string, (event: { type: string; target: unknown }) => void>();
  let tick: (() => void) | undefined;
  let teardown: (() => void) | undefined;
  let clearCount = 0;
  const track = { readyState: 'live', muted: false };
  class Video {
    readyState = 0;
    videoWidth = 0;
    paused = true;
    ended = false;
    srcObject: { getVideoTracks: () => typeof track[] } | null = null;
  }
  const video = new Video();
  const parent = { postMessage: (data: typeof messages[number]['data'], origin: string) => messages.push({ data, origin }) };
  runInNewContext(script, {
    URLSearchParams, HTMLVideoElement: Video,
    location: { search: QUERY, origin: 'http://127.0.0.1:24837' }, parent,
    window: { parent, addEventListener: (_event: string, handler: () => void) => { teardown = handler; } },
    document: {
      querySelectorAll: () => [video],
      addEventListener: (event: string, handler: (event: { type: string; target: unknown }) => void) => events.set(event, handler),
    },
    setInterval: (handler: () => void) => { tick = handler; return 1; },
    clearInterval: () => { clearCount++; },
  });
  tick!();
  assert.equal(messages.length, 0, 'iframe HTML alone cannot acknowledge inspection');
  video.readyState = 4; video.videoWidth = 1280; video.paused = false;
  tick!();
  assert.equal(messages.length, 0, 'a media element without a MediaStream cannot acknowledge inspection');
  video.srcObject = { getVideoTracks: () => [track] };
  tick!();
  assert.equal(messages.at(-1)?.data.type, 'agency.browser.viewer.ready');
  assert.equal(messages.at(-1)?.data.workspaceId, 'workspace-one');
  assert.equal(messages.at(-1)?.data.tabId, 'tab-one');
  assert.equal(messages.at(-1)?.origin, 'http://127.0.0.1:24837');
  events.get('stalled')!({ type: 'stalled', target: video });
  assert.equal(messages.at(-1)?.data.type, 'agency.browser.viewer.unavailable');
  const beforeTick = messages.length;
  tick!();
  assert.equal(messages.length, beforeTick, 'stale readyState does not override a stalled event');
  events.get('playing')!({ type: 'playing', target: video });
  assert.equal(messages.at(-1)?.data.type, 'agency.browser.viewer.ready');
  track.readyState = 'ended';
  tick!();
  assert.equal(messages.at(-1)?.data.type, 'agency.browser.viewer.unavailable');
  teardown!();
  assert.equal(clearCount, 1);
  assert.equal(messages.at(-1)?.data.type, 'agency.browser.viewer.unavailable');
});

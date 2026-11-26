import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyWebContentsZoom } from '../../../src/browser/zoom-controller.mjs';
import { discoverBackendReadiness } from '../../../src/ipc/backend-readiness.mjs';
import { isOAuthLoopbackCallback, createOAuthLoopbackGate } from '../../../src/security/oauth-loopback.mjs';
import {
  configureProviderSessionPermissions,
  configureShellSessionSecurity,
  isDurableProviderPage,
} from '../../../src/security/session-permissions.mjs';

test('isOAuthLoopbackCallback accepts valid loopback callbacks and rejects unsafe inputs', () => {
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/callback?code=abc123'), true);
  assert.equal(isOAuthLoopbackCallback('http://localhost:8080/oauth/callback?error=access_denied'), true);
  assert.equal(isOAuthLoopbackCallback('http://[::1]:5555/auth/callback/?code=xyz'), true);
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/oauth2callback?code=abc123'), true);
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/app/oidc/callback?code=abc123'), true);

  // Arbitrary non-callback paths must be rejected even with ?code=
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/x?code=1'), false);
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/other?code=abc123'), false);
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/?code=abc123'), false);
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/other?error=denied'), false);
  // Workbench's own port must be excluded when excludePort is provided
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:34187/callback?code=abc123', { excludePort: '34187' }), false);
  assert.equal(isOAuthLoopbackCallback('http://localhost:34187/callback?code=abc123', { excludePort: 34187 }), false);
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/callback?code=abc123', { excludePort: '34187' }), true);
  // Missing explicit port or empty code/error rejected
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1/callback?code=abc123'), false);
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/callback?code='), false);
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/callback?error='), false);

  assert.equal(isOAuthLoopbackCallback('https://127.0.0.1:4321/callback?code=abc123'), false);
  assert.equal(isOAuthLoopbackCallback('http://user:pass@localhost:4321/callback?code=abc'), false);
  assert.equal(isOAuthLoopbackCallback('http://example.com/callback?code=abc'), false);
  assert.equal(isOAuthLoopbackCallback('http://localhost:4321/callback'), false);
  assert.equal(isOAuthLoopbackCallback('http://localhost:4321/callback?code=abc\n'), false);
  assert.equal(isOAuthLoopbackCallback(null), false);
});

test('createOAuthLoopbackGate rate limits repeated loopback handoffs per source', () => {
  let clock = 1000;
  const allow = createOAuthLoopbackGate({ maxRequests: 2, windowMs: 5000, now: () => clock });
  assert.equal(allow('tab-1'), true);
  assert.equal(allow('tab-1'), true);
  assert.equal(allow('tab-1'), false);
  assert.equal(allow('tab-2'), true);
  clock += 5001;
  assert.equal(allow('tab-1'), true);
});

test('configureProviderSessionPermissions blocks local-network requests across restricted provider partitions', () => {
  for (const provider of ['chatgpt', 'github', 'perplexity']) {
    let beforeRequestHandler = null;
    const fakeSession = {
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      webRequest: {
        onBeforeRequest(handler) {
          beforeRequestHandler = handler;
        },
      },
    };
    configureProviderSessionPermissions({ provider, session: fakeSession });
    assert.equal(typeof beforeRequestHandler, 'function', `${provider} must register webRequest.onBeforeRequest`);

    const checkCancel = (url) => {
      let result = null;
      beforeRequestHandler({ url }, (res) => { result = res; });
      return result?.cancel;
    };

    for (const blocked of [
      'http://127.0.0.1:34187/api/state',
      'ws://127.0.0.1:34187/ws',
      'http://localhost:8080/secret',
      'http://[::1]:8080/',
      'http://192.168.1.1/admin',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://router.local/',
      'https://metadata.google.internal/',
    ]) {
      assert.equal(checkCancel(blocked), true, `${provider} must block ${blocked}`);
    }

    for (const allowed of [
      'https://chatgpt.com/backend-api/conversations',
      'wss://chatgpt.com/ws',
      'https://github.com/owner/repo',
      'https://www.perplexity.ai/search',
      'https://accounts.google.com/o/oauth2/v2/auth?state=' + 'a'.repeat(2500),
      'data:image/png;base64,AA==',
      'blob:https://chatgpt.com/123',
    ]) {
      assert.equal(checkCancel(allowed), false, `${provider} must allow ${allowed}`);
    }
  }
});

test('configureProviderSessionPermissions allows local web apps and enforces backend port and PNA protection for other partition', () => {
  let beforeRequestHandler = null;
  const fakeSession = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    webRequest: {
      onBeforeRequest(handler) {
        beforeRequestHandler = handler;
      },
    },
  };
  configureProviderSessionPermissions({
    provider: 'other',
    session: fakeSession,
    backendPort: 34187,
  });
  assert.equal(typeof beforeRequestHandler, 'function', 'other must register webRequest.onBeforeRequest');

  const check = (details) => {
    let result = null;
    const req = typeof details === 'string' ? { url: details } : details;
    beforeRequestHandler(req, (res) => { result = res; });
    return result?.cancel;
  };

  // Workbench backend loopback port is strictly blocked
  assert.equal(check('http://127.0.0.1:34187/api/state'), true, 'other must block Workbench backend port');
  assert.equal(check('ws://127.0.0.1:34187/ws'), true, 'other must block Workbench backend WebSocket');

  // Local web applications and private network hosts are permitted for direct navigation
  for (const allowedLocal of [
    'http://127.0.0.1:8080/dashboard',
    'ws://127.0.0.1:8080/ws',
    'http://localhost:3000/',
    'http://[::1]:8080/',
    'http://192.168.1.1/admin',
    'http://10.0.0.1/',
    'http://router.local/',
  ]) {
    assert.equal(check(allowedLocal), false, `other must allow local web app ${allowedLocal}`);
  }

  // Private Network Access (PNA) protection:
  // Remote public site attempting subresource request to local/private network is blocked
  assert.equal(
    check({
      url: 'http://127.0.0.1:8080/secret',
      resourceType: 'xhr',
      initiator: 'https://attacker.example.com',
    }),
    true,
    'other must block cross-network subresource access from public initiator to local host',
  );

  // Local site subresource request to local network is permitted
  assert.equal(
    check({
      url: 'http://127.0.0.1:8080/api/data',
      resourceType: 'xhr',
      initiator: 'http://127.0.0.1:8080',
    }),
    false,
    'other must allow local initiator to access local network subresources',
  );
});

test('configureShellSessionSecurity blocks non-shell local SSRF and strips cookies/Referer on cross-origin requests', () => {
  let onBeforeRequest = null;
  let onBeforeSendHeaders = null;
  let onHeadersReceived = null;
  const fakeSession = {
    webRequest: {
      onBeforeRequest(fn) { onBeforeRequest = fn; },
      onBeforeSendHeaders(fn) { onBeforeSendHeaders = fn; },
      onHeadersReceived(fn) { onHeadersReceived = fn; },
    },
  };
  configureShellSessionSecurity({
    session: fakeSession,
    getLocalOrigin: () => 'http://127.0.0.1:34187',
  });

  const checkCancel = (url) => {
    let res;
    onBeforeRequest({ url }, (out) => { res = out; });
    return res.cancel;
  };

  assert.equal(checkCancel('http://127.0.0.1:34187/'), false);
  assert.equal(checkCancel('ws://127.0.0.1:34187/ws'), false);
  assert.equal(checkCancel('https://github.githubassets.com/favicons/favicon.png'), false);
  assert.equal(checkCancel('data:image/png;base64,AA=='), false);

  assert.equal(checkCancel('http://127.0.0.1:9999/favicon.ico'), true);
  assert.equal(checkCancel('http://localhost:34187/favicon.ico'), true);
  assert.equal(checkCancel('http://[::1]:8080/favicon.ico'), true);
  assert.equal(checkCancel('https://192.168.1.1/favicon.ico'), true);
  assert.equal(checkCancel('http://example.com/favicon.ico'), true);

  // Cross-origin favicon request strips Cookie, Referer, Authorization, Origin
  let crossReqHeaders;
  onBeforeSendHeaders(
    {
      url: 'https://github.githubassets.com/favicons/favicon.png',
      requestHeaders: {
        Cookie: 'session=secret',
        Referer: 'http://127.0.0.1:34187/?token=supersecret',
        Authorization: 'Bearer abc',
        Origin: 'http://127.0.0.1:34187',
        Accept: 'image/png',
      },
    },
    (out) => { crossReqHeaders = out.requestHeaders; },
  );
  assert.deepEqual(crossReqHeaders, { Accept: 'image/png' });

  // Local shell request keeps headers intact
  let localReqHeaders;
  onBeforeSendHeaders(
    {
      url: 'http://127.0.0.1:34187/api/test',
      requestHeaders: { Cookie: 'a=b', Referer: 'http://127.0.0.1:34187/' },
    },
    (out) => { localReqHeaders = out.requestHeaders; },
  );
  assert.deepEqual(localReqHeaders, { Cookie: 'a=b', Referer: 'http://127.0.0.1:34187/' });

  // Cross-origin response strips Set-Cookie
  let crossResHeaders;
  onHeadersReceived(
    {
      url: 'https://github.githubassets.com/favicons/favicon.png',
      responseHeaders: { 'Set-Cookie': ['track=1'], 'Content-Type': ['image/png'] },
    },
    (out) => { crossResHeaders = out.responseHeaders; },
  );
  assert.deepEqual(crossResHeaders, { 'Content-Type': ['image/png'] });
});

test('isDurableProviderPage distinguishes durable provider routes from sensitive auth URLs', () => {
  assert.equal(isDurableProviderPage('chatgpt', 'https://chatgpt.com/c/12345'), true);
  assert.equal(isDurableProviderPage('chatgpt', 'https://chatgpt.com/auth/login'), false);
  assert.equal(isDurableProviderPage('chatgpt', 'https://chatgpt.com/?token=secret'), false);
  assert.equal(isDurableProviderPage('chatgpt', 'https://evil.com/'), false);

  assert.equal(isDurableProviderPage('github', 'https://github.com/example/workbench'), true);
  assert.equal(isDurableProviderPage('github', 'https://github.com/login/oauth/authorize?code=1'), false);

  assert.equal(isDurableProviderPage('other', 'https://example.com/docs'), true);
  assert.equal(isDurableProviderPage('other', 'http://127.0.0.1:3000/'), true);
  assert.equal(isDurableProviderPage('other', 'http://127.0.0.1:3000/auth/login'), false);
  assert.equal(isDurableProviderPage('other', 'http://127.0.0.1:3000/?token=secret'), false);
  assert.equal(isDurableProviderPage('other', 'javascript:alert(1)'), false);
});

test('applyWebContentsZoom bounds zoom levels, tracks map state, and emits zoom percentage', () => {
  const events = [];
  const zoomLevels = new Map();
  let currentLevel = 2.8;
  const fakeContents = {
    isDestroyed: () => false,
    getZoomLevel: () => currentLevel,
    setZoomLevel: (next) => {
      currentLevel = next;
    },
    getZoomFactor: () => Math.pow(1.2, currentLevel),
  };

  applyWebContentsZoom('tab-1', fakeContents, 'zoom-in', zoomLevels, (msg) => events.push(msg));
  assert.equal(currentLevel, 3);
  assert.equal(zoomLevels.get('tab-1'), 3);
  assert.equal(events.at(-1)?.type, 'browser-zoom');
  assert.equal(events.at(-1)?.id, 'tab-1');
  assert.equal(events.at(-1)?.percentage, Math.round(Math.pow(1.2, 3) * 100));

  applyWebContentsZoom('tab-1', fakeContents, 'zoom-reset', zoomLevels, (msg) => events.push(msg));
  assert.equal(currentLevel, 0);
  assert.equal(events.at(-1)?.percentage, 100);

  const countBeforeDestroyed = events.length;
  applyWebContentsZoom(
    'tab-1',
    { ...fakeContents, isDestroyed: () => true },
    'zoom-out',
    zoomLevels,
    (msg) => events.push(msg),
  );
  assert.equal(events.length, countBeforeDestroyed);
});

test('discoverBackendReadiness enforces file permissions, rejects symlinks, and probes loopback URL', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'maw-readiness-test-'));
  const previousRuntimeDir = process.env.WORKBENCH_RUNTIME_DIR;
  let server;
  try {
    await chmod(dir, 0o700);
    process.env.WORKBENCH_RUNTIME_DIR = dir;
    const readyFile = path.join(dir, 'workbench-ready.json');

    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    // Unsafe mode (0644) must be rejected.
    await writeFile(readyFile, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}/` }));
    await chmod(readyFile, 0o644);
    await assert.rejects(() => discoverBackendReadiness(), /Unsafe readiness file permissions/);

    // Valid 0600 file succeeds.
    await chmod(readyFile, 0o600);
    const result = await discoverBackendReadiness();
    assert.equal(result.pid, process.pid);
    assert.match(result.url.href, new RegExp(`127\\.0\\.0\\.1:${port}`));

    // Symlink must be rejected.
    const targetFile = path.join(dir, 'target.json');
    await writeFile(targetFile, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}/` }));
    await chmod(targetFile, 0o600);
    await rm(readyFile);
    await symlink(targetFile, readyFile);
    await assert.rejects(() => discoverBackendReadiness(), /Invalid readiness file type/);
  } finally {
    if (previousRuntimeDir === undefined) {
      delete process.env.WORKBENCH_RUNTIME_DIR;
    } else {
      process.env.WORKBENCH_RUNTIME_DIR = previousRuntimeDir;
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

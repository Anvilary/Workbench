import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyWebContentsZoom } from '../../../src/browser/zoom-controller.mjs';
import { discoverBackendReadiness } from '../../../src/ipc/backend-readiness.mjs';
import { isOAuthLoopbackCallback } from '../../../src/security/oauth-loopback.mjs';
import { isDurableProviderPage } from '../../../src/security/session-permissions.mjs';

test('isOAuthLoopbackCallback accepts valid loopback callbacks and rejects unsafe inputs', () => {
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/callback?code=abc123'), true);
  assert.equal(isOAuthLoopbackCallback('http://localhost:8080/oauth/callback?error=access_denied'), true);
  assert.equal(isOAuthLoopbackCallback('http://[::1]:5555/auth/callback/?code=xyz'), true);
  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/other?code=abc123'), true);

  assert.equal(isOAuthLoopbackCallback('http://127.0.0.1:4321/other?error=denied'), false);
  assert.equal(isOAuthLoopbackCallback('https://127.0.0.1:4321/callback?code=abc123'), false);
  assert.equal(isOAuthLoopbackCallback('http://user:pass@localhost:4321/callback?code=abc'), false);
  assert.equal(isOAuthLoopbackCallback('http://example.com/callback?code=abc'), false);
  assert.equal(isOAuthLoopbackCallback('http://localhost:4321/callback'), false);
  assert.equal(isOAuthLoopbackCallback('http://localhost:4321/callback?code=abc\n'), false);
  assert.equal(isOAuthLoopbackCallback(null), false);
});

test('isDurableProviderPage distinguishes durable provider routes from sensitive auth URLs', () => {
  assert.equal(isDurableProviderPage('chatgpt', 'https://chatgpt.com/c/12345'), true);
  assert.equal(isDurableProviderPage('chatgpt', 'https://chatgpt.com/auth/login'), false);
  assert.equal(isDurableProviderPage('chatgpt', 'https://chatgpt.com/?token=secret'), false);
  assert.equal(isDurableProviderPage('chatgpt', 'https://evil.com/'), false);

  assert.equal(isDurableProviderPage('github', 'https://github.com/user/My-Amazing-Workspace'), true);
  assert.equal(isDurableProviderPage('github', 'https://github.com/login/oauth/authorize?code=1'), false);

  assert.equal(isDurableProviderPage('other', 'https://example.com/docs'), true);
  assert.equal(isDurableProviderPage('other', 'http://127.0.0.1:3000/'), false);
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
  const previousRuntimeDir = process.env.MAW_RUNTIME_DIR;
  let server;
  try {
    await chmod(dir, 0o700);
    process.env.MAW_RUNTIME_DIR = dir;
    const readyFile = path.join(dir, 'maw-ready.json');

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
      delete process.env.MAW_RUNTIME_DIR;
    } else {
      process.env.MAW_RUNTIME_DIR = previousRuntimeDir;
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

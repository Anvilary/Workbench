// Spec test 11: browser partition state survives the migration, through ACTUAL Electron launches.
//
// Phase 1 writes cookies, localStorage, IndexedDB, a service worker cache and a custom spellchecker word
// into the legacy partitions (`persist:maw-*`) of a synthetic userData. Phase 2, after `apply`, reads the
// same state back from the canonical partitions (`persist:workbench-*`) of the copied userData.
//
// Only PIDs this test starts are signalled, and they are matched by the fixture HOME, never by name.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { _electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createFixture } from './helpers/migration-fixture.mjs';
import { fileManifest } from '../migrate-identity.mjs';
import { pidsWithHome, reapProcessesWithHome } from '../../../packages/desktop/tests/helpers/owned-processes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_APP = path.join(HERE, 'fixtures/partition-probe');
const REPO_ROOT = path.resolve(HERE, '../../..');
const PAGE = '<!doctype html><html><head><title>probe</title></head><body><p>probe</p></body></html>';
const SERVICE_WORKER = `
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open('wb-probe');
    await cache.put('/cached.txt', new Response('cached-payload', { headers: { 'Content-Type': 'text/plain' } }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
`;

async function startProbeOrigin(t) {
  const server = http.createServer((request, response) => {
    if (request.url === '/sw.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.setHeader('Service-Worker-Allowed', '/');
      response.end(SERVICE_WORKER);
    } else if (request.url === '/cached.txt') {
      response.setHeader('Content-Type', 'text/plain');
      response.end('cached-payload');
    } else if (request.url === '/auth') {
      const authenticated = String(request.headers.cookie || '').split(';').some((cookie) => cookie.trim().startsWith('wb_probe='));
      response.end(authenticated ? 'authenticated' : 'unauthorized');
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(PAGE);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function electronBinary() {
  const candidates = [
    process.env.WB_TEST_ELECTRON,
    process.env.WORKBENCH_ELECTRON_EXECUTABLE,
    '/opt/maw-electron/45.2.0/electron',
    path.join(REPO_ROOT, 'node_modules/electron/dist/electron'),
    path.join(REPO_ROOT, 'packages/desktop/node_modules/electron/dist/electron'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '');
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function probeEnv(fixture, userData) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('MAW_') || key.startsWith('WORKBENCH_')) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    ...env,
    HOME: fixture.home,
    XDG_CONFIG_HOME: fixture.configHome,
    XDG_DATA_HOME: fixture.dataHome,
    XDG_STATE_HOME: fixture.stateHome,
    XDG_RUNTIME_DIR: fixture.runtimeDir,
    XDG_CACHE_HOME: path.join(fixture.home, '.cache'),
    WB_PROBE_USER_DATA: userData,
  };
}

/** Run the probe app once. Retries with --no-sandbox only when the sandbox itself fails here. */
async function runProbe(fixture, { mode, partitions, userData, port, outFile, electron }) {
  const attempt = async (extraArgs) => {
    let application;
    let output = '';
    try {
      application = await _electron.launch({
        executablePath: electron,
        args: [PROBE_APP, '--ozone-platform=x11', ...extraArgs],
        chromiumSandbox: !extraArgs.includes('--no-sandbox'),
        timeout: 90_000,
        env: {
        ...probeEnv(fixture, userData),
        WB_PROBE_MODE: mode,
        WB_PROBE_PARTITIONS: partitions.join(','),
        WB_PROBE_OUT: outFile,
        WB_PROBE_PORT: String(port),
        WB_PROBE_ORIGIN: `http://127.0.0.1:${port}/`,
        },
      });
    } catch (error) {
      return { code: 1, output: String(error), startedPid: null };
    }
    const child = application.process();
    const startedPid = child.pid;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk.toString(); });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        application.close().catch(() => {});
        reject(new Error(`probe ${mode} timed out\n${output}`));
      }, 90_000);
      if (child.exitCode !== null) { clearTimeout(timer); resolve(child.exitCode); }
      else child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    await application.close().catch(() => {});
    return { code, output, startedPid };
  };

  let result = await attempt([]);
  if (result.code !== 0 && /sandbox|SUID|namespace/i.test(result.output)) {
    result = await attempt(['--no-sandbox']);
  }
  assert.equal(result.code, 0, `probe ${mode} failed (exit ${result.code}):\n${result.output}`);
  assert.equal(fs.existsSync(outFile), true, `probe ${mode} wrote no result:\n${result.output}`);
  return { ...JSON.parse(fs.readFileSync(outFile, 'utf8')), startedPid: result.startedPid };
}

const electron = electronBinary();

test('11. partition state survives the migration through real Electron launches', { timeout: 300_000, skip: electron === null ? 'no Electron runtime available' : false }, async (t) => {
  const fixture = createFixture(t);
  const port = await startProbeOrigin(t);
  // Electron owns this userData: start from an empty one so no synthetic leveldb files confuse it.
  fs.rmSync(fixture.legacy.userData, { recursive: true, force: true });
  fs.mkdirSync(fixture.legacy.userData, { recursive: true, mode: 0o700 });
  t.after(async () => {
    await reapProcessesWithHome(fixture.home).catch(() => {});
  });

  const write = await runProbe(fixture, {
    mode: 'write',
    partitions: ['persist:maw-browser', 'persist:maw-profile-test1-chatgpt'],
    userData: fixture.legacy.userData,
    port,
    outFile: path.join(fixture.home, 'probe-write.json'),
    electron,
  });
  assert.deepEqual(Object.keys(write.partitions).sort(), ['browser', 'profile-test1-chatgpt']);
  for (const [tag, state] of Object.entries(write.partitions)) {
    assert.deepEqual(state.cookie, [{ value: `cookie-${tag}`, persistent: true, httpOnly: true }], `${tag} cookie`);
    assert.equal(state.localStorage, `ls-${tag}`);
    assert.equal(state.indexedDb, `idb-${tag}`);
    assert.equal(state.cache, 'cached-payload');
    assert.equal(state.serviceWorkers, 1);
    assert.equal(state.authenticated, 'authenticated');
    assert.equal(state.httpOnlyCookieHidden, true);
    assert.deepEqual(state.dictionary, ['anvilaryworkbench'], `${tag} dictionary`);
  }
  // Electron rewrites files on shutdown: the baseline manifest is taken after it exited.
  assert.equal(pidsWithHome(fixture.home).length, 0, 'the write phase left processes behind');
  const legacyBefore = fileManifest(fixture.legacy.userData);
  const partitionsDir = path.join(fixture.legacy.userData, 'Partitions');
  assert.deepEqual(fs.readdirSync(partitionsDir).sort(), ['maw-browser', 'maw-profile-test1-chatgpt']);

  const applied = fixture.run(['apply']);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.deepEqual(
    fs.readdirSync(path.join(fixture.canonical.userData, 'Partitions')).sort(),
    ['workbench-browser', 'workbench-profile-test1-chatgpt'],
  );

  const read = await runProbe(fixture, {
    mode: 'read',
    partitions: ['persist:workbench-browser', 'persist:workbench-profile-test1-chatgpt'],
    userData: fixture.canonical.userData,
    port: write.port,
    outFile: path.join(fixture.home, 'probe-read.json'),
    electron,
  });
  assert.equal(read.port, write.port, 'the read phase must reuse the write phase origin');

  for (const tag of ['browser', 'profile-test1-chatgpt']) {
    const before = write.partitions[tag];
    const after = read.partitions[tag];
    assert.deepEqual(after.cookie, before.cookie, `${tag}: cookie`);
    assert.equal(after.localStorage, before.localStorage, `${tag}: localStorage`);
    assert.equal(after.indexedDb, before.indexedDb, `${tag}: IndexedDB`);
    assert.equal(after.cache, before.cache, `${tag}: service worker cache`);
    assert.equal(after.serviceWorkers, before.serviceWorkers, `${tag}: service worker registration`);
    assert.equal(after.authenticated, before.authenticated, `${tag}: HTTP-only cookie authentication`);
    assert.equal(after.httpOnlyCookieHidden, before.httpOnlyCookieHidden, `${tag}: HTTP-only cookie visibility`);
    assert.deepEqual(after.dictionary, before.dictionary, `${tag}: spellchecker dictionary`);
  }

  // The legacy installation is untouched by the copy.
  assert.deepEqual(fileManifest(fixture.legacy.userData), legacyBefore, 'the legacy userData changed');
  assert.equal(pidsWithHome(fixture.home).length, 0, 'the read phase left processes behind');
});

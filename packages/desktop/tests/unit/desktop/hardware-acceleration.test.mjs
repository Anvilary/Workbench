import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CHANNEL } from '../../../policy.mjs';
import { DESKTOP_PREFS_FILENAME, readDesktopPreferences, writeDesktopPreferences } from '../../../src/app/desktop-preferences.mjs';
import { createHardwareAccelerationSettings, summarizeGpuFeatureStatus } from '../../../src/app/hardware-acceleration.mjs';
import { GraphicsMode, resolveGraphicsPolicy } from '../../../src/gpu/graphics-policy.mjs';
import { registerCommandRouter } from '../../../src/ipc/command-router.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workbench-desktop-prefs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const resolve = (env, hardwareAccelerationPreference) => resolveGraphicsPolicy({ platform: 'linux', env, renderNodes: [], exists: () => false, hardwareAccelerationPreference });

/** The full startup path: file on disk -> preference -> policy. */
function startupFor(dir, env) {
  return resolve(env, readDesktopPreferences(dir).prefs.hardwareAcceleration);
}

test('precedence: WORKBENCH_SAFE_GRAPHICS=1 forces acceleration off over a saved true', async t => {
  const dir = await tempDir(t);
  writeDesktopPreferences(dir, { hardwareAcceleration: true });
  const policy = startupFor(dir, { WORKBENCH_SAFE_GRAPHICS: '1' });
  assert.equal(policy.disableHardwareAcceleration, true);
  assert.equal(policy.mode, GraphicsMode.SAFE);
  assert.deepEqual(policy.hardwareAcceleration, { effective: false, source: 'env' });
});

test('precedence: WORKBENCH_SAFE_GRAPHICS=0 forces acceleration on over a saved false', async t => {
  const dir = await tempDir(t);
  writeDesktopPreferences(dir, { hardwareAcceleration: false });
  const policy = startupFor(dir, { WORKBENCH_SAFE_GRAPHICS: '0' });
  assert.equal(policy.disableHardwareAcceleration, false);
  assert.deepEqual(policy.hardwareAcceleration, { effective: true, source: 'env' });
});

test('precedence: the saved preference applies without an environment override', async t => {
  const dir = await tempDir(t);
  writeDesktopPreferences(dir, { hardwareAcceleration: true });
  assert.deepEqual(startupFor(dir, {}).hardwareAcceleration, { effective: true, source: 'preference' });
  writeDesktopPreferences(dir, { hardwareAcceleration: false });
  const off = startupFor(dir, {});
  assert.equal(off.disableHardwareAcceleration, true);
  assert.equal(off.mode, GraphicsMode.SAFE);
  assert.deepEqual(off.hardwareAcceleration, { effective: false, source: 'preference' });
});

test('precedence: a missing file means enabled by default', async t => {
  const dir = await tempDir(t);
  assert.equal(readDesktopPreferences(dir).state, 'missing');
  const policy = startupFor(dir, {});
  assert.equal(policy.disableHardwareAcceleration, false);
  assert.deepEqual(policy.hardwareAcceleration, { effective: true, source: 'default' });
});

test('precedence: corrupt JSON or a non boolean value means enabled by default', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, DESKTOP_PREFS_FILENAME);
  fs.writeFileSync(file, '{"hardwareAcceleration": fal');
  assert.equal(readDesktopPreferences(dir).state, 'invalid');
  assert.deepEqual(startupFor(dir, {}).hardwareAcceleration, { effective: true, source: 'default' });
  fs.writeFileSync(file, JSON.stringify({ hardwareAcceleration: 'false' }));
  assert.equal(readDesktopPreferences(dir).state, 'invalid');
  assert.deepEqual(startupFor(dir, {}).hardwareAcceleration, { effective: true, source: 'default' });
  fs.writeFileSync(file, 'null');
  assert.deepEqual(startupFor(dir, {}).hardwareAcceleration, { effective: true, source: 'default' });
});

test('precedence: an unreadable file or a symlink means enabled by default and never throws', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, DESKTOP_PREFS_FILENAME);
  const eacces = { lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true }), readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  assert.deepEqual(readDesktopPreferences(dir, { fs: eacces }), { prefs: {}, state: 'unreadable', error: 'EACCES' });
  const target = path.join(dir, 'elsewhere.json');
  fs.writeFileSync(target, JSON.stringify({ hardwareAcceleration: false }));
  fs.symlinkSync(target, file);
  assert.equal(readDesktopPreferences(dir).state, 'invalid');
  assert.deepEqual(startupFor(dir, {}).hardwareAcceleration, { effective: true, source: 'default' });
  assert.equal(readDesktopPreferences('relative/path').state, 'unreadable');
});

test('the write is atomic, mode 0600, keeps other keys and leaves no temp file', async t => {
  const dir = await tempDir(t);
  assert.deepEqual(writeDesktopPreferences(dir, { hardwareAcceleration: false }), { ok: true });
  const file = path.join(dir, DESKTOP_PREFS_FILENAME);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, hardwareAcceleration: false });
  assert.deepEqual(fs.readdirSync(dir), [DESKTOP_PREFS_FILENAME]);

  // A failed rename leaves the previous file intact and cleans the temp file.
  const failing = { ...fs, renameSync: () => { throw Object.assign(new Error('boom'), { code: 'EXDEV' }); } };
  assert.deepEqual(writeDesktopPreferences(dir, { hardwareAcceleration: true }, { fs: failing }), { ok: false, error: 'EXDEV' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, hardwareAcceleration: false });
  assert.deepEqual(fs.readdirSync(dir), [DESKTOP_PREFS_FILENAME]);

  // Writes go through a temp file then a rename onto the final name.
  const ops = [];
  const spying = { ...fs, writeFileSync: (p, ...rest) => { ops.push(['write', path.basename(p), rest[0]?.mode ?? rest[1]?.mode]); return fs.writeFileSync(p, ...rest); }, renameSync: (a, b) => { ops.push(['rename', path.basename(a), path.basename(b)]); return fs.renameSync(a, b); } };
  writeDesktopPreferences(dir, { hardwareAcceleration: true }, { fs: spying });
  assert.equal(ops.length, 2);
  assert.match(ops[0][1], /^\.desktop-preferences\.json\.tmp\./);
  assert.equal(ops[1][1], ops[0][1]);
  assert.equal(ops[1][2], DESKTOP_PREFS_FILENAME);
});

test('the write refuses a symlinked preferences file', async t => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'target.json');
  fs.writeFileSync(target, '{}');
  fs.symlinkSync(target, path.join(dir, DESKTOP_PREFS_FILENAME));
  assert.equal(writeDesktopPreferences(dir, { hardwareAcceleration: false }).ok, false);
  assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});

const GPU = { gpu_compositing: 'enabled', rasterization: 'enabled', webgl: 'enabled', video_decode: 'disabled_software', '2d_canvas': 'enabled' };

test('IPC status shape: configured, effectiveAtStartup, source, pendingRestart and GPU status', async t => {
  const dir = await tempDir(t);
  let ready = false;
  const app = { isReady: () => ready, getGPUFeatureStatus: () => GPU };
  const settings = createHardwareAccelerationSettings({ app, userDataDir: dir, startup: { effective: true, source: 'default' } });
  assert.deepEqual(settings.status(), {
    ok: true, configured: true, effectiveAtStartup: true, source: 'default', pendingRestart: false, gpuFeatureStatus: null, gpuSummary: null,
  });
  ready = true;
  const next = settings.set(false);
  assert.equal(next.configured, false);
  assert.equal(next.effectiveAtStartup, true);
  assert.equal(next.pendingRestart, true);
  assert.deepEqual(next.gpuFeatureStatus, GPU);
  assert.deepEqual(next.gpuSummary, {
    compositing: 'hardware', rasterization: 'hardware', webgl: 'hardware', videoDecode: 'software',
    text: 'compositing=hardware, rasterization=hardware, webgl=hardware, videoDecode=software',
  });
  // Setting it back clears the pending restart. Nothing restarts the app.
  assert.equal(settings.set(true).pendingRestart, false);
  assert.deepEqual(settings.set('yes'), { ok: false, error: 'enabled must be a boolean' });
  const failing = createHardwareAccelerationSettings({ app, userDataDir: dir, startup: { effective: true, source: 'default' }, writePrefs: () => ({ ok: false, error: 'EACCES' }) });
  assert.equal(failing.set(false).ok, false);
});

test('the GPU summary classifies Chromium feature states', () => {
  assert.equal(summarizeGpuFeatureStatus(null), null);
  const off = summarizeGpuFeatureStatus({ gpu_compositing: 'disabled_software', rasterization: 'disabled_off', webgl: 'unavailable_off', video_decode: 'enabled_force' });
  assert.equal(off.compositing, 'software');
  assert.equal(off.rasterization, 'off');
  assert.equal(off.webgl, 'off');
  assert.equal(off.videoDecode, 'hardware');
  assert.equal(summarizeGpuFeatureStatus({}).webgl, 'unknown');
});

test('the desktop command channel routes and validates the hardware acceleration commands', async () => {
  const ORIGIN = 'http://127.0.0.1:4100';
  const shell = { id: 'shell', mainFrame: { id: 'main', url: `${ORIGIN}/` } };
  const calls = [];
  let handler;
  registerCommandRouter({
    ipcMain: { handle: (channel, fn) => { assert.equal(channel, CHANNEL); handler = fn; } },
    win: { webContents: shell },
    dialog: {},
    backend: { current: () => new URL(`${ORIGIN}/`) },
    controller: {},
    performance: {},
    hardwareAcceleration: { status: () => (calls.push(['status']), { ok: true }), set: enabled => (calls.push(['set', enabled]), { ok: true }) },
    clipboardCommands: {},
  });
  const event = { sender: shell, senderFrame: shell.mainFrame };
  await handler(event, { type: 'get-hardware-acceleration' });
  await handler(event, { type: 'set-hardware-acceleration', enabled: false });
  assert.deepEqual(calls, [['status'], ['set', false]]);
  await assert.rejects(handler(event, { type: 'set-hardware-acceleration', enabled: 'false' }), /Invalid desktop request/);
  await assert.rejects(handler(event, { type: 'set-hardware-acceleration' }), /Invalid desktop request/);
  await assert.rejects(handler(event, { type: 'get-hardware-acceleration', extra: 1 }), /Invalid desktop request/);
  assert.equal(calls.length, 2);
});

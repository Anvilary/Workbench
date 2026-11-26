import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  DESKTOP_LOG_FILENAME,
  MAIN_PROCESS_ERROR_TITLE,
  createDiagnosticLogger,
  ignoreEpipeOnly,
  installConsoleMirror,
  installFatalHandlers,
  installProcessGoneLogging,
  readReleaseInfo,
  redact,
  resolveDesktopLogDir,
} from '../../../src/app/diagnostic-log.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workbench-desktop-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('log directory: override, XDG_STATE_HOME, then ~/.local/state', () => {
  const homedir = () => '/home/user';
  assert.equal(resolveDesktopLogDir({ env: { WORKBENCH_DESKTOP_LOG_DIR: '/tmp/x', XDG_STATE_HOME: '/s' }, homedir }), '/tmp/x');
  assert.equal(resolveDesktopLogDir({ env: { XDG_STATE_HOME: '/s' }, homedir }), '/s/workbench/logs');
  assert.equal(resolveDesktopLogDir({ env: {}, homedir }), '/home/user/.local/state/workbench/logs');
  // Isolated non-production instances log inside their own data directory.
  assert.equal(resolveDesktopLogDir({ env: { WORKBENCH_DESKTOP_DATA_DIR: '/tmp/d', XDG_STATE_HOME: '/s' }, homedir }), '/tmp/d/logs');
  assert.equal(resolveDesktopLogDir({ env: { WORKBENCH_DESKTOP_DATA_DIR: '/tmp/d', WORKBENCH_DESKTOP_PRODUCTION: '1', XDG_STATE_HOME: '/s' }, homedir }), '/s/workbench/logs');
  // Relative overrides are ignored rather than resolved against an arbitrary cwd.
  assert.equal(resolveDesktopLogDir({ env: { WORKBENCH_DESKTOP_LOG_DIR: 'rel', XDG_STATE_HOME: 'rel2' }, homedir }), '/home/user/.local/state/workbench/logs');
});

test('the logger creates a 0700 directory and a 0600 file', async t => {
  const dir = path.join(await tempDir(t), 'nested', 'logs');
  const logger = createDiagnosticLogger({ dir });
  assert.equal(logger.error('boom'), true);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, DESKTOP_LOG_FILENAME)).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(logger.file, 'utf8'), /\[error\] pid=\d+ boom\n$/);
});

test('size based rotation keeps the configured number of old files', async t => {
  const dir = await tempDir(t);
  const logger = createDiagnosticLogger({ dir, maxBytes: 200, keep: 2 });
  for (let i = 0; i < 40; i++) logger.info(`line ${i} ${'x'.repeat(40)}`);
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, [DESKTOP_LOG_FILENAME, `${DESKTOP_LOG_FILENAME}.1`, `${DESKTOP_LOG_FILENAME}.2`]);
  for (const name of names) assert.ok(fs.statSync(path.join(dir, name)).size <= 200, name);
  assert.match(fs.readFileSync(path.join(dir, DESKTOP_LOG_FILENAME), 'utf8'), /line 39/);
});

test('redaction strips query strings, token parameters and long hex secrets', () => {
  const secret = 'a'.repeat(16) + '0123456789abcdef0123456789';
  const out = redact(`GET http://127.0.0.1:45000/?token=${secret}&x=1 token=abc password=hunter2 key ${secret} https://example.com/a/b#frag`);
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('token=abc'));
  assert.ok(!out.includes('frag'));
  assert.match(out, /http:\/\/127\.0\.0\.1:45000\/\?\[redacted\]/);
  assert.match(out, /\[redacted-hex\]/);
  assert.equal(redact('plain message 1234'), 'plain message 1234');
});

test('the logger never throws when the directory is unwritable', async t => {
  const base = await tempDir(t);
  const blocker = path.join(base, 'file-not-dir');
  fs.writeFileSync(blocker, '');
  const logger = createDiagnosticLogger({ dir: path.join(blocker, 'logs') });
  assert.equal(logger.error('nope'), false);
  const throwing = createDiagnosticLogger({
    dir: base,
    fs: { mkdirSync() { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } },
  });
  assert.doesNotThrow(() => throwing.warn('still fine'));
  assert.equal(throwing.warn('still fine'), false);
});

test('diagnostics refuses a symlink and tightens an existing log before appending', async t => {
  const dir = await tempDir(t);
  const logger = createDiagnosticLogger({ dir });
  const unrelated = path.join(dir, 'unrelated');
  fs.writeFileSync(unrelated, 'keep');
  fs.symlinkSync(unrelated, logger.file);
  assert.equal(logger.warn('private'), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  fs.unlinkSync(logger.file);
  fs.writeFileSync(logger.file, 'older entry');
  fs.chmodSync(logger.file, 0o644);
  assert.equal(logger.warn('new entry'), true);
  assert.equal(fs.statSync(logger.file).mode & 0o777, 0o600);
});

test('stdout EPIPE is ignored, every other stream error still surfaces', () => {
  const stream = new PassThrough();
  const consoleRef = { error() {}, warn() {} };
  const entries = [];
  const uninstall = installConsoleMirror({ logger: { write: (...a) => entries.push(a) }, consoleRef, streams: [stream] });
  assert.doesNotThrow(() => stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
  assert.throws(() => stream.emit('error', Object.assign(new Error('other'), { code: 'EIO' })), /other/);
  assert.throws(() => ignoreEpipeOnly(new Error('no code')), /no code/);
  uninstall();
  assert.equal(stream.listenerCount('error'), 0);
});

test('console.error and console.warn are mirrored to the log and still printed', () => {
  const printed = [];
  const consoleRef = { error: (...a) => printed.push(['error', ...a]), warn: (...a) => printed.push(['warn', ...a]) };
  const entries = [];
  const uninstall = installConsoleMirror({ logger: { write: (...a) => entries.push(a) }, consoleRef, streams: [] });
  consoleRef.error('e1');
  consoleRef.warn('w1');
  assert.deepEqual(entries, [['error', 'e1'], ['warn', 'w1']]);
  assert.deepEqual(printed, [['error', 'e1'], ['warn', 'w1']]);
  // A synchronous EPIPE from the underlying console write is ignored only for that write.
  uninstall();
  const mirrored = { error: () => { throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' }); }, warn() {} };
  installConsoleMirror({ logger: { write() {} }, consoleRef: mirrored, streams: [] });
  assert.doesNotThrow(() => mirrored.error('x'));
});

test('uncaughtException logs stack, process type, lifecycle and release, then shows the dialog and exits 1', () => {
  const proc = new EventEmitter();
  proc.type = 'browser';
  const lines = [];
  const calls = [];
  const handlers = installFatalHandlers({
    processRef: proc,
    logger: { error: (...a) => lines.push(a.join(' ')) },
    lifecycle: () => 'ready',
    context: () => ({ version: '1.2.3', releaseId: 'rel-1' }),
    showErrorBox: (title, body) => calls.push(['dialog', title, body]),
    exit: code => calls.push(['exit', code]),
  });
  const error = new Error('write EPIPE');
  proc.emit('uncaughtException', error, 'uncaughtException');
  assert.match(lines[0], /kind=uncaughtException processType=browser lifecycle=ready version=1\.2\.3 release=rel-1/);
  assert.ok(lines[0].includes(error.stack));
  assert.equal(calls[0][0], 'dialog');
  assert.equal(calls[0][1], MAIN_PROCESS_ERROR_TITLE);
  assert.ok(calls[0][2].startsWith('Uncaught Exception:\n'));
  assert.deepEqual(calls[1], ['exit', 1]);
  handlers.uninstall();
  assert.equal(proc.listenerCount('uncaughtException'), 0);
});

test('a failing dialog still reaches the fatal exit', () => {
  const proc = new EventEmitter();
  const exits = [];
  installFatalHandlers({
    processRef: proc,
    logger: { error() {} },
    showErrorBox: () => { throw new Error('no display'); },
    exit: code => exits.push(code),
  });
  proc.emit('uncaughtException', new Error('x'));
  assert.deepEqual(exits, [1]);
});

test('unhandledRejection is logged only', () => {
  const proc = new EventEmitter();
  const lines = [];
  const calls = [];
  installFatalHandlers({
    processRef: proc,
    logger: { error: (...a) => lines.push(a.join(' ')) },
    lifecycle: () => 'before-ready',
    showErrorBox: () => calls.push('dialog'),
    exit: () => calls.push('exit'),
  });
  proc.emit('unhandledRejection', new Error('rejected'), Promise.resolve());
  assert.match(lines[0], /kind=unhandledRejection .*lifecycle=before-ready/);
  assert.deepEqual(calls, []);
});

test('child-process-gone and render-process-gone are logged with reason and exit code', () => {
  const app = new EventEmitter();
  const lines = [];
  installProcessGoneLogging({ app, logger: { warn: line => lines.push(line) } });
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 139 });
  app.emit('render-process-gone', {}, {}, { reason: 'oom', exitCode: 9 });
  assert.deepEqual(lines, [
    'child-process-gone type=GPU reason=crashed exitCode=139',
    'render-process-gone type=renderer reason=oom exitCode=9',
  ]);
});

test('release info is read from the release root next to the app path, else null', async t => {
  const release = await tempDir(t);
  const appPath = path.join(release, 'packages', 'desktop');
  fs.mkdirSync(appPath, { recursive: true });
  assert.equal(readReleaseInfo(appPath), null);
  fs.writeFileSync(path.join(release, '.workbench-release-meta.json'), JSON.stringify({ releaseId: 'r-1', commit: 'abc' }));
  assert.deepEqual(readReleaseInfo(appPath), { releaseId: 'r-1', commit: 'abc' });
  fs.writeFileSync(path.join(release, '.workbench-release-meta.json'), '{not json');
  assert.equal(readReleaseInfo(appPath), null);
});

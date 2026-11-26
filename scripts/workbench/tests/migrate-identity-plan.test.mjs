import net from 'node:net';
// Guard, preflight and `plan` tests for the identity migration (spec tests 1, 3, 4, 9 preflight half).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFixture, MODULE_PATH } from './helpers/migration-fixture.mjs';
import { spawnSync } from 'node:child_process';

test('the guard refuses to run without an explicit --home', (t) => {
  const fixture = createFixture(t);
  const result = spawnSync(process.execPath, [MODULE_PATH, 'plan'], { encoding: 'utf8', env: fixture.env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /HOME is not the real home directory: pass --home explicitly/);
});

test('the guard refuses the real home without --i-am-the-owner', (t) => {
  const fixture = createFixture(t);
  const result = spawnSync(process.execPath, [MODULE_PATH, 'plan', '--home', os.userInfo().homedir], { encoding: 'utf8', env: fixture.env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--i-am-the-owner/);
});

test('the guard refuses an inherited XDG path outside --home', (t) => {
  const fixture = createFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-migration-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const result = fixture.run(['plan', '--home', fixture.home], { bare: true, env: { ...fixture.env, XDG_CONFIG_HOME: outside } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /XDG_CONFIG_HOME=.*resolves outside --home/);
});

test('1. a fresh install is not a migration and creates no canonical path', (t) => {
  const fixture = createFixture(t, { populate: false });
  const result = fixture.run(['plan']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /nothing to migrate/);
  for (const target of [fixture.canonical.configDir, fixture.canonical.userData, fixture.canonical.stateDir, fixture.canonical.stateFile, fixture.canonical.backupDir]) {
    assert.equal(fs.existsSync(target), false, `${target} must not exist`);
  }

  const applied = fixture.run(['apply']);
  assert.equal(applied.status, 0);
  assert.match(applied.stdout, /nothing to migrate/);
  assert.equal(fs.existsSync(fixture.canonical.stateDir), false);
});

test('plan lists every step and the source and destination paths', (t) => {
  const fixture = createFixture(t);
  const result = fixture.run(['plan']);
  assert.equal(result.status, 0, result.stderr);
  for (const step of ['backup', 'config', 'env', 'userdata', 'release', 'helpers', 'units', 'desktop', 'runtime']) {
    assert.match(result.stdout, new RegExp(`plan: step \\d+\\. ${step} \\[todo\\]`));
  }
  assert.match(result.stdout, new RegExp(`${fixture.legacy.userData} -> ${fixture.canonical.userData}`));
  // plan is read-only.
  assert.equal(fs.existsSync(fixture.canonical.stateFile), false);
  assert.equal(fs.existsSync(fixture.canonical.configDir), false);
});

test('3. custom XDG directories are honored end to end in plan', (t) => {
  const fixture = createFixture(t, { xdgLayout: 'custom' });
  const result = fixture.run(['plan']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${path.join(fixture.home, 'xdg/conf/agent-workbench')} -> ${path.join(fixture.home, 'xdg/conf/workbench')}`));
});

test('9. an active legacy unit blocks plan and apply', (t) => {
  const fixture = createFixture(t);
  fixture.setUnitState('maw.service', 'active', 'active');
  const planned = fixture.run(['plan']);
  assert.equal(planned.status, 2);
  assert.match(planned.stdout, /refused: maw\.service is active/);
  const applied = fixture.run(['apply']);
  assert.equal(applied.status, 2);
  assert.match(applied.stdout, /refused: maw\.service is active/);
  assert.equal(fs.existsSync(fixture.canonical.configDir), false);
});

test('an activating legacy restart helper blocks apply', (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.systemdState, 'restart-helpers'), 'maw-restart-helper-1234.service loaded activating start running\n');
  const result = fixture.run(['apply']);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /restart helper unit active: maw-restart-helper-1234\.service/);
});

test('a process holding the legacy PTY socket blocks apply', (t) => {
  const fixture = createFixture(t);
  const socket = path.join(fixture.runtimeDir, 'maw-ptyd/ptyd.sock');
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  fs.writeFileSync(socket, '');
  fixture.addProcess(4242, { cmdline: ['node', 'ptyd.mjs'], fds: ['/dev/null', socket] });
  const result = fixture.run(['apply']);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /legacy PTY socket in use by pid\(s\) 4242/);
});

test('preflight finds a real Unix socket owner by inode', { skip: process.platform !== 'linux' }, async (t) => {
  const fixture = createFixture(t);
  const socket = path.join(fixture.runtimeDir, 'maw-ptyd/ptyd.sock');
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  try {
    const result = fixture.run(['apply', '--proc-root', '/proc']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /legacy PTY socket in use/);
    assert.match(result.stdout, new RegExp(`pid\\(s\\) [^:]*${process.pid}`));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a desktop process using the legacy userData blocks apply', (t) => {
  const fixture = createFixture(t);
  fixture.addProcess(5151, { cmdline: ['electron', `--user-data-dir=${fixture.legacy.userData}`] });
  const result = fixture.run(['apply']);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /legacy userData in use by pid\(s\) 5151/);
});

test('4. a destination that exists without a state file is refused', (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(fixture.canonical.userData, { recursive: true });
  fs.writeFileSync(path.join(fixture.canonical.userData, 'Preferences'), '{}');
  const result = fixture.run(['apply']);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /canonical userData already exists without a v1 migration state file/);
  // The pre-existing destination is untouched.
  assert.equal(fs.readFileSync(path.join(fixture.canonical.userData, 'Preferences'), 'utf8'), '{}');
});

test('insufficient free space is refused', (t) => {
  const fixture = createFixture(t);
  const result = fixture.run(['plan', '--free-space-bytes', '1024']);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /insufficient free space/);
});

test('a source checkout at the wrong commit is refused', (t) => {
  const fixture = createFixture(t);
  const source = path.join(fixture.home, 'src');
  fs.mkdirSync(source, { recursive: true });
  const git = (...args) => spawnSync('git', ['-C', source, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  git('init', '-q');
  fs.writeFileSync(path.join(source, 'README.md'), 'baseline\n');
  git('add', '.');
  git('commit', '-q', '-m', 'baseline');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const mapPath = path.join(fixture.home, 'source-commit-map');
  const mapText = `old new\n${fixture.expectedCommit} ${head}\n`;
  fs.writeFileSync(mapPath, mapText);
  const mapDigest = crypto.createHash('sha256').update(mapText).digest('hex');
  const pinned = ['--commit-map', mapPath, '--commit-map-sha256', mapDigest];

  const wrong = fixture.run(['plan', '--source', source, '--expect-commit', 'c'.repeat(40), ...pinned]);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stdout, new RegExp(`--source is at ${head}, expected cccc`));

  const right = fixture.run(['plan', '--source', source, '--expect-commit', head, ...pinned]);
  assert.equal(right.status, 0, right.stdout + right.stderr);

  fs.writeFileSync(path.join(source, 'README.md'), 'dirty\n');
  const dirty = fixture.run(['plan', '--source', source, '--expect-commit', head, ...pinned]);
  assert.equal(dirty.status, 2);
  assert.match(dirty.stdout, /--source checkout is not clean/);
});

test('an unknown command and an unknown option are refused', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['frobnicate']).status, 2);
  assert.equal(fixture.run(['plan', '--wat', 'x']).status, 2);
});

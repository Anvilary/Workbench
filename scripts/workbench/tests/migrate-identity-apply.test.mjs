// `apply` tests for the identity migration (spec tests 2, 5, 6, 10, 14 plus the backup and runtime gate).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createFixture, removeElectronStub } from './helpers/migration-fixture.mjs';
import { fileManifest, migrateConfigDir, transformEnvFile, USERDATA_EXCLUDES } from '../migrate-identity.mjs';

const STEP_NAMES = ['backup', 'config', 'env', 'userdata', 'release', 'helpers', 'units', 'desktop', 'runtime'];

function installElectron(fixture) {
  const dir = path.join(fixture.electronRoot, fixture.electronVersion);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'electron'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

test('2. a populated legacy install is migrated by copy, leaving the legacy tree intact', (t) => {
  const fixture = createFixture(t);
  const before = {
    config: fileManifest(fixture.legacy.configDir),
    userData: fileManifest(fixture.legacy.userData),
    env: fs.readFileSync(fixture.legacy.envFile, 'utf8'),
  };
  const result = fixture.run(['apply']);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  // Config dir copied file for file.
  assert.deepEqual(
    fileManifest(fixture.canonical.configDir, (rel) => rel !== 'environment'),
    before.config,
  );
  assert.equal(fs.statSync(fixture.canonical.configDir).mode & 0o777, 0o700);

  // Env file rewritten into the canonical config dir with 0600.
  const env = fs.readFileSync(fixture.canonical.envFile, 'utf8');
  assert.match(env, /^WORKBENCH_PORT=45643$/m);
  assert.equal(fs.statSync(fixture.canonical.envFile).mode & 0o777, 0o600);

  // userData: excludes dropped, everything else kept, partitions renamed.
  const partitions = fs.readdirSync(path.join(fixture.canonical.userData, 'Partitions')).sort();
  assert.deepEqual(partitions, ['workbench-browser', 'workbench-profile-test1-chatgpt']);
  for (const excluded of [...USERDATA_EXCLUDES, 'SingletonLock', 'SingletonCookie']) {
    assert.equal(fs.existsSync(path.join(fixture.canonical.userData, excluded)), false, `${excluded} must not be copied`);
  }
  for (const partition of partitions) {
    const dir = path.join(fixture.canonical.userData, 'Partitions', partition);
    for (const kept of ['Local Storage/leveldb/CURRENT', 'IndexedDB/http_127.0.0.1_0.indexeddb.leveldb/CURRENT', 'Service Worker/CacheStorage/abc/CURRENT', 'Session Storage/CURRENT', 'Cookies', 'Network Persistent State', 'TransportSecurity', 'Custom Dictionary.txt']) {
      assert.equal(fs.existsSync(path.join(dir, kept)), true, `${partition}/${kept} must be copied`);
    }
    assert.equal(fs.existsSync(path.join(dir, 'Cache')), false);
    // Only the legacy userData path is rewritten; other values are untouched.
    const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'Preferences'), 'utf8'));
    assert.equal(prefs.download.default_directory, path.join(fixture.canonical.userData, 'Downloads'));
    assert.equal(prefs.partition, partition.replace('workbench-', 'maw-'));
  }
  const topPrefs = JSON.parse(fs.readFileSync(path.join(fixture.canonical.userData, 'Preferences'), 'utf8'));
  assert.equal(topPrefs.spellcheck.dictionary_path, path.join(fixture.canonical.userData, 'Dictionaries'));
  assert.equal(topPrefs.unrelated, 'keep me');
  const localState = JSON.parse(fs.readFileSync(path.join(fixture.canonical.userData, 'Local State'), 'utf8'));
  assert.equal(localState.profile.last_used, path.join(fixture.canonical.userData, 'Default'));

  // Backup archive with a verified checksum.
  const state = fixture.state();
  const archive = state.steps.backup.dest;
  assert.equal(fs.existsSync(archive), true);
  assert.equal(fs.statSync(archive).mode & 0o777, 0o600);
  assert.equal(fs.statSync(fixture.canonical.backupDir).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(`${archive}.sha256`, 'utf8').split(' ')[0], state.steps.backup.sha256);
  const listed = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' });
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /legacy-state-meta\/pointers\.txt/);

  // The first canonical release exists and is never healthy.
  assert.equal(fs.existsSync(path.join(fixture.canonical.stateDir, 'current')), true);
  assert.equal(fs.existsSync(path.join(fixture.canonical.stateDir, 'healthy')), false);
  assert.match(fs.readFileSync(path.join(fixture.canonical.stateDir, 'update-log.jsonl'), 'utf8'), /identity-migration-initial-release/);
  assert.equal(state.steps.release.legacyHealthyCommit, fixture.expectedCommit);
  assert.equal(state.steps.release.commit, fixture.expectedCommit);
  assert.equal(fs.readFileSync(path.join(fixture.home, 'updater-args.log'), 'utf8').trim(), `--initial --source ${fixture.sourceDir} --ref ${fixture.expectedCommit} --allow-unapproved-ref`);

  // State file is 0600 and marks every step.
  assert.equal(fs.statSync(fixture.canonical.stateFile).mode & 0o777, 0o600);
  assert.equal(state.status, 'applied');
  for (const name of STEP_NAMES) assert.ok(['done', 'skipped'].includes(state.steps[name].status), `${name}: ${state.steps[name].status}`);

  // COPY semantics: the legacy installation is untouched.
  assert.deepEqual(fileManifest(fixture.legacy.configDir), before.config);
  assert.deepEqual(fileManifest(fixture.legacy.userData), before.userData);
  assert.equal(fs.readFileSync(fixture.legacy.envFile, 'utf8'), before.env);
  assert.equal(fs.existsSync(path.join(fixture.legacy.stateDir, 'healthy')), true);
  assert.equal(fs.existsSync(path.join(fixture.legacy.libDir, 'maw-lib.sh')), true);
});

test('6. a second apply is a no-op and re-verifies every step from disk', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);
  const after = {
    config: fileManifest(fixture.canonical.configDir),
    userData: fileManifest(fixture.canonical.userData),
    release: fs.readlinkSync(path.join(fixture.canonical.stateDir, 'current')),
    log: fs.readFileSync(path.join(fixture.canonical.stateDir, 'update-log.jsonl'), 'utf8'),
    backup: fixture.state().steps.backup.dest,
  };
  const second = fixture.run(['apply']);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  for (const name of STEP_NAMES) {
    assert.match(second.stdout, new RegExp(`step ${name}: already done \\(re-verified from disk\\)`));
  }
  assert.deepEqual(fileManifest(fixture.canonical.configDir), after.config);
  assert.deepEqual(fileManifest(fixture.canonical.userData), after.userData);
  assert.equal(fs.readlinkSync(path.join(fixture.canonical.stateDir, 'current')), after.release);
  assert.equal(fs.readFileSync(path.join(fixture.canonical.stateDir, 'update-log.jsonl'), 'utf8'), after.log);
  assert.equal(fs.readdirSync(fixture.canonical.backupDir).filter((name) => name.endsWith('.sha256')).length, 1);
  assert.equal(fixture.state().steps.backup.dest, after.backup);
});

test('5. a kill after any step is recoverable: the rerun completes it', (t) => {
  for (const killed of STEP_NAMES) {
    const fixture = createFixture(t);
    assert.equal(fixture.run(['apply']).status, 0);
    const expected = {
      config: fileManifest(fixture.canonical.configDir),
      userData: fileManifest(fixture.canonical.userData),
    };
    // Simulate a kill right before the marker was written, with the step's output half-written.
    const state = fixture.state();
    state.steps[killed] = ['config', 'userdata'].includes(killed)
      ? { ...state.steps[killed], status: 'prepared' }
      : { status: 'pending' };
    state.status = 'in-progress';
    fs.writeFileSync(fixture.canonical.stateFile, JSON.stringify(state, null, 2));
    if (killed === 'config') fs.rmSync(fixture.canonical.configDir, { recursive: true, force: true });
    if (killed === 'env') fs.rmSync(fixture.canonical.envFile);
    if (killed === 'userdata') fs.rmSync(fixture.canonical.userData, { recursive: true, force: true });
    if (killed === 'helpers') fs.rmSync(path.join(fixture.binDir, 'maw'));
    if (killed === 'desktop') fs.rmSync(fixture.canonical.desktopFile);
    if (killed === 'units') fs.rmSync(path.join(fixture.unitDir, 'workbench.service'));

    const rerun = fixture.run(['apply']);
    assert.equal(rerun.status, 0, `${killed}: ${rerun.stdout}${rerun.stderr}`);
    const final = fixture.state();
    assert.equal(final.status, 'applied', killed);
    assert.ok(['done', 'skipped'].includes(final.steps[killed].status), `${killed}: ${final.steps[killed].status}`);
    assert.deepEqual(fileManifest(fixture.canonical.configDir), expected.config, killed);
    assert.deepEqual(fileManifest(fixture.canonical.userData), expected.userData, killed);
  }
});

test('a step marker that disagrees with the disk is redone', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);
  const ownerFile = path.join(fixture.canonical.configDir, 'owner-created-after-activation');
  fs.writeFileSync(ownerFile, 'keep');
  const rerun = fixture.run(['apply']);
  assert.equal(rerun.status, 2, rerun.stdout + rerun.stderr);
  assert.match(rerun.stderr, /refusing to overwrite/);
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), 'keep');
});

test('an existing canonical userData tree is never overwritten on re-apply', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);
  const ownerFile = path.join(fixture.canonical.userData, 'owner-created-after-activation');
  fs.writeFileSync(ownerFile, 'keep');
  const rerun = fixture.run(['apply']);
  assert.equal(rerun.status, 2);
  assert.match(rerun.stderr, /refusing to overwrite/);
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), 'keep');
});

test('10. the env file migration renames, drops NO_AUTH, keeps unknown keys and never prints values', (t) => {
  const fixture = createFixture(t);
  const result = fixture.run(['apply']);
  assert.equal(result.status, 0, result.stderr);
  const env = fs.readFileSync(fixture.canonical.envFile, 'utf8');
  assert.match(env, /^WORKBENCH_PORT=45643$/m);
  assert.match(env, /^WORKBENCH_LOG_LEVEL=debug$/m);
  assert.match(env, /^EDITOR=vim$/m);
  assert.match(env, /^GIT_PAGER=cat$/m);
  assert.match(env, /^# legacy environment$/m);
  assert.doesNotMatch(env, /^MAW_/m);
  assert.doesNotMatch(env, /^AGENT_WORKBENCH_/m);
  assert.doesNotMatch(env, /UNSAFE_LOCAL_NO_AUTH/);
  assert.equal(fs.statSync(fixture.canonical.envFile).mode & 0o777, 0o600);

  // The report names the dropped and unknown keys, and no value ever appears.
  assert.match(result.stdout, /env: dropped \(not carried forward\): MAW_UNSAFE_LOCAL_NO_AUTH/);
  assert.match(result.stdout, /env: kept unknown keys verbatim: EDITOR, GIT_PAGER/);
  for (const value of ['vim', 'cat', '45643', 'debug']) {
    assert.ok(!result.stdout.includes(`=${value}`), `value ${value} must not be printed`);
  }
  const state = fixture.state();
  assert.deepEqual(state.steps.env.dropped, ['MAW_UNSAFE_LOCAL_NO_AUTH', 'WORKBENCH_UNSAFE_LOCAL_NO_AUTH']);
  assert.deepEqual(state.steps.env.unknownKeys, ['EDITOR', 'GIT_PAGER']);
  assert.equal(JSON.stringify(state).includes('45643'), false);
});

test('the env transform keeps the canonical key when both names are set', () => {
  const result = transformEnvFile('WORKBENCH_PORT=1\nMAW_PORT=2\n');
  assert.match(result.content, /^WORKBENCH_PORT=1$/m);
  assert.equal(result.content.includes('WORKBENCH_PORT=2'), false);
  assert.deepEqual(result.collisions, ['WORKBENCH_PORT']);
  const dropped = transformEnvFile('AGENT_WORKBENCH_UNSAFE_LOCAL_NO_AUTH=1\n');
  assert.equal(dropped.content.trim(), '');
  assert.deepEqual(dropped.dropped, ['AGENT_WORKBENCH_UNSAFE_LOCAL_NO_AUTH']);
  assert.equal(transformEnvFile('WORKBENCH_UNSAFE_LOCAL_NO_AUTH=1\n').content.trim(), '');
});

test('the missing canonical Electron runtime stops apply with exit 3 and the owner command', (t) => {
  const fixture = createFixture(t);
  removeElectronStub(fixture);
  const blocked = fixture.run(['apply']);
  assert.equal(blocked.status, 3);
  assert.match(blocked.stdout, /sudo apt install \.\/workbench-electron-45\.2\.0_amd64\.deb/);
  assert.equal(fixture.state().status, 'awaiting-runtime');
  // Every earlier step is complete, so the rerun only needs the runtime.
  assert.equal(fs.existsSync(fixture.canonical.userData), true);

  installElectron(fixture);
  const resumed = fixture.run(['apply']);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(fixture.state().status, 'applied');
});

test('14. migrateConfigDir copies for a non-systemd install and is idempotent', (t) => {
  const fixture = createFixture(t, { populate: true });
  const legacyDir = fixture.legacy.configDir;
  const canonicalDir = fixture.canonical.configDir;
  const before = fileManifest(legacyDir);

  const first = migrateConfigDir({ legacyDir, canonicalDir });
  assert.equal(first.migrated, true);
  assert.equal(first.reason, 'copied');
  assert.deepEqual(fileManifest(canonicalDir), before);

  fs.writeFileSync(path.join(canonicalDir, 'settings.json'), JSON.stringify({ theme: 'light' }));
  const second = migrateConfigDir({ legacyDir, canonicalDir });
  assert.equal(second.migrated, false);
  assert.equal(second.reason, 'canonical-exists');
  assert.equal(JSON.parse(fs.readFileSync(path.join(canonicalDir, 'settings.json'), 'utf8')).theme, 'light');
  assert.deepEqual(fileManifest(legacyDir), before);

  const missing = migrateConfigDir({ legacyDir: path.join(fixture.home, 'nope'), canonicalDir: path.join(fixture.home, 'nope-dest') });
  assert.equal(missing.migrated, false);
  assert.equal(missing.reason, 'no-legacy-config');
  assert.equal(fs.existsSync(path.join(fixture.home, 'nope-dest')), false);
  assert.throws(() => migrateConfigDir({ legacyDir: '', canonicalDir }), TypeError);
});

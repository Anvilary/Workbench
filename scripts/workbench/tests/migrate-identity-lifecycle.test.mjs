// Units, desktop entry, CLI shims, verify, rollback and clean (spec tests 7, 8, 12, 13 plus verify and clean).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createFixture } from './helpers/migration-fixture.mjs';
import { fileManifest } from '../migrate-identity.mjs';

const CANONICAL_UNITS = ['workbench-ptyd.service', 'workbench.service'];
const LEGACY_UNITS = ['maw.service', 'maw-ptyd.service'];

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Bring the fixture to a state where `verify` passes: units active, socket owned, readiness ok. */
function makeVerifiable(fixture) {
  const socket = path.join(fixture.runtimeDir, 'workbench-ptyd/ptyd.sock');
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  fs.writeFileSync(socket, '');
  fixture.addProcess(7777, { cmdline: ['node', 'ptyd.mjs'], fds: [socket] });
  for (const unit of CANONICAL_UNITS) fixture.setUnitState(unit, 'active', 'active');
  fixture.setUnitState('workbench-ptyd.service', 'mainpid', '7777');
  return ['--readiness-cmd', 'echo 20261126090000-beef1234'];
}

test('the canonical units are rendered, the legacy units masked, the new ones enabled and never started', (t) => {
  const fixture = createFixture(t);
  const legacyUnitHashes = Object.fromEntries(LEGACY_UNITS.map((unit) => [unit, sha(path.join(fixture.unitDir, unit))]));
  assert.equal(fixture.run(['apply']).status, 0);

  for (const unit of CANONICAL_UNITS) {
    const text = fs.readFileSync(path.join(fixture.unitDir, unit), 'utf8');
    assert.equal(/@[A-Z_]+@/.test(text), false, `${unit} still has tokens`);
    assert.match(text, new RegExp(fixture.canonical.stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(fs.statSync(path.join(fixture.unitDir, unit)).mode & 0o777, 0o644);
    assert.equal(fixture.unitState(unit, 'enabled'), 'enabled');
  }
  assert.match(fs.readFileSync(path.join(fixture.unitDir, 'workbench.service'), 'utf8'), new RegExp(`EnvironmentFile=-${fixture.canonical.envFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  for (const unit of LEGACY_UNITS) {
    assert.equal(fixture.unitState(unit, 'enabled'), 'masked');
    // A real mask replaces the regular file with a /dev/null symlink, preserving its exact bytes in state.
    assert.equal(fs.readlinkSync(path.join(fixture.unitDir, unit)), '/dev/null');
    const saved = Buffer.from(fixture.state().steps.units.originalUnits[unit].content, 'base64');
    assert.equal(crypto.createHash('sha256').update(saved).digest('hex'), legacyUnitHashes[unit]);
  }
  const calls = fixture.systemctlCalls();
  const disableAt = calls.findIndex((line) => line.startsWith('disable maw.service'));
  const maskAt = calls.findIndex((line) => line.startsWith('mask maw.service'));
  const enableAt = calls.findIndex((line) => line.startsWith('enable workbench-ptyd.service'));
  assert.ok(disableAt !== -1 && maskAt > disableAt && enableAt > maskAt, calls.join(' | '));
  assert.ok(calls.some((line) => line === 'daemon-reload'), calls.join(' | '));
  assert.equal(calls.some((line) => line.startsWith('start ')), false, 'apply must never start a unit');
});

test('12. a masked legacy unit cannot start', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);
  const started = spawnSync(path.join(fixture.mockBin, 'systemctl'), ['--user', 'start', 'maw.service'], { encoding: 'utf8', env: fixture.env });
  assert.notEqual(started.status, 0);
  assert.match(started.stderr, /Unit maw\.service is masked/);
  assert.equal(fixture.unitState('maw.service', 'active'), 'inactive');
});

test('13. the CLI shims resolve to anvi-bench and keep the invoked name', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);
  assert.equal(fs.existsSync(path.join(fixture.binDir, 'anvi-bench')), true);
  for (const name of ['maw', 'anvil-bench', 'workbench']) {
    const shim = path.join(fixture.binDir, name);
    const text = fs.readFileSync(shim, 'utf8');
    assert.equal(text.split('\n').filter((line) => line.trim() !== '').length, 2, `${name} must be a 2-line shim`);
    assert.match(text, /exec "\$\(dirname "\$0"\)\/anvi-bench" "\$@"/);
    const run = spawnSync(shim, ['status'], { encoding: 'utf8', env: fixture.env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`^anvi-bench ${name} status$`, 'm'));
  }
  // The originals are backed up in the state file directory.
  for (const name of ['maw', 'anvil-bench']) {
    const backup = path.join(fixture.canonical.stateDir, 'migration/bin-backup', name);
    assert.match(fs.readFileSync(backup, 'utf8'), new RegExp(`legacy ${name}`));
  }
});

test('the desktop entry, icons, legacy hide override and favorite-apps are written', (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(fixture.gsettingsFile, "['maw.desktop', 'org.example.Files.desktop']\n");
  assert.equal(fixture.run(['apply']).status, 0);

  const entry = fs.readFileSync(fixture.canonical.desktopFile, 'utf8');
  assert.match(entry, /^Icon=workbench$/m);
  assert.match(entry, /^StartupWMClass=workbench$/m);
  assert.match(entry, new RegExp(`^Exec="${path.join(fixture.binDir, 'anvi-bench')}" desktop$`, 'm'));
  assert.equal(entry.includes('maw'), false);

  for (const size of [48, 256]) {
    const icon = path.join(fixture.dataHome, 'icons/hicolor', `${size}x${size}`, 'apps/workbench.png');
    assert.equal(fs.readFileSync(icon, 'utf8'), `icon-${size}`);
  }

  const legacyEntry = fs.readFileSync(fixture.legacy.desktopFile, 'utf8');
  assert.match(legacyEntry, /^NoDisplay=true$/m);
  assert.match(legacyEntry, /^Hidden=true$/m);
  assert.match(legacyEntry, /^Exec=maw desktop$/m);

  assert.equal(fs.readFileSync(fixture.gsettingsFile, 'utf8').trim(), "['workbench.desktop', 'org.example.Files.desktop']");
  assert.equal(fixture.state().steps.desktop.favoriteAppsPrevious.trim(), "['maw.desktop', 'org.example.Files.desktop']");
});

test('verify fails while the canonical units are inactive and never marks the migration verified', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);
  const result = fixture.run(['verify', '--accept']);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /verify: FAIL workbench\.service is active/);
  assert.match(result.stdout, /check\(s\) failed: not marking verified/);
  assert.equal(fixture.state().status, 'applied');
});

test('verify passes every check and marks verified only with --accept', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);
  const extra = makeVerifiable(fixture);

  const dry = fixture.run(['verify', ...extra]);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.equal(dry.stdout.includes('FAIL'), false, dry.stdout);
  assert.match(dry.stdout, /Re-run with --accept/);
  assert.equal(fixture.state().status, 'applied');

  const accepted = fixture.run(['verify', '--accept', ...extra]);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.equal(fixture.state().status, 'verified');
  assert.match(accepted.stdout, /verify: ok\s+maw\.service is masked and inactive/);
});

test('verify fails when a running desktop still uses the legacy userData', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);
  const extra = makeVerifiable(fixture);
  fixture.addProcess(8181, { cmdline: ['electron', `--user-data-dir=${fixture.legacy.userData}`] });
  const result = fixture.run(['verify', '--accept', ...extra]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /verify: FAIL the running desktop uses the canonical userData/);
});

test('verify ignores unrelated browser profiles and requires an exact readiness release id', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);
  const extra = makeVerifiable(fixture);
  fixture.addProcess(8282, { cmdline: ['electron', `--user-data-dir=${path.join(fixture.home, 'unrelated-browser-profile')}`] });
  const result = fixture.run(['verify', '--accept', ...extra]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fixture.state().status, 'verified');

  const fake = fixture.run(['verify', '--accept', '--readiness-cmd', 'echo extra-20261126090000-beef1234', ...extra.slice(2)]);
  assert.equal(fake.status, 2);
  assert.match(fake.stdout, /FAIL readiness probe reports the canonical release id/);
});

test('verify pins the canonical readiness probe despite inherited application overrides', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);
  makeVerifiable(fixture);
  const expected = {
    WORKBENCH_UNIT: 'workbench.service',
    WORKBENCH_RUNTIME_DIR: path.join(fixture.runtimeDir, 'workbench'),
    XDG_CONFIG_HOME: fixture.configHome,
    XDG_RUNTIME_DIR: fixture.runtimeDir,
  };
  fs.writeFileSync(path.join(fixture.canonical.libDir, 'control.mjs'), `
    import assert from 'node:assert/strict';
    for (const [key, value] of Object.entries(${JSON.stringify(expected)})) assert.equal(process.env[key], value);
    for (const key of ['WORKBENCH_SYSTEMD_BUS_ADDRESS', 'MAW_RUNTIME_DIR', 'AGENT_WORKBENCH_NO_RESTORE']) {
      assert.equal(process.env[key], undefined);
    }
    assert.equal(process.argv[2], 'migration-ready');
    console.log(process.argv[3]);
  `);
  const result = fixture.run(['verify', '--accept'], { env: {
    WORKBENCH_UNIT: 'maw.service',
    WORKBENCH_RUNTIME_DIR: '/outside-fixture',
    WORKBENCH_SYSTEMD_BUS_ADDRESS: 'unix:path=/outside-fixture',
    MAW_RUNTIME_DIR: '/outside-fixture',
    AGENT_WORKBENCH_NO_RESTORE: '1',
    XDG_CONFIG_HOME: '/outside-fixture',
    XDG_RUNTIME_DIR: '/outside-fixture',
  } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fixture.state().status, 'verified');
});

test('7, 8. rollback after a failed first activation restores legacy operability', (t) => {
  const fixture = createFixture(t);
  const legacyBefore = {
    units: Object.fromEntries(LEGACY_UNITS.map((unit) => [unit, sha(path.join(fixture.unitDir, unit))])),
    config: fileManifest(fixture.legacy.configDir),
    userData: fileManifest(fixture.legacy.userData),
    desktop: fs.readFileSync(fixture.legacy.desktopFile, 'utf8'),
  };
  fs.writeFileSync(fixture.gsettingsFile, "['maw.desktop']\n");
  assert.equal(fixture.run(['apply']).status, 0);

  // First activation fails: the unit never becomes active.
  fixture.setUnitState('workbench.service', 'active', 'failed');
  const failedVerify = fixture.run(['verify', '--accept']);
  assert.equal(failedVerify.status, 2);

  const rolled = fixture.run(['rollback']);
  assert.equal(rolled.status, 0, rolled.stdout + rolled.stderr);
  assert.equal(fixture.state().status, 'rolled-back');

  // Legacy units unmasked, enabled, and startable again; their files are unchanged.
  for (const unit of LEGACY_UNITS) {
    assert.equal(fixture.unitState(unit, 'enabled'), 'enabled');
    assert.equal(sha(path.join(fixture.unitDir, unit)), legacyBefore.units[unit]);
  }
  const started = spawnSync(path.join(fixture.mockBin, 'systemctl'), ['--user', 'start', ...LEGACY_UNITS], { encoding: 'utf8', env: fixture.env });
  assert.equal(started.status, 0, started.stderr);

  // Canonical units stopped, disabled and their files moved aside.
  const calls = fixture.systemctlCalls();
  assert.ok(calls.some((line) => line.startsWith('stop workbench-ptyd.service')), calls.join(' | '));
  for (const unit of CANONICAL_UNITS) assert.equal(fs.existsSync(path.join(fixture.unitDir, unit)), false);

  // Bin scripts, the desktop entry and favorites are restored.
  const maw = spawnSync(path.join(fixture.binDir, 'maw'), [], { encoding: 'utf8', env: fixture.env });
  assert.match(maw.stdout, /legacy maw/);
  assert.equal(fs.existsSync(path.join(fixture.binDir, 'workbench')), false, 'a shim this migration created is removed');
  assert.equal(fs.readFileSync(fixture.legacy.desktopFile, 'utf8'), legacyBefore.desktop);
  assert.equal(fs.readFileSync(fixture.gsettingsFile, 'utf8').trim(), "['maw.desktop']");

  // Canonical copies are kept, renamed, never deleted; legacy data is intact.
  const renamed = fixture.state().rollback.renamed;
  assert.ok(renamed.some((target) => /workbench-desktop\.rolled-back-\d{14}$/.test(target)), renamed.join(', '));
  for (const target of renamed) assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(fixture.canonical.configDir), false);
  assert.deepEqual(fileManifest(fixture.legacy.configDir), legacyBefore.config);
  assert.deepEqual(fileManifest(fixture.legacy.userData), legacyBefore.userData);
  assert.match(rolled.stdout, /rollback: start the legacy installation with: systemctl --user start maw-ptyd\.service maw\.service/);
});

test('rollback fails closed when canonical shutdown fails', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);
  const failing = path.join(fixture.home, 'systemctl-fail-stop');
  fs.writeFileSync(failing, `#!/bin/sh\n[ "$2" != stop ] || exit 9\nexec "${path.join(fixture.mockBin, 'systemctl')}" "$@"\n`, { mode: 0o700 });
  const result = fixture.run(['rollback', '--systemctl-cmd', failing]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /failed to stop canonical units/);
  for (const unit of LEGACY_UNITS) {
    assert.equal(fixture.unitState(unit, 'enabled'), 'masked');
    assert.equal(fs.readlinkSync(path.join(fixture.unitDir, unit)), '/dev/null');
  }
  assert.equal(fixture.state().status, 'applied');
});

test('rollback succeeds after an early apply failure before canonical units exist', (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(path.dirname(fixture.canonical.stateFile), { recursive: true });
  fs.writeFileSync(fixture.canonical.stateFile, JSON.stringify({
    version: 1,
    status: 'in-progress',
    steps: { backup: { status: 'failed', error: 'simulated early failure' } },
  }));
  const unitCheck = path.join(fixture.home, 'systemctl-no-missing-stop');
  fs.writeFileSync(unitCheck, `#!/bin/sh
if [ "$2" = "stop" ]; then
  for arg in "$@"; do
    case "$arg" in
      workbench*.service)
        if [ ! -e "${fixture.unitDir}/$arg" ]; then
          printf 'Failed to stop %s: Unit %s not loaded.\\n' "$arg" "$arg" >&2
          exit 5
        fi
        ;;
    esac
  done
fi
exec "${path.join(fixture.mockBin, 'systemctl')}" "$@"
`, { mode: 0o700 });
  const rolled = fixture.run(['rollback', '--systemctl-cmd', unitCheck]);
  assert.equal(rolled.status, 0, rolled.stdout + rolled.stderr);
  assert.equal(fixture.state().status, 'rolled-back');
  for (const unit of LEGACY_UNITS) {
    assert.equal(fixture.unitState(unit, 'enabled'), 'enabled');
  }
});

test('apply resolves canonical unit templates from helpers source when template flags are omitted', (t) => {
  const fixture = createFixture(t);
  const helpersDir = path.join(fixture.home, 'helpers-source');
  fs.mkdirSync(path.join(helpersDir, 'pty-host'), { recursive: true });
  fs.copyFileSync(path.join(fixture.home, 'templates/workbench.service'), path.join(helpersDir, 'workbench.service'));
  fs.copyFileSync(path.join(fixture.home, 'templates/workbench-ptyd.service'), path.join(helpersDir, 'pty-host/workbench-ptyd.service'));
  const filteredArgs = [];
  const raw = fixture.baseArgs();
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '--unit-template' || raw[i] === '--ptyd-unit-template') {
      i += 1;
      continue;
    }
    filteredArgs.push(raw[i]);
  }
  const result = fixture.run(['apply', ...filteredArgs], { bare: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fixture.state().status, 'applied');
  for (const unit of CANONICAL_UNITS) {
    assert.equal(fs.existsSync(path.join(fixture.unitDir, unit)), true, `${unit} must be rendered`);
  }
});

test('clean needs a verified migration, an explicit --yes, and keeps the backup', (t) => {
  const fixture = createFixture(t);
  assert.equal(fixture.run(['apply']).status, 0);

  const tooEarly = fixture.run(['clean', '--yes']);
  assert.equal(tooEarly.status, 2);
  assert.match(tooEarly.stderr, /clean needs a verified migration/);
  assert.equal(fs.existsSync(fixture.legacy.configDir), true);

  const extra = makeVerifiable(fixture);
  assert.equal(fixture.run(['verify', '--accept', ...extra]).status, 0);

  const listed = fixture.run(['clean']);
  assert.equal(listed.status, 2);
  assert.match(listed.stdout, new RegExp(`clean: will remove ${fixture.legacy.userData}`));
  assert.match(listed.stdout, /sudo apt remove maw-electron/);
  assert.equal(fs.existsSync(fixture.legacy.userData), true, 'clean without --yes removes nothing');

  const backupArchive = fixture.state().steps.backup.dest;
  const cleaned = fixture.run(['clean', '--yes']);
  assert.equal(cleaned.status, 0, cleaned.stdout + cleaned.stderr);
  for (const target of [fixture.legacy.configDir, fixture.legacy.userData, fixture.legacy.stateDir, fixture.legacy.libDir, fixture.legacy.envFile, fixture.legacy.desktopFile, path.join(fixture.unitDir, 'maw.service'), path.join(fixture.dataHome, 'icons/hicolor/48x48/apps/maw-workspace.png')]) {
    assert.equal(fs.existsSync(target), false, `${target} must be removed`);
  }
  assert.equal(fs.existsSync(backupArchive), true, 'the backup is kept until the owner deletes it');
  assert.equal(fs.existsSync(fixture.canonical.configDir), true);
  assert.equal(fs.existsSync(fixture.canonical.userData), true);
  assert.equal(fixture.state().status, 'cleaned');

  const afterClean = fixture.run(['rollback']);
  assert.equal(afterClean.status, 2);
  assert.match(afterClean.stderr, /rollback is impossible/);
});

test('15. a mapped history transition admits only normal descendant updates afterward', (t) => {
  const fixture = createFixture(t);
  const originalCommit = 'a'.repeat(40);
  const baselineCommit = fixture.expectedCommit;
  const legacyMetadata = path.join(fixture.legacy.stateDir, 'healthy/.maw-release-meta.json');
  const legacy = JSON.parse(fs.readFileSync(legacyMetadata, 'utf8'));
  fs.writeFileSync(legacyMetadata, JSON.stringify({ ...legacy, commit: originalCommit }));
  fs.writeFileSync(fixture.commitMap, `old new\n${originalCommit} ${baselineCommit}\n`);
  fixture.commitMapSha256 = sha(fixture.commitMap);

  const apply = fixture.run(['apply']);
  assert.equal(apply.status, 0, apply.stdout + apply.stderr);
  assert.equal(fixture.state().steps.release.legacyHealthyCommit, originalCommit);
  assert.equal(fixture.state().steps.release.commit, baselineCommit);

  // The fixture's next build supplies disposable artifacts through Corepack.
  // The real updater still enforces its regular channel, metadata and ancestry rules.
  const corepack = path.join(fixture.mockBin, 'corepack');
  fs.writeFileSync(corepack, `#!/bin/sh
case "$2" in
  --version) echo 12.21.0 ;;
  install)
    mkdir -p packages/server/node_modules/node-pty packages/server/node_modules/tsx/dist
    : > packages/server/node_modules/tsx/dist/loader.mjs
    ;;
  build)
    mkdir -p packages/server/dist packages/web/dist
    printf 'export {};\\n' > packages/server/dist/index.mjs
    printf 'export {};\\n' > packages/server/dist/ptyd.mjs
    printf 'export {};\\n' > packages/server/dist/terminal-state.mjs
    printf '<!doctype html>\\n' > packages/web/dist/index.html
    ;;
esac
`, { mode: 0o755 });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', fixture.sourceDir, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const files = path.join(fixture.sourceDir, 'packages/server/src');
  fs.mkdirSync(files, { recursive: true });
  for (const name of ['index.ts', 'workbench-host.ts']) fs.writeFileSync(path.join(files, name), 'export {};\n');
  git('add', '.');
  git('commit', '-m', 'descendant update');
  const descendant = git('rev-parse', 'HEAD');
  const update = (options = []) => spawnSync('/bin/sh', [
    new URL('../update.sh', import.meta.url).pathname,
    '--no-restart', '--source', fixture.sourceDir, ...options,
  ], {
    encoding: 'utf8',
    env: {
      ...fixture.env,
      WORKBENCH_NODE_BIN: process.execPath,
      WORKBENCH_UPDATE_CHANNEL: 'HEAD',
      WORKBENCH_STATE_DIR: fixture.canonical.stateDir,
      WORKBENCH_HEADLESS: '1',
    },
  });
  const staged = update();
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const readMeta = pointer => JSON.parse(fs.readFileSync(
    path.join(fixture.canonical.stateDir, pointer, '.workbench-release-meta.json'), 'utf8'));
  assert.equal(readMeta('current').commit, baselineCommit);
  assert.equal(readMeta('staged').commit, descendant);
  assert.equal(fs.existsSync(path.join(fixture.canonical.stateDir, 'healthy')), false);

  git('checkout', '--orphan', 'unrelated');
  git('commit', '--allow-empty', '-m', 'unrelated history');
  const refused = update();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /branches have diverged/);
  assert.equal(readMeta('staged').commit, descendant);
});

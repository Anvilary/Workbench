/**
 * REAL systemd acceptance for Workbench activation and rollback (opt-in: WORKBENCH_REAL_SYSTEMD=1).
 *
 * Uses the production unit template (scripts/workbench/workbench.service rendered by render-unit.sh) as a
 * disposable runtime unit `workbench-test-<random>.service` in $XDG_RUNTIME_DIR/systemd/user, with its own state
 * dir, runtime directory and loopback port. Never touches workbench.service, the real state dir or any live
 * process. The unit file, its runtime directory and the temp state are removed afterwards.
 *
 * Releases are minimal but real: the unit boots their bundled dist/index.mjs entry point
 * and the healthy one serves an authenticated loopback
 * URL and publishes readiness with the repository's real publishReadiness/readReleaseIdentity.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, readlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { SCRIPTS_WORKBENCH_DIR, SERVER_SRC } from '../../helpers/paths.js';

const exec = promisify(execFile);
const managerRuntime = `/run/user/${process.getuid?.()}`;
const managerBus = path.join(managerRuntime, 'bus');
const enabled = process.env.WORKBENCH_REAL_SYSTEMD === '1' && process.platform === 'linux' && existsSync(managerBus);
const managerEnvironment = { XDG_RUNTIME_DIR: managerRuntime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${managerBus}` };
const systemctl = (args: string[]) => exec('systemctl', ['--user', ...args], {
  env: { PATH: process.env.PATH, ...managerEnvironment },
});
const SCRIPT_DIR = SCRIPTS_WORKBENCH_DIR;

function fixtureEnvironment(root: string) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:MAW_|WORKBENCH_|AGENT_WORKBENCH_)/.test(name)));
  return {
    ...inherited,
    ...managerEnvironment,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
}

const TSX = await realpath(path.resolve(SERVER_SRC, '../node_modules/tsx')).catch(() => null);

// The production template names the real PTY unit. A fixture must never pull it in.
function isolateUnit(rendered: string) {
  return rendered.replace(/^Wants=workbench-ptyd\.service\n/m, '').replace(/^After=network\.target workbench-ptyd\.service$/m, 'After=network.target');
}

const HEALTHY_SERVER = `
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishReadiness, readReleaseIdentity } from ${JSON.stringify(path.join(SERVER_SRC, 'workbench-host.ts'))};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const token = randomBytes(16).toString('hex');
const server = createServer((req, res) => {
  res.statusCode = new URL(req.url ?? '/', 'http://x').searchParams.get('token') === token ? 200 : 401;
  res.end();
});
server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  if (!address || typeof address === 'string') process.exit(1);
  await publishReadiness(process.env.WORKBENCH_RUNTIME_DIR!, 'http://127.0.0.1:' + address.port + '/?token=' + token, await readReleaseIdentity(root));
});
process.on('SIGTERM', () => process.exit(0));
`;
const CRASHING_SERVER = `setTimeout(() => { console.error('candidate crashed on start'); process.exit(1); }, 500);\n`;

async function makeRelease(releases: string, id: string, source: string): Promise<string> {
  const dir = path.join(releases, id);
  await mkdir(path.join(dir, 'packages/server/src'), { recursive: true });
  await mkdir(path.join(dir, 'packages/server/dist'), { recursive: true });
  await mkdir(path.join(dir, 'packages/server/node_modules'), { recursive: true });
  await writeFile(path.join(dir, 'packages/server/package.json'), '{"type":"module"}\n');
  await symlink(TSX!, path.join(dir, 'packages/server/node_modules/tsx'));
  await writeFile(path.join(dir, 'packages/server/src/workbench-host.ts'), 'export {};\n');
  await writeFile(path.join(dir, 'packages/server/src/index.ts'), source);
  await build({
    entryPoints: [path.join(dir, 'packages/server/src/index.ts')],
    outfile: path.join(dir, 'packages/server/dist/index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  await writeFile(path.join(dir, 'packages/server/dist/ptyd.mjs'), '#!/usr/bin/env node\n');
  await writeFile(path.join(dir, '.workbench-release-meta.json'), JSON.stringify({ releaseId: id, commit: id.split('-')[1] }) + '\n');
  return dir;
}

test('real systemd: crash-looping candidate hits start-limit, is detected, and the verified release is restored', { skip: !enabled || !TSX }, async () => {
  const suffix = randomBytes(4).toString('hex');
  const unit = `workbench-test-${suffix}.service`;
  const runtimeName = `workbench-test-${suffix}`;
  const unitDir = path.join(managerRuntime, 'systemd/user');
  const unitFile = path.join(unitDir, unit);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'maw-systemd-')));
  const state = path.join(root, '.local/share/workbench');
  const releases = path.join(state, 'releases');
  await mkdir(releases, { recursive: true });
  const env = {
    ...fixtureEnvironment(root), WORKBENCH_STATE_DIR: state, WORKBENCH_UNIT: unit, WORKBENCH_RUNTIME_DIR: path.join(managerRuntime, runtimeName),
    WORKBENCH_NODE_BIN: process.execPath, WORKBENCH_READY_TIMEOUT: '25', WORKBENCH_CGROUP_FILE: path.join(root, 'none'),
    WORKBENCH_PTYD_UNIT: `workbench-test-ptyd-${suffix}.service`, XDG_CONFIG_HOME: path.join(root, 'config'), WORKBENCH_ENV_FILE: path.join(root, 'no-environment'),
  };
  const helper = async (): Promise<{ code: number; out: string }> => {
    try { const r = await exec(path.join(SCRIPT_DIR, 'restart-helper.sh'), ['--unit', unit], { env }); return { code: 0, out: r.stdout + r.stderr }; }
    catch (e) { const x = e as { code: number; stdout: string; stderr: string }; return { code: x.code, out: x.stdout + x.stderr }; }
  };
  const ptr = async (name: string) => { try { return path.basename(await readlink(path.join(state, name))); } catch { return null; } };
  const H = await makeRelease(releases, '20261029000001-aaaaaaa', HEALTHY_SERVER);
  await symlink(H, path.join(state, 'current'));
  try {
    await mkdir(unitDir, { recursive: true });
    assert.ok(!existsSync(unitFile));
    const rendered = await exec('/bin/sh', [path.join(SCRIPT_DIR, 'render-unit.sh')],
      { env: { ...env, WORKBENCH_RUNTIME_NAME: runtimeName, WORKBENCH_BIN_DIR: path.join(root, 'bin') } });
    await writeFile(unitFile, isolateUnit(rendered.stdout));

    // First verified start: no healthy yet; success makes H healthy.
    let r = await helper();
    assert.equal(r.code, 0, r.out);
    assert.equal(await ptr('healthy'), path.basename(H));
    const status = await exec(process.execPath, [path.join(SCRIPT_DIR, 'control.mjs'), 'status'], { env: { ...env, WORKBENCH_EXPECT_RELEASE_ID: path.basename(H) } });
    assert.match(status.stdout, /Healthy; PID \d+; loopback port \d+; release 20261029000001-aaaaaaa/);

    // P1-A: stage a release that crashes on every start. (Releases are created when needed: a successful
    // activation garbage-collects unreferenced releases.)
    const B = await makeRelease(releases, '20261029000002-bbbbbbb', CRASHING_SERVER);
    await symlink(B, path.join(state, 'staged'));
    const started = Date.now();
    r = await helper();
    const elapsed = Date.now() - started;
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /failed activation: unit entered failed state/);
    assert.match(r.out, /UPDATE FAILED, SERVICE RECOVERED: 20261029000001-aaaaaaa/);
    const journal = (await exec('journalctl', ['--user', '-u', unit, '--no-pager', '-o', 'cat'])).stdout;
    assert.match(journal, /Start request repeated too quickly/, 'systemd start-limit was really hit');
    assert.match(journal, /candidate crashed on start/);
    assert.deepEqual([await ptr('current'), await ptr('staged'), await ptr('healthy')], [path.basename(H), null, path.basename(H)]);
    const after = await exec(process.execPath, [path.join(SCRIPT_DIR, 'control.mjs'), 'status'], { env: { ...env, WORKBENCH_EXPECT_RELEASE_ID: path.basename(H) } });
    assert.match(after.stdout, /release 20261029000001-aaaaaaa/, 'authenticated readiness of the restored release');
    console.log(`# candidate failure detected and recovered in ${elapsed} ms`);

    // Successful activation promotes S and keeps H as previous.
    const S = await makeRelease(releases, '20261029000003-ccccccc', HEALTHY_SERVER);
    await symlink(S, path.join(state, 'staged'));
    r = await helper();
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([await ptr('current'), await ptr('healthy'), await ptr('previous')], [path.basename(S), path.basename(S), path.basename(H)]);

    // Rollback failure: the verified release is (made) broken too -> explicit CRITICAL, exit 3, no loop.
    const S2 = await makeRelease(releases, '20261029000004-ddddddd', CRASHING_SERVER);
    const V = await makeRelease(releases, '20261029000005-eeeeeee', CRASHING_SERVER);
    await rm(path.join(state, 'healthy'));
    await symlink(V, path.join(state, 'healthy'));   // a "verified" release that now crashes
    await symlink(S2, path.join(state, 'staged'));
    r = await helper();
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /CRITICAL: rollback to 20261029000005-eeeeeee also failed/);
  } finally {
    await systemctl(['stop', unit]).catch(() => undefined);
    await systemctl(['reset-failed', unit]).catch(() => undefined);
    if (path.basename(unitFile).startsWith('workbench-test-')) await rm(unitFile, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A REAL release of this repository: built by update.sh (--initial, isolated worktree, frozen install,
 * typecheck, build, profile tests), booted by both production unit templates under disposable names with
 * isolated HOME/XDG, verified by the restart helper and the authenticated readiness probe, and serving
 * its own built UI. Opt-in and slow: WORKBENCH_REAL_SYSTEMD=1 WORKBENCH_REAL_RELEASE=1 (needs a clean checkout).
 */
test('real systemd: a release built from this repository activates, is verified by release ID and serves its UI', {
  skip: !enabled || process.env['WORKBENCH_REAL_RELEASE'] !== '1', timeout: 900_000,
}, async () => {
  const suffix = randomBytes(4).toString('hex');
  const unit = `workbench-test-${suffix}.service`;
  const runtimeName = `workbench-test-${suffix}`;
  const ptydRuntime = `workbench-test-ptyd-${suffix}`;
  const ptydUnit = `${ptydRuntime}.service`;
  const unitDir = path.join(managerRuntime, 'systemd/user');
  const unitFile = path.join(unitDir, unit);
  const ptydUnitFile = path.join(unitDir, ptydUnit);
  const dropIn = path.join(unitDir, unit + '.d');
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'workbench-real-release-')));
  const state = path.join(root, '.local/share/workbench');
  const sandbox = path.join(root, 'sandbox');
  const repoRoot = path.resolve(SCRIPT_DIR, '../..');
  await mkdir(path.join(sandbox, 'home'), { recursive: true });
  const env = { ...fixtureEnvironment(sandbox),
    WORKBENCH_STATE_DIR: state, WORKBENCH_UNIT: unit, WORKBENCH_RUNTIME_DIR: path.join(managerRuntime, runtimeName),
    WORKBENCH_NODE_BIN: process.execPath, WORKBENCH_READY_TIMEOUT: '20', WORKBENCH_CGROUP_FILE: path.join(root, 'none'), WORKBENCH_ENV_FILE: path.join(root, 'no-environment'),
    WORKBENCH_PTYD_UNIT: ptydUnit, XDG_CONFIG_HOME: path.join(sandbox, 'config'),
    WORKBENCH_LIB_DIR: path.join(root, 'lib'), WORKBENCH_BIN_DIR: path.join(root, 'bin'), WORKBENCH_HEADLESS: '1' };
  try {
    await exec('/bin/sh', [path.join(SCRIPT_DIR, 'install.sh'), '--commands-only'], { env });
    const built = await exec('/bin/sh', [path.join(SCRIPT_DIR, 'update.sh'), '--initial', '--source', repoRoot, '--ref', 'HEAD', '--allow-unapproved-ref'],
      { env, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
    assert.match(built.stdout, /Initial release (\S+) installed/);
    const release = await realpath(path.join(state, 'current'));
    const id = path.basename(release);
    const meta = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(release, '.workbench-release-meta.json'), 'utf8'));
    assert.equal(meta.releaseId, id);
    assert.equal(meta.channel, 'unapproved');
    assert.ok(!existsSync(path.join(release, '.git')), 'detached from git');

    await mkdir(unitDir, { recursive: true });
    assert.ok(!existsSync(unitFile));
    assert.ok(!existsSync(ptydUnitFile));
    const rendered = await exec('/bin/sh', [path.join(SCRIPT_DIR, 'render-unit.sh')], { env: { ...env, WORKBENCH_RUNTIME_NAME: runtimeName, WORKBENCH_BIN_DIR: path.join(root, 'bin') } });
    await writeFile(unitFile, rendered.stdout.replaceAll('workbench-ptyd.service', ptydUnit));
    const ptyd = await exec('/bin/sh', [path.join(SCRIPT_DIR, 'render-ptyd-unit.sh')], {
      env: { ...env, WORKBENCH_PTYD_RUNTIME_NAME: ptydRuntime, WORKBENCH_BIN_DIR: path.join(root, 'bin') },
    });
    await writeFile(ptydUnitFile, ptyd.stdout
      .replace('Environment=HOME=%h', `Environment=HOME=${sandbox}/home`)
      .replace(/^Standard(Output|Error)=append:.+$/gm, 'Standard$1=journal'));
    await mkdir(dropIn, { recursive: true });
    for (const dir of ['home', 'config', 'data', 'state', 'cache']) await mkdir(path.join(sandbox, dir), { recursive: true });
    await writeFile(path.join(dropIn, 'isolation.conf'), [
      '[Service]',
      `Environment=HOME=${sandbox}/home`, `Environment=XDG_CONFIG_HOME=${sandbox}/config`, `Environment=XDG_DATA_HOME=${sandbox}/data`,
      `Environment=XDG_STATE_HOME=${sandbox}/state`, `Environment=XDG_CACHE_HOME=${sandbox}/cache`, `Environment=CODEX_HOME=${sandbox}/home/.codex`,
      'Environment=WORKBENCH_PERSISTENT_PTY=1', `Environment=WORKBENCH_PTYD_SOCKET=%t/${ptydRuntime}/ptyd.sock`,
      `Environment=WORKBENCH_PTYD_AUTH_FILE=%t/${ptydRuntime}/ptyd.sock.auth`,
      'Environment=WORKBENCH_NO_RESTORE=1', 'Environment=SHELL=/bin/bash',
      `Environment=PATH=${sandbox}/bin:/usr/bin:/bin`, '',
    ].join('\n'));

    const started = Date.now();
    let out = '';
    try { const r = await exec(path.join(SCRIPT_DIR, 'maw'), ['start'], { env }); out = r.stdout + r.stderr; }
    catch (e) { const x = e as { stdout: string; stderr: string }; assert.fail('activation failed: ' + x.stdout + x.stderr); }
    assert.match(out, new RegExp(`healthy on release ${id}`));
    const supervisor = await exec(process.execPath, [path.join(SCRIPT_DIR, 'control.mjs'), 'ptyd-empty'], { env });
    assert.match(supervisor.stdout, /no live sessions/);
    assert.equal(path.basename(await readlink(path.join(state, 'healthy'))), id);
    const status = await exec(process.execPath, [path.join(SCRIPT_DIR, 'control.mjs'), 'status'], { env: { ...env, WORKBENCH_EXPECT_RELEASE_ID: id } });
    assert.match(status.stdout, new RegExp(`release ${id}`));
    const url = (await exec(process.execPath, [path.join(SCRIPT_DIR, 'control.mjs'), 'url'], { env })).stdout.trim();
    const readiness = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(env.WORKBENCH_RUNTIME_DIR, 'workbench-ready.json'), 'utf8'));
    assert.equal(url, new URL(readiness.url).origin + '/');
    assert.equal((await fetch(url)).status, 401);
    const page = await (await fetch(readiness.url)).text();
    const builtIndex = await (await import('node:fs/promises')).readFile(path.join(release, 'packages/web/dist/index.html'), 'utf8');
    const mainChunk = builtIndex.match(/assets\/index-[\w-]+\.js/)?.[0];
    assert.ok(mainChunk && page.includes(mainChunk), 'the service serves this release\'s own built UI');
    const assetUrl = new URL(mainChunk, url); assetUrl.search = new URL(readiness.url).search;
    assert.equal((await fetch(assetUrl)).status, 200, 'built assets under hidden release parents');
    const missingUrl = new URL('/assets/missing.js', url); missingUrl.search = new URL(readiness.url).search;
    assert.equal((await fetch(missingUrl)).status, 404, 'missing assets never become healthy HTML');
    assert.equal((await fetch(new URL('/', url))).status, 401, 'UI remains authenticated');
    const startedPid = Number((await systemctl(['show', unit, '--property=MainPID', '--value'])).stdout.trim());
    await exec(path.join(SCRIPT_DIR, 'maw'), ['start'], { env });
    assert.equal(Number((await systemctl(['show', unit, '--property=MainPID', '--value'])).stdout.trim()), startedPid,
      'verified repeated start does not restart the process');
    const pid = Number((await systemctl(['show', unit, '--property=MainPID', '--value'])).stdout.trim());
    assert.equal(await realpath(`/proc/${pid}/cwd`), release, 'the process runs from the release, not a checkout');
    // Isolation is proven from the service process itself: its HOME/XDG point into the sandbox (the store is
    // created lazily, so its absence elsewhere proves nothing).
    const environ = Object.fromEntries((await (await import('node:fs/promises')).readFile(`/proc/${pid}/environ`, 'utf8'))
      .split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
    assert.equal(environ['HOME'], `${sandbox}/home`);
    assert.equal(environ['XDG_CONFIG_HOME'], `${sandbox}/config`);
    console.log(`# real release ${id} built and activated; ready ${Date.now() - started} ms after activation start`);
  } finally {
    await systemctl(['stop', unit]).catch(() => undefined);
    await systemctl(['stop', ptydUnit]).catch(() => undefined);
    await systemctl(['reset-failed', unit]).catch(() => undefined);
    await systemctl(['reset-failed', ptydUnit]).catch(() => undefined);
    if (path.basename(unitFile).startsWith('workbench-test-')) { await rm(unitFile, { force: true }); await rm(dropIn, { recursive: true, force: true }); }
    await rm(ptydUnitFile, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Real systemd user-bus isolation acceptance:
 * Verifies that all Workbench lifecycle commands (start, stop, status, restart, rollback)
 * correctly interact with the systemd user manager both outside and inside Workbench,
 * specifically when executing under an isolated private D-Bus daemon (FINDING-01).
 */
test('real systemd: in-app lifecycle commands and restart delegation succeed under simulated private D-Bus session', { skip: !enabled || !TSX }, async () => {
  const suffix = randomBytes(4).toString('hex');
  const unit = `workbench-test-${suffix}.service`;
  const helperUnit = `workbench-test-helper-${suffix}`;
  const runtimeName = `workbench-test-${suffix}`;
  const uid = process.getuid ? process.getuid() : 1000;
  const userDir = `/run/user/${uid}`;
  const unitDir = path.join(userDir, 'systemd/user');
  const unitFile = path.join(unitDir, unit);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'maw-systemd-')));
  const state = path.join(root, '.local/share/workbench');
  const releases = path.join(state, 'releases');
  const cgroupFile = path.join(root, 'cgroup');
  await writeFile(cgroupFile, `0::/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}\n`);
  await mkdir(releases, { recursive: true });
  await mkdir(unitDir, { recursive: true });

  const runtimeDir = path.join(userDir, runtimeName);
  const ptr = async (name: string) => { try { return path.basename(await readlink(path.join(state, name))); } catch { return null; } };

  // Start a private D-Bus daemon to simulate the private provider bus (e.g. agy-a, agy-b accounts / gnome-keyring)
  let privateBusPid = 0;
  let privateBusAddress = '';
  try {
    const busInfo = (await exec('dbus-daemon', ['--session', '--fork', '--print-address=1', '--print-pid=1'])).stdout.trim().split('\n');
    privateBusAddress = busInfo[0]?.trim() || '';
    privateBusPid = Number(busInfo[1]?.trim() || 0);
  } catch (e) {
    throw new Error('dbus-daemon required for private D-Bus isolation test: ' + e);
  }

  const baseEnv: NodeJS.ProcessEnv = {
    ...fixtureEnvironment(root),
    WORKBENCH_STATE_DIR: state,
    WORKBENCH_UNIT: unit,
    WORKBENCH_HELPER_UNIT: helperUnit,
    WORKBENCH_PTYD_UNIT: `workbench-test-ptyd-${suffix}.service`,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    WORKBENCH_ENV_FILE: path.join(root, 'no-environment'),
    WORKBENCH_RUNTIME_DIR: runtimeDir,
    WORKBENCH_NODE_BIN: process.execPath,
    WORKBENCH_READY_TIMEOUT: '25',
  };

  try {
    const rendered = await exec('/bin/sh', [path.join(SCRIPT_DIR, 'render-unit.sh')],
      { env: { ...baseEnv, WORKBENCH_RUNTIME_NAME: runtimeName, WORKBENCH_BIN_DIR: path.join(root, 'bin') } });
    await writeFile(unitFile, isolateUnit(rendered.stdout));

    const H = await makeRelease(releases, '20261029000001-aaaaaaa', HEALTHY_SERVER);
    await symlink(H, path.join(state, 'current'));

    // 1. External terminal start with normal D-Bus
    const extStart = await exec(path.join(SCRIPT_DIR, 'maw'), ['start'], { env: baseEnv });
    assert.match(extStart.stdout + extStart.stderr, /healthy on release 20261029000001-aaaaaaa/);
    assert.equal(await ptr('healthy'), path.basename(H));

    // Simulated private inside-Workbench environment:
    // Has WORKBENCH_CGROUP_FILE pointing to the unit cgroup, private DBUS_SESSION_BUS_ADDRESS, and unset XDG_RUNTIME_DIR.
    const inAppEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      WORKBENCH_CGROUP_FILE: cgroupFile,
      DBUS_SESSION_BUS_ADDRESS: privateBusAddress,
    };
    delete inAppEnv.XDG_RUNTIME_DIR;

    // Verify negative check: raw systemctl and systemd-run fail without bus routing under this environment
    await assert.rejects(
      exec('systemctl', ['--user', 'status', unit], { env: inAppEnv }),
      /Process org.freedesktop.systemd1 exited with status 1|No such file or directory/
    );
    await assert.rejects(
      exec('systemd-run', ['--user', 'true'], { env: inAppEnv }),
      /Process org.freedesktop.systemd1 exited with status 1|No such file or directory/
    );

    // 2. In-app status with simulated private D-Bus
    const statusRes = await exec(path.join(SCRIPT_DIR, 'maw'), ['status'], { env: inAppEnv });
    assert.match(statusRes.stdout, /ActiveState=active/);
    assert.match(statusRes.stdout, /current: 20261029000001-aaaaaaa/);
    assert.match(statusRes.stdout, /healthy: 20261029000001-aaaaaaa/);

    // 3. In-app restart with simulated private D-Bus
    const C = await makeRelease(releases, '20261029000002-ccccccc', HEALTHY_SERVER);
    await symlink(C, path.join(state, 'staged'));

    const restartRes = await exec(path.join(SCRIPT_DIR, 'maw'), ['restart'], { env: inAppEnv });
    assert.match(restartRes.stderr, /Restarting Workbench from inside Workbench\. Delegating restart outside service control group/);
    assert.match(restartRes.stdout, /Safe restart scheduled/);

    // Wait for helper delegation to complete
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if ((await ptr('healthy')) === path.basename(C)) break;
      await new Promise(r => setTimeout(r, 500));
    }
    assert.equal(await ptr('healthy'), path.basename(C), 'candidate promoted to healthy');
    assert.equal(await ptr('current'), path.basename(C));
    assert.equal(await ptr('previous'), path.basename(H));
    assert.equal(await ptr('staged'), null);

    // 4. Repeat / concurrent restart rejection
    const lock = path.join(runtimeDir, 'restart.lock');
    await mkdir(path.dirname(lock), { recursive: true });
    const lockHolder = spawn('flock', [lock, 'sh', '-c', 'read x'], { stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      await new Promise(r => setTimeout(r, 200));
      await assert.rejects(
        exec(path.join(SCRIPT_DIR, 'maw'), ['restart'], { env: inAppEnv }),
        (err: { stderr: string }) => /Duplicate restart avoided/.test(err.stderr)
      );
    } finally {
      lockHolder.stdin.end();
      lockHolder.kill('SIGKILL');
      for (let i = 0; i < 50; i++) {
        const free = await exec('flock', ['-n', lock, 'true']).then(() => true, () => false);
        if (free) break;
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // 5. In-app rollback with simulated private D-Bus
    for (let i = 0; i < 50; i++) {
      const active = await systemctl(['is-active', `${helperUnit}.service`]).then(r => r.stdout.trim() === 'active', () => false);
      if (!active) break;
      await new Promise(r => setTimeout(r, 200));
    }
    const rollbackRes = await exec(path.join(SCRIPT_DIR, 'maw'), ['rollback'], { env: inAppEnv });
    assert.match(rollbackRes.stderr, /Restarting Workbench from inside Workbench/);
    assert.match(rollbackRes.stdout, /Safe restart scheduled/);
    const rollbackDeadline = Date.now() + 30_000;
    while (Date.now() < rollbackDeadline) {
      if ((await ptr('healthy')) === path.basename(H)) break;
      await new Promise(r => setTimeout(r, 500));
    }
    assert.equal(await ptr('healthy'), path.basename(H), 'rolled back release restored');

    // 6. Native CLI environment safety
    assert.equal(inAppEnv.DBUS_SESSION_BUS_ADDRESS, privateBusAddress);

    // 7. Failure handling when user manager is unavailable
    const brokenEnv: NodeJS.ProcessEnv = {
      ...inAppEnv,
      WORKBENCH_SYSTEMD_RUNTIME_DIR: '/nonexistent/runtime',
      WORKBENCH_SYSTEMD_BUS_ADDRESS: 'unix:path=/nonexistent/bus',
    };
    await assert.rejects(
      exec(path.join(SCRIPT_DIR, 'maw'), ['restart'], { env: brokenEnv }),
      (err: { stderr: string }) => /Failed to schedule safe restart/.test(err.stderr)
    );
  } finally {
    if (privateBusPid) {
      try { process.kill(privateBusPid, 'SIGTERM'); } catch {}
    }
    await systemctl(['stop', unit]).catch(() => undefined);
    await systemctl(['stop', `${helperUnit}.service`]).catch(() => undefined);
    await systemctl(['stop', `${helperUnit}.timer`]).catch(() => undefined);
    await systemctl(['reset-failed', unit]).catch(() => undefined);
    if (path.basename(unitFile).startsWith('workbench-test-')) await rm(unitFile, { force: true });
    await rm(root, { recursive: true, force: true });
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * MAW updater / activation acceptance (mocked systemd).
 *
 * `systemctl` is a stub that models the service faithfully enough for the state machine: `restart`
 * "boots" whatever `current` resolves to at that moment (recorded in `running`), a release listed in
 * `broken/` never becomes ready, and `restart-fail-<n>` makes the n-th restart command itself fail
 * (ExecStartPre failure / start-limit-hit). The readiness probe is a mock that reports healthy only when
 * the running release matches MAW_EXPECT_RELEASE_ID. Real-systemd coverage lives in
 * maw-systemd-acceptance.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat, symlink, readlink, readdir, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const exec = promisify(execFile);

const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/maw');
const MAW_BIN = path.join(SCRIPT_DIR, 'maw');
const MAW_UPDATE_BIN = path.join(SCRIPT_DIR, 'maw-update.sh');
const MAW_RESTART_HELPER_BIN = path.join(SCRIPT_DIR, 'maw-restart-helper.sh');

type Fixture = Awaited<ReturnType<typeof setupGitFixture>>;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args])).stdout.trim();
}

async function setupGitFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'maw-test-')));
  const bareDir = path.join(root, 'origin.git');
  const sourceDir = path.join(root, 'source');
  const stateDir = path.join(root, 'state');
  const runtimeDir = path.join(root, 'runtime');
  const binDir = path.join(root, 'bin');
  const releasesDir = path.join(stateDir, 'releases');
  await mkdir(releasesDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(root, 'broken'), { recursive: true });

  await exec('git', ['init', '--bare', bareDir]);
  await git(bareDir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await exec('git', ['clone', bareDir, sourceDir]);
  await git(sourceDir, 'config', 'user.name', 'MAW Tester');
  await git(sourceDir, 'config', 'user.email', 'tester@example.com');
  await writeFile(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'test-maw', version: '1.0.0' }, null, 2));
  await mkdir(path.join(sourceDir, 'packages/server/src'), { recursive: true });
  await writeFile(path.join(sourceDir, 'packages/server/src/maw-host.ts'), 'export const ready = true;\n');
  await writeFile(path.join(sourceDir, 'packages/server/src/index.ts'), 'export {};\n');
  await git(sourceDir, 'add', '.');
  await git(sourceDir, 'commit', '-m', 'Initial commit');
  await git(sourceDir, 'branch', '-M', 'main');
  await git(sourceDir, 'push', '-u', 'origin', 'main');

  // The running, verified release (built from the initial commit).
  const initialCommit = await git(sourceDir, 'rev-parse', 'HEAD');
  const initialId = '20260101000000-' + initialCommit.slice(0, 7);
  const initialDir = path.join(releasesDir, initialId);
  await makeRelease(initialDir, initialId, initialCommit);
  await symlink(initialDir, path.join(stateDir, 'current'));
  await symlink(initialDir, path.join(stateDir, 'healthy'));
  await writeFile(path.join(stateDir, 'source_path'), sourceDir);
  await writeFile(path.join(root, 'running'), initialDir + '\n');
  // Never reach the real systemd from this suite: no service MainPID (disables the ancestor check) and a
  // systemd-run stub that refuses. Tests that need either override these files.
  await writeFile(path.join(root, 'mainpid'), '0\n');
  await writeFile(path.join(binDir, 'systemd-run'), '#!/bin/sh\necho "unexpected systemd-run" >&2\nexit 1\n', { mode: 0o755 });

  // pnpm/corepack stub: builds a structurally valid release; FAIL_<STEP> files in the commit fail a step;
  // SLEEP_STEP/PNPM_SLEEP make a step slow (for interruption tests).
  await writeFile(path.join(binDir, 'corepack'), `#!/bin/sh
[ "$1" = pnpm ] && shift
step="$1"; [ "$step" = --filter ] && step=test
echo "pnpm $step $$ $PWD" >> "${root}/pnpm.log"
if [ -n "\${PNPM_SLEEP:-}" ] && [ "\${SLEEP_STEP:-build}" = "$step" ]; then sleep "$PNPM_SLEEP"; fi
case "$step" in
  install) [ -f FAIL_INSTALL ] && exit 1; mkdir -p packages/server/node_modules/tsx/dist packages/server/node_modules/node-pty && echo '' > packages/server/node_modules/tsx/dist/loader.mjs ;;
  typecheck) [ -f FAIL_TYPECHECK ] && { echo "simulated typecheck failure" >&2; exit 1; } ;;
  build) [ -f FAIL_BUILD ] && { echo "simulated build failure" >&2; exit 1; }; mkdir -p packages/web/dist packages/server/dist && echo "<html>built</html>" > packages/web/dist/index.html && echo "export {};" > packages/server/dist/index.mjs && echo "#!/usr/bin/env node" > packages/server/dist/maw-ptyd.mjs ;;
  test) [ -f FAIL_TEST ] && exit 1 ;;
esac
exit 0
`, { mode: 0o755 });

  await writeFile(path.join(binDir, 'systemctl'), `#!/bin/sh
F="${root}"
cmd=""; for a in "$@"; do case "$a" in --*) ;; *) [ -z "$cmd" ] && cmd="$a" ;; esac; done
echo "$*" >> "$F/systemctl.log"
running_id() { r=$(cat "$F/running" 2>/dev/null); printf '%s' "\${r##*/}"; }
case "$cmd" in
  show)
    case "$*" in
      *MainPID*) cat "$F/mainpid" 2>/dev/null || echo "${process.pid}"; exit 0 ;;
      *ActiveState*) if [ -e "$F/fastfail" ] && [ -e "$F/broken/$(running_id)" ]; then echo failed; else echo active; fi; exit 0 ;;
      *Result*) echo start-limit-hit; exit 0 ;;
    esac
    echo ActiveState=active; exit 0 ;;
  restart|start)
    case "$*" in *maw-ptyd.service*) n=$(( $(cat "$F/ptyd-restarts" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$F/ptyd-restarts"; exit 0 ;; esac
    n=$(( $(cat "$F/restarts" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$F/restarts"
    if [ -e "$F/restart-fail-$n" ]; then : > "$F/running"; echo "Job failed: Start request repeated too quickly." >&2; exit 1; fi
    readlink -f "${stateDir}/current" > "$F/running"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });

  const mockControl = path.join(binDir, 'mock-control.mjs');
  await writeFile(mockControl, `
import fs from 'node:fs';
const F = ${JSON.stringify(root)};
if (process.argv[2] === 'check-data') {
  const target = process.argv[3];
  let supported = 1;
  try { supported = JSON.parse(fs.readFileSync(target + '/package.json', 'utf8')).mawCompatibility?.browserTabStore || 1; } catch {}
  const config = process.env.XDG_CONFIG_HOME || process.env.HOME + '/.config';
  for (const file of [config + '/agent-workbench/agency-web-tabs.json', config + '/agent-workbench/agency-web-tabs.json.bak']) {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).version > supported) process.exit(3); } catch (error) { if (error.code !== 'ENOENT') process.exit(1); }
  }
  process.exit(0);
}
if (process.argv[2] === 'ptyd-empty') {
  if (fs.existsSync(F + '/ptyd-auth-fail')) process.exit(1);
  if (fs.existsSync(F + '/ptyd-live')) process.exit(3);
  process.exit(0);
}
let running = ''; try { running = fs.readFileSync(F + '/running', 'utf8').trim(); } catch {}
const id = running.split('/').pop();
const expected = process.env.MAW_EXPECT_RELEASE_ID || '';
if (!running || fs.existsSync(F + '/broken/' + id) || (expected && expected !== id)) process.exit(1);
console.log('Healthy; release ' + id);
`);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: root,
    MAW_STATE_DIR: stateDir,
    MAW_RUNTIME_DIR: runtimeDir,
    MAW_SOURCE_DIR: sourceDir,
    MAW_UNIT: 'maw-fixture.service',
    MAW_NODE_BIN: process.execPath,
    MAW_CONTROL_SCRIPT: mockControl,
    MAW_READY_TIMEOUT: '2',
    MAW_CGROUP_FILE: path.join(root, 'no-cgroup'),
  };
  return { root, bareDir, sourceDir, stateDir, releasesDir, runtimeDir, binDir, env, initialDir, initialId, initialCommit };
}

async function makeRelease(dir: string, id: string, commit: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-workbench', version: '1.0.0' }) + '\n');
  await mkdir(path.join(dir, 'packages/server/src'), { recursive: true });
  await mkdir(path.join(dir, 'packages/server/dist'), { recursive: true });
  await mkdir(path.join(dir, 'packages/server/node_modules/tsx/dist'), { recursive: true });
  await mkdir(path.join(dir, 'packages/server/node_modules/node-pty'), { recursive: true });
  await writeFile(path.join(dir, 'packages/server/src/maw-host.ts'), '');
  await writeFile(path.join(dir, 'packages/server/src/index.ts'), '');
  await writeFile(path.join(dir, 'packages/server/node_modules/tsx/dist/loader.mjs'), '');
  await writeFile(path.join(dir, 'packages/server/dist/index.mjs'), 'export {};\n');
  await writeFile(path.join(dir, 'packages/server/dist/maw-ptyd.mjs'), '#!/usr/bin/env node\n');
  await writeFile(path.join(dir, '.maw-release-meta.json'), JSON.stringify({ releaseId: id, commit }) + '\n');
}

/** Push a new upstream commit; the developer checkout stays on the previous commit (clean). */
async function pushUpstream(f: Fixture, name: string, extra: Record<string, string> = {}): Promise<string> {
  await writeFile(path.join(f.sourceDir, `packages/server/src/${name}.ts`), `export const ${name.replace(/\W/g, '_')} = 1;\n`);
  for (const [file, content] of Object.entries(extra)) await writeFile(path.join(f.sourceDir, file), content);
  await git(f.sourceDir, 'add', '.');
  await git(f.sourceDir, 'commit', '-m', name);
  await git(f.sourceDir, 'push', 'origin', 'main');
  const commit = await git(f.sourceDir, 'rev-parse', 'HEAD');
  await git(f.sourceDir, 'reset', '--hard', 'HEAD~1');
  return commit;
}

async function pointer(f: Fixture, name: string): Promise<string | null> {
  try { return path.basename(await readlink(path.join(f.stateDir, name))); } catch { return null; }
}

async function pointers(f: Fixture) {
  return {
    current: await pointer(f, 'current'), staged: await pointer(f, 'staged'),
    healthy: await pointer(f, 'healthy'), previous: await pointer(f, 'previous'),
  };
}

async function logEvents(f: Fixture): Promise<Record<string, string>[]> {
  try { return (await readFile(path.join(f.stateDir, 'update-log.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

async function update(f: Fixture, args: string[] = ['--no-restart'], env: NodeJS.ProcessEnv = {}) {
  return exec(MAW_UPDATE_BIN, args, { env: { ...f.env, ...env } });
}

async function helper(f: Fixture, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await exec(MAW_RESTART_HELPER_BIN, ['--unit', 'maw-fixture.service'], { env: { ...f.env, ...env }, cwd: f.root });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

async function registeredWorktrees(f: Fixture): Promise<string[]> {
  return (await git(f.sourceDir, 'worktree', 'list', '--porcelain')).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
}

async function withFixture(body: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await setupGitFixture();
  try { await body(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}

async function changeStagedSupervisor(f: Fixture): Promise<void> {
  const staged = await pointer(f, 'staged');
  assert.ok(staged);
  await writeFile(path.join(f.releasesDir, staged!, 'packages/server/dist/maw-ptyd.mjs'), '#!/usr/bin/env node\n// changed supervisor\n');
}

async function setBrowserStoreCompatibility(f: Fixture, version: number): Promise<void> {
  const target = await pointer(f, 'staged');
  assert.ok(target);
  const manifestPath = path.join(f.releasesDir, target!, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.mawCompatibility = { browserTabStore: version };
  await writeFile(manifestPath, JSON.stringify(manifest) + '\n');
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------
test('supervisor code promotion refuses live PTYs before changing release pointers or restarting services', () => withFixture(async f => {
  await pushUpstream(f, 'ptyd-live');
  await update(f);
  await changeStagedSupervisor(f);
  await writeFile(path.join(f.root, 'ptyd-live'), '');
  const before = await pointers(f);
  const result = await helper(f);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Activation deferred/);
  assert.deepEqual(await pointers(f), before);
  assert.ok(!existsSync(path.join(f.root, 'restarts')));
  assert.ok(!existsSync(path.join(f.root, 'ptyd-restarts')));
}));

test('control ptyd-empty authenticates over the supervisor socket and checks live sessions', () => withFixture(async f => {
  const runtime = path.join(f.root, 'ptyd-runtime');
  await mkdir(runtime, { mode: 0o700 });
  const socketPath = path.join(runtime, 'ptyd.sock');
  const authPath = `${socketPath}.auth`;
  const token = randomBytes(32).toString('hex');
  await writeFile(authPath, `${token}\n`, { mode: 0o600 });
  let live = false;
  const server = net.createServer((socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      if (request.authToken !== token) {
        socket.write(`${JSON.stringify({ op: 'error', reqId: request.reqId, message: 'invalid authentication' })}\n`);
        return;
      }
      socket.write(`${JSON.stringify({ op: 'snapshot', reqId: request.reqId, sessions: live ? [{ id: 'live', alive: true }] : [], tombstones: [], pid: process.pid })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const run = () => exec(process.execPath, [path.join(SCRIPT_DIR, 'control.mjs'), 'ptyd-empty'], {
    env: { ...f.env, MAW_PTYD_SOCKET: socketPath, MAW_PTYD_AUTH_FILE: authPath },
  });
  try {
    const empty = await run();
    assert.match(empty.stdout, /no live sessions/);
    live = true;
    await assert.rejects(run());
    await writeFile(authPath, `${'0'.repeat(64)}\n`, { mode: 0o600 });
    await assert.rejects(run());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}));

test('control check-data reads compatibility metadata and refuses a v2-to-v1 downgrade without writes', () => withFixture(async f => {
  const target = path.join(f.root, 'target');
  const configHome = path.join(f.root, 'config');
  const configDir = path.join(configHome, 'agent-workbench');
  await mkdir(target, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const manifest = path.join(target, 'package.json');
  const store = path.join(configDir, 'agency-web-tabs.json');
  await writeFile(manifest, JSON.stringify({ mawCompatibility: { browserTabStore: 1 } }));
  const original = JSON.stringify({ version: 2, tabs: [], keep: true });
  await writeFile(store, original);
  const run = () => exec(process.execPath, [path.join(SCRIPT_DIR, 'control.mjs'), 'check-data', target], {
    env: { ...f.env, XDG_CONFIG_HOME: configHome },
  });
  await assert.rejects(run(), (error: { stderr: string }) => /supports browser tab store v1.*v2/.test(error.stderr));
  assert.equal(await readFile(store, 'utf8'), original);
  await writeFile(manifest, JSON.stringify({ mawCompatibility: { browserTabStore: 2 } }));
  await run();
  assert.equal(await readFile(store, 'utf8'), original);
}));

test('supervisor code promotion fails closed on auth/list failure without switching current', () => withFixture(async f => {
  await pushUpstream(f, 'ptyd-auth-failure');
  await update(f);
  await changeStagedSupervisor(f);
  await writeFile(path.join(f.root, 'ptyd-auth-fail'), '');
  const before = await pointers(f);
  const result = await helper(f);
  assert.equal(result.code, 1);
  assert.deepEqual(await pointers(f), before);
  assert.ok(!existsSync(path.join(f.root, 'restarts')));
  assert.ok(!existsSync(path.join(f.root, 'ptyd-restarts')));
}));

test('empty authenticated supervisor is restarted to load the staged PTY host code', () => withFixture(async f => {
  await pushUpstream(f, 'ptyd-empty');
  await update(f);
  await changeStagedSupervisor(f);
  const result = await helper(f);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await readFile(path.join(f.root, 'ptyd-restarts'), 'utf8')).trim(), '1');
  assert.equal((await readFile(path.join(f.root, 'restarts'), 'utf8')).trim(), '1');
}));

test('restart refuses a browser store downgrade before changing current or restarting MAW', () => withFixture(async f => {
  await pushUpstream(f, 'browser-data-downgrade');
  await update(f);
  await setBrowserStoreCompatibility(f, 1);
  const configHome = path.join(f.root, 'config');
  const configDir = path.join(configHome, 'agent-workbench');
  await mkdir(configDir, { recursive: true });
  const storePath = path.join(configDir, 'agency-web-tabs.json');
  const original = JSON.stringify({ version: 2, tabs: [], migrationData: 'preserve' });
  await writeFile(storePath, original);
  const before = await pointers(f);
  const result = await helper(f, { XDG_CONFIG_HOME: configHome });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Activation refused to protect browser tab data/);
  assert.deepEqual(await pointers(f), before);
  assert.equal(await readFile(storePath, 'utf8'), original);
  assert.ok(!existsSync(path.join(f.root, 'restarts')));
}));

test('target that supports browser store v2 passes the read-only compatibility preflight', () => withFixture(async f => {
  await pushUpstream(f, 'browser-data-compatible');
  await update(f);
  await setBrowserStoreCompatibility(f, 2);
  const configHome = path.join(f.root, 'config');
  const configDir = path.join(configHome, 'agent-workbench');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'agency-web-tabs.json'), JSON.stringify({ version: 2, tabs: [] }));
  const target = await pointer(f, 'staged');
  const result = await helper(f, { XDG_CONFIG_HOME: configHome });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await pointer(f, 'current'), target);
}));

test('maw rollback refuses an older target before mutating current or staged pointers', () => withFixture(async f => {
  await pushUpstream(f, 'rollback-from-v2');
  await update(f);
  await setBrowserStoreCompatibility(f, 2);
  assert.equal((await helper(f)).code, 0);
  const before = await pointers(f);
  assert.ok(before.previous);
  const configHome = path.join(f.root, 'config');
  const configDir = path.join(configHome, 'agent-workbench');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'agency-web-tabs.json'), JSON.stringify({ version: 2, tabs: [] }));
  const result = await exec(MAW_BIN, ['rollback'], { env: { ...f.env, XDG_CONFIG_HOME: configHome } }).then(
    (value) => ({ code: 0, ...value }),
    (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Rollback refused to protect browser tab data/);
  assert.deepEqual(await pointers(f), before);
  assert.ok(!existsSync(path.join(f.root, 'restarts')) || (await readFile(path.join(f.root, 'restarts'), 'utf8')).trim() === '1');
}));

test('1. staging builds an isolated release and changes ONLY the staged pointer (U-4)', () => withFixture(async f => {
  const commit = await pushUpstream(f, 'v2');
  const res = await update(f);
  assert.match(res.stdout, /MAW update staged successfully/);
  assert.match(res.stdout, /keeps booting the current release, even after a crash or reboot/);
  const p = await pointers(f);
  assert.equal(p.current, f.initialId);
  assert.equal(p.healthy, f.initialId);
  assert.equal(p.previous, null);
  assert.ok(p.staged && p.staged.endsWith(commit.slice(0, 7)));
  const meta = JSON.parse(await readFile(path.join(f.releasesDir, p.staged!, '.maw-release-meta.json'), 'utf8'));
  assert.equal(meta.commit, commit);
  assert.equal(meta.channel, 'approved');
  assert.ok(!existsSync(path.join(f.releasesDir, p.staged!, '.git')), 'release is detached from git');
  assert.ok(!existsSync(path.join(f.releasesDir, p.staged!, '.maw-candidate')));
  assert.deepEqual(await registeredWorktrees(f), [f.sourceDir]);
  assert.ok((await logEvents(f)).some(e => e.event === 'stage-success'));
  assert.ok(!(await logEvents(f)).some(e => e.event === 'update-success'), 'no success claim before activation');
}));

test('2. dirty development checkout is detected and preserved untouched', () => withFixture(async f => {
  await writeFile(path.join(f.sourceDir, 'uncommitted.txt'), 'my uncommitted work\n');
  await assert.rejects(update(f), (err: { stderr: string }) => /Git worktree is dirty/.test(err.stderr));
  assert.equal(await readFile(path.join(f.sourceDir, 'uncommitted.txt'), 'utf8'), 'my uncommitted work\n');
  assert.ok((await logEvents(f)).some(e => e.error?.includes('dirty')));
}));

test('3. local unpushed commits are never deployed and never lost', () => withFixture(async f => {
  const upstream = await pushUpstream(f, 'upstream');
  await git(f.sourceDir, 'merge', '--ff-only', 'origin/main');
  await writeFile(path.join(f.sourceDir, 'local-work.ts'), 'export const local = true;\n');
  await git(f.sourceDir, 'add', '.');
  await git(f.sourceDir, 'commit', '-m', 'Local unpushed commit');
  await update(f);
  const staged = (await pointers(f)).staged!;
  assert.ok(staged.endsWith(upstream.slice(0, 7)));
  assert.match(await git(f.sourceDir, 'log', '-1', '--format=%s'), /Local unpushed commit/);
}));

test('4. diverged upstream is refused safely', () => withFixture(async f => {
  // Deployed release is on a commit that is not an ancestor of origin/main.
  await writeFile(path.join(f.sourceDir, 'diverged.ts'), 'export const local = 2;\n');
  await git(f.sourceDir, 'add', '.');
  await git(f.sourceDir, 'commit', '-m', 'Local diverged commit');
  const diverged = await git(f.sourceDir, 'rev-parse', 'HEAD');
  await writeFile(path.join(f.initialDir, '.maw-release-meta.json'), JSON.stringify({ releaseId: f.initialId, commit: diverged }));
  await git(f.sourceDir, 'reset', '--hard', 'origin/main');
  await pushUpstream(f, 'upstream');
  await assert.rejects(update(f), (err: { stderr: string }) => /cannot be fast-forwarded/.test(err.stderr));
  assert.equal((await pointers(f)).staged, null);
}));

for (const [n, step, marker] of [[5, 'dependencies', 'FAIL_INSTALL'], [6, 'typecheck', 'FAIL_TYPECHECK'], [7, 'build', 'FAIL_BUILD']] as const) {
  test(`${n}. ${step} failure removes the candidate and its worktree registration; pointers untouched`, () => withFixture(async f => {
    await pushUpstream(f, 'broken', { [marker]: 'x\n' });
    await assert.rejects(update(f), (err: { stderr: string }) => new RegExp(`stage: ${step}`).test(err.stderr));
    assert.deepEqual(await readdir(f.releasesDir), [f.initialId]);
    assert.deepEqual(await registeredWorktrees(f), [f.sourceDir]);
    assert.deepEqual(await pointers(f), { current: f.initialId, staged: null, healthy: f.initialId, previous: null });
    assert.ok((await logEvents(f)).some(e => e.event === 'update-failure' && e.stage === step));
  }));
}

// ---------------------------------------------------------------------------
// Activation / rollback (U-1, U-2)
// ---------------------------------------------------------------------------
test('8. U-1: candidate that never becomes ready is rolled back to the verified healthy release (exit 2)', () => withFixture(async f => {
  await pushUpstream(f, 'v2');
  await update(f);
  const staged = (await pointers(f)).staged!;
  await writeFile(path.join(f.root, 'broken', staged), '');
  const r = await helper(f);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /UPDATE FAILED, SERVICE RECOVERED/);
  assert.match(r.stderr, /Executable rollback does not guarantee historical-data compatibility/);
  assert.deepEqual(await pointers(f), { current: f.initialId, staged: null, healthy: f.initialId, previous: null });
  assert.equal((await readFile(path.join(f.root, 'running'), 'utf8')).trim().split('/').pop(), f.initialId);
  const events = (await logEvents(f)).map(e => e.event);
  assert.ok(events.includes('activation-failure') && events.includes('rollback-success'));
  assert.match(await readFile(path.join(f.root, 'systemctl.log'), 'utf8'), /reset-failed/);
}));

test('9. U-1: a failing `systemctl restart` (start-limit / ExecStartPre) still reaches rollback', () => withFixture(async f => {
  await pushUpstream(f, 'v2');
  await update(f);
  await writeFile(path.join(f.root, 'restart-fail-1'), '');
  const r = await helper(f);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /systemctl restart failed/);
  assert.equal((await pointers(f)).current, f.initialId);
  assert.ok((await logEvents(f)).some(e => e.event === 'rollback-success'));
}));

test('9b. U-1: rollback restart failure is reported as CRITICAL (exit 3) and logged', () => withFixture(async f => {
  await pushUpstream(f, 'v2');
  await update(f);
  await writeFile(path.join(f.root, 'restart-fail-1'), '');
  await writeFile(path.join(f.root, 'restart-fail-2'), '');
  const r = await helper(f);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /CRITICAL: rollback to .* also failed/);
  assert.ok((await logEvents(f)).some(e => e.event === 'rollback-failure'));
}));

test('9c. U-1: the verified healthy release failing a plain restart is CRITICAL and never loops', () => withFixture(async f => {
  await writeFile(path.join(f.root, 'broken', f.initialId), '');
  const r = await helper(f);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /verified healthy release .* failed to start/);
  assert.equal((await readFile(path.join(f.root, 'restarts'), 'utf8')).trim(), '1');
}));

test('9d. U-1: early failure detection uses the unit state instead of waiting the full timeout', () => withFixture(async f => {
  await pushUpstream(f, 'v2');
  await update(f);
  await writeFile(path.join(f.root, 'broken', (await pointers(f)).staged!), '');
  await writeFile(path.join(f.root, 'fastfail'), '');
  const r = await helper(f, { MAW_READY_TIMEOUT: '30' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unit entered failed state/);
}));

test('9e. U-1: an invalid rollback target (healthy points at a non-release) is never used; CRITICAL', () => withFixture(async f => {
  await pushUpstream(f, 'v2');
  await update(f);
  await writeFile(path.join(f.root, 'broken', (await pointers(f)).staged!), '');
  await rm(path.join(f.stateDir, 'healthy'));
  await symlink(f.sourceDir, path.join(f.stateDir, 'healthy'));   // mutable checkout: not a release
  await writeFile(path.join(f.root, 'running'), '');   // service down, so nothing can be adopted as healthy
  const r = await helper(f);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /no verified healthy release is available/);
  assert.equal((await readFile(path.join(f.root, 'restarts'), 'utf8')).trim(), '1', 'no restart into the invalid target');
}));

test('16. U-2: two staged updates never replace the verified rollback target; failed B recovers H, not A', () => withFixture(async f => {
  const H = f.initialId;
  await pushUpstream(f, 'releaseA');
  await update(f);
  const A = (await pointers(f)).staged!;
  assert.deepEqual(await pointers(f), { current: H, staged: A, healthy: H, previous: null });
  await git(f.sourceDir, 'merge', '--ff-only', 'origin/main');
  await pushUpstream(f, 'releaseB');
  await update(f);
  const B = (await pointers(f)).staged!;
  assert.notEqual(A, B);
  assert.deepEqual(await pointers(f), { current: H, staged: B, healthy: H, previous: null });

  // Simulated crash + reboot before activation: the service boots `current`, i.e. still H.
  await exec('systemctl', ['--user', 'restart', 'maw-fixture.service'], { env: f.env });
  assert.equal((await readFile(path.join(f.root, 'running'), 'utf8')).trim().split('/').pop(), H);

  await writeFile(path.join(f.root, 'broken', B), '');
  const r = await helper(f);
  assert.equal(r.code, 2);
  assert.deepEqual(await pointers(f), { current: H, staged: null, healthy: H, previous: null });
}));

test('16b. U-2: helper killed after switching pointers; reboot boots unverified B; next restart rolls back to H', () => withFixture(async f => {
  const H = f.initialId;
  await pushUpstream(f, 'releaseB');
  await update(f);
  const B = (await pointers(f)).staged!;
  await writeFile(path.join(f.root, 'broken', B), '');
  const child = spawn(MAW_RESTART_HELPER_BIN, ['--unit', 'maw-fixture.service'], { env: { ...f.env, MAW_READY_TIMEOUT: '30' }, stdio: 'ignore', detached: true });
  for (let i = 0; i < 100 && (await pointer(f, 'current')) !== B; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(await pointer(f, 'current'), B, 'helper switched current to B');
  // A reboot also kills helper children that can briefly inherit its flock descriptors.
  assert.ok(child.pid);
  process.kill(-child.pid, 'SIGKILL');
  await new Promise(r => child.once('exit', r));
  // Machine crash/reboot: systemd boots `current` = B (unverified, broken).
  await exec('systemctl', ['--user', 'restart', 'maw-fixture.service'], { env: f.env });
  const status = await exec(MAW_BIN, ['status'], { env: f.env }).catch(e => e as { stdout: string });
  assert.match(status.stdout, /current is not the verified healthy release/);
  const r = await helper(f);
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(await pointers(f), { current: H, staged: null, healthy: H, previous: null });
}));

test('17. U-2: successful activation promotes healthy and keeps the old healthy as previous', () => withFixture(async f => {
  const H = f.initialId;
  await pushUpstream(f, 'v2');
  await update(f);
  const S = (await pointers(f)).staged!;
  const r = await helper(f);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(await pointers(f), { current: S, staged: null, healthy: S, previous: H });
  assert.ok((await logEvents(f)).some(e => e.event === 'activation-success' && e.release === S));
  // maw rollback reactivates the previous verified release.
  const rb = await exec(MAW_BIN, ['rollback'], { env: f.env });
  assert.match(rb.stderr, /Executable rollback does not guarantee historical-data compatibility/);
  assert.match(rb.stdout, /Activating previous verified release/);
  assert.deepEqual(await pointers(f), { current: H, staged: null, healthy: H, previous: S });
}));

test('18. U-10: activation verifies the release ID, not just "something answers"', () => withFixture(async f => {
  await pushUpstream(f, 'v2');
  await update(f);
  // The probe sees the OLD release still serving (e.g. restart did not switch): must not be promoted.
  const stub = path.join(f.binDir, 'systemctl');
  const body = await readFile(stub, 'utf8');
  await writeFile(stub, body.replace('readlink -f "' + f.stateDir + '/current" > "$F/running"', `echo "${f.initialDir}" > "$F/running"`), { mode: 0o755 });
  const r = await helper(f);
  assert.equal(r.code, 2);
  assert.equal((await pointers(f)).healthy, f.initialId);
}));

// ---------------------------------------------------------------------------
// Target ref policy (U-7)
// ---------------------------------------------------------------------------
test('19. U-7: plain update on a pushed feature branch stages the approved channel, never the branch', () => withFixture(async f => {
  const main = await pushUpstream(f, 'mainline');
  await git(f.sourceDir, 'switch', '-c', 'feature/wip');
  await writeFile(path.join(f.sourceDir, 'experimental.ts'), 'export {};\n');
  await git(f.sourceDir, 'add', '.');
  await git(f.sourceDir, 'commit', '-m', 'WIP');
  await git(f.sourceDir, 'push', '-u', 'origin', 'feature/wip');
  await update(f);
  const staged = (await pointers(f)).staged!;
  assert.ok(staged.endsWith(main.slice(0, 7)), 'staged origin/main');
  assert.ok(!existsSync(path.join(f.releasesDir, staged, 'experimental.ts')));

  await assert.rejects(update(f, ['--no-restart', '--ref', 'origin/feature/wip']),
    (err: { stderr: string }) => /not the approved release channel/.test(err.stderr));
  await update(f, ['--no-restart', '--ref', 'origin/feature/wip', '--allow-unapproved-ref']);
  const wip = (await pointers(f)).staged!;
  const meta = JSON.parse(await readFile(path.join(f.releasesDir, wip, '.maw-release-meta.json'), 'utf8'));
  assert.equal(meta.channel, 'unapproved');
  assert.equal(meta.ref, 'origin/feature/wip');
}));

test('20. --ref without a value is a usage error, not a shell crash', () => withFixture(async f => {
  await assert.rejects(update(f, ['--ref']), (err: { code: number; stderr: string }) => err.code === 2 && /requires a value/.test(err.stderr));
}));

// ---------------------------------------------------------------------------
// Interruption, locking, GC (U-5, U-6, U-9, U-11, U-12)
// ---------------------------------------------------------------------------
async function interruptDuringBuild(f: Fixture, signal: NodeJS.Signals): Promise<{ code: number | null; ms: number }> {
  const child = spawn(MAW_UPDATE_BIN, ['--no-restart'], { env: { ...f.env, PNPM_SLEEP: '20', SLEEP_STEP: 'build' }, stdio: 'ignore' });
  const logFile = path.join(f.root, 'pnpm.log');
  for (let i = 0; i < 200; i++) {
    if (existsSync(logFile) && /pnpm build/.test(await readFile(logFile, 'utf8'))) break;
    await new Promise(r => setTimeout(r, 50));
  }
  const started = Date.now();
  child.kill(signal);
  const code = await new Promise<number | null>(r => child.once('exit', c => r(c)));
  return { code, ms: Date.now() - started };
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  test(`21. U-5/U-6: ${signal} during build aborts promptly, removes only its candidate, releases the lock`, () => withFixture(async f => {
    await pushUpstream(f, 'v2');
    const { code, ms } = await interruptDuringBuild(f, signal);
    assert.equal(code, 130);
    assert.ok(ms < 5000, `aborted in ${ms} ms`);
    assert.deepEqual(await readdir(f.releasesDir), [f.initialId]);
    assert.deepEqual(await registeredWorktrees(f), [f.sourceDir]);
    assert.deepEqual(await pointers(f), { current: f.initialId, staged: null, healthy: f.initialId, previous: null });
    assert.ok((await logEvents(f)).some(e => e.stage === 'interrupted'));
    await update(f);   // lock is free immediately
    assert.ok((await pointers(f)).staged);
  }));
}

test('22. U-5: SIGKILL leaves an orphan that the next run removes (ownership-checked; decoys untouched)', () => withFixture(async f => {
  await pushUpstream(f, 'v2');
  const decoyDir = path.join(f.releasesDir, '20260202000000-deadbee');     // finished release, unreferenced
  await makeRelease(decoyDir, '20260202000000-deadbee', f.initialCommit);
  const foreign = path.join(f.releasesDir, 'my-notes');                      // not ours by name
  await mkdir(foreign);
  const { code } = await interruptDuringBuild(f, 'SIGKILL');
  assert.equal(code, null);
  const orphan = (await readdir(f.releasesDir)).filter(n => ![f.initialId, 'my-notes', '20260202000000-deadbee'].includes(n));
  assert.equal(orphan.length, 1);
  assert.ok((await registeredWorktrees(f)).length === 2, 'orphan worktree is registered');
  await new Promise(r => setTimeout(r, 1100));   // distinct release id
  await update(f);
  const after = await readdir(f.releasesDir);
  assert.ok(!after.includes(orphan[0]!), 'orphan removed');
  assert.ok(after.includes('my-notes') && after.includes('20260202000000-deadbee'), 'non-owned entries untouched');
  assert.deepEqual(await registeredWorktrees(f), [f.sourceDir]);
  assert.ok((await logEvents(f)).some(e => e.event === 'orphan-removed'));
}));

test('23. unexpected parent exit does not abort or corrupt staging', () => withFixture(async f => {
  await pushUpstream(f, 'v2');
  await exec('/bin/sh', ['-c', `"${MAW_UPDATE_BIN}" --no-restart >/dev/null 2>&1 & exit 0`], { env: f.env });
  for (let i = 0; i < 200 && !(await pointers(f)).staged; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok((await pointers(f)).staged);
  assert.deepEqual(await registeredWorktrees(f), [f.sourceDir]);
}));

test('24. U-9: concurrent updaters are serialized by an atomic lock (20 races)', () => withFixture(async f => {
  await pushUpstream(f, 'v2');
  for (let i = 0; i < 20; i++) {
    await rm(path.join(f.stateDir, 'staged'), { force: true });
    for (const n of await readdir(f.releasesDir)) if (n !== f.initialId) await rm(path.join(f.releasesDir, n), { recursive: true, force: true });
    const run = () => update(f, ['--no-restart'], { PNPM_SLEEP: '0.3', SLEEP_STEP: 'install' }).then(() => 'ok', (e: { stderr: string }) => e.stderr);
    const results = await Promise.all([run(), run()]);
    assert.equal(results.filter(r => r === 'ok').length, 1, JSON.stringify(results));
    assert.ok(results.some(r => r !== 'ok' && /already in progress/.test(r)), JSON.stringify(results));
  }
}));

test('25. U-11: `maw update --restart` leaves no lock behind (flock released on exit)', () => withFixture(async f => {
  await pushUpstream(f, 'v2');
  const r = await update(f, ['--restart']);
  assert.match(r.stdout, /healthy on release/);
  await git(f.sourceDir, 'merge', '--ff-only', 'origin/main');
  await pushUpstream(f, 'v3');
  await update(f);   // would fail with "already in progress" if a stale lock remained
  assert.ok((await pointers(f)).staged);
}));

test('26. U-12: successful activation garbage-collects unreferenced releases, keeping one spare', () => withFixture(async f => {
  const ids: string[] = [];
  for (const name of ['r1', 'r2', 'r3']) {
    await git(f.sourceDir, 'merge', '--ff-only', 'origin/main').catch(() => undefined);
    await pushUpstream(f, name);
    await update(f);
    ids.push((await pointers(f)).staged!);
    assert.equal((await helper(f)).code, 0);
    await new Promise(r => setTimeout(r, 1100));
  }
  await mkdir(path.join(f.releasesDir, 'not-a-release'));
  await git(f.sourceDir, 'merge', '--ff-only', 'origin/main');
  await pushUpstream(f, 'r4');
  await update(f);
  assert.equal((await helper(f)).code, 0);
  const left = await readdir(f.releasesDir);
  const p = await pointers(f);
  assert.ok(left.includes(p.healthy!) && left.includes(p.previous!));
  assert.ok(left.includes('not-a-release'), 'never removes non-release entries');
  assert.ok(!left.includes(f.initialId), 'oldest unreferenced release removed');
  assert.equal(left.filter(n => n !== 'not-a-release').length, 3, left.join(','));
}));

// ---------------------------------------------------------------------------
// Launcher (U-13)
// ---------------------------------------------------------------------------
test('27. U-13b: restart inside MAW delegates with a fixed collectable unit and passes MAW_* state', () => withFixture(async f => {
  const runLog = path.join(f.root, 'systemd-run.log');
  await writeFile(path.join(f.binDir, 'systemd-run'), `#!/bin/sh\necho "$@" >> "${runLog}"\nexit 0\n`, { mode: 0o755 });
  const cgroup = path.join(f.root, 'cgroup');
  await writeFile(cgroup, '0::/user.slice/user-1000.slice/user@1000.service/app.slice/maw-fixture.service\n');
  const res = await exec(MAW_BIN, ['restart'], { env: { ...f.env, MAW_CGROUP_FILE: cgroup } });
  assert.match(res.stderr, /Original PTY will not survive/);
  assert.match(res.stdout, /Safe restart scheduled/);
  const log = await readFile(runLog, 'utf8');
  assert.match(log, /--unit=maw-restart-helper /);
  assert.match(log, /--collect/);
  assert.ok(log.includes(`--setenv=MAW_STATE_DIR=${f.stateDir}`));
  assert.ok(log.includes(`--setenv=MAW_RUNTIME_DIR=${f.runtimeDir}`));
}));

test('28. U-13b: cgroup detection is an exact unit match, not a regex substring', () => withFixture(async f => {
  const runLog = path.join(f.root, 'systemd-run.log');
  await writeFile(path.join(f.binDir, 'systemd-run'), `#!/bin/sh\necho "$@" >> "${runLog}"\nexit 0\n`, { mode: 0o755 });
  await writeFile(path.join(f.root, 'mainpid'), '0\n');   // disable ancestor fallback
  const cgroup = path.join(f.root, 'cgroup');
  for (const line of ['0::/user.slice/app.slice/app-mawxfixture.service', '0::/user.slice/app.slice/maw-fixture.service.d', '0::/user.slice/app.slice/xmaw-fixture.service']) {
    await writeFile(cgroup, line + '\n');
    await exec(MAW_BIN, ['restart'], { env: { ...f.env, MAW_CGROUP_FILE: cgroup } }).catch(() => undefined);
    assert.ok(!existsSync(runLog), `not inside for ${line}`);
  }
}));

test('29. duplicate restart is rejected while a helper holds the restart lock', () => withFixture(async f => {
  const lock = path.join(f.runtimeDir, 'restart.lock');
  const holder = spawn('flock', [lock, 'sleep', '5'], { stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 200));
    const r = await helper(f);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already in progress/);
    const cgroup = path.join(f.root, 'cgroup');
    await writeFile(cgroup, '0::/x/maw-fixture.service\n');
    await assert.rejects(exec(MAW_BIN, ['restart'], { env: { ...f.env, MAW_CGROUP_FILE: cgroup } }),
      (err: { stderr: string }) => /Duplicate restart avoided/.test(err.stderr));
  } finally { holder.kill(); }
}));

test('30. U-13a: scripts and unit template contain no user-specific paths', async () => {
  for (const name of ['maw', 'maw-lib.sh', 'maw-update.sh', 'maw-restart-helper.sh', 'install.sh', 'control.mjs', 'maw.service']) {
    const text = await readFile(path.join(SCRIPT_DIR, name), 'utf8');
    assert.ok(!/\/home\/[a-z]/.test(text) && !/nvm\/versions/.test(text), name);
  }
});

test('31. U-3/U-13a: install --service builds an isolated first release and renders the unit (legacy current preserved)', () => withFixture(async f => {
  // Install from a clone of the fixture repository (the "repository" holding scripts/maw).
  const repo = path.join(f.root, 'repo');
  await exec('git', ['clone', f.bareDir, repo]);
  await mkdir(path.join(repo, 'scripts'), { recursive: true });
  await exec('cp', ['-r', SCRIPT_DIR, path.join(repo, 'scripts/maw')]);
  await git(repo, 'config', 'user.name', 'MAW Tester');
  await git(repo, 'config', 'user.email', 'tester@example.com');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'scripts');
  const state = path.join(f.root, 'fresh-state');
  await mkdir(state);
  await symlink(f.sourceDir, path.join(state, 'current'));   // old installer layout
  const env = {
    ...f.env, MAW_STATE_DIR: state, MAW_LIB_DIR: path.join(f.root, 'lib'), MAW_BIN_DIR: path.join(f.root, 'localbin'),
    MAW_SYSTEMD_USER_DIR: path.join(f.root, 'units'), MAW_NODE_BIN: process.execPath, MAW_SOURCE_DIR: '',
  };
  const out = await exec(path.join(repo, 'scripts/maw/install.sh'), ['--service'], { env });
  assert.match(out.stdout, /Service installed but not enabled/, out.stdout + out.stderr);
  const current = await realpath(path.join(state, 'current'));
  assert.equal(path.dirname(current), await realpath(path.join(state, 'releases')));
  assert.ok(existsSync(path.join(current, '.maw-release-meta.json')));
  assert.equal(await realpath(path.join(state, 'legacy-current')), f.sourceDir);
  assert.equal((await lstat(path.join(state, 'healthy')).catch(() => null)), null, 'not healthy before first verified start');
  const unit = await readFile(path.join(f.root, 'units/maw-fixture.service'), 'utf8');
  assert.ok(!unit.includes('@'), 'all placeholders rendered');
  assert.ok(unit.includes(`ExecStart=${process.execPath} --import ${state}/current/packages/server/node_modules/tsx/dist/loader.mjs`));
  assert.ok(unit.includes(`WorkingDirectory=${state}/current`));
  assert.match(unit, /ExecStartPre=\/usr\/bin\/test -f .*\.maw-release-meta\.json/);
}));

test('31b. installed library renders and runs after the installer source is removed', () => withFixture(async f => {
  const repo = path.join(f.root, 'installer-source');
  await mkdir(path.join(repo, 'scripts'), { recursive: true });
  await exec('cp', ['-r', SCRIPT_DIR, path.join(repo, 'scripts/maw')]);
  const env = {
    ...f.env, MAW_LIB_DIR: path.join(f.root, 'installed-lib'), MAW_BIN_DIR: path.join(f.root, 'installed-bin'),
    MAW_RUNTIME_NAME: 'maw-installed-fixture',
  };
  await exec(path.join(repo, 'scripts/maw/install.sh'), ['--commands-only'], { env });
  await rm(repo, { recursive: true, force: true });
  for (const [name, mode] of [['maw-render-unit.sh', 0o755], ['maw.service', 0o644]] as const) {
    assert.equal((await stat(path.join(env.MAW_LIB_DIR, name))).mode & 0o777, mode);
  }
  const rendered = await exec(path.join(env.MAW_LIB_DIR, 'maw-render-unit.sh'), [], { env, cwd: f.root });
  assert.ok(!rendered.stdout.includes('@'), 'installed template is fully rendered');
  assert.ok(rendered.stdout.includes(`WorkingDirectory=${f.stateDir}/current`));
  assert.ok(rendered.stdout.includes(`ExecStart=${process.execPath} --import `));
  assert.ok(rendered.stdout.includes('RuntimeDirectory=maw-installed-fixture'));
  const installedMaw = path.join(env.MAW_BIN_DIR, 'maw');
  assert.match((await exec(installedMaw, ['help'], { env, cwd: f.root })).stdout, /Usage: maw/);
  assert.match((await exec(installedMaw, ['update', '--help'], { env, cwd: f.root })).stdout, /Usage: maw update/);
  await pushUpstream(f, 'installed-update');
  await exec(installedMaw, ['update', '--no-restart'], { env, cwd: f.root });
  assert.ok(await pointer(f, 'staged'), 'installed updater builds from the configured fixture Git source');
  const activated = await exec(path.join(env.MAW_LIB_DIR, 'maw-restart-helper.sh'), ['--unit', env.MAW_UNIT], { env, cwd: f.root });
  assert.match(activated.stdout, /healthy on release/);

  // Exercise the installed control.mjs as well, using only fixture readiness and a local HTTP server.
  const server = createServer((req, res) => { res.statusCode = req.url?.includes('token=installed-fixture') ? 200 : 401; res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const url = `http://127.0.0.1:${addr.port}/?token=installed-fixture`;
    await writeFile(path.join(f.runtimeDir, 'maw-ready.json'), JSON.stringify({ pid: process.pid, url, releaseId: f.initialId }), { mode: 0o600 });
    await writeFile(path.join(f.root, 'mainpid'), `${process.pid}\n`);
    assert.equal((await exec(installedMaw, ['url'], { env: { ...env, MAW_CONTROL_SCRIPT: '' }, cwd: f.root })).stdout.trim(), url);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));

// ---------------------------------------------------------------------------
// Control (unchanged contract)
// ---------------------------------------------------------------------------
test('32. browser-independent startup and maw url loopback token retrieval', () => withFixture(async f => {
  const server = createServer((req, res) => { res.statusCode = req.url?.includes('token=secure-token-123') ? 200 : 401; res.end('ok'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const expectedUrl = `http://127.0.0.1:${addr.port}/?token=secure-token-123`;
    await writeFile(path.join(f.runtimeDir, 'maw-ready.json'), JSON.stringify({ pid: process.pid, url: expectedUrl, releaseId: f.initialId }), { mode: 0o600 });
    await writeFile(path.join(f.root, 'mainpid'), `${process.pid}\n`);
    const env = { ...f.env, MAW_CONTROL_SCRIPT: '' };
    const urlOut = await exec(MAW_BIN, ['url'], { env });
    assert.equal(urlOut.stdout.trim(), expectedUrl);
  } finally { await new Promise(r => server.close(r)); }
}));

test('33. manual Brave launch invokes brave-browser explicitly without xdg-open', () => withFixture(async f => {
  const browserLog = path.join(f.root, 'browser-launch.log');
  await writeFile(path.join(f.binDir, 'brave-browser'), `#!/bin/sh\necho "brave: $@" >> "${browserLog}"\n`, { mode: 0o755 });
  await writeFile(path.join(f.binDir, 'xdg-open'), `#!/bin/sh\necho "xdg: $@" >> "${browserLog}"\n`, { mode: 0o755 });
  const server = createServer((req, res) => { res.statusCode = req.url?.includes('token=token-abc') ? 200 : 401; res.end('ok'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    const expectedUrl = `http://127.0.0.1:${addr.port}/?token=token-abc`;
    await writeFile(path.join(f.runtimeDir, 'maw-ready.json'), JSON.stringify({ pid: process.pid, url: expectedUrl }), { mode: 0o600 });
    await writeFile(path.join(f.root, 'mainpid'), `${process.pid}\n`);
    await exec(MAW_BIN, ['open', 'brave-browser'], { env: { ...f.env, MAW_CONTROL_SCRIPT: '', DEBUG_MAW_CONTROL: '1' } });
    const logs = await readFile(browserLog, 'utf8');
    assert.ok(logs.includes(`brave: ${expectedUrl}`));
    assert.ok(!logs.includes('xdg:'));
  } finally { await new Promise(r => server.close(r)); }
}));

test('34. linked Git worktree source (.git file) is supported', () => withFixture(async f => {
  const worktreeDir = path.join(f.root, 'linked-worktree');
  await git(f.sourceDir, 'worktree', 'add', '-b', 'wt-branch', worktreeDir, 'main');
  assert.ok((await stat(path.join(worktreeDir, '.git'))).isFile());
  await pushUpstream(f, 'wt');
  const res = await update(f, ['--no-restart', '--source', worktreeDir]);
  assert.match(res.stdout, /MAW update staged successfully/);
}));

test('active start requires authenticated HTTP success and adopts the first healthy release without restarting', () => withFixture(async f => {
  let status = 404;
  const server = createServer((_req, res) => { res.statusCode = status; res.end('fixture'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/?token=readiness-fixture`;
    await writeFile(path.join(f.runtimeDir, 'maw-ready.json'), JSON.stringify({ pid: process.pid, url, releaseId: f.initialId }), { mode: 0o600 });
    await writeFile(path.join(f.root, 'mainpid'), `${process.pid}\n`);
    await rm(path.join(f.stateDir, 'healthy'));
    const env = { ...f.env, MAW_CONTROL_SCRIPT: '' };
    await assert.rejects(exec(MAW_BIN, ['start'], { env }), (error: { code: number; stderr: string }) =>
      error.code === 1 && /active but authenticated readiness failed/.test(error.stderr));
    assert.equal(await pointer(f, 'healthy'), null, '404 never creates healthy');
    status = 200;
    await exec(MAW_BIN, ['start'], { env });
    assert.equal(await pointer(f, 'healthy'), f.initialId, 'live authenticated success establishes healthy');
    const wrong = { pid: process.pid, url, releaseId: '20260101000001-deadbee' };
    await writeFile(path.join(f.runtimeDir, 'maw-ready.json'), JSON.stringify(wrong), { mode: 0o600 });
    await assert.rejects(exec(MAW_BIN, ['start'], { env }), /Command failed/);
    assert.equal(await pointer(f, 'healthy'), f.initialId, 'wrong release cannot alter healthy');
    assert.ok(!existsSync(path.join(f.root, 'restarts')), 'active start never restarts the service');
    assert.ok(existsSync(f.initialDir), 'first release remains installed');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test('35. in-app lifecycle commands isolate systemd invocations to canonical user bus when private DBUS_SESSION_BUS_ADDRESS is present', () => withFixture(async f => {
  const runLog = path.join(f.root, 'systemd-run.log');
  const runEnvLog = path.join(f.root, 'systemd-run-env.log');
  await writeFile(path.join(f.binDir, 'systemd-run'), `#!/bin/sh
echo "$@" >> "${runLog}"
echo "DBUS=\${DBUS_SESSION_BUS_ADDRESS:-UNSET} XDG=\${XDG_RUNTIME_DIR:-UNSET}" >> "${runEnvLog}"
exit 0
`, { mode: 0o755 });

  const ctlEnvLog = path.join(f.root, 'systemctl-env.log');
  const origSystemctl = await readFile(path.join(f.binDir, 'systemctl'), 'utf8');
  await writeFile(path.join(f.binDir, 'systemctl'), `#!/bin/sh
echo "DBUS=\${DBUS_SESSION_BUS_ADDRESS:-UNSET} XDG=\${XDG_RUNTIME_DIR:-UNSET}" >> "${ctlEnvLog}"
exec /bin/sh -c '${origSystemctl.replace(/'/g, "'\\''")}' "$0" "$@"
`, { mode: 0o755 });

  const cgroup = path.join(f.root, 'cgroup');
  await writeFile(cgroup, '0::/user.slice/user-1000.slice/user@1000.service/app.slice/maw-fixture.service\n');

  const privateBus = 'unix:path=/tmp/private-dbus-session.sock';
  const callerEnv = {
    ...f.env,
    MAW_CGROUP_FILE: cgroup,
    DBUS_SESSION_BUS_ADDRESS: privateBus,
    MAW_SYSTEMD_RUNTIME_DIR: f.runtimeDir,
    MAW_SYSTEMD_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  };

  // Verify restart from inside MAW delegates via systemd-run with canonical bus
  const restartRes = await exec(MAW_BIN, ['restart'], { env: callerEnv });
  assert.match(restartRes.stdout, /Safe restart scheduled/);
  const runEnv = await readFile(runEnvLog, 'utf8');
  assert.match(runEnv, /DBUS=unix:path=\/run\/user\/1000\/bus/);
  assert.ok(!runEnv.includes(privateBus), 'private bus was not leaked to systemd-run');

  // Verify status executes systemctl with canonical bus
  await exec(MAW_BIN, ['status'], { env: callerEnv });
  const ctlEnv = await readFile(ctlEnvLog, 'utf8');
  assert.match(ctlEnv, /DBUS=unix:path=\/run\/user\/1000\/bus/);
  assert.ok(!ctlEnv.includes(privateBus), 'private bus was not leaked to systemctl');

  // Verify stop executes systemctl with canonical bus
  await exec(MAW_BIN, ['stop'], { env: callerEnv });
  const ctlEnv2 = await readFile(ctlEnvLog, 'utf8');
  assert.ok(!ctlEnv2.includes(privateBus), 'private bus was not leaked to systemctl on stop');

  // Verify caller's environment is untouched
  assert.equal(callerEnv.DBUS_SESSION_BUS_ADDRESS, privateBus);
}));

test('36. in-app update --restart delegates with canonical bus isolation', () => withFixture(async f => {
  const runLog = path.join(f.root, 'systemd-run.log');
  const runEnvLog = path.join(f.root, 'systemd-run-env.log');
  await writeFile(path.join(f.binDir, 'systemd-run'), `#!/bin/sh
echo "$@" >> "${runLog}"
echo "DBUS=\${DBUS_SESSION_BUS_ADDRESS:-UNSET} XDG=\${XDG_RUNTIME_DIR:-UNSET}" >> "${runEnvLog}"
exit 0
`, { mode: 0o755 });

  const cgroup = path.join(f.root, 'cgroup');
  await writeFile(cgroup, '0::/user.slice/user-1000.slice/user@1000.service/app.slice/maw-fixture.service\n');

  const privateBus = 'unix:path=/tmp/private-dbus-session-2.sock';
  const callerEnv = {
    ...f.env,
    MAW_CGROUP_FILE: cgroup,
    DBUS_SESSION_BUS_ADDRESS: privateBus,
    MAW_SYSTEMD_RUNTIME_DIR: f.runtimeDir,
    MAW_SYSTEMD_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  };

  await pushUpstream(f, 'feature-restart');
  const res = await update(f, ['--restart'], callerEnv);
  assert.match(res.stdout, /Safe restart scheduled/);
  const runEnv = await readFile(runEnvLog, 'utf8');
  assert.match(runEnv, /DBUS=unix:path=\/run\/user\/1000\/bus/);
  assert.ok(!runEnv.includes(privateBus), 'private bus was not leaked on update --restart');
}));

test('37. failure handling when systemd user manager runtime is unavailable', () => withFixture(async f => {
  const cgroup = path.join(f.root, 'cgroup');
  await writeFile(cgroup, '0::/user.slice/user-1000.slice/user@1000.service/app.slice/maw-fixture.service\n');

  await writeFile(path.join(f.binDir, 'systemd-run'), `#!/bin/sh
echo "Failed to connect to bus: No such file or directory" >&2
exit 1
`, { mode: 0o755 });

  const callerEnv = {
    ...f.env,
    MAW_CGROUP_FILE: cgroup,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus',
    MAW_SYSTEMD_RUNTIME_DIR: '/nonexistent/runtime',
    MAW_SYSTEMD_BUS_ADDRESS: 'unix:path=/nonexistent/bus',
  };

  await assert.rejects(exec(MAW_BIN, ['restart'], { env: callerEnv }), (err: { code: number; stderr: string }) =>
    err.code === 1 && /Failed to schedule safe restart/.test(err.stderr));
}));

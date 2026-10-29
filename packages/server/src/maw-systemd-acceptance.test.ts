/**
 * REAL systemd acceptance for MAW activation and rollback (opt-in: MAW_REAL_SYSTEMD=1).
 *
 * Uses the production unit template (scripts/maw/maw.service rendered by maw-render-unit.sh) as a
 * disposable runtime unit `maw-test-<random>.service` in $XDG_RUNTIME_DIR/systemd/user, with its own state
 * dir, runtime directory and loopback port. Never touches maw.service, the real state dir or any live
 * process. The unit file, its runtime directory and the temp state are removed afterwards.
 *
 * Releases are minimal but real: the unit boots them exactly like production (node --import <release tsx
 * loader> <release>/packages/server/src/index.ts), and the healthy one serves an authenticated loopback
 * URL and publishes readiness with the repository's real publishReadiness/readReleaseIdentity.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, readlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const exec = promisify(execFile);
const enabled = process.env['MAW_REAL_SYSTEMD'] === '1' && process.platform === 'linux' && !!process.env['XDG_RUNTIME_DIR'];
const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/maw');
const SERVER_SRC = path.dirname(fileURLToPath(import.meta.url));
const TSX = await realpath(path.resolve(SERVER_SRC, '../node_modules/tsx')).catch(() => null);

const HEALTHY_SERVER = `
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishReadiness, readReleaseIdentity } from ${JSON.stringify(path.join(SERVER_SRC, 'maw-host.ts'))};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const token = randomBytes(16).toString('hex');
const server = createServer((req, res) => {
  res.statusCode = new URL(req.url ?? '/', 'http://x').searchParams.get('token') === token ? 200 : 401;
  res.end();
});
server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  if (!address || typeof address === 'string') process.exit(1);
  await publishReadiness(process.env.MAW_RUNTIME_DIR!, 'http://127.0.0.1:' + address.port + '/?token=' + token, await readReleaseIdentity(root));
});
process.on('SIGTERM', () => process.exit(0));
`;
const CRASHING_SERVER = `setTimeout(() => { console.error('candidate crashed on start'); process.exit(1); }, 500);\n`;

async function makeRelease(releases: string, id: string, source: string): Promise<string> {
  const dir = path.join(releases, id);
  await mkdir(path.join(dir, 'packages/server/src'), { recursive: true });
  await mkdir(path.join(dir, 'packages/server/node_modules'), { recursive: true });
  await writeFile(path.join(dir, 'packages/server/package.json'), '{"type":"module"}\n');
  await symlink(TSX!, path.join(dir, 'packages/server/node_modules/tsx'));
  await writeFile(path.join(dir, 'packages/server/src/maw-host.ts'), 'export {};\n');
  await writeFile(path.join(dir, 'packages/server/src/index.ts'), source);
  await writeFile(path.join(dir, '.maw-release-meta.json'), JSON.stringify({ releaseId: id, commit: id.split('-')[1] }) + '\n');
  return dir;
}

test('real systemd: crash-looping candidate hits start-limit, is detected, and the verified release is restored', { skip: !enabled || !TSX }, async () => {
  const suffix = randomBytes(4).toString('hex');
  const unit = `maw-test-${suffix}.service`;
  const runtimeName = `maw-test-${suffix}`;
  const unitDir = path.join(process.env['XDG_RUNTIME_DIR']!, 'systemd/user');
  const unitFile = path.join(unitDir, unit);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'maw-systemd-')));
  const state = path.join(root, 'state');
  const releases = path.join(state, 'releases');
  await mkdir(releases, { recursive: true });
  const env = {
    ...process.env, MAW_STATE_DIR: state, MAW_UNIT: unit, MAW_RUNTIME_DIR: path.join(process.env['XDG_RUNTIME_DIR']!, runtimeName),
    MAW_NODE_BIN: process.execPath, MAW_READY_TIMEOUT: '25', MAW_CGROUP_FILE: path.join(root, 'none'),
  };
  const helper = async (): Promise<{ code: number; out: string }> => {
    try { const r = await exec(path.join(SCRIPT_DIR, 'maw-restart-helper.sh'), ['--unit', unit], { env }); return { code: 0, out: r.stdout + r.stderr }; }
    catch (e) { const x = e as { code: number; stdout: string; stderr: string }; return { code: x.code, out: x.stdout + x.stderr }; }
  };
  const ptr = async (name: string) => { try { return path.basename(await readlink(path.join(state, name))); } catch { return null; } };
  const H = await makeRelease(releases, '20261029000001-aaaaaaa', HEALTHY_SERVER);
  await symlink(H, path.join(state, 'current'));
  try {
    await mkdir(unitDir, { recursive: true });
    assert.ok(!existsSync(unitFile));
    const rendered = await exec('/bin/sh', [path.join(SCRIPT_DIR, 'maw-render-unit.sh')],
      { env: { ...env, MAW_RUNTIME_NAME: runtimeName, MAW_BIN_DIR: path.join(root, 'bin') } });
    await writeFile(unitFile, rendered.stdout);

    // First verified start: no healthy yet; success makes H healthy.
    let r = await helper();
    assert.equal(r.code, 0, r.out);
    assert.equal(await ptr('healthy'), path.basename(H));
    const status = await exec(process.execPath, [path.join(SCRIPT_DIR, 'control.mjs'), 'status'], { env: { ...env, MAW_EXPECT_RELEASE_ID: path.basename(H) } });
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
    const after = await exec(process.execPath, [path.join(SCRIPT_DIR, 'control.mjs'), 'status'], { env: { ...env, MAW_EXPECT_RELEASE_ID: path.basename(H) } });
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
    await exec('systemctl', ['--user', 'stop', unit]).catch(() => undefined);
    await exec('systemctl', ['--user', 'reset-failed', unit]).catch(() => undefined);
    if (path.basename(unitFile).startsWith('maw-test-')) await rm(unitFile, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

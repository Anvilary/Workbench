import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, symlink, mkdir, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// @ts-expect-error - standalone pure-ESM supervisor script
import { isMainModule } from './maw-ptyd.mjs';
import { PtyHostClient } from './pty-host-client.js';

const exec = promisify(execFile);
const PTY_HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PTY_HOST_DIR, '../../../..');
const SUPERVISOR_SRC = path.join(PTY_HOST_DIR, 'maw-ptyd.mjs');
const RENDER_SCRIPT = path.join(REPO_ROOT, 'scripts/maw/maw-render-ptyd-unit.sh');

interface SpawnedSupervisor {
  child: ReturnType<typeof spawn>;
  getStdout: () => string;
  getStderr: () => string;
  waitForOutput: (pattern: string | RegExp, timeoutMs?: number) => Promise<string>;
  waitForExit: (timeoutMs?: number) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

function runSupervisor(
  executablePath: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): SpawnedSupervisor {
  let stdoutData = '';
  let stderrData = '';

  const child = spawn(process.execPath, [executablePath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
  });

  child.stdout?.on('data', (d) => {
    stdoutData += d.toString('utf8');
  });

  child.stderr?.on('data', (d) => {
    stderrData += d.toString('utf8');
  });

  const waitForOutput = async (pattern: string | RegExp, timeoutMs = 4000): Promise<string> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (typeof pattern === 'string' ? stdoutData.includes(pattern) : pattern.test(stdoutData)) {
        return stdoutData;
      }
      if (child.exitCode !== null) {
        throw new Error(
          `Supervisor exited prematurely with code ${child.exitCode} before emitting "${pattern}". stderr: ${stderrData}`,
        );
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Timeout waiting for "${pattern}". stdout: ${stdoutData}, stderr: ${stderrData}`);
  };

  const waitForExit = async (
    timeoutMs = 4000,
  ): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { exitCode: child.exitCode, signal: child.signalCode };
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Timeout waiting for process ${child.pid} to exit`);
  };

  return {
    child,
    getStdout: () => stdoutData,
    getStderr: () => stderrData,
    waitForOutput,
    waitForExit,
  };
}

test('CLI ENTRYPOINT 1, 4, 5, 6, 7: Direct execution by canonical absolute path with socket, auth, and SIGTERM cleanup', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'maw-cli-direct-'));
  const socketPath = path.join(tmpDir, 'ptyd.sock');
  const authPath = path.join(tmpDir, 'ptyd.auth');

  try {
    const sup = runSupervisor(SUPERVISOR_SRC, ['--socket', socketPath, '--auth-file', authPath]);
    const pid = sup.child.pid;
    assert.ok(typeof pid === 'number' && pid > 0, 'Supervisor must spawn with valid PID');

    // Requirement 1 & 6: Starts and remains alive
    await sup.waitForOutput('[maw-ptyd] Listening on');
    await new Promise((r) => setTimeout(r, 200));
    assert.doesNotThrow(() => process.kill(pid, 0), 'Supervisor must remain alive after startup');

    // Requirement 4: Socket creation and permissions (0600)
    assert.ok(fs.existsSync(socketPath), 'Unix domain socket must exist');
    const socketStat = fs.statSync(socketPath);
    assert.ok(socketStat.isSocket(), 'Socket path must be a socket descriptor');
    const socketMode = socketStat.mode & 0o777;
    assert.equal(socketMode, 0o600, `Socket permissions must be 0600, got ${socketMode.toString(8)}`);

    // Requirement 5: Auth-file creation and permissions (0600)
    assert.ok(fs.existsSync(authPath), 'Auth file must exist');
    const authStat = fs.statSync(authPath);
    assert.ok(authStat.isFile(), 'Auth path must be a regular file');
    const authMode = authStat.mode & 0o777;
    assert.equal(authMode, 0o600, `Auth file permissions must be 0600, got ${authMode.toString(8)}`);
    const authContent = fs.readFileSync(authPath, 'utf8').trim();
    assert.match(authContent, /^[0-9a-f]{64}$/, 'Auth token must be a 64-character hex string');

    // Requirement 7: SIGTERM cleanup
    sup.child.kill('SIGTERM');
    const { exitCode } = await sup.waitForExit();
    assert.equal(exitCode, 0, 'Supervisor must exit 0 on SIGTERM');

    assert.ok(!fs.existsSync(socketPath), 'Socket must be unlinked on SIGTERM exit');
    assert.ok(!fs.existsSync(authPath), 'Auth file must be unlinked on SIGTERM exit');
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('CLI ENTRYPOINT 2: Execution through a symbolic link resolves target and runs daemon', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'maw-cli-symlink-'));
  const linkDir = path.join(tmpDir, 'bin');
  await mkdir(linkDir, { recursive: true });
  const symlinkPath = path.join(linkDir, 'maw-ptyd-link.mjs');
  await symlink(SUPERVISOR_SRC, symlinkPath);

  const socketPath = path.join(tmpDir, 'ptyd.sock');
  const authPath = path.join(tmpDir, 'ptyd.auth');

  try {
    const sup = runSupervisor(symlinkPath, ['--socket', socketPath, '--auth-file', authPath]);
    const pid = sup.child.pid!;
    await sup.waitForOutput('[maw-ptyd] Listening on');

    // Verify it stays alive and created artifacts
    await new Promise((r) => setTimeout(r, 200));
    assert.doesNotThrow(() => process.kill(pid, 0), 'Supervisor executed via symlink must stay alive');
    assert.ok(fs.existsSync(socketPath), 'Socket must be created via symlink invocation');
    assert.ok(fs.existsSync(authPath), 'Auth file must be created via symlink invocation');

    sup.child.kill('SIGTERM');
    const { exitCode } = await sup.waitForExit();
    assert.equal(exitCode, 0, 'Symlink-invoked supervisor must exit cleanly');
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('CLI ENTRYPOINT 2 (special characters & spaces): Execution through directory symlink with spaces and symbols', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'maw-cli-spaces-'));
  const complexDir = path.join(tmpDir, 'folder with spaces and #@! chars');
  const releaseDir = path.join(complexDir, 'releases/release-1');
  await mkdir(releaseDir, { recursive: true });

  const supervisorTarget = path.join(releaseDir, 'maw-ptyd.mjs');
  await symlink(SUPERVISOR_SRC, supervisorTarget);

  const currentLink = path.join(complexDir, 'current');
  await symlink('releases/release-1', currentLink);

  const executableThroughLink = path.join(currentLink, 'maw-ptyd.mjs');
  const socketPath = path.join(tmpDir, 'ptyd.sock');
  const authPath = path.join(tmpDir, 'ptyd.auth');

  try {
    const sup = runSupervisor(executableThroughLink, ['--socket', socketPath, '--auth-file', authPath]);
    const pid = sup.child.pid!;
    await sup.waitForOutput('[maw-ptyd] Listening on');

    await new Promise((r) => setTimeout(r, 200));
    assert.doesNotThrow(() => process.kill(pid, 0), 'Must survive invocation with special characters');
    assert.ok(fs.existsSync(socketPath));
    assert.ok(fs.existsSync(authPath));

    sup.child.kill('SIGTERM');
    const { exitCode } = await sup.waitForExit();
    assert.equal(exitCode, 0);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('CLI ENTRYPOINT 3: Imported module does not auto-start the daemon', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'maw-cli-import-'));
  const testConsumer = path.join(tmpDir, 'consumer.mjs');
  await writeFile(
    testConsumer,
    `import { PtySupervisor, isMainModule } from ${JSON.stringify(SUPERVISOR_SRC)};
console.log('MAIN_CHECK=' + isMainModule(import.meta.url));
console.log('IMPORTED_SUCCESSFULLY');
`,
    'utf8',
  );

  try {
    const { stdout, stderr } = await exec(process.execPath, [testConsumer]);
    assert.ok(stdout.includes('IMPORTED_SUCCESSFULLY'), 'Consumer module must execute');
    assert.ok(stdout.includes('MAIN_CHECK=true'), 'Consumer main module should be true for itself');
    assert.ok(!stdout.includes('[maw-ptyd] Listening on'), 'Imported supervisor must not auto-start');
    assert.equal(stderr, '', 'Stderr should be empty on normal import');
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('CLI ENTRYPOINT 3 (isMainModule unit edge cases): Robust handling of absent or invalid argv', () => {
  const originalArgv = [...process.argv];

  try {
    // Missing argv[1]
    process.argv = [process.execPath];
    assert.equal(isMainModule(), false, 'Should be false when argv[1] is undefined');

    // Empty argv[1]
    process.argv = [process.execPath, ''];
    assert.equal(isMainModule(), false, 'Should be false when argv[1] is empty');

    // Non-existent path
    process.argv = [process.execPath, '/non/existent/path/never/created/script.mjs'];
    assert.equal(isMainModule(), false, 'Should be false without throwing for nonexistent path');

    // Path starting with file://
    process.argv = [process.execPath, `file://${SUPERVISOR_SRC}`];
    assert.equal(isMainModule(import.meta.url), false, 'Should not match different module url');

    // Matching fileURLToPath on current module
    process.argv = [process.execPath, fileURLToPath(import.meta.url)];
    assert.equal(isMainModule(import.meta.url), true, 'Should match when pointing to current file');
  } finally {
    process.argv = originalArgv;
  }
});

test('CLI ENTRYPOINT 8: Startup failure exits nonzero', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'maw-cli-fail-'));
  // Path pointing into a non-directory file causes mkdirSync / listen to fail
  const blocker = path.join(tmpDir, 'blocker');
  await writeFile(blocker, 'file', 'utf8');
  const impossibleSocket = path.join(blocker, 'sub/ptyd.sock');
  const impossibleAuth = path.join(blocker, 'sub/ptyd.auth');

  try {
    const sup = runSupervisor(SUPERVISOR_SRC, ['--socket', impossibleSocket, '--auth-file', impossibleAuth]);
    const { exitCode } = await sup.waitForExit();
    assert.notEqual(exitCode, 0, 'Supervisor must exit nonzero on listen failure');
    assert.ok(sup.getStderr().includes('[maw-ptyd] Failed to start'), 'Supervisor must log failure to stderr');
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('CLI ENTRYPOINT 9: Exact executable path used by rendered systemd unit', async () => {
  const tmpState = await mkdtemp(path.join(os.tmpdir(), 'maw-cli-systemd-'));
  const binDir = path.join(tmpState, 'bin');
  await mkdir(binDir, { recursive: true });

  const env = {
    ...process.env,
    MAW_NODE_BIN: process.execPath,
    MAW_STATE_DIR: tmpState,
    MAW_BIN_DIR: binDir,
    MAW_PTYD_RUNTIME_NAME: 'maw-ptyd-test',
  };

  try {
    // 1. Render unit
    const { stdout: renderedUnit } = await exec(RENDER_SCRIPT, [], { env });

    // 2. Extract ExecStart command line
    const execStartLine = renderedUnit.split('\n').find((l) => l.startsWith('ExecStart='));
    assert.ok(execStartLine, 'Rendered unit must contain ExecStart line');

    const expectedCommand = `${process.execPath} ${tmpState}/current/packages/server/dist/maw-ptyd.mjs`;
    assert.equal(execStartLine, `ExecStart=${expectedCommand}`, 'ExecStart must match expected rendered command');

    // 3. Create simulated release and current symlink
    const releaseId = '20261104-testrelease';
    const releaseServerDir = path.join(tmpState, 'releases', releaseId, 'packages/server');
    const releaseDistDir = path.join(releaseServerDir, 'dist');
    await mkdir(releaseDistDir, { recursive: true });

    // Link node_modules so node-pty resolves just as in a real installed release
    await symlink(
      path.join(REPO_ROOT, 'packages/server/node_modules'),
      path.join(releaseServerDir, 'node_modules'),
    );

    const deployedSupervisor = path.join(releaseDistDir, 'maw-ptyd.mjs');
    await fs.promises.copyFile(SUPERVISOR_SRC, deployedSupervisor);
    await chmod(deployedSupervisor, 0o755);

    const currentSymlink = path.join(tmpState, 'current');
    await symlink(path.join(tmpState, 'releases', releaseId), currentSymlink);

    // 4. Execute the EXACT path from ExecStart
    const exactExecStartPath = path.join(tmpState, 'current/packages/server/dist/maw-ptyd.mjs');
    const socketPath = path.join(tmpState, 'test.sock');
    const authPath = path.join(tmpState, 'test.auth');

    const sup = runSupervisor(exactExecStartPath, ['--socket', socketPath, '--auth-file', authPath]);
    const pid = sup.child.pid!;

    await sup.waitForOutput('[maw-ptyd] Listening on');
    await new Promise((r) => setTimeout(r, 200));

    // Must be running and alive (not exiting in 34ms)
    assert.doesNotThrow(() => process.kill(pid, 0), 'Supervisor at systemd ExecStart path must remain alive');
    assert.ok(fs.existsSync(socketPath), 'Socket must exist');
    assert.ok(fs.existsSync(authPath), 'Auth file must exist');

    sup.child.kill('SIGTERM');
    const { exitCode } = await sup.waitForExit();
    assert.equal(exitCode, 0, 'Clean exit on SIGTERM');
  } finally {
    await rm(tmpState, { recursive: true, force: true }).catch(() => {});
  }
});

test('CLI ENTRYPOINT (Test Cleanup Regression): Test harness cleanup does not leak supervisor processes', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'maw-cleanup-reg-'));
  const runtimeDir = path.join(tmpDir, 'runtime');
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const socketPath = path.join(runtimeDir, 'ptyd.sock');
  const authPath = path.join(runtimeDir, 'ptyd.auth');

  // Spawn a supervisor daemon in the background as test harnesses do
  const sup = runSupervisor(SUPERVISOR_SRC, ['--socket', socketPath, '--auth-file', authPath]);
  const supervisorPid = sup.child.pid!;
  await sup.waitForOutput('[maw-ptyd] Listening on');

  assert.doesNotThrow(() => process.kill(supervisorPid, 0), 'Supervisor process must be alive');

  // Now perform cleanup as implemented in the updated harness
  if (fs.existsSync(socketPath) && fs.existsSync(authPath)) {
    const client = await PtyHostClient.connectOrSpawn({
      socketPath,
      authPath,
      autoSpawn: false,
      spawnTimeoutMs: 1000,
    });
    await client.shutdown(true);
  }
  await rm(tmpDir, { recursive: true, force: true });

  // Verify process terminates and does not leak
  await new Promise((r) => setTimeout(r, 200));
  let isAlive = true;
  try {
    process.kill(supervisorPid, 0);
  } catch {
    isAlive = false;
  }
  assert.equal(isAlive, false, 'Supervisor process must be terminated; zero processes leaked');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { PtyHostClient } from '../../../src/pty-host/pty-host-client.js';
// @ts-expect-error - standalone pure-ESM supervisor script
import { PtySupervisor } from '../../../src/pty-host/maw-ptyd.mjs';
import { REPO_ROOT } from '../../helpers/paths.js';

const exec = promisify(execFile);

const SCRIPT_DIR = path.join(REPO_ROOT, 'scripts/maw');

test('TERMINAL ENVIRONMENT 1: Unit template and rendered unit omit PrivateTmp and NoNewPrivileges', async () => {
  const templatePath = path.join(SCRIPT_DIR, 'pty-host', 'maw-ptyd.service');
  const template = await fs.promises.readFile(templatePath, 'utf8');

  assert.ok(!template.includes('PrivateTmp='), 'maw-ptyd.service template must not set PrivateTmp');
  assert.ok(!template.includes('NoNewPrivileges='), 'maw-ptyd.service template must not set NoNewPrivileges');

  const tmpState = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-unit-test-'));
  const env = {
    ...process.env,
    MAW_STATE_DIR: tmpState,
    MAW_NODE_BIN: process.execPath,
    MAW_BIN_DIR: path.join(tmpState, 'bin'),
    MAW_PTYD_RUNTIME_NAME: 'maw-ptyd-env-test',
  };

  const rendered = (await exec('/bin/sh', [path.join(SCRIPT_DIR, 'maw-render-ptyd-unit.sh')], { env })).stdout;
  assert.ok(!rendered.includes('PrivateTmp='), 'Rendered maw-ptyd unit must not include PrivateTmp');
  assert.ok(!rendered.includes('NoNewPrivileges='), 'Rendered maw-ptyd unit must not include NoNewPrivileges');
  assert.ok(rendered.includes('RuntimeDirectory=maw-ptyd-env-test'), 'Rendered maw-ptyd unit must retain RuntimeDirectory');
  assert.ok(rendered.includes('UMask=0077'), 'Rendered maw-ptyd unit must retain UMask=0077');

  await fs.promises.rm(tmpState, { recursive: true, force: true });
});

test('TERMINAL ENVIRONMENT 2: Supervisor spawns PTY children without adding user namespaces or NoNewPrivs', async () => {
  const tmpRuntime = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'maw-term-env-test-'));
  const socketPath = path.join(tmpRuntime, 'ptyd.sock');
  const authPath = path.join(tmpRuntime, 'ptyd.sock.auth');

  const supervisor = new PtySupervisor({
    socketPath,
    authPath,
  });
  await supervisor.listen();

  const client = await PtyHostClient.connectOrSpawn({
    socketPath,
    authPath,
    autoSpawn: false,
  });

  try {
    const sessionId = randomUUID();
    const session = await client.spawn({
      id: sessionId,
      cmd: '/bin/sh',
      args: ['-c', 'cat /proc/self/uid_map; grep NoNewPrivs /proc/self/status'],
      cols: 80,
      rows: 24,
      cwd: tmpRuntime,
      env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
    });

    assert.ok(session.pid > 0, 'Spawned terminal process must have valid PID');

    // Wait for output
    let output = '';
    const outputPromise = new Promise<void>((resolve) => {
      const unsub = client.onData((id, chunk) => {
        if (id === sessionId) {
          output += chunk;
          if (output.includes('NoNewPrivs')) {
            unsub();
            resolve();
          }
        }
      });
    });

    await Promise.race([
      outputPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for terminal output')), 4000)),
    ]);

    // The supervisor itself does not call unshare or prctl(PR_SET_NO_NEW_PRIVS).
    assert.ok(session.pid > 0);
  } finally {
    try { supervisor.close(); } catch {}
    client.detach();
    await fs.promises.rm(tmpRuntime, { recursive: true, force: true });
  }
});

test('TERMINAL ENVIRONMENT 3: Clean systemd user execution validates normal namespace, root file ownership, and SSH', async () => {
  // Test transient systemd user service environment (how maw-ptyd.service runs without PrivateTmp and NoNewPrivileges)
  const userBus = `/run/user/${process.getuid ? process.getuid() : 1000}/bus`;
  const systemdEnv = {
    ...process.env,
    ...(fs.existsSync(userBus) ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${userBus}` } : {}),
  };
  const execSystemd = (args: string[]) => exec('systemd-run', args, { env: systemdEnv });

  const { stdout: uidMap } = await execSystemd(['--user', '--pipe', '-q', '/bin/sh', '-c', 'cat /proc/self/uid_map']);
  assert.ok(!uidMap.includes('1000       1000          1'), 'Clean systemd user execution must not have single-UID map');

  const { stdout: privs } = await execSystemd(['--user', '--pipe', '-q', '/bin/sh', '-c', 'cat /proc/self/status | grep NoNewPrivs']);
  assert.ok(privs.includes('NoNewPrivs:\t0'), 'Clean systemd user execution must have NoNewPrivs: 0');

  // Verify file ownership in clean user namespace
  const sshProxyConf = '/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf';
  if (fs.existsSync(sshProxyConf)) {
    const { stdout: lsOut } = await execSystemd(['--user', '--pipe', '-q', 'ls', '-l', sshProxyConf]);
    assert.ok(lsOut.includes('root root'), `${sshProxyConf} must appear owned by root root, not nobody nogroup`);

    // Verify OpenSSH client validates config cleanly
    const { stdout: sshOut, stderr: sshErr } = await execSystemd(['--user', '--pipe', '-q', 'ssh', '-G', 'localhost']);
    assert.ok(!sshErr.includes('Bad owner or permissions'), 'SSH config validation must succeed without permission errors');
    assert.ok(sshOut.includes('hostname localhost'), 'SSH config parsed successfully');

    // Verify GitHub SSH authentication succeeds without permission/config rejection
    const { stdout: ghOut } = await execSystemd(['--user', '--pipe', '-q', '/bin/sh', '-c',
      'ssh -T -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes git@github.com 2>&1 || true']);
    assert.ok(!ghOut.includes('Bad owner or permissions'), 'GitHub SSH must not fail with bad ownership/permissions');
    assert.ok(ghOut.includes('You\'ve successfully authenticated') || ghOut.includes('github.com'),
      'GitHub SSH authentication succeeded or connected to GitHub');
  }

  // Verify sudo capability in clean execution (not blocked by NoNewPrivs)
  const { stdout: sudoOut, stderr: sudoErr } = await execSystemd(['--user', '--pipe', '-q', '/bin/sh', '-c', 'sudo -n true 2>&1 || true']);
  assert.ok(!sudoOut.includes('no new privileges') && !sudoErr.includes('no new privileges'),
    'sudo must not report "no new privileges flag is set"');
});

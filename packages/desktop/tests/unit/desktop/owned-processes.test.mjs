import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pidsWithHome, reapProcessesWithHome } from '../../helpers/owned-processes.mjs';

const linux = process.platform === 'linux';

// A daemon-like tree: a detached (setsid) parent that starts another detached
// child, then exits, so the survivor is reparented away from the test process.
const daemonScript = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
child.unref();
console.log(child.pid);
setTimeout(() => process.exit(0), 50);
`;

function waitFor(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() > end) return reject(new Error('timed out'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('reapProcessesWithHome kills detached descendants owned by the fixture HOME only', { skip: !linux, timeout: 20000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'wb-owned-processes-'));
  const home = path.join(root, 'home');
  const otherHome = path.join(root, 'other-home');
  const control = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, HOME: otherHome }, stdio: 'ignore' });
  t.after(() => {
    try { control.kill('SIGKILL'); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  const launcher = spawn(process.execPath, ['-e', daemonScript], { env: { ...process.env, HOME: home }, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  launcher.stdout.on('data', (chunk) => { out += chunk; });
  const daemonPid = Number(await waitFor(() => out.trim()));
  await waitFor(() => launcher.exitCode !== null);
  assert.deepEqual(pidsWithHome(home), [daemonPid], 'the escaped daemon is found by its HOME');

  // The daemon ignores SIGTERM, so this also covers escalation to SIGKILL.
  const reaped = await reapProcessesWithHome(home, { graceMs: 200, timeoutMs: 5000 });
  assert.ok(reaped.includes(daemonPid));
  assert.deepEqual(pidsWithHome(home), [], 'no process with the fixture HOME remains');
  assert.equal(control.exitCode, null, 'a process with a different HOME is untouched');
  assert.ok(pidsWithHome(otherHome).includes(control.pid));
});

test('pidsWithHome refuses to match the real HOME or a relative path', { skip: !linux }, () => {
  assert.throws(() => pidsWithHome(process.env.HOME || '/'), /non-fixture HOME/);
  assert.throws(() => pidsWithHome('relative/home'), /non-fixture HOME/);
  assert.throws(() => pidsWithHome('/'), /non-fixture HOME/);
});

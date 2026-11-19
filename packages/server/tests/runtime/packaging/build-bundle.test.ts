import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT, SERVER_ROOT } from '../../helpers/paths.js';

const serverRoot = SERVER_ROOT;
const bundlePath = path.join(serverRoot, 'dist/index.mjs');
const webIndexPath = path.join(REPO_ROOT, 'packages/web/dist/index.html');

test('Prebuilt production server bundle: exists and starts cleanly under raw node', async () => {
  if (!existsSync(bundlePath)) {
    execSync('node scripts/build-bundle.mjs', { cwd: serverRoot, stdio: 'inherit' });
  }
  if (!existsSync(webIndexPath)) {
    execSync('pnpm --filter @agent-workbench/web build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  assert.ok(existsSync(bundlePath), 'dist/index.mjs should exist');
  assert.ok(existsSync(webIndexPath), 'packages/web/dist/index.html should exist');

  const tempHome = await mkdtemp(path.join(tmpdir(), 'maw-bundle-test-'));

  try {
    const env = {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      XDG_DATA_HOME: path.join(tempHome, '.local/share'),
      XDG_RUNTIME_DIR: path.join(tempHome, 'runtime'),
      AGENT_WORKBENCH_NO_OPEN: '1',
      AGENT_WORKBENCH_NO_RESTORE: '1',
      MAW_EAGER_CLASSIC: '0',
    };
    delete (env as Record<string, string | undefined>).MAW_UNSAFE_LOCAL_NO_AUTH;
    delete (env as Record<string, string | undefined>).MAW_RUNTIME_DIR;

    const child = spawn(process.execPath, [bundlePath, '--prod'], {
      cwd: serverRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const started = await new Promise<{ port: number; token: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Timeout waiting for server startup. Output:\n${output}`));
      }, 15000);

      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/(?:\?token=([^\s]+))?/);
        if (match && match[1]) {
          clearTimeout(timer);
          resolve({ port: Number(match[1]), token: match[2] || '' });
        }
      };

      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited prematurely with code ${code}. Output:\n${output}`));
      });
    });

    assert.ok(started.port > 0, 'Should have bound to a valid loopback port');
    assert.ok(started.token.length > 0, 'Should have generated a token');

    const response = await fetch(`http://127.0.0.1:${started.port}/?token=${started.token}`);
    assert.equal(response.status, 200);

    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
  } finally {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  }
});

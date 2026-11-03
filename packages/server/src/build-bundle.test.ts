import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const bundlePath = path.join(serverRoot, 'dist/index.mjs');

test('Prebuilt production server bundle: exists and starts cleanly under raw node', async () => {
  assert.ok(existsSync(bundlePath), 'dist/index.mjs should exist');

  const tempHome = await mkdtemp(path.join(tmpdir(), 'maw-bundle-test-'));

  try {
    const env = {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      XDG_DATA_HOME: path.join(tempHome, '.local/share'),
      AGENT_WORKBENCH_NO_OPEN: '1',
      AGENT_WORKBENCH_NO_RESTORE: '1',
      MAW_EAGER_CLASSIC: '0',
    };

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
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s]+)/);
        if (match && match[1] && match[2]) {
          clearTimeout(timer);
          resolve({ port: Number(match[1]), token: match[2] });
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

    // Verify HTTP connectivity
    const response = await fetch(`http://127.0.0.1:${started.port}/?token=${started.token}`);
    assert.equal(response.status, 200);

    // Shutdown gracefully
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
  } finally {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  }
});

// Real Electron OS clipboard verification and IPC bridge validation suite.
// Run: node --test packages/desktop/terminal-clipboard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import { validCommand } from '../../../policy.mjs';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(import.meta.url);
const here = DESKTOP_ROOT;
const electronExecutable = process.env.WORKBENCH_ELECTRON_EXECUTABLE ||
  (existsSync('/opt/workbench-electron/45.2.0/electron') ? '/opt/workbench-electron/45.2.0/electron' : require('electron'));

test('policy: write-clipboard-text and read-clipboard-text commands fail closed on invalid payloads', () => {
  // Valid write
  assert.equal(validCommand({ type: 'write-clipboard-text', text: 'sample output' }), true);
  assert.equal(validCommand({ type: 'write-clipboard-text', text: '' }), true);
  assert.equal(validCommand({ type: 'write-clipboard-text', text: 'Unicode test: 🚀 世界 ñ' }), true);

  // Invalid write: non-string, extra fields, missing fields, or oversized
  assert.equal(validCommand({ type: 'write-clipboard-text', text: 12345 }), false);
  assert.equal(validCommand({ type: 'write-clipboard-text', text: null }), false);
  assert.equal(validCommand({ type: 'write-clipboard-text', text: 'text', extra: 'bad' }), false);
  assert.equal(validCommand({ type: 'write-clipboard-text' }), false);
  assert.equal(validCommand({ type: 'write-clipboard-text', text: 'a'.repeat(26_000_000) }), false);

  // Valid read
  assert.equal(validCommand({ type: 'read-clipboard-text' }), true);

  // Invalid read: unexpected fields
  assert.equal(validCommand({ type: 'read-clipboard-text', extra: 'not-allowed' }), false);
  assert.equal(validCommand({ type: 'read-clipboard-text', text: 'forbidden' }), false);
});

test('electron: real OS clipboard write, IPC bridge roundtrip, and independent xclip verification', { timeout: 60000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'maw-clip-test-'));
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body><div id="root">clipboard-fixture</div></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  let desktop;
  t.after(async () => {
    try {
      await desktop?.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  desktop = await electron.launch({
    chromiumSandbox: true,
    executablePath: electronExecutable,
    args: [here, '--ozone-platform=x11'],
    env: {
      ...process.env,
      HOME: dataDir,
      WORKBENCH_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`,
      WORKBENCH_DESKTOP_DATA_DIR: dataDir,
    },
  });

  const page = await desktop.firstWindow();
  await page.waitForSelector('#root', { timeout: 10000 });

  // 1. Write text via the trusted desktop IPC bridge
  const testString = 'MAW Terminal Selection Test · 🚀 2026-11-05\nWrapped logical line test';
  const writeRes = await page.evaluate(
    (text) => window.workbench.command({ type: 'write-clipboard-text', text }),
    testString,
  );
  assert.equal(writeRes?.ok, true, 'IPC write-clipboard-text must succeed');

  // 2. Read back via both IPC bridge and Electron main clipboard API
  const ipcReadBack = await page.evaluate(
    () => window.workbench.command({ type: 'read-clipboard-text' }),
  );
  assert.equal(ipcReadBack?.ok, true, 'IPC read-clipboard-text must succeed');
  assert.equal(ipcReadBack?.text, testString, 'IPC read-back text matches written text exactly');

  const readBack = await desktop.evaluate(async ({ clipboard }) => {
    return await clipboard.readText();
  });
  assert.equal(readBack, testString, 'Main-process read-back text matches written text exactly');

  // 3. Independent read using external OS tool (xclip) if available
  try {
    const xclipOut = execFileSync('xclip', ['-o', '-selection', 'clipboard'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(xclipOut, testString, 'xclip independently verifies clipboard content on X11');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // 4. Overwrite with empty string
  const clearRes = await page.evaluate(
    () => window.workbench.command({ type: 'write-clipboard-text', text: '' }),
  );
  assert.equal(clearRes?.ok, true, 'IPC clear clipboard must succeed');
  const emptyRead = await desktop.evaluate(async ({ clipboard }) => {
    return await clipboard.readText();
  });
  assert.equal(emptyRead, '', 'Empty string cleanly clears or empties the clipboard');
});

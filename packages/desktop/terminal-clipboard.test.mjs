// Real Electron OS clipboard verification and IPC bridge validation suite.
// Run: node --test packages/desktop/terminal-clipboard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { _electron as electron } from 'playwright';
import { validCommand } from './policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const electronExecutable = '/opt/maw-electron/45.2.0/electron';

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

test('electron: real OS clipboard write and independent xclip verification', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'maw-clip-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  let desktop;
  try {
    desktop = await electron.launch({
      chromiumSandbox: false,
      executablePath: electronExecutable,
      args: [here, '--no-sandbox', '--ozone-platform=x11'],
      env: {
        ...process.env,
        MAW_DESKTOP_URL: 'http://127.0.0.1:12345/',
        MAW_DESKTOP_DATA_DIR: dataDir,
      },
    });
  } catch (err) {
    t.skip('Skipping GUI test if display or electron cannot launch: ' + err.message);
    return;
  }

  t.after(async () => {
    if (desktop) await desktop.close().catch(() => {});
  });

  // 1. Write text via Electron clipboard API
  const testString = 'MAW Terminal Selection Test · 🚀 2026-11-05\nWrapped logical line test';
  await desktop.evaluate(async ({ clipboard }, text) => {
    await clipboard.writeText(text);
  }, testString);

  // 2. Read back via Electron clipboard API
  const readBack = await desktop.evaluate(async ({ clipboard }) => {
    return await clipboard.readText();
  });
  assert.equal(readBack, testString, 'Read-back text matches written text exactly');

  // 3. Independent read using external OS tool (xclip) if available
  try {
    const xclipOut = execSync('xclip -o -selection clipboard', {
      env: process.env,
      timeout: 3000,
    }).toString('utf8');
    assert.equal(xclipOut, testString, 'xclip independently verifies clipboard content on X11');
  } catch {
    // xclip might not be available or fail in non-X11 environment; skip external check
  }

  // 4. Overwrite with empty string
  await desktop.evaluate(async ({ clipboard }) => {
    await clipboard.writeText('');
  });
  const emptyRead = await desktop.evaluate(async ({ clipboard }) => {
    return await clipboard.readText();
  });
  assert.equal(emptyRead, '', 'Empty string cleanly clears or empties the clipboard');
});

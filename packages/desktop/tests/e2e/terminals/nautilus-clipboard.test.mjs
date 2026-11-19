import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(import.meta.url);
const here = DESKTOP_ROOT;
const electronExecutable = fs.existsSync('/opt/maw-electron/45.2.0/electron')
  ? '/opt/maw-electron/45.2.0/electron'
  : require('electron');

const hasRequiredDesktopTools = (() => {
  try {
    execSync('which nautilus && which xdotool && which xwininfo && which xclip', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('authoritative workspace copy-file rejects unauthorized paths and pastes into real Nautilus', { timeout: 60000 }, async (t) => {
  if (process.env.MAW_NAUTILUS_TEST_ISOLATED !== '1') {
    t.skip('Requires an explicitly isolated Xvfb display and D-Bus session');
    return;
  }
  if (!hasRequiredDesktopTools) {
    t.skip('Nautilus, xdotool, xwininfo or xclip not available');
    return;
  }

  // Create authoritative workspace, destination for paste, and unauthorized folder
  const baseDir = await mkdtemp(path.join(tmpdir(), 'maw-nautilus-test-'));
  const workspaceDir = path.join(baseDir, 'workspace');
  const destDir = path.join(baseDir, 'nautilus-dest');
  const unauthorizedDir = path.join(baseDir, 'unauthorized');
  const dataDir = path.join(baseDir, 'desktop-data');

  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(destDir, { recursive: true });
  await mkdir(unauthorizedDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const sampleFileName = 'authoritative-file.txt';
  const fileContent = 'pasted successfully by nautilus into target folder\n';
  await writeFile(path.join(workspaceDir, sampleFileName), fileContent);
  await writeFile(path.join(unauthorizedDir, 'secret.txt'), 'secret outside workspace');

  // Minimal HTTP server serving a test page with mawChatGpt command interface
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body><div id="root">MAW Test</div></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  let desktop;
  let nautilusProc;

  try {
    // Launch Electron desktop process with MAW_WORKSPACE_ROOT configured to authoritative workspace
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [here, '--ozone-platform=x11'],
      env: {
        ...process.env,
        MAW_WORKSPACE_ROOT: workspaceDir,
        MAW_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`,
        MAW_DESKTOP_DATA_DIR: dataDir,
      },
    });

    const page = await desktop.firstWindow();

    // 1. Verify unauthorized cwd is denied
    const deniedRes = await page.evaluate(
      async ({ unauth, rel }) => {
        return await window.mawChatGpt.command({
          type: 'copy-file',
          cwd: unauth,
          relative: rel,
        });
      },
      { unauth: unauthorizedDir, rel: 'secret.txt' },
    );
    assert.equal(deniedRes?.ok, false, 'Copying from unauthorized root must fail');
    assert.equal(deniedRes?.error, 'denied', 'Error code must be denied');

    // 2. Verify path traversal escaping authoritative root is denied
    const traversalRes = await page.evaluate(
      async ({ ws, rel }) => {
        return await window.mawChatGpt.command({
          type: 'copy-file',
          cwd: ws,
          relative: rel,
        });
      },
      { ws: workspaceDir, rel: '../unauthorized/secret.txt' },
    );
    assert.equal(traversalRes?.ok, false, 'Path traversal must be rejected');

    // Launch Nautilus before handing it the clipboard.
    nautilusProc = spawn('nautilus', ['--new-window', destDir], {
      env: {
        ...process.env,
        GDK_BACKEND: 'x11',
        GSK_RENDERER: 'cairo',
        LIBGL_ALWAYS_SOFTWARE: '1',
      },
      stdio: 'pipe',
    });

    // Wait for Nautilus visible window to appear
    let wid = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        const out = execSync(
          'xdotool search --class org.gnome.Nautilus || xdotool search --class nautilus',
          { env: process.env },
        )
          .toString('utf8')
          .trim();
        const wids = out.split(/\s+/).filter(Boolean);
        for (const candidate of wids) {
          try {
            const info = execSync(`xwininfo -id ${candidate}`, { env: process.env }).toString('utf8');
            if (info.includes('Map State: IsViewable')) {
              wid = candidate;
              break;
            }
          } catch {
            // Window not available yet
          }
        }
        if (wid) break;
      } catch {
        // xdotool returns non-zero when no window matches yet
      }
    }
    assert.ok(wid, 'Expected visible Nautilus window to be found');

    const copyRes = await page.evaluate(
      ({ ws, rel }) => window.mawChatGpt.command({ type: 'copy-file', cwd: ws, relative: rel }),
      { ws: workspaceDir, rel: sampleFileName },
    );
    assert.equal(copyRes?.ok, true, 'Copy-file on authoritative file must succeed');
    const offered = execFileSync('xclip', ['-o', '-selection', 'clipboard', '-t', 'x-special/gnome-copied-files'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(offered, `copy\n${pathToFileURL(path.join(workspaceDir, sampleFileName)).href}`);

    execFileSync('xdotool', ['windowfocus', '--sync', wid], { timeout: 3000 });
    assert.equal(execFileSync('xdotool', ['getwindowfocus'], { encoding: 'utf8' }).trim(), wid);
    // XTEST delivers the accelerator to the focused Nautilus window.
    execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], { timeout: 3000 });

    // Poll for destination file to be created by Nautilus
    const pastedFilePath = path.join(destDir, sampleFileName);
    let pastedContent = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        pastedContent = await readFile(pastedFilePath, 'utf8');
        if (pastedContent === fileContent) {
          break;
        }
      } catch {
        // File not pasted yet
      }
    }

    assert.equal(
      pastedContent,
      fileContent,
      'Real file must be pasted into Nautilus with intact content',
    );
  } finally {
    if (nautilusProc && !nautilusProc.killed) {
      nautilusProc.kill('SIGTERM');
    }
    if (desktop) {
      await desktop.close().catch(() => undefined);
    }
    await new Promise((resolve) => server.close(resolve));
    await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

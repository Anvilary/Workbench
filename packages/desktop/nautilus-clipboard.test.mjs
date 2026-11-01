import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);

const hasNautilusAndXdotool = (() => {
  try {
    execSync('which nautilus && which xdotool', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('authoritative workspace copy-file rejects unauthorized paths and pastes into real Nautilus', { timeout: 60000 }, async (t) => {
  if (!hasNautilusAndXdotool) {
    t.skip('Nautilus or xdotool not available');
    return;
  }

  try {
    execSync('pkill -x nautilus', { stdio: 'ignore' });
  } catch {}

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
      executablePath: require('electron'),
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

    // 3. Verify copy-file from authoritative workspace root succeeds
    const copyRes = await page.evaluate(
      async ({ ws, rel }) => {
        return await window.mawChatGpt.command({
          type: 'copy-file',
          cwd: ws,
          relative: rel,
        });
      },
      { ws: workspaceDir, rel: sampleFileName },
    );
    assert.equal(copyRes?.ok, true, 'Copy-file on authoritative file must succeed');

    // 4. Launch real Nautilus file manager in destDir using GDK_BACKEND=x11
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
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        const out = execSync(
          'xdotool search --onlyvisible --class org.gnome.Nautilus',
          { env: process.env },
        )
          .toString('utf8')
          .trim();
        const wids = out.split(/\s+/).filter(Boolean);
        if (wids.length > 0) {
          wid = wids[wids.length - 1];
          break;
        }
      } catch {
        // xdotool returns non-zero when no window matches yet
      }
    }
    assert.ok(wid, 'Expected visible Nautilus window to be found');

    // Focus visible Nautilus window and simulate Ctrl+V paste
    for (let i = 0; i < 20; i++) {
      try {
        execSync(`xdotool windowfocus --sync ${wid}`, { env: process.env, stdio: 'ignore' });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    execSync(`xdotool key --window ${wid} ctrl+v`, { env: process.env });

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

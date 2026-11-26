import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { serveFixture, frames, pane, order } from '../../../../web/tests/fixtures/pane-interactions-harness.mjs';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(import.meta.url);
const here = DESKTOP_ROOT;
const evidenceDir = path.resolve(process.env.MAW_PANE_HEADER_EVIDENCE_DIR || path.join(tmpdir(), 'maw-pane-header-evidence'));
const electronExecutable = fs.existsSync('/opt/maw-electron/45.2.0/electron')
  ? '/opt/maw-electron/45.2.0/electron'
  : require('electron');

async function eventually(check, message = 'condition') {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail('Timed out waiting for ' + message);
}

test('capture Electron visual evidence for pane header controls', { timeout: 90000 }, async (t) => {
  await mkdir(evidenceDir, { recursive: true });
  const url = await serveFixture(t);
  const data = await mkdtemp(path.join(tmpdir(), 'maw-pane-evidence-'));
  const env = {
    ...process.env,
    MAW_DESKTOP_URL: url + '/?mode=mixed&shape=row',
    MAW_DESKTOP_DATA_DIR: data,
    MAW_DOWNLOAD_AUTO_SAVE: '1',
  };

  let desktop;
  const closeDesktop = async () => {
    if (!desktop) return;
    const target = desktop;
    desktop = undefined;
    const child = target.process();
    let timer;
    try {
      await Promise.race([
        target.close().catch(() => {}),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
            resolve();
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  t.after(async () => {
    await closeDesktop();
    await rm(data, { recursive: true, force: true });
  });

  desktop = await electron.launch({
    chromiumSandbox: true,
    executablePath: electronExecutable,
    args: [here, '--ozone-platform=x11'],
    env,
  });

  await desktop.evaluate(({ session, app, BrowserWindow }, dataDir) => {
    BrowserWindow.getAllWindows()[0].setPosition(0, 0);
    app.setPath('downloads', dataDir);
    const chat = session.fromPartition('persist:maw-chatgpt');
    chat.protocol.handle('https', () => {
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic ChatGPT</title><style>body{margin:0;background:#202123;color:#ececf1;font:15px system-ui}header{padding:18px;border-bottom:1px solid #444;background:#202123}main{padding:24px}textarea{display:block;width:90%;height:60px;margin:10px 0;background:#303136;color:white;border:1px solid #666;padding:10px}a{color:#81c2b5}p{line-height:1.8}</style></head><body><header>◎ ChatGPT · native browser pane</header><main><label>Prompt<textarea>Universal internal navigation active</textarea></label><p>Native WebContentsView renders immediately without grey page</p><div style="height:600px;background:linear-gradient(#202123,#101114)"></div></main></body></html>`,
        { headers: { 'Content-Type': 'text/html' } },
      );
    });
  }, data);

  const page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  await page.locator('#start').click();
  await page.waitForSelector('.maw-split-pane');
  await frames(page, 16);

  // Initialize a visible terminal session in pane 1
  await page.evaluate(async () => {
    const term = window.terminals[0];
    if (term) {
      await new Promise((resolve) =>
        term.write('Anvilary Workbench Terminal\r\nPane header controls active.\r\n$ ', resolve),
      );
    }
  });

  // Verify native WebContentsView is attached
  const attached = () =>
    desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children
        .filter((v) => v.webContents)
        .map((v) => v.webContents.id),
    );
  await eventually(async () => (await attached()).length === 1, 'native browser view attached');

  const captureWindow = async (filename) => {
    const pngBase64 = await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const image = await win.capturePage();
      return image.toPNG().toString('base64');
    });
    await writeFile(path.join(evidenceDir, filename), Buffer.from(pngBase64, 'base64'));
  };

  // 1. Capture normal split workspace
  await frames(page, 10);
  await captureWindow('01-normal-split-workspace.png');
  assert.equal(await page.locator('.maw-split-pane').count(), 2);

  // 2. Expand pane 2 (browser pane)
  const pane2ExpandBtn = pane(page, 2).locator('.maw-pane-expand-button');
  await pane2ExpandBtn.click();
  await frames(page, 16);

  // Verify native view remains attached and sized
  assert.equal(await page.locator('.maw-split-pane').count(), 1);
  await eventually(async () => (await attached()).length === 1, 'native browser view attached during expand');
  await captureWindow('02-expanded-pane.png');

  // 3. Restore split workspace via collapse button
  const pane2CollapseBtn = pane(page, 2).locator('.maw-pane-expand-button');
  assert.equal(await pane2CollapseBtn.getAttribute('aria-pressed'), 'true');
  await pane2CollapseBtn.click();
  await frames(page, 16);

  assert.equal(await page.locator('.maw-split-pane').count(), 2);
  await eventually(async () => (await attached()).length === 1, 'native browser view attached after restore');
  await captureWindow('03-restored-split-workspace.png');

  // 4. Open Settings menu on pane 1
  const pane1Settings = pane(page, 1).locator('.maw-pane-menu-toggle');
  await pane1Settings.click();
  await frames(page, 10);
  await page.getByRole('menu').waitFor();

  // Verify removed items are not present
  const menu = page.getByRole('menu');
  assert.equal(await menu.getByRole('menuitem', { name: 'Maximize pane', exact: true }).count(), 0);
  assert.equal(await menu.getByRole('menuitem', { name: 'Restore pane', exact: true }).count(), 0);
  assert.equal(await menu.getByRole('menuitem', { name: 'Close pane', exact: true }).count(), 0);
  assert.equal(await menu.getByRole('menuitem', { name: 'Split vertically', exact: true }).count(), 1);
  assert.equal(await menu.getByRole('menuitem', { name: 'Split horizontally', exact: true }).count(), 1);

  await captureWindow('04-simplified-settings-menu.png');
  await page.keyboard.press('Escape');
  await frames(page);
});

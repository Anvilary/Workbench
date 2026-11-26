import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { serveFixture, frames, pane, root } from '../../../../web/tests/fixtures/pane-interactions-harness.mjs';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(import.meta.url);
const here = DESKTOP_ROOT;
const electronExecutable = fs.existsSync('/opt/workbench-electron/45.2.0/electron')
  ? '/opt/workbench-electron/45.2.0/electron'
  : require('electron');

async function eventually(check, message = 'condition') {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail('Timed out waiting for ' + message);
}

test('Electron runtime: clicking a cross-site web link in ChatGPT opens a new browser tab in the SAME pane', async (t) => {
  const url = await serveFixture(t);
  const data = await mkdtemp(path.join(tmpdir(), 'maw-link-nav-'));
  const env = {
    ...process.env,
    WORKBENCH_DESKTOP_URL: url + '/?mode=web&shape=single',
    WORKBENCH_DESKTOP_DATA_DIR: data,
  };

  let desktop;
  t.after(async () => {
    if (desktop) await desktop.close();
    await rm(data, { recursive: true, force: true });
  });

  desktop = await electron.launch({
    chromiumSandbox: true,
    executablePath: electronExecutable,
    args: [here, '--ozone-platform=x11'],
    env,
  });

  // Intercept https requests in ChatGPT partition to serve our synthetic page with hyperlinks
  await desktop.evaluate(({ session }) => {
    const chat = session.fromPartition('persist:workbench-chatgpt');
    chat.protocol.handle('https', req => {
      const u = new URL(req.url);
      if (u.hostname === 'chatgpt.com') {
        return new Response(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Synthetic ChatGPT</title></head>
<body>
  <h1>ChatGPT</h1>
  <p>Here is a helpful repo:</p>
  <a id="ext-blank" href="https://github.com/openai/openai-python" target="_blank">GitHub Blank</a>
  <a id="ext-self" href="https://github.com/openai/openai-python">GitHub Self</a>
  <a id="ext-docs" href="https://docs.python.org/3/">Python Docs</a>
  <a id="local-link" href="http://localhost:3000/">Local Link</a>
</body>
</html>`, { headers: { 'Content-Type': 'text/html' } });
      }
      return new Response('Not found', { status: 404 });
    });
  });

  const page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);

  // Start the UI fixture
  await page.locator('#start').click();
  await page.waitForSelector('.wb-split-pane');
  await frames(page);

  // Wait for ChatGPT view to load and attach
  await eventually(async () => {
    return desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win?.contentView?.children?.filter(v => v.webContents).length === 1;
    });
  }, 'ChatGPT view to attach');

  // Verify initial pane has 1 tab
  const tabs = pane(page, 1).locator('[role=tab]');
  assert.equal(await tabs.count(), 1, 'Initially 1 tab in pane 1');

  // Find the ChatGPT webContents
  const chatWebContentsId = await desktop.evaluate(({ session, webContents }) => {
    const chatSession = session.fromPartition('persist:workbench-chatgpt');
    const all = webContents.getAllWebContents();
    const chat = all.find(c => c.session === chatSession);
    return chat?.id;
  });
  assert.ok(chatWebContentsId, 'ChatGPT WebContents exists');

  // Click the link inside ChatGPT using webContents.executeJavaScript to click #ext-blank
  await desktop.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    contents.executeJavaScript('document.getElementById("ext-blank").click()');
  }, chatWebContentsId);

  // The application should receive open-web-tab and call agency.webTab.create
  await page.waitForFunction(() =>
    window.fixture.requests.some(r => r.type === 'agency.webTab.create')
  );

  const req = await page.evaluate(() =>
    window.fixture.requests.find(r => r.type === 'agency.webTab.create')
  );

  assert.equal(req.url, 'https://github.com/openai/openai-python');
  assert.equal(req.provider, 'github');
  assert.equal(req.targetPaneId, 'pane-1');

  // Wait for the new tab to be added to pane 1
  await page.waitForFunction(() =>
    window.fixture.state.layout.tree.tabIds.length === 2
  );

  // Verify pane 1 now has 2 tabs
  assert.equal(await tabs.count(), 2, 'Pane 1 now holds both ChatGPT and GitHub tabs');

  // Verify ChatGPT webContents is still alive (not closed or lost)
  const isAlive = await desktop.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id);
    return c && !c.isDestroyed();
  }, chatWebContentsId);
  assert.ok(isAlive, 'Original ChatGPT tab is preserved and not destroyed');

  // Verify clicking the original tab switches back to it
  await tabs.first().click();
  await frames(page);
  const layoutState = await page.evaluate(() => window.fixture.state.layout);
  assert.equal(layoutState.tree.selectedTabId, layoutState.tree.tabIds[0], 'Switched back to ChatGPT tab');
});

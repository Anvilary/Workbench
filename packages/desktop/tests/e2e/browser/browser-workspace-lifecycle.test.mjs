import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(import.meta.url);
const here = DESKTOP_ROOT;
const electronExecutable = process.env.WORKBENCH_ELECTRON_EXECUTABLE || (fs.existsSync('/opt/workbench-electron/45.2.0/electron')
  ? '/opt/workbench-electron/45.2.0/electron'
  : require('electron'));

const browserCss = fs.readFileSync(path.join(here, '../web/src/app/workbench.css'), 'utf8');
const tabId = '99999999-9999-4999-8999-999999999999';

const fixture = `import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeBrowserView } from './src/features/browser/NativeBrowserView.tsx';
import { EmptyPaneChooser } from './src/features/panes/EmptyPaneChooser.tsx';

function App() {
  const [activeWs, setActiveWs] = useState('A');
  const [displayed, setDisplayed] = useState(false);
  const [terminalLaunched, setTerminalLaunched] = useState(false);

  return (
    <div className="agency-app">
      <nav style={{ height: '40px', background: '#25252b', display: 'flex', gap: '8px', padding: '6px 12px', alignItems: 'center' }}>
        <button id="nav-ws-a" type="button" onClick={() => setActiveWs('A')} style={{ background: activeWs === 'A' ? '#d97442' : '#333', color: '#fff', border: 0, padding: '4px 10px', borderRadius: '4px' }}>
          Workspace A
        </button>
        <button id="nav-ws-b" type="button" onClick={() => setActiveWs('B')} style={{ background: activeWs === 'B' ? '#d97442' : '#333', color: '#fff', border: 0, padding: '4px 10px', borderRadius: '4px' }}>
          Workspace B
        </button>
        <span id="displayed-indicator">{displayed ? 'displayed' : 'hidden'}</span>
        {terminalLaunched && <span id="terminal-indicator">terminal-running</span>}
      </nav>

      <div
        id="ws-slot-a"
        className="agency-workspace-slot"
        style={{ display: activeWs === 'A' ? 'contents' : 'none' }}
        hidden={activeWs !== 'A'}
      >
        <div className="wb-browser-pane" style={{ width: '800px', height: '600px' }}>
          <NativeBrowserView
            tab={{ id: '${tabId}', url: 'https://chatgpt.com/' }}
            toolbarOpen={true}
            activeWorkspace={activeWs === 'A'}
            onDisplayed={(_id, ready) => setDisplayed(ready)}
          />
        </div>
      </div>

      <div
        id="ws-slot-b"
        className="agency-workspace-slot"
        style={{ display: activeWs === 'B' ? 'contents' : 'none' }}
        hidden={activeWs !== 'B'}
      >
        <div style={{ width: '800px', height: '600px', display: 'flex' }}>
          <EmptyPaneChooser
            paneId="pane-b-1"
            online={true}
            busy={false}
            canClose={false}
            onAddTerminal={() => setTerminalLaunched(true)}
            onAddBrowser={() => {}}
            onOpenFile={() => {}}
            onClosePane={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

test('browser workspace lifecycle, immediate restoration, loading logo, and empty workspace initialization', { timeout: 60000 }, async () => {
  const bundle = await build({
    stdin: { contents: fixture, resolveDir: path.join(here, '../web'), loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent',
  });

  const server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(bundle.outputFiles[0].text);
    } else {
      response.end(`<!doctype html><html><head><style>${browserCss}body{margin:0;background:#1e1e1e;color:#fff;font-family:sans-serif;}.agency-workspace-slot{display:contents;}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`);
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const data = await mkdtemp(path.join(tmpdir(), 'maw-ws-lifecycle-'));
  let desktop;

  try {
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [here, '--ozone-platform=x11'],
      env: {
        ...process.env,
        WORKBENCH_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`,
        WORKBENCH_DESKTOP_DATA_DIR: data,
      },
    });

    // Provide synthetic page with solid red background, form input, and scrollable content
    await desktop.evaluate(({ session }) => {
      session.fromPartition('persist:workbench-chatgpt').protocol.handle('https', () =>
        new Response(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Target Fixture</title>
  <style>
    body { margin: 0; background-color: rgb(255, 0, 0); height: 2000px; padding: 20px; font-family: sans-serif; color: white; }
    input { font-size: 16px; padding: 6px 10px; }
  </style>
</head>
<body>
  <h1>RED FIXTURE PAGE</h1>
  <input id="user-input" value="initial value" />
  <div style="height: 1200px;"></div>
  <p id="bottom-marker">Bottom of page</p>
</body>
</html>`, {
          headers: { 'Content-Type': 'text/html' },
        })
      );
    });

    const page = await desktop.firstWindow();
    await page.waitForSelector('#nav-ws-a');

    const attached = () => desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.webContents).length
    );

    // 1. Initial Attachment and Render in Workspace A
    for (let i = 0; i < 50; i++) {
      if ((await attached()) === 1) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(await attached(), 1, 'View attached in Workspace A');

    await page.waitForFunction(() => document.getElementById('displayed-indicator')?.textContent === 'displayed');

    // 2. Set form value and scroll position in Workspace A
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win.contentView.children.find(v => v.webContents);
      await view.webContents.executeJavaScript(`
        document.getElementById('user-input').value = 'critical-user-draft';
        window.scrollTo(0, 450);
      `);
    });

    // 3. Switch to Workspace B
    await page.locator('#nav-ws-b').click();

    for (let i = 0; i < 50; i++) {
      if ((await attached()) === 0) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(await attached(), 0, 'View detached in Workspace B');

    // 4. Verify Workspace B starts with EmptyPaneChooser
    await page.waitForSelector('.wb-empty-pane-chooser');
    const newTerminalBtn = page.locator('.wb-empty-pane-action[aria-label="New Terminal"]');
    assert.ok(await newTerminalBtn.isVisible(), 'New Terminal button is visible in EmptyPaneChooser');

    const webPageBtn = page.locator('.wb-empty-pane-action[aria-label="Web Page"]');
    assert.ok(await webPageBtn.isVisible(), 'Web Page button is visible in EmptyPaneChooser');

    const openFileBtn = page.locator('.wb-empty-pane-action-disabled');
    assert.ok(await openFileBtn.isVisible(), 'Open File button is disabled');
    const openFileDisabledAttr = await openFileBtn.getAttribute('disabled');
    assert.notEqual(openFileDisabledAttr, null, 'Open File has disabled attribute');
    const badgeText = await page.locator('.wb-empty-pane-badge').textContent();
    assert.equal(badgeText?.trim(), 'Coming soon', 'Shows Coming soon badge');

    // Confirm NO Coding Agent option exists in EmptyPaneChooser
    const agentOptionCount = await page.locator('.wb-empty-pane-chooser button:has-text("Agent"), .wb-empty-pane-chooser button:has-text("Codex")').count();
    assert.equal(agentOptionCount, 0, 'No Coding Agent option in starting panel');

    // Test clicking New Terminal in EmptyPaneChooser
    await newTerminalBtn.click();
    await page.waitForFunction(() => !!document.getElementById('terminal-indicator'));

    // 5. Switch back to Workspace A: immediate restoration
    await page.locator('#nav-ws-a').click();

    for (let i = 0; i < 50; i++) {
      if ((await attached()) === 1) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(await attached(), 1, 'View immediately reattached upon return to Workspace A');

    // Check displayed indicator
    await page.waitForFunction(() => document.getElementById('displayed-indicator')?.textContent === 'displayed');

    // Verify loading logo did NOT appear on return to already-loaded workspace (zero flicker)
    const loadingLogoCount = await page.locator('.wb-browser-loading-container').count();
    assert.equal(loadingLogoCount, 0, 'Loading logo does not flicker on return to loaded workspace');

    // Capture bitmap and verify red content is actively painted
    const capture = await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win.contentView.children.find(v => v.webContents);
      if (!view) return { error: 'No attached view' };
      const img = await view.webContents.capturePage();
      const bmp = img.toBitmap();
      let redCount = 0;
      let greyCount = 0;
      for (let i = 0; i < bmp.length; i += 4) {
        const b = bmp[i], g = bmp[i+1], r = bmp[i+2];
        if (r > 200 && g < 50 && b < 50) redCount++;
        if (Math.abs(r - 33) < 5 && Math.abs(g - 33) < 5 && Math.abs(b - 33) < 5) greyCount++;
      }
      return {
        redCount,
        greyCount,
        total: bmp.length / 4,
      };
    });

    assert.ok(capture.redCount > 10000, `Red content rendered without tab switch or reload (redCount: ${capture.redCount})`);
    assert.equal(capture.greyCount, 0, `No grey blank view overlay remaining (greyCount: ${capture.greyCount})`);

    // Verify form input value preserved
    const formValue = await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win.contentView.children.find(v => v.webContents);
      return view.webContents.executeJavaScript(`document.getElementById('user-input').value`);
    });
    assert.equal(formValue, 'critical-user-draft', 'User form input is preserved across workspace switch');

    // Verify scroll position preserved
    const scrollY = await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win.contentView.children.find(v => v.webContents);
      return view.webContents.executeJavaScript(`window.scrollY`);
    });
    assert.equal(scrollY, 450, 'Scroll position is preserved across workspace switch');

  } finally {
    if (desktop) await desktop.close();
    await new Promise(r => server.close(r));
    await rm(data, { recursive: true, force: true });
  }
});

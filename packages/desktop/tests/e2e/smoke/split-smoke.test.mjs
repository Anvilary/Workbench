import { test } from 'node:test';
import assert from 'node:assert/strict';
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
const electronExecutable = fs.existsSync('/opt/workbench-electron/45.2.0/electron')
  ? '/opt/workbench-electron/45.2.0/electron'
  : require('electron');

const testIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

const fixture = `
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [paneCount, setPaneCount] = useState(2);
  const [overlay, setOverlay] = useState(false);

  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge) return;

    for (let i = 0; i < paneCount; i++) {
      bridge.command({ type: 'open', id: '${testIds[0]}'.replace(/1/g, String(i + 1)), url: 'https://chatgpt.com/' });
    }

    const updateLayout = () => {
      const views = [];
      const v = { width: window.innerWidth, height: window.innerHeight };
      if (paneCount === 2) {
        // 2 panes side-by-side
        const w = Math.floor(v.width / 2);
        if (!overlay) {
          views.push({ id: '${testIds[0]}', bounds: { x: 0, y: 0, width: w, height: v.height } });
        }
        views.push({ id: '${testIds[1]}', bounds: { x: w, y: 0, width: w, height: v.height } });
      } else if (paneCount === 4) {
        // 4 panes 2x2 grid
        const w = Math.floor(v.width / 2);
        const h = Math.floor(v.height / 2);
        views.push({ id: '${testIds[0]}', bounds: { x: 0, y: 0, width: w, height: h } });
        views.push({ id: '${testIds[1]}', bounds: { x: w, y: 0, width: w, height: h } });
        views.push({ id: '${testIds[2]}', bounds: { x: 0, y: h, width: w, height: h } });
        views.push({ id: '${testIds[3]}', bounds: { x: w, y: h, width: w, height: h } });
      }
      bridge.command({ type: 'layout', views, viewport: v });
    };

    updateLayout();
  }, [paneCount, overlay]);

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex' }}>
      <button id="btn-2panes" onClick={() => setPaneCount(2)}>2 Panes</button>
      <button id="btn-4panes" onClick={() => setPaneCount(4)}>4 Panes</button>
      <button id="btn-overlay" onClick={() => setOverlay(!overlay)}>Toggle Overlay</button>
      {overlay && <div id="overlay-menu" role="menu" style={{ position: 'absolute', top: 50, left: 50, width: 200, height: 200, background: 'black', color: 'white' }}>Menu</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

async function eventually(check, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for assertion');
}

test('multi-ChatGPT views: 2 and 4 simultaneous attached views with atomic reconciliation', { timeout: 60000 }, async () => {
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
      response.end('<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const data = await mkdtemp(path.join(tmpdir(), 'wb-split-smoke-'));

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

    await desktop.evaluate(({ session }) => {
      session.fromPartition('persist:workbench-chatgpt').protocol.handle('https', () =>
        new Response('<!doctype html><title>ChatGPT Page</title><div>ChatGPT Page</div>', {
          headers: { 'Content-Type': 'text/html' },
        })
      );
    });

    const attached = () => desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.webContents).length
    );

    const page = await desktop.firstWindow();

    // 1. Initial 2 panes: 2 simultaneous WebContentsViews attached!
    await eventually(async () => (await attached()) === 2);
    assert.equal(await attached(), 2, 'Two native ChatGPT views must be simultaneously attached');

    // 2. Switch to 4 panes: 4 simultaneous WebContentsViews attached!
    await page.click('#btn-4panes');
    await eventually(async () => (await attached()) === 4);
    assert.equal(await attached(), 4, 'Four native ChatGPT views must be simultaneously attached in 2x2 grid');

    // 3. Switch back to 2 panes: safely detaches 2 views, keeping exactly 2 attached
    await page.click('#btn-2panes');
    await eventually(async () => (await attached()) === 2);
    assert.equal(await attached(), 2, 'Reducing panes safely detaches unused native views');

    // 4. In-memory capture test. capturePage can reject until the view has painted.
    let captureResult;
    await eventually(async () => {
      captureResult = await page.evaluate((id) => window.workbench.command({ type: 'capture', id }), testIds[0]);
      return !!(captureResult && captureResult.ok && typeof captureResult.dataUrl === 'string' && captureResult.dataUrl.startsWith('data:image/'));
    });
    assert.equal(captureResult.ok, true, 'Capture command succeeds in-memory');
    assert.equal(captureResult.dataUrl.startsWith('data:image/'), true, 'Returns valid data URL for in-memory backdrop');

    // 5. Overlay on Pane 1 detaches only Pane 1's view; Pane 2 remains attached!
    await page.click('#btn-overlay');
    await eventually(async () => (await attached()) === 1);
    assert.equal(await attached(), 1, 'Overlapping overlay detaches only the intersecting pane, keeping other pane attached');

    // 6. Dismissing overlay re-attaches Pane 1!
    await page.click('#btn-overlay');
    await eventually(async () => (await attached()) === 2);
    assert.equal(await attached(), 2, 'Dismissing overlay immediately re-attaches native view');
  } finally {
    if (desktop) await desktop.close();
    server.close();
    await rm(data, { recursive: true, force: true });
  }
});

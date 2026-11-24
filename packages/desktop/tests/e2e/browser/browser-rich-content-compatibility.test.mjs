import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(import.meta.url);
const here = DESKTOP_ROOT;
const electronExecutable = fs.existsSync('/opt/maw-electron/45.2.0/electron')
  ? '/opt/maw-electron/45.2.0/electron'
  : require('electron');

async function eventually(check, message = 'condition', timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for ' + message);
}

/**
 * Verifies Chromium Web API availability and synthetic local fixture rendering
 * (Canvas 2D, SVG, WebGL 1, WebGL 2, WebAssembly, Web Workers, IndexedDB,
 * LocalStorage) inside an isolated native WebContentsView.
 *
 * Scope boundary: this validates runtime capability availability in the native
 * browser container; it does not claim or verify interactive parity for live
 * authenticated ChatGPT responses.
 */
test('verify Chromium web API availability and synthetic fixture rendering in native WebContentsView', { timeout: 60000 }, async (t) => {
  const tabId = '33333333-3333-4333-8333-333333333333';

  const richHtml = `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>Rich Web Content Compatibility Test</title>
    <style>
      body { margin: 0; background: #121214; color: #eee; font-family: sans-serif; padding: 20px; }
      .chart-card { background: #1f1f23; border: 1px solid #333; border-radius: 8px; padding: 16px; margin-bottom: 16px; width: 400px; }
      .legend { display: flex; gap: 12px; margin-top: 8px; font-size: 13px; }
      .legend-item { display: flex; align-items: center; gap: 4px; }
      .legend-color { width: 12px; height: 12px; border-radius: 2px; }
    </style>
  </head>
  <body>
    <h1>Rich Content Diagnostics</h1>
    <div class="chart-card" id="doughnut-card">
      <h3>Distribution Analysis</h3>
      <svg id="doughnut-svg" width="200" height="200" viewBox="0 0 42 42">
        <circle class="donut-ring" cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="#2a2b30" stroke-width="5"></circle>
        <circle id="donut-segment-1" cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="#ff7a00" stroke-width="5" stroke-dasharray="40 60" stroke-dashoffset="25"></circle>
        <text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="#fff" font-size="6" id="doughnut-total">100%</text>
      </svg>
    </div>
    <canvas id="canvas-2d" width="120" height="120"></canvas>
    <canvas id="canvas-webgl" width="120" height="120"></canvas>
    <canvas id="canvas-webgl2" width="120" height="120"></canvas>
  </body>
  </html>`;

  const shellServer = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><head><title>Workbench Test Shell</title></head><body><script>window.events=[];if(window.mawChatGpt)window.mawChatGpt.subscribe(s=>window.events.push(s));</script></body></html>');
  });

  await new Promise((resolve) => shellServer.listen(0, '127.0.0.1', resolve));
  const serverPort = shellServer.address().port;
  t.after(() => new Promise((resolve) => { shellServer.closeAllConnections?.(); shellServer.close(resolve); }));

  const dataDir = await mkdtemp(path.join(tmpdir(), 'maw-rich-content-'));
  const env = {
    ...process.env,
    HOME: dataDir,
    MAW_DESKTOP_URL: `http://127.0.0.1:${serverPort}/`,
    MAW_DESKTOP_DATA_DIR: dataDir,
  };

  let desktop;
  const closeDesktop = async () => {
    if (!desktop) return;
    const child = desktop.process();
    let timer;
    try {
      await Promise.race([
        desktop.close().catch(() => {}),
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
    await rm(dataDir, { recursive: true, force: true });
  });

  desktop = await electron.launch({
    chromiumSandbox: true,
    executablePath: electronExecutable,
    args: [here, '--ozone-platform=x11'],
    env,
  });

  const page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.mawChatGpt !== 'undefined');

  await desktop.evaluate(({ session }, html) => {
    const sess = session.fromPartition('persist:maw-browser');
    sess.protocol.handle('https', (req) => {
      const u = new URL(req.url);
      if (u.pathname === '/worker.js') {
        return new Response('self.onmessage = (e) => self.postMessage({ echo: e.data });', {
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
      if (u.pathname === '/rich') {
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response('Not found', { status: 404 });
    });
  }, richHtml);

  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.evaluate(({ id, vp }) => {
    void window.mawChatGpt.command({ type: 'open', id, provider: 'other', url: 'https://rich-content.maw-test.org/rich' });
    void window.mawChatGpt.command({
      type: 'layout',
      views: [{ id, bounds: { x: 0, y: 40, width: vp.width, height: vp.height - 40 } }],
      viewport: vp,
    });
  }, { id: tabId, vp: viewport });

  await eventually(async () => {
    return await desktop.evaluate(({ session, webContents }) => {
      const sess = session.fromPartition('persist:maw-browser');
      const view = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/rich'));
      return Boolean(view && !view.isDestroyed() && !view.isLoading());
    });
  }, 'native WebContentsView to load /rich');

  const diag = await desktop.evaluate(async ({ session, webContents }) => {
    const sess = session.fromPartition('persist:maw-browser');
    const tabWeb = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/rich'));
    return await tabWeb.executeJavaScript(`(async () => {
      const c2d = document.getElementById('canvas-2d');
      const ctx2d = c2d.getContext('2d');
      ctx2d.fillStyle = '#ff7a00';
      ctx2d.fillRect(10, 10, 50, 50);
      const pixel2d = ctx2d.getImageData(20, 20, 1, 1).data;
      const canvas2dOk = pixel2d[0] === 255 && pixel2d[1] === 122 && pixel2d[2] === 0;

      const cgl = document.getElementById('canvas-webgl');
      const gl = cgl.getContext('webgl');
      let webglOk = false;
      if (gl) {
        gl.clearColor(0.2, 0.4, 0.8, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const pixelGl = new Uint8Array(4);
        gl.readPixels(10, 10, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixelGl);
        webglOk = pixelGl[0] > 40 && pixelGl[1] > 90 && pixelGl[2] > 190;
      }

      const cgl2 = document.getElementById('canvas-webgl2');
      const gl2 = cgl2.getContext('webgl2');
      const webgl2Ok = !!gl2;

      const svgDoughnut = document.getElementById('doughnut-svg');
      const seg1 = document.getElementById('donut-segment-1');
      const svgOk = !!svgDoughnut && !!seg1 && seg1.getBBox().width > 0;

      const wasmOk = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';

      let workerOk = false;
      try {
        const worker = new Worker('/worker.js');
        workerOk = await new Promise((resolve) => {
          worker.onmessage = (e) => resolve(e.data?.echo === 'test-msg');
          setTimeout(() => resolve(false), 2000);
          worker.postMessage('test-msg');
        });
        worker.terminate();
      } catch {}

      let idbOk = false;
      try {
        const req = indexedDB.open('rich-content-test-db', 1);
        idbOk = await new Promise((resolve) => {
          req.onupgradeneeded = (e) => { e.target.result.createObjectStore('data'); };
          req.onsuccess = () => {
            req.result.close();
            indexedDB.deleteDatabase('rich-content-test-db');
            resolve(true);
          };
          req.onerror = () => resolve(false);
        });
      } catch {}

      localStorage.setItem('diag_test', 'val');
      const storageOk = localStorage.getItem('diag_test') === 'val';
      localStorage.removeItem('diag_test');

      return { canvas2dOk, webglOk, webgl2Ok, svgOk, wasmOk, workerOk, idbOk, storageOk, userAgent: navigator.userAgent };
    })()`);
  });

  assert.equal(diag.canvas2dOk, true, 'Canvas 2D rendering must succeed in native WebContentsView');
  assert.equal(diag.webglOk, true, 'WebGL 1 rendering must succeed in native WebContentsView');
  assert.equal(diag.webgl2Ok, true, 'WebGL 2 context creation must succeed in native WebContentsView');
  assert.equal(diag.svgOk, true, 'Interactive SVG chart rendering must succeed in native WebContentsView');
  assert.equal(diag.wasmOk, true, 'WebAssembly must be available in native WebContentsView');
  assert.equal(diag.workerOk, true, 'Web Workers must operate in native WebContentsView');
  assert.equal(diag.idbOk, true, 'IndexedDB must operate in native WebContentsView');
  assert.equal(diag.storageOk, true, 'LocalStorage must operate in native WebContentsView');
  assert.ok(diag.userAgent.includes('Chrome/'), 'User-Agent must identify as Chromium');
});

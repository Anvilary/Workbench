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

async function eventually(check, message = 'condition') {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail('Timed out waiting for ' + message);
}

test('verify rich interactive web content capabilities in native WebContentsView', { timeout: 60000 }, async (t) => {
  // Create HTTP test server serving rich interactive content fixtures
  const server = createServer((req, res) => {
    if (req.url === '/worker.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end('self.onmessage = (e) => self.postMessage({ echo: e.data });');
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
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
        .bar-container { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
        .bar-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
        .bar { height: 16px; border-radius: 3px; transition: width 0.3s; }
      </style>
    </head>
    <body>
      <h1>Rich Content Diagnostics</h1>

      <!-- Interactive SVG Doughnut Chart -->
      <div class="chart-card" id="doughnut-card">
        <h3>Distribution Analysis</h3>
        <svg id="doughnut-svg" width="200" height="200" viewBox="0 0 42 42">
          <circle class="donut-ring" cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="#2a2b30" stroke-width="5"></circle>
          <circle id="donut-segment-1" cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="#ff7a00" stroke-width="5" stroke-dasharray="40 60" stroke-dashoffset="25"></circle>
          <circle id="donut-segment-2" cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="#3b82f6" stroke-width="5" stroke-dasharray="35 65" stroke-dashoffset="85"></circle>
          <circle id="donut-segment-3" cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="#10b981" stroke-width="5" stroke-dasharray="25 75" stroke-dashoffset="50"></circle>
          <text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="#fff" font-size="6" id="doughnut-total">100%</text>
        </svg>
        <div class="legend">
          <div class="legend-item"><div class="legend-color" style="background:#ff7a00"></div>Alpha (40%)</div>
          <div class="legend-item"><div class="legend-color" style="background:#3b82f6"></div>Beta (35%)</div>
          <div class="legend-item"><div class="legend-color" style="background:#10b981"></div>Gamma (25%)</div>
        </div>
      </div>

      <!-- Horizontal Bar Chart -->
      <div class="chart-card" id="bar-card">
        <h3>Performance Metrics</h3>
        <div class="bar-container">
          <div class="bar-row"><span>Throughput</span><div class="bar" style="width: 220px; background: #ff7a00;"></div><span>88%</span></div>
          <div class="bar-row"><span>Reliability</span><div class="bar" style="width: 245px; background: #3b82f6;"></div><span>98%</span></div>
          <div class="bar-row"><span>Latency</span><div class="bar" style="width: 175px; background: #10b981;"></div><span>70%</span></div>
        </div>
      </div>

      <!-- Canvas and WebGL Viewports -->
      <canvas id="canvas-2d" width="120" height="120"></canvas>
      <canvas id="canvas-webgl" width="120" height="120"></canvas>
      <canvas id="canvas-webgl2" width="120" height="120"></canvas>
    </body>
    </html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));

  const dataDir = await mkdtemp(path.join(tmpdir(), 'maw-rich-content-'));
  const env = {
    ...process.env,
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

  // Verify rich content capabilities in the running Electron window
  const diag = await page.evaluate(async (port) => {
    // 1. Canvas 2D
    const c2d = document.getElementById('canvas-2d');
    const ctx2d = c2d.getContext('2d');
    ctx2d.fillStyle = '#ff7a00';
    ctx2d.fillRect(10, 10, 50, 50);
    const pixel2d = ctx2d.getImageData(20, 20, 1, 1).data;
    const canvas2dOk = pixel2d[0] === 255 && pixel2d[1] === 122 && pixel2d[2] === 0;

    // 2. WebGL 1
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

    // 3. WebGL 2
    const cgl2 = document.getElementById('canvas-webgl2');
    const gl2 = cgl2.getContext('webgl2');
    const webgl2Ok = !!gl2;

    // 4. SVG Elements and Bounding Box
    const svgDoughnut = document.getElementById('doughnut-svg');
    const seg1 = document.getElementById('donut-segment-1');
    const svgOk = !!svgDoughnut && !!seg1 && seg1.getBBox().width > 0;

    // 5. WebAssembly
    const wasmOk = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';

    // 6. Web Worker
    let workerOk = false;
    try {
      const worker = new Worker('/worker.js');
      const echoPromise = new Promise((resolve) => {
        worker.onmessage = (e) => resolve(e.data?.echo === 'test-msg');
        setTimeout(() => resolve(false), 2000);
      });
      worker.postMessage('test-msg');
      workerOk = await echoPromise;
      worker.terminate();
    } catch {}

    // 7. IndexedDB
    let idbOk = false;
    try {
      const req = indexedDB.open('rich-content-test-db', 1);
      idbOk = await new Promise((resolve) => {
        req.onupgradeneeded = (e) => {
          e.target.result.createObjectStore('data');
        };
        req.onsuccess = () => {
          req.result.close();
          indexedDB.deleteDatabase('rich-content-test-db');
          resolve(true);
        };
        req.onerror = () => resolve(false);
      });
    } catch {}

    // 8. Storage
    localStorage.setItem('diag_test', 'val');
    const storageOk = localStorage.getItem('diag_test') === 'val';
    localStorage.removeItem('diag_test');

    return {
      canvas2dOk,
      webglOk,
      webgl2Ok,
      svgOk,
      wasmOk,
      workerOk,
      idbOk,
      storageOk,
      userAgent: navigator.userAgent,
    };
  }, serverPort);

  assert.equal(diag.canvas2dOk, true, 'Canvas 2D rendering must succeed');
  assert.equal(diag.webglOk, true, 'WebGL 1 rendering must succeed');
  assert.equal(diag.webgl2Ok, true, 'WebGL 2 context creation must succeed');
  assert.equal(diag.svgOk, true, 'Interactive SVG chart rendering must succeed');
  assert.equal(diag.wasmOk, true, 'WebAssembly must be available');
  assert.equal(diag.workerOk, true, 'Web Workers must operate');
  assert.equal(diag.idbOk, true, 'IndexedDB must operate');
  assert.equal(diag.storageOk, true, 'LocalStorage must operate');
  assert.ok(diag.userAgent.includes('Chrome/'), 'User-Agent must identify as Chromium');
});

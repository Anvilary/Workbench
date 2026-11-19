import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { runtimeFor } from '../../../scripts/maw/desktop-runtime.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '../..');
const { directory: installedRuntimeDir } = await runtimeFor(repoRoot);
const installedElectron = path.join(installedRuntimeDir, 'electron');
const electronExecutable = process.env.MAW_ELECTRON_EXECUTABLE
  || (existsSync(installedElectron) ? installedElectron : require('electron'));

const VALID_SUITES = new Set([
  'all',
  'lifecycle',
  'tab-switch',
  'pane-resize',
  'overlay-capture',
  'browser-profiles',
  'concurrent-stream',
  'resource-matrix',
]);

function stats(samples) {
  if (samples.length === 0) return { mean: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const p = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct))];
  return {
    mean: Number(mean.toFixed(3)),
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
    p50: Number(p(0.5).toFixed(3)),
    p95: Number(p(0.95).toFixed(3)),
    p99: Number(p(0.99).toFixed(3)),
    count: sorted.length,
  };
}

function readProcessSmaps(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const get = (name) => {
      const m = raw.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm'));
      return m ? Number(m[1]) / 1024 : 0;
    };
    return {
      rssMiB: Number(get('Rss').toFixed(1)),
      pssMiB: Number(get('Pss').toFixed(1)),
      privateMiB: Number((get('Private_Clean') + get('Private_Dirty')).toFixed(1)),
      sharedMiB: Number((get('Shared_Clean') + get('Shared_Dirty')).toFixed(1)),
    };
  } catch {
    return { rssMiB: 0, pssMiB: 0, privateMiB: 0, sharedMiB: 0 };
  }
}

async function runBenchmarkSuite(targetSuite = 'all') {
  if (!VALID_SUITES.has(targetSuite)) {
    throw new Error(`Unknown benchmark suite '${targetSuite}'. Expected one of: ${[...VALID_SUITES].join(', ')}`);
  }
  console.log(`\n======================================================`);
  console.log(` MAW Embedded Webview Automated Benchmark Suite`);
  console.log(` Target Suite: ${targetSuite}`);
  console.log(` Electron: ${electronExecutable}`);
  console.log(`======================================================\n`);

  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body><div id="root"><h1>Bench Fixture</h1></div></body></html>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'maw-bench-'));

  let desktop;
  const results = {
    timestamp: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
    benchmarks: {},
  };

  try {
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (/^(MAW_|AGENT_WORKBENCH_|ELECTRON_RUN_AS_NODE$)/.test(key)) delete cleanEnv[key];
    }
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [desktopDir, '--ozone-platform=x11'],
      env: {
        ...cleanEnv,
        MAW_DESKTOP_URL: `http://127.0.0.1:${serverPort}/`,
        MAW_DESKTOP_DATA_DIR: dataDir,
        MAW_MAX_RESIDENT_VIEWS: '10',
      },
    });

    const win = await desktop.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 1. BENCHMARK: Lifecycle Primitives
    if (targetSuite === 'all' || targetSuite === 'lifecycle') {
      console.log('Running Benchmark: Native View Lifecycle Primitives (N=20, 2 warmup)...');
      const lifecycleData = await desktop.evaluate(async ({ WebContentsView, BrowserWindow }) => {
        const mainWin = BrowserWindow.getAllWindows()[0];
        const measurements = {
          create: [],
          attach: [],
          setBounds: [],
          detach: [],
          close: [],
        };

        for (let i = -2; i < 20; i++) {
          const t0 = performance.now();
          const view = new WebContentsView();
          const t1 = performance.now();

          const t2 = performance.now();
          mainWin.contentView.addChildView(view);
          const t3 = performance.now();

          const t4 = performance.now();
          view.setBounds({ x: 50, y: 50, width: 800, height: 600 });
          const t5 = performance.now();

          const t6 = performance.now();
          mainWin.contentView.removeChildView(view);
          const t7 = performance.now();

          const destroyed = new Promise((resolve) => view.webContents.once('destroyed', resolve));
          const t8 = performance.now();
          view.webContents.close();
          await destroyed;
          const t9 = performance.now();

          if (i >= 0) {
            measurements.create.push(t1 - t0);
            measurements.attach.push(t3 - t2);
            measurements.setBounds.push(t5 - t4);
            measurements.detach.push(t7 - t6);
            measurements.close.push(t9 - t8);
          }
        }

        return measurements;
      });

      results.benchmarks.lifecycle = {
        viewCreation: stats(lifecycleData.create),
        viewAttachment: stats(lifecycleData.attach),
        boundsUpdate: stats(lifecycleData.setBounds),
        viewDetachment: stats(lifecycleData.detach),
        viewDestruction: stats(lifecycleData.close),
      };

      console.log('Lifecycle Results (ms):');
      console.table({
        'View Creation': results.benchmarks.lifecycle.viewCreation,
        'View Attachment': results.benchmarks.lifecycle.viewAttachment,
        'Bounds Update': results.benchmarks.lifecycle.boundsUpdate,
        'View Detachment': results.benchmarks.lifecycle.viewDetachment,
        'View Close': results.benchmarks.lifecycle.viewDestruction,
      });
    }

    // 2. BENCHMARK: Tab Switching Latency
    if (targetSuite === 'all' || targetSuite === 'tab-switch') {
      console.log('\nRunning Benchmark: Tab Switching Latency (N=20)...');
      const tabSwitchData = await desktop.evaluate(async ({ WebContentsView, BrowserWindow }) => {
        const mainWin = BrowserWindow.getAllWindows()[0];
        const viewA = new WebContentsView();
        const viewB = new WebContentsView();
        mainWin.contentView.addChildView(viewA);
        viewA.setBounds({ x: 0, y: 0, width: 800, height: 600 });

        const primitives = [];
        for (let i = 0; i < 20; i++) {
          const fromView = i % 2 === 0 ? viewA : viewB;
          const toView = i % 2 === 0 ? viewB : viewA;

          const t0 = performance.now();
          mainWin.contentView.removeChildView(fromView);
          fromView.setVisible(false);
          mainWin.contentView.addChildView(toView);
          toView.setBounds({ x: 0, y: 0, width: 800, height: 600 });
          toView.setVisible(true);
          const t1 = performance.now();
          primitives.push(t1 - t0);
        }

        mainWin.contentView.removeChildView(viewA);
        mainWin.contentView.removeChildView(viewB);
        viewA.webContents.close();
        viewB.webContents.close();

        return primitives;
      });

      results.benchmarks.tabSwitch = {
        warmSwitchPrimitiveMs: stats(tabSwitchData),
      };

      console.log('Tab Switching Results (ms):');
      console.table({ 'Warm Tab Switch Primitive': results.benchmarks.tabSwitch.warmSwitchPrimitiveMs });
    }

    // 3. BENCHMARK: Pane Resizing
    if (targetSuite === 'all' || targetSuite === 'pane-resize') {
      console.log('\nRunning Benchmark: Pane Resizing Bounds Cadence (N=50)...');
      const resizeData = await desktop.evaluate(async ({ WebContentsView, BrowserWindow }) => {
        const mainWin = BrowserWindow.getAllWindows()[0];
        const view = new WebContentsView();
        mainWin.contentView.addChildView(view);

        const latencies = [];
        for (let w = 400; w <= 900; w += 10) {
          const t0 = performance.now();
          view.setBounds({ x: 0, y: 0, width: w, height: 600 });
          const t1 = performance.now();
          latencies.push(t1 - t0);
        }

        mainWin.contentView.removeChildView(view);
        view.webContents.close();
        return latencies;
      });

      results.benchmarks.paneResize = {
        setBoundsLatencyMs: stats(resizeData),
      };

      console.log('Pane Resize Latency Results (ms):');
      console.table({ 'Native setBounds Latency': results.benchmarks.paneResize.setBoundsLatencyMs });
    }

    // 4. BENCHMARK: Overlay Capture
    if (targetSuite === 'all' || targetSuite === 'overlay-capture') {
      console.log('\nRunning Benchmark: Overlay Page Capture (N=10)...');
      const captureData = await desktop.evaluate(async ({ WebContentsView, BrowserWindow }) => {
        const mainWin = BrowserWindow.getAllWindows()[0];
        const view = new WebContentsView();
        mainWin.contentView.addChildView(view);
        view.setBounds({ x: 0, y: 0, width: 800, height: 600 });

        try {
          await view.webContents.loadURL('data:text/html,' + encodeURIComponent(
            '<style>body{background:linear-gradient(120deg,#123,#abc);font:32px sans-serif;color:white}</style>' +
            '<main>Native overlay capture fixture</main>',
          ));
          await view.webContents.executeJavaScript(
            'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
          );
          const captures = [];
          const emptyPrefixLen = Buffer.byteLength('data:image/png;base64,');
          for (let i = 0; i < 10; i++) {
            const t0 = performance.now();
            const img = await view.webContents.capturePage();
            const t1 = performance.now();
            const size = img.getSize();
            if (img.isEmpty() || size.width <= 0 || size.height <= 0) {
              throw new Error(`Native overlay capture returned an empty image (${size.width}x${size.height})`);
            }
            const png = img.toPNG();
            const dataUrl = img.toDataURL();
            const t2 = performance.now();
            const dataUrlBytes = Buffer.byteLength(dataUrl);
            if (png.length === 0 || dataUrlBytes <= emptyPrefixLen) {
              throw new Error(`Native overlay PNG encoding produced empty payload (${png.length} PNG bytes, ${dataUrlBytes} dataURL bytes)`);
            }
            captures.push({
              captureMs: t1 - t0,
              encodeMs: t2 - t1,
              totalMs: t2 - t0,
              bytes: dataUrlBytes,
              pngBytes: png.length,
            });
          }
          return captures;
        } finally {
          mainWin.contentView.removeChildView(view);
          view.webContents.close();
        }
      });

      results.benchmarks.overlayCapture = {
        gpuReadbackMs: stats(captureData.map((c) => c.captureMs)),
        pngEncodeMs: stats(captureData.map((c) => c.encodeMs)),
        totalCaptureMs: stats(captureData.map((c) => c.totalMs)),
        payloadBytes: stats(captureData.map((c) => c.bytes)),
      };

      console.log('Overlay Capture Results (ms):');
      console.table({
        'GPU Readback': results.benchmarks.overlayCapture.gpuReadbackMs,
        'PNG Encode': results.benchmarks.overlayCapture.pngEncodeMs,
        'Total Capture': results.benchmarks.overlayCapture.totalCaptureMs,
      });
    }

    if (targetSuite === 'all' || targetSuite === 'browser-profiles') {
      await desktop.evaluate(({ session }) => {
        for (const partition of ['persist:maw-browser', 'persist:maw-profile-bench-browser']) {
          session.fromPartition(partition).protocol.handle('https', () =>
            new Response('<title>Browser profile benchmark</title>', { headers: { 'Content-Type': 'text/html' } }));
        }
      });
      const samples = await win.evaluate(async () => {
        const bridge = window.mawChatGpt;
        const timings = { main: [], bench: [] };
        for (let run = 0; run < 9; run++) {
          for (const profileId of (run % 2 === 0 ? ['main', 'bench'] : ['bench', 'main'])) {
            const id = crypto.randomUUID();
            let unsubscribe;
            let deadline;
            const began = performance.now();
            try {
              const ready = new Promise((resolve, reject) => {
                deadline = setTimeout(() => reject(new Error('Native browser fixture did not load')), 10_000);
                unsubscribe = bridge.subscribe(event => {
                  if (event.id !== id) return;
                  if (event.type === 'ready') resolve();
                  if (event.type === 'error') reject(new Error(event.message));
                });
              });
              await Promise.all([ready, bridge.command({ type: 'open', id, profileId, provider: 'other', url: 'https://docs.example.com/' })]);
              if (run > 0) timings[profileId].push(performance.now() - began);
            } finally {
              clearTimeout(deadline);
              unsubscribe?.();
              await bridge.command({ type: 'close', id });
            }
          }
        }
        return timings;
      });
      results.benchmarks.browserProfiles = { mainOpenReadyMs: stats(samples.main), customOpenReadyMs: stats(samples.bench) };
      console.table(results.benchmarks.browserProfiles);
    }

    // 5. BENCHMARK: Concurrent Streaming Load across Multiple Native Views
    if (targetSuite === 'all' || targetSuite === 'concurrent-stream') {
      console.log('\nRunning Benchmark: Concurrent Streaming Views (3 views x 40 bursts)...');
      const streamData = await desktop.evaluate(async ({ WebContentsView, BrowserWindow }) => {
        const mainWin = BrowserWindow.getAllWindows()[0];
        const views = [new WebContentsView(), new WebContentsView(), new WebContentsView()];
        const streamHtml = 'data:text/html,' + encodeURIComponent(
          '<!doctype html><html><body><pre id="out"></pre><script>' +
          'let count = 0; const out = document.getElementById("out");' +
          'window.__streamBurst = (n) => { const lines = []; for (let i = 0; i < n; i++) lines.push("line-" + (++count) + " " + "x".repeat(64)); out.textContent = (out.textContent + "\\n" + lines.join("\\n")).slice(-16384); return count; };' +
          '</script></body></html>',
        );
        try {
          for (let i = 0; i < views.length; i++) {
            mainWin.contentView.addChildView(views[i]);
            views[i].setBounds({ x: i * 260, y: 0, width: 260, height: 500 });
            await views[i].webContents.loadURL(streamHtml);
          }
          const burstLatencies = [];
          const boundsLatencies = [];
          for (let burst = -2; burst < 40; burst++) {
            const t0 = performance.now();
            await Promise.all(views.map((v) => v.webContents.executeJavaScript('window.__streamBurst(20)')));
            const t1 = performance.now();
            const b0 = performance.now();
            views[0].setBounds({ x: 0, y: 0, width: 260 + (burst % 2) * 10, height: 500 });
            const b1 = performance.now();
            if (burst >= 0) {
              burstLatencies.push(t1 - t0);
              boundsLatencies.push(b1 - b0);
            }
          }
          return { burstLatencies, boundsLatencies };
        } finally {
          for (const view of views) {
            mainWin.contentView.removeChildView(view);
            view.webContents.close();
          }
        }
      });

      results.benchmarks.concurrentStream = {
        concurrentBurstMs: stats(streamData.burstLatencies),
        interleavedSetBoundsMs: stats(streamData.boundsLatencies),
      };

      console.log('Concurrent Stream Results (ms):');
      console.table({
        'Concurrent 3-View Burst': results.benchmarks.concurrentStream.concurrentBurstMs,
        'Interleaved setBounds': results.benchmarks.concurrentStream.interleavedSetBoundsMs,
      });
    }

    // Resource Matrix Accounting
    if (targetSuite === 'all' || targetSuite === 'resource-matrix') {
      console.log('\nRunning Benchmark: Multi-Workload Resource Matrix...');
      const pids = await desktop.evaluate(async ({ app }) => {
        const metrics = app.getAppMetrics();
        return {
          mainPid: process.pid,
          processes: metrics.map((m) => ({ pid: m.pid, type: m.type })),
        };
      });

      let totalRss = 0;
      let totalPss = 0;
      let totalPrivate = 0;
      const processBreakdown = [];

      for (const p of pids.processes) {
        const mem = readProcessSmaps(p.pid);
        totalRss += mem.rssMiB;
        totalPss += mem.pssMiB;
        totalPrivate += mem.privateMiB;
        processBreakdown.push({
          type: p.type,
          pid: p.pid,
          rssMiB: mem.rssMiB,
          pssMiB: mem.pssMiB,
          privateMiB: mem.privateMiB,
        });
      }

      results.benchmarks.resourceMatrix = {
        processCount: pids.processes.length,
        totalRssMiB: Number(totalRss.toFixed(1)),
        totalPssMiB: Number(totalPss.toFixed(1)),
        totalPrivateMiB: Number(totalPrivate.toFixed(1)),
        processes: processBreakdown,
      };

      console.log('Resource Matrix Results:');
      console.table(processBreakdown);
      console.log(`Total RSS: ${results.benchmarks.resourceMatrix.totalRssMiB} MiB | Total PSS: ${results.benchmarks.resourceMatrix.totalPssMiB} MiB | Total Private: ${results.benchmarks.resourceMatrix.totalPrivateMiB} MiB`);
    }

    // Save output evidence file (avoid dirtying tracked docs unless explicitly requested)
    const evidenceDir = process.env.MAW_WEBVIEW_EVIDENCE_DIR
      ? path.resolve(process.env.MAW_WEBVIEW_EVIDENCE_DIR)
      : path.join(tmpdir(), 'maw-webview-bench-evidence');
    await mkdir(evidenceDir, { recursive: true });
    const evidencePath = path.resolve(evidenceDir, 'latest-benchmark.json');
    await writeFile(evidencePath, JSON.stringify(results, null, 2), 'utf8');
    console.log(`\n✔ Benchmark results successfully written to ${evidencePath}\n`);

  } finally {
    if (desktop) await desktop.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

const target = process.argv[2] || 'all';
runBenchmarkSuite(target).catch((err) => {
  console.error('Benchmark execution error:', err);
  process.exit(1);
});

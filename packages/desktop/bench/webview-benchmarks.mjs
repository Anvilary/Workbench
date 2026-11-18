import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(desktopDir, '../..');
const electronExecutable = existsSync('/opt/maw-electron/45.2.0/electron')
  ? '/opt/maw-electron/45.2.0/electron'
  : require('electron');

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
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [desktopDir, '--ozone-platform=x11'],
      env: {
        ...process.env,
        MAW_DESKTOP_URL: `http://127.0.0.1:${serverPort}/`,
        MAW_DESKTOP_DATA_DIR: dataDir,
        MAW_MAX_RESIDENT_VIEWS: '10',
      },
    });

    const win = await desktop.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 1. BENCHMARK: Lifecycle Primitives
    if (targetSuite === 'all' || targetSuite === 'lifecycle') {
      console.log('Running Benchmark: Native View Lifecycle Primitives (N=20)...');
      const lifecycleData = await desktop.evaluate(async ({ WebContentsView, BrowserWindow }) => {
        const mainWin = BrowserWindow.getAllWindows()[0];
        const measurements = {
          create: [],
          attach: [],
          setBounds: [],
          detach: [],
          close: [],
        };

        for (let i = 0; i < 20; i++) {
          const t0 = performance.now();
          const view = new WebContentsView();
          const t1 = performance.now();
          measurements.create.push(t1 - t0);

          const t2 = performance.now();
          mainWin.contentView.addChildView(view);
          const t3 = performance.now();
          measurements.attach.push(t3 - t2);

          const t4 = performance.now();
          view.setBounds({ x: 50, y: 50, width: 800, height: 600 });
          const t5 = performance.now();
          measurements.setBounds.push(t5 - t4);

          const t6 = performance.now();
          mainWin.contentView.removeChildView(view);
          const t7 = performance.now();
          measurements.detach.push(t7 - t6);

          const t8 = performance.now();
          view.webContents.close();
          const t9 = performance.now();
          measurements.close.push(t9 - t8);
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

        const captures = [];
        for (let i = 0; i < 10; i++) {
          const t0 = performance.now();
          const img = await view.webContents.capturePage();
          const t1 = performance.now();
          const dataUrl = img.toDataURL();
          const t2 = performance.now();
          captures.push({
            captureMs: t1 - t0,
            encodeMs: t2 - t1,
            totalMs: t2 - t0,
            bytes: dataUrl.length,
          });
        }

        mainWin.contentView.removeChildView(view);
        view.webContents.close();
        return captures;
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

    // 5. BENCHMARK: Resource Matrix Accounting
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

    // Save output evidence file
    const evidenceDir = process.env.MAW_WEBVIEW_EVIDENCE_DIR
      ? path.resolve(process.env.MAW_WEBVIEW_EVIDENCE_DIR)
      : path.resolve(repoRoot, 'docs/maw/webview-performance/evidence');
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

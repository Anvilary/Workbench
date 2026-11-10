// Compare the actual MAW entry in fresh, isolated browser processes. No live backend or user profile.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [baseline, candidate = process.cwd(), output = '/tmp/maw-release-benchmark.json'] = process.argv.slice(2);
if (!baseline) throw new Error('Usage: node scripts/maw/bench-release.mjs BASELINE_ROOT [CANDIDATE_ROOT] [OUTPUT_JSON]');
const cache = path.join(homedir(), '.cache/ms-playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? [chromium.executablePath(),
  ...(existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse()
    .map(name => path.join(cache, name, 'chrome-headless-shell-linux64/chrome-headless-shell')) : [])].find(file => existsSync(file));
if (!executablePath) throw new Error('An installed Chromium is required; no browser is downloaded by this benchmark');
const results = { method: 'Actual MAW root, production React, disconnected local fixture, 1280x860 DPR 1.5; fresh Chromium per sample, 1s warmup and 5s measured. CPU is CDP renderer task time, memory is unique Chromium-process PSS/SwapPss. No real agents or website workloads.', samples: [] };
for (const [label, root] of [['baseline', baseline], ['candidate', candidate], ['baseline', baseline], ['candidate', candidate]]) {
  const bundle = await build({ entryPoints: [path.join(root, 'packages/web/src/main.tsx')], bundle: true, splitting: true,
    format: 'esm', write: false, outdir: '/maw-bench', jsx: 'automatic', minify: true,
    define: { __APP_VERSION__: '"benchmark"', 'process.env.NODE_ENV': '"production"' },
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.mp3': 'dataurl', '.wav': 'dataurl' }, logLevel: 'silent' });
  const files = new Map(bundle.outputFiles.map(file => [file.path.replace('/maw-bench', ''), file.contents]));
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (files.has(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(files.get(url.pathname));
    } else res.end('<!doctype html><html><link rel="stylesheet" href="/main.css"><div id="root"></div><script type="module" src="/main.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1.5, reducedMotion: 'no-preference' });
    await page.addInitScript(() => {
      window.auditFrames = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => raf(time => { window.auditFrames++; callback(time); });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    const start = performance.now();
    await page.goto(base);
    await page.waitForSelector('.agency-app');
    const readyMs = performance.now() - start;
    await page.waitForTimeout(1000);
    const before = Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const framesBefore = await page.evaluate(() => window.auditFrames);
    await page.waitForTimeout(5000);
    const after = Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const frames = await page.evaluate(() => window.auditFrames) - framesBefore;
    const processSession = await browser.newBrowserCDPSession();
    const processes = (await processSession.send('SystemInfo.getProcessInfo')).processInfo;
    let pssKiB = 0, swapKiB = 0, unreadable = 0;
    for (const { id } of processes) {
      try {
        const smaps = await readFile(`/proc/${id}/smaps_rollup`, 'utf8');
        pssKiB += Number(smaps.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0);
        swapKiB += Number(smaps.match(/^SwapPss:\s+(\d+)/m)?.[1] ?? 0);
      } catch { unreadable++; }
    }
    const sample = { label, commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      readyMs: +readyMs.toFixed(1), rendererTaskMs: +((after.TaskDuration - before.TaskDuration) * 1000).toFixed(2),
      scriptMs: +((after.ScriptDuration - before.ScriptDuration) * 1000).toFixed(2), animationCallbacks: frames,
      chromiumPssMiB: +(pssKiB / 1024).toFixed(1), chromiumSwapPssMiB: +(swapKiB / 1024).toFixed(1), processes: processes.length, unreadable };
    results.samples.push(sample);
    console.log(JSON.stringify(sample));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
await writeFile(output, JSON.stringify(results, null, 2) + '\n');
console.log(`Evidence: ${output}`);

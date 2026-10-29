// First-load measurement of a built web bundle in real headless Chromium (no backend: the MAW shell renders
// disconnected, which isolates JS download/parse/eval/first render from server work).
// Usage: node docs/maw/claude-review/evidence/bench-first-load.mjs <distDir> [runs=15] [cpuThrottle=1]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
function executable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const d of existsSync(cache) ? readdirSync(cache).filter(n => n.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const p = `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

const [dist, runsArg = '15', throttleArg = '1'] = process.argv.slice(2);
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try { res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream'); res.end(await readFile(path.join(dist, file))); }
  catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true, executablePath: executable() });
const rows = [];
for (let i = 0; i < Number(runsArg); i++) {
  const context = await browser.newContext();   // cold cache every run
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (Number(throttleArg) > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(throttleArg) });
  await page.goto(base);
  await page.waitForSelector('.agency-app', { timeout: 30000 });
  const shown = await page.evaluate(() => performance.now());
  await page.waitForTimeout(300);
  const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
  const js = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.name.endsWith('.js')).reduce((n, e) => n + (e.encodedBodySize || 0), 0));
  rows.push({ shownMs: shown, scriptMs: m.ScriptDuration * 1000, taskMs: m.TaskDuration * 1000, heapMB: m.JSHeapUsedSize / 1048576, jsBytes: js });
  await context.close();
}
await browser.close(); server.close();
const pct = (k, q) => { const a = rows.map(r => r[k]).sort((x, y) => x - y); return a[Math.floor(q * (a.length - 1))]; };
const out = {};
for (const k of ['shownMs', 'scriptMs', 'taskMs', 'heapMB', 'jsBytes']) out[k] = { p50: +pct(k, 0.5).toFixed(2), p95: +pct(k, 0.95).toFixed(2) };
console.log(JSON.stringify({ dist: path.basename(dist), runs: rows.length, cpuThrottle: Number(throttleArg), ...out }));

// Local/CI browser regression for the MAW-first root (Opt-A).
// Run: node --test packages/web/src/maw-root.test.mjs
// Bundles the real entry (src/main.tsx) with code splitting, serves it without a backend, and checks in real
// Chromium that the MAW view never downloads the classic Workbench chunk, that `?view=workbench` still loads the
// classic UI, that switching between them works, and that a failed classic chunk shows a recoverable error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const path = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(path)) return path;
  }
  return undefined;
}

test('MAW view loads without the classic Workbench chunk; classic view still works; chunk failure is recoverable', { timeout: 120000 }, async t => {
  const executablePath = browserExecutable();
  if (!executablePath) { t.skip('Chromium is not installed; set PLAYWRIGHT_CHROMIUM_EXECUTABLE'); return; }
  const result = await build({
    entryPoints: [process.cwd() + '/packages/web/src/main.tsx'], bundle: true, splitting: true, format: 'esm', write: false,
    outdir: '/out', jsx: 'automatic', logLevel: 'silent', define: { __APP_VERSION__: '"test"' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.mp3': 'dataurl', '.wav': 'dataurl' },
  });
  const files = new Map(result.outputFiles.map(file => [file.path.replace(/^\/out/, ''), file.text]));
  // The classic chunk is the one holding the classic header; the entry must not contain it.
  const classicChunk = [...files.entries()].find(([, text]) => text.includes('app-header'))?.[0];
  assert.ok(classicChunk && classicChunk !== '/main.js', 'classic Workbench is a separate chunk');
  assert.ok(!files.get('/main.js').includes('app-header'));

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (files.has(url.pathname)) { res.setHeader('Content-Type', 'text/javascript'); res.end(files.get(url.pathname)); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html lang="en"><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });

  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const requested = []; page.on('request', request => requested.push(new URL(request.url()).pathname));

  await page.goto(base + '/');
  await page.waitForSelector('.agency-app');
  await page.waitForTimeout(300);
  assert.ok(!requested.includes(classicChunk), 'MAW view never downloads the classic chunk');
  assert.equal(await page.locator('.app-name').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme !== undefined), true, 'theme attributes still applied');

  await page.goto(base + '/?view=workbench');
  await page.getByText('Agent Workbench', { exact: true }).waitFor();
  assert.ok(requested.includes(classicChunk), 'classic view loads its chunk on demand');
  assert.equal(await page.locator('.agency-app').count(), 0);

  await page.goto(base + '/');
  await page.waitForSelector('.agency-app');
  assert.deepEqual(errors, []);

  const failing = await browser.newContext();
  const broken = await failing.newPage();
  await broken.route('**' + classicChunk, route => route.abort());
  await broken.goto(base + '/?view=workbench');
  await broken.getByRole('alert').filter({ hasText: 'This view could not be loaded' }).waitFor();
  await broken.getByRole('button', { name: 'Reload page', exact: true }).waitFor();
  await failing.close();
});

// Stale ChatGPT capture fallback. Run: node --test packages/web/src/agency/native-layout-coordinator.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const fixture = `
import { nativeLayoutCoordinator } from './src/agency/native-layout-coordinator.ts';
window.commands = [];
window.pending = [];
window.backdrops = [];
window.focused = [];
window.mawChatGpt = {
  command(cmd) {
    window.commands.push(cmd.type);
    if (cmd.type === 'capture') {
      return new Promise((resolve) => window.pending.push(resolve));
    }
    return Promise.resolve({ ok: true });
  },
  subscribe(cb) {
    window.onState = cb;
    return () => {};
  },
};
const view = document.getElementById('view');
nativeLayoutCoordinator.register({
  id: 'view-1',
  element: view,
  onDisplayed() {},
  onFocused() { window.focused.push('view-1'); },
  setCaptureBackdrop(url) {
    window.backdrops.push({ url, overlayOpen: !document.getElementById('overlay').hidden });
  },
});
window.overlay = (open) => { document.getElementById('overlay').hidden = !open; };
window.resizeView = (width) => { view.style.width = width + 'px'; };
`;

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const path = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(path)) return path;
  }
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

test('native capture fallback ignores results that arrive after the overlay closes', { timeout: 60000 }, async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium is not installed; set PLAYWRIGHT_CHROMIUM_EXECUTABLE');
    return;
  }
  const bundle = await build({
    stdin: { contents: fixture, loader: 'ts', resolveDir: process.cwd() + '/packages/web' },
    bundle: true,
    write: false,
    format: 'esm',
    logLevel: 'silent',
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(bundle.outputFiles[0].text);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><body style="margin:0">
      <div id="view" style="position:absolute;left:0;top:0;width:400px;height:300px"></div>
      <div id="overlay" role="dialog" hidden style="position:absolute;left:20px;top:20px;width:160px;height:120px"></div>
      <script type="module" src="/bundle.js"></script>
    </body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => typeof window.overlay === 'function');

  const frames = (count) => page.evaluate(async (n) => {
    for (let i = 0; i < n; i += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
  const appliedWhileHidden = () => page.evaluate(() => window.backdrops.filter((entry) => typeof entry.url === 'string' && entry.url.startsWith('data:') && !entry.overlayOpen));

  await frames(3);
  await page.evaluate(() => {
    window.onState({ type: 'focused', id: 'another-workspace' });
    window.onState({ type: 'focused', id: 'view-1' });
  });
  assert.deepEqual(await page.evaluate(() => window.focused), ['view-1'], 'only registered visible views can report focus');

  await page.evaluate(() => window.overlay(true));
  await page.waitForFunction(() => window.pending.length === 1);
  // Even a loading native page must yield to a menu/drag shield.
  await page.evaluate(() => window.onState({ type: 'ready', id: 'view-1' }));
  await page.evaluate(() => window.onState({ type: 'focused', id: 'view-1' }));
  assert.deepEqual(await page.evaluate(() => window.focused), ['view-1'], 'covered native views cannot steal dialog focus');
  await page.evaluate(() => window.overlay(false));
  await frames(3);
  await page.evaluate(() => window.pending.splice(0).forEach((resolve) => resolve({ ok: true, dataUrl: 'data:image/png;base64,STALE' })));
  await frames(3);
  assert.deepEqual(await appliedWhileHidden(), []);
  assert.equal(await page.evaluate(() => window.backdrops.some((entry) => entry.url && String(entry.url).includes('STALE'))), false);

  await page.evaluate(() => window.overlay(true));
  await page.waitForFunction(() => window.pending.length === 1);
  await page.evaluate(() => {
    const resolve = window.pending.shift();
    resolve({ ok: true, dataUrl: 'data:image/png;base64,FRESH' });
  });
  await page.waitForFunction(() => window.backdrops.some((entry) => entry.url && String(entry.url).includes('FRESH') && entry.overlayOpen));
  await page.evaluate(() => window.overlay(false));
  await frames(3);
  assert.equal(await page.evaluate(() => window.backdrops.at(-1).url), null);
  assert.deepEqual(await appliedWhileHidden(), []);

  await page.evaluate(() => window.overlay(true));
  await page.waitForFunction(() => window.pending.length === 1);
  const pendingBeforeResize = await page.evaluate(() => window.pending.length);
  await page.evaluate(() => window.resizeView(220));
  await page.waitForFunction((count) => window.pending.length > count, pendingBeforeResize);
  await page.evaluate(() => {
    const obsolete = window.pending.shift();
    obsolete({ ok: true, dataUrl: 'data:image/png;base64,OLDSIZE' });
  });
  await frames(2);
  await page.evaluate(() => {
    const latest = window.pending.pop();
    window.pending.splice(0).forEach((resolve) => resolve({ ok: true, dataUrl: 'data:image/png;base64,OLDSIZE' }));
    latest({ ok: true, dataUrl: 'data:image/png;base64,RESIZED' });
  });
  await frames(3);
  const duringResize = await page.evaluate(() => window.backdrops.map((entry) => entry.url));
  assert.equal(duringResize.includes('data:image/png;base64,OLDSIZE'), false);
  assert.equal(duringResize.includes('data:image/png;base64,RESIZED'), true);
  await page.evaluate(() => window.overlay(false));
  await frames(3);
  assert.equal(await page.evaluate(() => window.backdrops.at(-1).url), null);

  for (let cycle = 0; cycle < 8; cycle += 1) {
    await page.evaluate(() => window.overlay(true));
    await frames(1);
    await page.evaluate(() => window.overlay(false));
    await frames(1);
    if (cycle % 2 === 0) await page.evaluate((width) => window.resizeView(width), 180 + cycle * 20);
  }
  await page.evaluate(() => {
    window.pending.splice(0).forEach((resolve, index) => resolve({ ok: true, dataUrl: 'data:image/png;base64,RAPID' + index }));
  });
  await frames(3);
  assert.deepEqual(await appliedWhileHidden(), []);
  const last = await page.evaluate(() => window.backdrops.at(-1)?.url ?? null);
  assert.equal(last === null || last === undefined || !String(last).startsWith('data:'), true);
  assert.deepEqual(errors, []);
});

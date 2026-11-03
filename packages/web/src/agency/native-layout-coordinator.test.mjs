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
window.nativeLayoutCoordinator = nativeLayoutCoordinator;
window.commands = [];
window.pending = [];
window.backdrops = [];
window.focused = [];
window.layoutHistory = [];
window.measureCount = 0;
const origMeasure = nativeLayoutCoordinator.measure.bind(nativeLayoutCoordinator);
nativeLayoutCoordinator.measure = function() {
  window.measureCount++;
  return origMeasure();
};
window.mawChatGpt = {
  command(cmd) {
    window.commands.push(cmd.type);
    if (cmd.type === 'layout') {
      window.layoutHistory.push(JSON.parse(JSON.stringify(cmd)));
    }
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
window.unregisterView = nativeLayoutCoordinator.register({
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
      <div class="xterm" id="term" style="position:absolute;left:450px;top:0;width:300px;height:200px">
        <div id="term-row">line 1</div>
      </div>
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

test('event-driven layout coordinator eliminates idle animation-frame loop and ignores xterm repaints', { timeout: 60000 }, async (t) => {
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
      <div class="xterm" id="term" style="position:absolute;left:450px;top:0;width:300px;height:200px">
        <div id="term-row">line 1</div>
      </div>
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
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => typeof window.resizeView === 'function');

  const frames = (count) => page.evaluate(async (n) => {
    for (let i = 0; i < n; i += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }, count);

  // Let initial setup settle
  await frames(5);
  const baselineMeasures = await page.evaluate(() => window.measureCount);

  // 1. Across 30 animation frames, idle measures should not run every frame (unconditional loop would run 30 times)
  await frames(30);
  const idleMeasuresDelta = (await page.evaluate(() => window.measureCount)) - baselineMeasures;
  assert.ok(idleMeasuresDelta <= 2, `Idle measures across 30 frames must be bounded (got delta ${idleMeasuresDelta}, expected <= 2)`);

  // 2. Terminal repaints (DOM mutations inside .xterm) must be ignored
  const beforeTerm = await page.evaluate(() => window.measureCount);
  await page.evaluate(() => {
    const row = document.getElementById('term-row');
    for (let i = 0; i < 20; i++) {
      const span = document.createElement('span');
      span.textContent = ' chunk ' + i;
      row.appendChild(span);
    }
  });
  await frames(5);
  const termDelta = (await page.evaluate(() => window.measureCount)) - beforeTerm;
  assert.equal(termDelta, 0, 'Mutations inside .xterm must not trigger native layout measurements');

  // 3. Resizing the element must be detected by ResizeObserver and trigger layout
  const beforeResize = await page.evaluate(() => window.layoutHistory.length);
  await page.evaluate(() => window.resizeView(550));
  await frames(5);
  const afterResize = await page.evaluate(() => window.layoutHistory.length);
  assert.ok(afterResize > beforeResize, 'ResizeObserver must trigger layout on element size change');
  const latestLayout = await page.evaluate(() => window.layoutHistory.at(-1));
  assert.equal(latestLayout.views[0]?.bounds.width, 550, 'Layout bounds must reflect resized element width');

  // 4. Focus change must update layout
  await page.evaluate(() => window.nativeLayoutCoordinator.setFocusedTabId('view-1'));
  await frames(5);
  const focusedLayout = await page.evaluate(() => window.layoutHistory.at(-1));
  assert.equal(focusedLayout.focusedId, 'view-1', 'Layout must reflect updated focused tab ID');
  assert.equal(await page.evaluate(() => window.nativeLayoutCoordinator.isViewing('view-1')), true, 'Coordinator must report viewing view-1');

  // 5. Unregister view cleanly stops coordinator, clears focused tab, and hides views
  await page.evaluate(() => window.unregisterView());
  await frames(5);
  const finalLayout = await page.evaluate(() => window.layoutHistory.at(-1));
  assert.deepEqual(finalLayout.views, [], 'Unregistering all views must publish empty view array');
  assert.equal(await page.evaluate(() => window.nativeLayoutCoordinator.isViewing('view-1')), false, 'Unregistering focused view must clear focused tab identity');

  // 6. Explicit clearing of focused tab ID (e.g. on workspace view unmount)
  await page.evaluate(() => {
    window.nativeLayoutCoordinator.setFocusedTabId('test-workspace-tab');
    window.nativeLayoutCoordinator.setFocusedTabId(null);
  });
  assert.equal(await page.evaluate(() => window.nativeLayoutCoordinator.isViewing('test-workspace-tab')), false, 'Workspace unmount cleanup must reset focused tab to null');
});

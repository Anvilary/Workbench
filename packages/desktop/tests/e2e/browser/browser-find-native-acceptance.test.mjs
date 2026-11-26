import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const electronExecutable = process.env.WORKBENCH_ELECTRON_EXECUTABLE || ('/opt/workbench-electron/45.2.0/electron');

async function eventually(check, message = 'condition', timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('Timed out waiting for ' + message);
}

test('native browser search scrolling, Next/Prev navigation, tab switching and counter in real Electron', { timeout: 60000 }, async (t) => {
  const tab1Id = '11111111-1111-4111-8111-111111111111';
  const tab2Id = '22222222-2222-4222-8222-222222222222';

  const doc1Html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Document 1</title>
  <style>
    body { margin: 0; padding: 0; font-family: sans-serif; background: #fff; color: #111; }
    .spacer { height: 1200px; background: linear-gradient(#f0f0f0, #e0e0e0); margin: 10px 0; padding: 20px; box-sizing: border-box; }
    .keyword { font-size: 20px; font-weight: bold; padding: 8px 16px; background: #ffeb3b; display: inline-block; }
    .target { font-size: 22px; font-weight: bold; padding: 10px 20px; background: #4caf50; color: #fff; display: inline-block; }
  </style>
</head>
<body>
  <div id="top-section">
    <h1>Top Section</h1>
    <p class="keyword" id="match-top">RepeatedKeyword top</p>
  </div>
  <div class="spacer">Spacer 1 (1200px)</div>
  <div id="mid-section">
    <h2>Middle Section</h2>
    <p class="keyword" id="match-mid">RepeatedKeyword middle</p>
  </div>
  <div class="spacer">Spacer 2 (1200px)</div>
  <div id="bot-section">
    <h2>Bottom Section</h2>
    <p class="target" id="distant-target">DistantDeepSecretTarget</p>
    <br>
    <p class="keyword" id="match-bot">RepeatedKeyword bottom</p>
  </div>
  <div class="spacer" style="height: 600px;">Footer Spacer</div>
</body>
</html>`;

  const doc2Html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Document 2</title></head>
<body>
  <h1>Tab 2 Content</h1>
  <p id="tab2-target">TabTwoDistinctTarget</p>
</body>
</html>`;

  // Server for shell UI
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>Workbench Test Shell</title></head><body><script>window.events=[];if(window.workbench)window.workbench.subscribe(s=>window.events.push(s));</script></body></html>');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const serverPort = server.address().port;
  const shellUrl = `http://127.0.0.1:${serverPort}/`;

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'maw-find-native-'));
  let app;

  t.after(async () => {
    if (app) await app.close();
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  });

  app = await electron.launch({
    chromiumSandbox: true,
    executablePath: electronExecutable,
    args: [DESKTOP_ROOT, '--ozone-platform=x11'],
    env: {
      ...process.env,
      HOME: dataDir,
      WORKBENCH_DESKTOP_DATA_DIR: dataDir,
      WORKBENCH_DESKTOP_URL: shellUrl,
      // Keep both test tabs resident across tab switches regardless of host swap pressure;
      // memory-pressure eviction is tested independently in resource-budget and resource-tab-pool tests.
      WORKBENCH_MAX_RESIDENT_VIEWS: '4',
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  await page.waitForFunction(() => typeof window.workbench !== 'undefined' && Array.isArray(window.events));

  // Intercept https requests in persist:workbench-browser to serve our test fixtures
  await app.evaluate(({ session }, { d1, d2 }) => {
    const sess = session.fromPartition('persist:workbench-browser');
    sess.protocol.handle('https', (req) => {
      const u = new URL(req.url);
      if (u.pathname === '/doc1') {
        return new Response(d1, { headers: { 'Content-Type': 'text/html' } });
      }
      if (u.pathname === '/doc2') {
        return new Response(d2, { headers: { 'Content-Type': 'text/html' } });
      }
      return new Response('Not found', { status: 404 });
    });
  }, { d1: doc1Html, d2: doc2Html });

  const command = (cmd) => page.evaluate((c) => window.workbench.command(c), cmd);

  // Helper to query element bounds and visibility in the native WebContentsView
  const getTabElementMetrics = (tabId, elementId) => {
    return app.evaluate(async ({ session, webContents }, { id, elId }) => {
      const sess = session.fromPartition('persist:workbench-browser');
      const all = webContents.getAllWebContents().filter((c) => c.session === sess);
      const tabWeb = all.find((c) => c.getURL().includes(id === 'tab2' ? '/doc2' : '/doc1'));
      if (!tabWeb || tabWeb.isDestroyed()) return null;

      try {
        return await tabWeb.executeJavaScript(`
          (() => {
            const el = document.getElementById('${elId}');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
              top: r.top,
              bottom: r.bottom,
              height: r.height,
              scrollY: window.scrollY,
              innerHeight: window.innerHeight,
              isVisible: r.top >= 0 && r.bottom <= window.innerHeight
            };
          })()
        `);
      } catch {
        return null;
      }
    }, { id: tabId, elId: elementId });
  };

  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

  // 1. Open Tab 1 with /doc1
  await command({ type: 'open', id: tab1Id, provider: 'other', url: 'https://docs.maw-find-audit.org/doc1' });
  await command({
    type: 'layout',
    views: [{ id: tab1Id, bounds: { x: 0, y: 40, width: viewport.width, height: viewport.height - 40 } }],
    viewport,
  });

  // Wait for Tab 1 to finish loading
  await eventually(async () => {
    const m = await getTabElementMetrics('tab1', 'distant-target');
    return m !== null && m.innerHeight > 0;
  }, 'Tab 1 to load and render');

  // Verify initial scroll position is 0
  const initialMetrics = await getTabElementMetrics('tab1', 'match-top');
  assert.equal(initialMetrics.scrollY, 0, 'Tab 1 must start at scrollY = 0');
  assert.equal(initialMetrics.isVisible, true, 'Top match must be visible initially');

  // 2. Search for distant target: "DistantDeepSecretTarget"
  await page.evaluate(() => { window.events = []; });
  await command({
    type: 'find-in-page',
    id: tab1Id,
    text: 'DistantDeepSecretTarget',
    forward: true,
    findNext: false,
    searchId: 1,
  });

  // Verify found-in-page event
  await eventually(async () => {
    const events = await page.evaluate(() => window.events);
    return events.some((e) => e.type === 'found-in-page' && e.id === tab1Id && e.matches === 1);
  }, 'found-in-page for DistantDeepSecretTarget');

  const distantFindEvent = (await page.evaluate(() => window.events)).find((e) => e.type === 'found-in-page');
  assert.equal(distantFindEvent.matches, 1, 'Exactly 1 match for unique target');
  assert.equal(distantFindEvent.activeMatchOrdinal, 1, 'Match ordinal must be 1');

  // Verify the distant target became visible
  await eventually(async () => {
    const m = await getTabElementMetrics('tab1', 'distant-target');
    return m && m.scrollY > 1500 && m.isVisible;
  }, 'Distant target to scroll into view and become visible');

  const distantMetrics = await getTabElementMetrics('tab1', 'distant-target');
  assert.ok(distantMetrics.scrollY > 1500, `Document must scroll down (scrollY: ${distantMetrics.scrollY})`);
  assert.ok(distantMetrics.isVisible, 'Distant target must be visible within viewport');

  // 3. Search for repeated keyword: "RepeatedKeyword"
  // Clear selection first so search starts cleanly
  await command({ type: 'stop-find-in-page', id: tab1Id, action: 'clearSelection' });
  await page.evaluate(() => { window.events = []; });

  await command({
    type: 'find-in-page',
    id: tab1Id,
    text: 'RepeatedKeyword',
    forward: true,
    findNext: false,
    searchId: 2,
  });

  await eventually(async () => {
    const events = await page.evaluate(() => window.events);
    return events.some((e) => e.type === 'found-in-page' && e.id === tab1Id && e.matches === 3);
  }, 'found-in-page for RepeatedKeyword');

  const repFindEvent = (await page.evaluate(() => window.events)).filter((e) => e.type === 'found-in-page').pop();
  assert.equal(repFindEvent.matches, 3, 'Repeated keyword must have 3 matches');
  assert.equal(repFindEvent.activeMatchOrdinal, 1, 'First match ordinal must be 1');

  // First occurrence (top) should be visible
  await eventually(async () => {
    const m = await getTabElementMetrics('tab1', 'match-top');
    return m && m.isVisible;
  }, 'First occurrence (match-top) to become visible');

  const topMatchMetrics = await getTabElementMetrics('tab1', 'match-top');
  assert.ok(topMatchMetrics.isVisible, 'First match must be visible');

  // 4. Next match -> occurrence 2 (middle)
  await page.evaluate(() => { window.events = []; });
  await command({
    type: 'find-in-page',
    id: tab1Id,
    text: 'RepeatedKeyword',
    forward: true,
    findNext: true,
    searchId: 2,
  });

  await eventually(async () => {
    const events = await page.evaluate(() => window.events);
    return events.some((e) => e.type === 'found-in-page' && e.id === tab1Id && e.activeMatchOrdinal === 2);
  }, 'Next match ordinal 2');

  await eventually(async () => {
    const m = await getTabElementMetrics('tab1', 'match-mid');
    return m && m.isVisible;
  }, 'Second occurrence (match-mid) to scroll into view');

  const midMatchMetrics = await getTabElementMetrics('tab1', 'match-mid');
  assert.ok(midMatchMetrics.isVisible, 'Second match must be visible');
  assert.ok(midMatchMetrics.scrollY > 800, 'Viewport must scroll down to middle section');

  // 5. Next match again -> occurrence 3 (bottom)
  await page.evaluate(() => { window.events = []; });
  await command({
    type: 'find-in-page',
    id: tab1Id,
    text: 'RepeatedKeyword',
    forward: true,
    findNext: true,
    searchId: 2,
  });

  await eventually(async () => {
    const events = await page.evaluate(() => window.events);
    return events.some((e) => e.type === 'found-in-page' && e.id === tab1Id && e.activeMatchOrdinal === 3);
  }, 'Next match ordinal 3');

  await eventually(async () => {
    const m = await getTabElementMetrics('tab1', 'match-bot');
    return m && m.isVisible;
  }, 'Third occurrence (match-bot) to scroll into view');

  const botMatchMetrics = await getTabElementMetrics('tab1', 'match-bot');
  assert.ok(botMatchMetrics.isVisible, 'Third match must be visible');
  assert.ok(botMatchMetrics.scrollY > 2000, 'Viewport must scroll down to bottom section');

  // 6. Previous match -> back to occurrence 2 (middle)
  await page.evaluate(() => { window.events = []; });
  await command({
    type: 'find-in-page',
    id: tab1Id,
    text: 'RepeatedKeyword',
    forward: false,
    findNext: true,
    searchId: 2,
  });

  await eventually(async () => {
    const events = await page.evaluate(() => window.events);
    return events.some((e) => e.type === 'found-in-page' && e.id === tab1Id && e.activeMatchOrdinal === 2);
  }, 'Previous match back to ordinal 2');

  await eventually(async () => {
    const m = await getTabElementMetrics('tab1', 'match-mid');
    return m && m.isVisible;
  }, 'Previous match to scroll back up to middle section');

  const prevMidMetrics = await getTabElementMetrics('tab1', 'match-mid');
  assert.ok(prevMidMetrics.isVisible, 'Middle match must be visible after Previous');
  assert.ok(prevMidMetrics.scrollY < botMatchMetrics.scrollY, 'Viewport must scroll upward');

  // 7. Tab switching: Switch to Tab 2 and return to Tab 1
  await command({ type: 'open', id: tab2Id, provider: 'other', url: 'https://docs.maw-find-audit.org/doc2' });
  await command({
    type: 'layout',
    views: [{ id: tab2Id, bounds: { x: 0, y: 40, width: viewport.width, height: viewport.height - 40 } }],
    viewport,
  });

  await eventually(async () => {
    const m = await getTabElementMetrics('tab2', 'tab2-target');
    return m !== null;
  }, 'Tab 2 to load');

  // Switch back to Tab 1
  await command({
    type: 'layout',
    views: [{ id: tab1Id, bounds: { x: 0, y: 40, width: viewport.width, height: viewport.height - 40 } }],
    viewport,
  });

  // Verify Tab 1's scroll position and middle match visibility are preserved
  await eventually(async () => {
    const m = await getTabElementMetrics('tab1', 'match-mid');
    return m && m.isVisible;
  }, 'Tab 1 middle match position to be preserved across tab switch');

  const preservedMetrics = await getTabElementMetrics('tab1', 'match-mid');
  assert.ok(preservedMetrics.isVisible, 'Middle match must remain visible after returning from Tab 2');

  // 8. Focus styling / border verification
  const viewStyles = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const views = win.contentView.children.filter((c) => c.webContents);
    return {
      count: views.length,
      bounds: views.map((v) => v.getBounds()),
    };
  });

  assert.equal(viewStyles.count, 1, 'Only active tab view is attached to contentView');
  // Tab 1 view has the active layout bounds
  assert.equal(viewStyles.bounds[0].width, viewport.width);
  assert.equal(viewStyles.bounds[0].height, viewport.height - 40);

  // Stop find session cleanly
  await command({ type: 'stop-find-in-page', id: tab1Id, action: 'clearSelection' });
});

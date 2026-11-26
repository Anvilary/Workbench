import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(import.meta.url);
const here = DESKTOP_ROOT;
const electronExecutable = process.env.WORKBENCH_ELECTRON_EXECUTABLE || (fs.existsSync('/opt/workbench-electron/45.2.0/electron')
  ? '/opt/workbench-electron/45.2.0/electron'
  : require('electron'));

async function eventually(check, message = 'condition', maxAttempts = 50, delayMs = 100) {
  for (let n = 0; n < maxAttempts; n++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  assert.fail('Timed out waiting for ' + message);
}

test('Electron runtime: universal internal navigation, rendering compatibility, and explicit external browser action', { timeout: 90000 }, async (t) => {
  const data = await mkdtemp(path.join(tmpdir(), 'maw-universal-nav-'));
  const screenshotDir = path.join(data, 'screenshots');
  await mkdir(screenshotDir, { recursive: true });

  // Minimal UI shell server that subscribes to workbench events
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Workbench Universal Nav Test</title></head>
<body>
  <div id="root"></div>
  <script>
    window.events = [];
    window.workbench.subscribe(msg => {
      window.events.push(msg);
    });
  </script>
</body>
</html>`);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;

  const env = {
    ...process.env,
    HOME: data,
    WORKBENCH_DESKTOP_DATA_DIR: data,
    WORKBENCH_DESKTOP_URL: `http://127.0.0.1:${serverPort}/`,
    WORKBENCH_EXTERNAL_POLICY: 'allow',
  };

  let app;
  t.after(async () => {
    if (app) {
      const closed = app.close().then(() => true, () => false);
      const finished = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
      if (!finished) {
        try { app.process().kill('SIGKILL'); } catch {}
      }
    }
    await new Promise(resolve => server.close(resolve));
    await rm(data, { recursive: true, force: true });
  });

  app = await electron.launch({
    chromiumSandbox: true,
    executablePath: electronExecutable,
    args: [here, '--ozone-platform=x11'],
    env,
  });

  const page = await app.firstWindow();
  await page.waitForFunction(() => Array.isArray(window.events), null, { timeout: 15000 });

  // Setup custom protocol handlers in persist:workbench-browser to simulate sites
  await app.evaluate(({ session }) => {
    const browser = session.fromPartition('persist:workbench-browser');
    globalThis.__openedExternalUrls = [];

    // Protocol handler simulating synthetic Google Ads, multi-domain links, and redirects
    browser.protocol.handle('https', async (req) => {
      const u = new URL(req.url);

      if (u.hostname === 'ads.google.com' && u.pathname === '/redirect-hop') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://site-c.example.com/landing' },
        });
      }

      if (u.hostname === 'ads.google.com') {
        return new Response(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Google Ads Account Selection</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: Roboto, sans-serif;
      color: #202124;
      /* Notice: body has no background-color specified, defaults to transparent */
    }
    .header {
      background-color: #ffffff;
      height: 64px;
      display: flex;
      align-items: center;
      padding: 0 24px;
      border-bottom: 1px solid #dadce0;
    }
    .account-dialog {
      margin: 40px auto;
      max-width: 600px;
      padding: 24px;
      border: 1px solid #dadce0;
      border-radius: 8px;
    }
    .account-title {
      font-size: 20px;
      font-weight: 500;
      color: #202124;
    }
    .account-email {
      font-size: 14px;
      color: #5f6368;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="header">
    <span style="font-weight: bold; font-size: 18px; color: #1a73e8;">Google Ads</span>
  </div>
  <div class="account-dialog">
    <div class="account-title" id="account-heading">Select an account</div>
    <div class="account-email" id="account-sub">alexandre@example.com</div>
    <p>Choose an account to continue to Keyword Planner.</p>
    <a id="link-to-site-b" href="https://site-b.example.com/dashboard">Continue to Dashboard (Same Tab)</a><br><br>
    <a id="link-new-tab" href="https://site-b.example.com/docs" target="_blank">Documentation (New Tab)</a><br><br>
    <a id="link-redirect" href="https://ads.google.com/redirect-hop">Redirect Cross-Domain</a><br><br>
    <a id="link-blocked-local" href="http://127.0.0.1:8080/admin">Blocked Local Link</a><br><br>
    <a id="link-blocked-file" href="file:///etc/passwd">Blocked File Link</a>
  </div>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      if (u.hostname === 'site-b.example.com') {
        return new Response(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Site B Dashboard</title></head>
<body>
  <h1 id="b-title">Welcome to Site B Dashboard</h1>
  <p id="b-origin">Origin: https://site-b.example.com</p>
  <a id="b-back-link" href="https://ads.google.com/nav/selectaccount">Back to Google Ads</a>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      if (u.hostname === 'site-c.example.com') {
        return new Response(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Site C Landing</title></head>
<body>
  <h1 id="c-title">Site C Landing Page</h1>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      if (u.hostname === 'auth.example.com') {
        return new Response(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>OAuth Provider</title></head>
<body>
  <h1>OAuth Auth Dialog</h1>
  <button id="auth-finish" onclick="if (window.opener) window.opener.postMessage('auth-complete', '*'); window.close();">Authorize</button>
</body>
</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      return new Response('Not found', { status: 404 });
    });
  });

  const tabId = '11111111-2222-4333-8444-555555555555';
  const initialUrl = 'https://ads.google.com/nav/selectaccount';

  // 1. Open the synthetic Google Ads page in an 'other' browser tab
  await page.evaluate(({ id, url }) => {
    return window.workbench.command({ type: 'open', id, provider: 'other', url });
  }, { id: tabId, url: initialUrl });

  // Attach and layout the view so it is visible and attached to the main window
  const [winWidth, winHeight] = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => !w.getParentWindow());
    return win.getContentSize();
  });

  await page.evaluate(({ id, w, h }) => {
    return window.workbench.command({
      type: 'layout',
      id,
      bounds: { x: 0, y: 0, width: w, height: h },
      viewport: { width: w, height: h },
    });
  }, { id: tabId, w: winWidth, h: winHeight });

  // Wait for the WebContentsView to attach and render
  await eventually(async () => {
    return app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => !w.getParentWindow());
      const views = win?.contentView?.children?.filter(v => v.webContents) || [];
      return views.length >= 1;
    });
  }, 'WebContentsView to attach');

  // Find the WebContents of the tab
  const tabWebContentsId = await app.evaluate(({ session, webContents }) => {
    const s = session.fromPartition('persist:workbench-browser');
    const c = webContents.getAllWebContents().find(item => item.session === s);
    return c?.id;
  });
  assert.ok(tabWebContentsId, 'Tab WebContents must exist');

  // Wait for page to finish loading
  await eventually(async () => {
    return app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id);
      return c && !c.isLoading() && c.getURL().includes('ads.google.com');
    }, tabWebContentsId);
  }, 'Google Ads page to load');

  // 2. VERIFY RENDERING COMPATIBILITY:
  // Check the effective canvas background and computed styling
  const renderVerification = await app.evaluate(async ({ webContents }, id) => {
    const c = webContents.fromId(id);
    return c.executeJavaScript(`(() => {
      const bodyStyle = window.getComputedStyle(document.body);
      const dialog = document.querySelector('.account-dialog');
      const dialogStyle = window.getComputedStyle(dialog);
      const heading = document.getElementById('account-heading');
      const headingStyle = window.getComputedStyle(heading);

      return {
        bodyBg: bodyStyle.backgroundColor,
        dialogBg: dialogStyle.backgroundColor,
        headingColor: headingStyle.color,
      };
    })()`);
  }, tabWebContentsId);

  // Body and dialog are transparent rgba(0, 0, 0, 0)
  assert.equal(renderVerification.bodyBg, 'rgba(0, 0, 0, 0)');
  assert.equal(renderVerification.dialogBg, 'rgba(0, 0, 0, 0)');
  assert.equal(renderVerification.headingColor, 'rgb(32, 33, 36)'); // #202124

  // Now capture pixels to verify canvas background is white (#ffffff), not dark (#212121)
  const imageCapture = await app.evaluate(async ({ BrowserWindow, webContents }, id) => {
    const win = BrowserWindow.getAllWindows().find(w => !w.getParentWindow());
    const view = win.contentView.children.find(v => v.webContents?.id === id);
    if (!view) return null;

    // Position and size the view to capture
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    view.setVisible(true);

    const image = await view.webContents.capturePage();
    const bitmap = image.toBitmap(); // BGRA raw buffer
    // Sample a pixel in the body outside the header, e.g. at (100, 200)
    const x = 100;
    const y = 200;
    const stride = 800 * 4;
    const offset = y * stride + x * 4;
    const b = bitmap[offset];
    const g = bitmap[offset + 1];
    const r = bitmap[offset + 2];
    const a = bitmap[offset + 3];

    return { r, g, b, a, width: image.getSize().width, height: image.getSize().height };
  }, tabWebContentsId);

  assert.ok(imageCapture, 'Capture succeeded');
  // Canvas background must be neutral white (>= 240), completely eliminating dark-mode bleed (where R,G,B were 33)
  assert.ok(imageCapture.r >= 240, `Red channel must be >= 240 (white canvas), got ${imageCapture.r}`);
  assert.ok(imageCapture.g >= 240, `Green channel must be >= 240 (white canvas), got ${imageCapture.g}`);
  assert.ok(imageCapture.b >= 240, `Blue channel must be >= 240 (white canvas), got ${imageCapture.b}`);

  // 3. VERIFY UNIVERSAL INTERNAL NAVIGATION: NORMAL LINK (CROSS-DOMAIN)
  // Clicking an ordinary link (<a href="https://site-b.example.com/dashboard">)
  // MUST navigate inside the current Workbench browser tab, preserving the tab.
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id);
    c.executeJavaScript("document.getElementById('link-to-site-b').click()", true);
  }, tabWebContentsId);

  // Verify tab URL navigated to site-b inside the same WebContents
  await eventually(async () => {
    return app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id);
      return c && !c.isLoading() && c.getURL() === 'https://site-b.example.com/dashboard';
    }, tabWebContentsId);
  }, 'In-page navigation to site-b in same tab');

  // Verify no open-web-tab was emitted for normal in-page link
  const eventsAfterNav = await page.evaluate(() => window.events);
  const openTabEvents = eventsAfterNav.filter(e => e.type === 'open-web-tab');
  assert.equal(openTabEvents.length, 0, 'Normal link navigation must stay in same tab, not open a new tab');

  // 4. VERIFY BROWSER HISTORY: BACK & FORWARD WORK ACROSS CROSS-ORIGIN NAVIGATION
  await eventually(async () => {
    return app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id);
      return c.navigationHistory.canGoBack();
    }, tabWebContentsId);
  }, 'canGoBack to be true after cross-origin navigation');

  // Execute Back command
  await page.evaluate(({ id }) => {
    return window.workbench.command({ type: 'browser-action', id, action: 'back' });
  }, { id: tabId });

  // Verify URL returned to ads.google.com
  await eventually(async () => {
    return app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id);
      return c && !c.isLoading() && c.getURL().includes('ads.google.com');
    }, tabWebContentsId);
  }, 'Browser back to ads.google.com');

  // Execute Forward command
  await page.evaluate(({ id }) => {
    return window.workbench.command({ type: 'browser-action', id, action: 'forward' });
  }, { id: tabId });

  // Verify URL went forward to site-b
  await eventually(async () => {
    return app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id);
      return c && !c.isLoading() && c.getURL() === 'https://site-b.example.com/dashboard';
    }, tabWebContentsId);
  }, 'Browser forward to site-b');

  // Navigate back to Google Ads for remaining checks
  await page.evaluate(({ id }) => {
    return window.workbench.command({ type: 'browser-action', id, action: 'back' });
  }, { id: tabId });
  await eventually(async () => {
    return app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id);
      return c && !c.isLoading() && c.getURL().includes('ads.google.com');
    }, tabWebContentsId);
  }, 'Browser back to ads.google.com ready');

  // 5. VERIFY CROSS-DOMAIN REDIRECTS STAY IN WORKBENCH
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id);
    c.executeJavaScript("document.getElementById('link-redirect').click()", true);
  }, tabWebContentsId);

  // Verify redirect landed on site-c in the same tab
  await eventually(async () => {
    return app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id);
      return c && !c.isLoading() && c.getURL() === 'https://site-c.example.com/landing';
    }, tabWebContentsId);
  }, 'Redirect landed on site-c in same tab');

  // Navigate back to Google Ads
  await page.evaluate(({ id }) => {
    return window.workbench.command({ type: 'browser-action', id, action: 'back' });
  }, { id: tabId });
  await eventually(async () => {
    return app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id);
      return c && !c.isLoading() && c.getURL().includes('ads.google.com');
    }, tabWebContentsId);
  }, 'Browser back to ads.google.com after redirect test');

  // 6. VERIFY NEW-TAB LINKS: target="_blank" REQUESTS A NEW WORKBENCH TAB
  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id);
    c.executeJavaScript("document.getElementById('link-new-tab').click()", true);
  }, tabWebContentsId);

  await eventually(async () => {
    const events = await page.evaluate(() => window.events);
    return events.some(e => e.type === 'open-web-tab' && e.url === 'https://site-b.example.com/docs');
  }, 'open-web-tab event for target="_blank" link');

  // 7. VERIFY BLOCKED DESTINATIONS: LOCALHOST / FILE PROTOCOL
  // Must NOT open external browser dialog, must emit concise error state
  await page.evaluate(() => { window.events.length = 0; });

  await app.evaluate(({ webContents }, id) => {
    const c = webContents.fromId(id);
    c.executeJavaScript("document.getElementById('link-blocked-local').click()", true);
  }, tabWebContentsId);

  await eventually(async () => {
    const events = await page.evaluate(() => window.events);
    return events.some(e => e.type === 'error' && e.id === tabId && /blocked for security/.test(e.message));
  }, 'Error event for blocked localhost destination');

  // Tab must remain on Google Ads (not navigating or crashed)
  const tabUrlAfterBlocked = await app.evaluate(({ webContents }, id) => {
    return webContents.fromId(id).getURL();
  }, tabWebContentsId);
  assert.ok(tabUrlAfterBlocked.includes('ads.google.com'), 'Tab preserved on original page');

  // 8. VERIFY EXPLICIT EXTERNAL BROWSER ACTIONS
  // Context menu "Open in external browser" triggers shell.openExternal directly
  await app.evaluate(({ shell }) => {
    globalThis.__openedExternally = [];
    shell.openExternal = async (targetUrl) => {
      globalThis.__openedExternally.push(targetUrl);
    };
  });

  // Test action: 'open-page'
  await page.evaluate(({ id }) => {
    return window.workbench.command({ type: 'browser-action', id, action: 'open-page' });
  }, { id: tabId });

  await eventually(async () => {
    return app.evaluate(() => globalThis.__openedExternally?.length >= 1);
  }, 'shell.openExternal called for open-page');

  const openedPageUrl = await app.evaluate(() => globalThis.__openedExternally[0]);
  assert.ok(openedPageUrl.includes('ads.google.com'), 'Explicit open-page opened current URL in external browser');

  // Test action: 'open-link-external'
  await page.evaluate(({ id }) => {
    return window.workbench.command({
      type: 'browser-action',
      id,
      action: 'open-link-external',
      url: 'https://site-c.example.com/landing',
    });
  }, { id: tabId });

  await eventually(async () => {
    return app.evaluate(() => globalThis.__openedExternally?.length >= 2);
  }, 'shell.openExternal called for open-link-external');

  const openedLinkUrl = await app.evaluate(() => globalThis.__openedExternally[1]);
  assert.equal(openedLinkUrl, 'https://site-c.example.com/landing', 'Explicit open-link-external opened link URL in external browser');
});

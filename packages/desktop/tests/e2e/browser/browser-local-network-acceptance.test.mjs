import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

test('Electron runtime: local web application browsing, websocket, asset loading and private network protection', { timeout: 90000 }, async (t) => {
  const data = await mkdtemp(path.join(tmpdir(), 'maw-local-network-'));

  // 1. Local web app server with HTTP, API endpoint, and WebSocket server
  let wsReceivedMessage = '';
  const localAppServer = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Local Web App Dashboard</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <h1 id="app-heading">Local Service Running</h1>
  <div id="api-status">loading</div>
  <div id="ws-status">disconnected</div>
  <a id="internal-link" href="/page2">Go to Page 2</a>
  <script src="/app.js"></script>
</body>
</html>`);
      return;
    }
    if (url.pathname === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(`body { background-color: #f0f0f0; color: #111; }`);
      return;
    }
    if (url.pathname === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`
        fetch('/api/status')
          .then(r => r.json())
          .then(data => {
            document.getElementById('api-status').textContent = data.status;
          })
          .catch(err => {
            document.getElementById('api-status').textContent = 'fetch-failed';
          });

        const ws = new WebSocket('ws://' + window.location.host + '/ws');
        ws.onopen = () => {
          document.getElementById('ws-status').textContent = 'connected';
          ws.send('ping-from-local-app');
        };
        ws.onerror = () => {
          document.getElementById('ws-status').textContent = 'ws-error';
        };
      `);
      return;
    }
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'api-success', port: localAppServer.address().port }));
      return;
    }
    if (url.pathname === '/secret') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('classified-local-data');
      return;
    }
    if (url.pathname === '/page2') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body><h1 id="page2-heading">Local Page 2</h1></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  localAppServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const digest = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${digest}\r\n\r\n`
    );
    socket.on('data', (buf) => {
      if (buf.length < 6) return;
      const mask = buf.subarray(2, 6);
      const payload = buf.subarray(6);
      const decoded = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        decoded[i] = payload[i] ^ mask[i % 4];
      }
      wsReceivedMessage = decoded.toString('utf8');
    });
  });

  await new Promise(resolve => localAppServer.listen(0, '127.0.0.1', resolve));
  const localAppPort = localAppServer.address().port;

  // 2. Minimal UI Shell server
  const shellServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Workbench Shell</title></head>
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

  await new Promise(resolve => shellServer.listen(0, '127.0.0.1', resolve));
  const shellPort = shellServer.address().port;

  const env = {
    ...process.env,
    HOME: data,
    WORKBENCH_DESKTOP_DATA_DIR: data,
    WORKBENCH_DESKTOP_URL: `http://127.0.0.1:${shellPort}/`,
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
    localAppServer.close();
    shellServer.close();
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

  // Setup protocol handler in persist:workbench-browser to simulate a public site that attempts cross-network redirect
  await app.evaluate(({ session }, { localAppPort }) => {
    const browser = session.fromPartition('persist:workbench-browser');
    browser.protocol.handle('https', async (req) => {
      const u = new URL(req.url);
      if (u.hostname === 'public-attacker.example.com' && u.pathname === '/redirect-to-local') {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${localAppPort}/secret` },
        });
      }
      if (u.hostname === 'public-attacker.example.com' && u.pathname === '/') {
        return new Response(`<!doctype html><html><body><h1>Public Attacker</h1><a id="redirect-link" href="/redirect-to-local">Trigger Redirect</a><a id="local-link" href="http://127.0.0.1:${localAppPort}/secret">Trigger Local</a></body></html>`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('<!doctype html><html><body><h1>Public Page</h1></body></html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    });
  }, { localAppPort });

  const tabId = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';
  const localAppUrl = `http://127.0.0.1:${localAppPort}/`;

  // 3. Open local web app tab
  await page.evaluate(({ id, url }) => {
    return window.workbench.command({
      type: 'open',
      id,
      url,
      provider: 'other',
    });
  }, { id: tabId, url: localAppUrl });

  // Attach and layout the view
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

  // Wait for the WebContentsView to attach
  await eventually(async () => {
    return app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => !w.getParentWindow());
      const views = win?.contentView?.children?.filter(v => v.webContents) || [];
      return views.length >= 1;
    });
  }, 'WebContentsView to attach');

  const tabWebContentsId = await app.evaluate(({ session, webContents }) => {
    const s = session.fromPartition('persist:workbench-browser');
    const c = webContents.getAllWebContents().find(item => item.session === s);
    return c?.id;
  });
  assert.ok(tabWebContentsId, 'Tab WebContents must exist');

  // Wait for local app page to finish loading
  await eventually(async () => {
    return app.evaluate(({ webContents }, { id, port }) => {
      const c = webContents.fromId(id);
      return c && !c.isLoading() && c.getURL().includes(`:${port}`);
    }, { id: tabWebContentsId, port: localAppPort });
  }, 'local web app to load');

  // 4. Verify local application DOM, CSS styling, API fetch, and WebSocket messaging
  await eventually(async () => {
    const status = await app.evaluate(async ({ webContents }, id) => {
      const c = webContents.fromId(id);
      return c.executeJavaScript(`(() => {
        const heading = document.getElementById('app-heading')?.textContent || '';
        const api = document.getElementById('api-status')?.textContent || '';
        const ws = document.getElementById('ws-status')?.textContent || '';
        const bg = window.getComputedStyle(document.body).backgroundColor;
        return { heading, api, ws, bg };
      })()`);
    }, tabWebContentsId);

    return (
      status.heading === 'Local Service Running' &&
      status.api === 'api-success' &&
      status.ws === 'connected' &&
      status.bg === 'rgb(240, 240, 240)'
    );
  }, 'local app DOM, API fetch, WebSocket and CSS verification');

  assert.equal(wsReceivedMessage, 'ping-from-local-app', 'WebSocket server received message from local app');

  // 5. In-place navigation within local app
  await app.evaluate(async ({ webContents }, id) => {
    const c = webContents.fromId(id);
    await c.executeJavaScript("document.getElementById('internal-link').click()", true);
  }, tabWebContentsId);

  await eventually(async () => {
    return app.evaluate(async ({ webContents }, id) => {
      const c = webContents.fromId(id);
      const url = c.getURL();
      const heading = await c.executeJavaScript("document.getElementById('page2-heading')?.textContent || ''");
      return url.includes('/page2') && heading === 'Local Page 2';
    }, tabWebContentsId);
  }, 'in-place navigation to local Page 2');

  // 6. Navigation history works for local apps (back to home page)
  await page.evaluate(({ id }) => {
    return window.workbench.command({
      type: 'browser-action',
      id,
      action: 'back',
    });
  }, { id: tabId });

  await eventually(async () => {
    return app.evaluate(async ({ webContents }, id) => {
      const c = webContents.fromId(id);
      const heading = await c.executeJavaScript("document.getElementById('app-heading')?.textContent || ''");
      return heading === 'Local Service Running';
    }, tabWebContentsId);
  }, 'navigated back to local home page');

  // 7. Workbench backend loopback port protection
  // An embedded tab must NEVER be able to navigate to the Workbench backend port
  await page.evaluate(({ id, shellPort }) => {
    return window.workbench.command({
      type: 'update',
      id,
      url: `http://127.0.0.1:${shellPort}/`,
      provider: 'other',
    }).catch(() => {});
  }, { id: tabId, shellPort });

  await new Promise(r => setTimeout(r, 600));
  const currentUrl = await app.evaluate(({ webContents }, id) => {
    return webContents.fromId(id)?.getURL() || '';
  }, tabWebContentsId);
  assert.ok(!currentUrl.includes(`:${shellPort}`), 'Workbench backend port was protected and not loaded');

  // 8. Cross-network navigation and automatic redirect from public website to local network address are blocked
  // Navigate to public attacker site first
  await page.evaluate(({ id }) => {
    return window.workbench.command({
      type: 'update',
      id,
      url: 'https://public-attacker.example.com/',
      provider: 'other',
    });
  }, { id: tabId });

  await eventually(async () => {
    return app.evaluate(({ webContents }, id) => {
      const c = webContents.fromId(id);
      return c && !c.isLoading() && c.getURL().startsWith('https://public-attacker.example.com');
    }, tabWebContentsId);
  }, 'public attacker site to load');

  // Trigger redirect to local network
  await app.evaluate(async ({ webContents }, id) => {
    const c = webContents.fromId(id);
    await c.executeJavaScript("document.getElementById('redirect-link').click()", true);
  }, tabWebContentsId);

  await eventually(async () => {
    const events = await page.evaluate(() => window.events);
    return events.some(e => e.type === 'error' && (e.message?.includes('blocked') || e.message?.includes('redirect')));
  }, 'automatic cross-network redirect to local address blocked with error event');

  // Close tab cleanly
  await page.evaluate(({ id }) => {
    return window.workbench.command({ type: 'close', id });
  }, { id: tabId });
});

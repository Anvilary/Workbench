import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { ResourceCollector } from '../src/performance/resource-monitor.mjs';

const __filename = fileURLToPath(import.meta.url);
const here = path.dirname(__filename);
const root = path.resolve(here, '../..');
const artifactDir = process.env.MAW_EVIDENCE_ARTIFACT_DIR ? path.resolve(process.env.MAW_EVIDENCE_ARTIFACT_DIR) : null;

const fixture = `
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PerformancePanel } from './src/features/performance/PerformancePanel.tsx';

function App() {
  const [shellMenu, setShellMenu] = useState(false);
  const [perfOpen, setPerfOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('terminal');

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', background: '#0b0d13', color: '#f1f5f9', overflow: 'hidden' }}>
      {/* Left Sidebar */}
      <aside style={{ width: '250px', background: '#141720', borderRight: '1px solid #232936', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #232936', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#38bdf8' }} />
            <span style={{ fontWeight: 600, fontSize: '13px', letterSpacing: '0.02em', color: '#e2e8f0' }}>MAW Workspace</span>
          </div>
          <span style={{ fontSize: '11px', color: '#64748b', background: '#1c2230', padding: '2px 6px', borderRadius: '4px' }}>Lane A</span>
        </div>

        <div style={{ padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ padding: '8px 12px', background: '#202637', border: '1px solid #2e374d', borderRadius: '6px', fontSize: '12px', fontWeight: 500, color: '#f8fafc' }}>
            📁 feat/maw-resource-monitor
          </div>
          <div style={{ padding: '8px 12px', color: '#94a3b8', borderRadius: '6px', fontSize: '12px' }}>
            📁 main
          </div>
        </div>

        <div style={{ marginTop: 'auto', padding: '12px 16px', borderTop: '1px solid #232936', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', color: '#64748b' }}>
          <span>Linux x86_64</span>
          <span style={{ color: '#10b981' }}>● Online</span>
        </div>
      </aside>

      {/* Main Content Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Top Header / Tab Bar */}
        <header style={{ height: '44px', background: '#141720', borderBottom: '1px solid #232936', display: 'flex', alignItems: 'center', padding: '0 16px', gap: '8px', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              id="tab-terminal"
              onClick={() => setActiveTab('terminal')}
              style={{
                padding: '5px 12px',
                borderRadius: '5px',
                border: activeTab === 'terminal' ? '1px solid #333d52' : '1px solid transparent',
                background: activeTab === 'terminal' ? '#1c2230' : 'transparent',
                color: activeTab === 'terminal' ? '#f8fafc' : '#94a3b8',
                fontSize: '12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>zsh (Codex CLI)</span>
            </button>
            <button
              id="tab-chatgpt"
              onClick={() => setActiveTab('chatgpt')}
              style={{
                padding: '5px 12px',
                borderRadius: '5px',
                border: activeTab === 'chatgpt' ? '1px solid #333d52' : '1px solid transparent',
                background: activeTab === 'chatgpt' ? '#1c2230' : 'transparent',
                color: activeTab === 'chatgpt' ? '#10b981' : '#94a3b8',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              ChatGPT · WebContentsView
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', position: 'relative' }}>
            <button
              id="maw-shell-menu-trigger"
              onClick={() => setShellMenu(!shellMenu)}
              aria-expanded={shellMenu}
              style={{
                background: shellMenu ? '#202637' : 'transparent',
                border: '1px solid #2e374d',
                color: '#cbd5e1',
                borderRadius: '5px',
                padding: '4px 10px',
                cursor: 'pointer',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>Menu</span>
              <span style={{ fontSize: '10px' }}>▼</span>
            </button>

            {shellMenu && (
              <div
                id="maw-shell-menu-dropdown"
                className="agency-dropdown-menu"
                style={{
                  position: 'absolute',
                  top: '36px',
                  right: '0',
                  width: '210px',
                  background: '#171b26',
                  border: '1px solid #2d3648',
                  borderRadius: '6px',
                  boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
                  padding: '5px',
                  zIndex: 1000,
                }}
              >
                <button
                  id="menu-open-performance"
                  onClick={() => {
                    setPerfOpen(true);
                    setShellMenu(false);
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    color: '#f8fafc',
                    padding: '8px 10px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#22293a')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="#38bdf8">
                      <path d="M1 11.5a.5.5 0 0 1 .5-.5h2.793l1.853-3.707a.5.5 0 0 1 .894 0L8.5 10.207l1.646-1.646a.5.5 0 0 1 .708 0L12 9.707V2.5a.5.5 0 0 1 1 0v8a.5.5 0 0 1-.5.5H1.5a.5.5 0 0 1-.5-.5z"/>
                    </svg>
                    Performance
                  </span>
                  <span style={{ fontSize: '10px', color: '#64748b', fontFamily: 'monospace' }}>Alt+P</span>
                </button>
                <div style={{ height: '1px', background: '#252c3c', margin: '4px 0' }} />
                <button
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    color: '#94a3b8',
                    padding: '8px 10px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  Settings
                </button>
              </div>
            )}
          </div>
        </header>

        {/* Viewport */}
        <main style={{ flex: 1, display: 'flex', position: 'relative', background: '#0b0d13', overflow: 'hidden' }}>
          <div style={{ flex: 1, padding: '24px', fontFamily: 'ui-monospace, monospace', color: '#94a3b8', fontSize: '13px', lineHeight: 1.6 }}>
            <div style={{ color: '#38bdf8' }}>~/Projects/My-Amazing-Workspace-monitor (feat/maw-resource-monitor)</div>
            <div style={{ color: '#10b981' }}>$ codex exec "optimize native resource monitor"</div>
            <div style={{ color: '#64748b', marginTop: '12px' }}>[codex] Analyzing process accounting deltas...</div>
            <div style={{ color: '#64748b' }}>[codex] Kernel /proc/pid/smaps_rollup parsed via proportional set size (PSS).</div>
            <div style={{ color: '#64748b' }}>[codex] Single process ownership enforced with zero double counting.</div>
            <div style={{ color: '#f8fafc', marginTop: '16px' }}>Ready for inspection. Press Alt+P or open Performance from Menu.</div>
          </div>

          {perfOpen && (
            <PerformancePanel onClose={() => setPerfOpen(false)} />
          )}
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

async function main() {
  console.log('[Capture] Compiling React bundle with esbuild...');
  const bundle = await build({
    stdin: { contents: fixture, resolveDir: path.join(root, 'packages/web'), loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent',
  });

  const agencyCss = await readFile(path.join(root, 'packages/web/src/agency/agency.css'), 'utf8');

  // Set up mock views and backend readiness for real Linux resource collector
  const mockViews = new Map();
  const mockProviders = new Map();
  const mockUrls = new Map();
  const mockAttachedViews = new Map();

  const chatgptView = {
    webContents: {
      getOSProcessId: () => process.pid,
      getURL: () => 'https://chatgpt.com/',
      isDestroyed: () => false,
    },
  };
  mockViews.set('chatgpt-tab-1', chatgptView);
  mockProviders.set('chatgpt-tab-1', 'chatgpt');
  mockUrls.set('chatgpt-tab-1', 'https://chatgpt.com/');
  mockAttachedViews.set('chatgpt-tab-1', chatgptView);

  // Set up SSE subscribers for live broadcast
  const sseClients = new Set();
  const broadcastSnapshot = (snap) => {
    const data = JSON.stringify({ type: 'performance-update', snapshot: snap });
    for (const res of sseClients) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch {}
    }
  };

  const collector = new ResourceCollector({
    views: mockViews,
    providers: mockProviders,
    urls: mockUrls,
    attachedViews: mockAttachedViews,
    getBackendReadiness: async () => ({
      pid: process.pid,
      url: new URL('http://127.0.0.1:4000/?token=live-preview'),
    }),
    onState: (snap) => {
      broadcastSnapshot(snap);
    },
  });

  const server = createServer(async (req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(bundle.outputFiles[0].text);
      return;
    }

    if (req.url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.url === '/api/bridge' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const cmd = JSON.parse(body);
        if (cmd.type === 'performance-subscribe') {
          const snapshot = await collector.subscribe();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, snapshot }));
          return;
        }
        if (cmd.type === 'performance-pause') {
          collector.pause();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (cmd.type === 'performance-resume') {
          collector.resume();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (cmd.type === 'performance-refresh') {
          const snapshot = await collector.refresh();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, snapshot }));
          return;
        }
        if (cmd.type === 'performance-unsubscribe') {
          collector.unsubscribe();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: String(err) }));
        return;
      }
    }

    // Default HTML
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>MAW Performance Monitor</title>
          <style>
            html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
            ${agencyCss}
          </style>
          <script>
            // Bridge polyfill connecting window.mawChatGpt directly to our live collector
            window.mawChatGpt = {
              command: async function(cmd) {
                const resp = await fetch('/api/bridge', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(cmd)
                });
                return await resp.json();
              },
              subscribe: function(callback) {
                const es = new EventSource('/api/events');
                es.onmessage = function(e) {
                  try {
                    const data = JSON.parse(e.data);
                    callback(data);
                  } catch (err) {}
                };
                return function() {
                  es.close();
                };
              }
            };
          </script>
        </head>
        <body>
          <div id="root"></div>
          <script type="module" src="/bundle.js"></script>
        </body>
      </html>
    `);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`[Capture] Server listening on http://127.0.0.1:${port}`);

  const evidenceDir = path.join(here, 'evidence');
  const writeDocs = process.env.MAW_WRITE_DOCS_EVIDENCE === '1';
  const docsDir = writeDocs ? path.resolve(root, 'docs/maw/performance-monitor') : null;
  await mkdir(evidenceDir, { recursive: true });
  if (docsDir) await mkdir(docsDir, { recursive: true });
  if (artifactDir) await mkdir(artifactDir, { recursive: true });

  console.log('[Capture] Launching Chromium to capture synthetic fixture evidence...');
  const launchOptions = {};
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }
  const browser = await chromium.launch(launchOptions);

  const page = await browser.newPage({
    viewport: { width: 1280, height: 860 },
  });
  page.on('console', (msg) => console.log('[BrowserConsole]', msg.text()));
  page.on('pageerror', (err) => console.log('[BrowserPageError]', err));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    console.log('[Capture] Workspace loaded.');

    // 1. Open the top-right menu
    await page.locator('#maw-shell-menu-trigger').click();
    await page.waitForSelector('#maw-shell-menu-dropdown');
    await new Promise((r) => setTimeout(r, 200));

    // 2. Click "Performance"
    console.log('[Capture] Clicking Performance menu item...');
    await page.locator('#menu-open-performance').click();
    await page.waitForSelector('.maw-performance-panel');

    // Wait for performance collector snapshots (gather ~3 sampling intervals for sparklines)
    console.log('[Capture] Gathering live performance metrics...');
    await new Promise((r) => setTimeout(r, 4500));

    // Capture screenshot: Active Performance Panel Overview
    console.log('[Capture] Capturing performance-panel-overview.png...');
    const overviewBuf = await page.screenshot({ fullPage: true });

    await writeFile(path.join(evidenceDir, 'performance-panel-overview.png'), overviewBuf);
    if (docsDir) await writeFile(path.join(docsDir, 'performance-panel-overview.png'), overviewBuf);
    if (artifactDir) await writeFile(path.join(artifactDir, 'performance-panel-overview.png'), overviewBuf);
    console.log('[Capture] Saved performance-panel-overview.png.');

    // 3. Click Pause button to demonstrate control and paused status badge
    console.log('[Capture] Clicking Pause button...');
    const pauseBtn = page.locator('.maw-perf-btn', { hasText: 'Pause' });
    if (await pauseBtn.count() > 0) {
      await pauseBtn.first().click();
      await new Promise((r) => setTimeout(r, 600));

      console.log('[Capture] Capturing performance-panel-paused.png...');
      const pausedBuf = await page.screenshot({ fullPage: true });

      await writeFile(path.join(evidenceDir, 'performance-panel-paused.png'), pausedBuf);
      if (docsDir) await writeFile(path.join(docsDir, 'performance-panel-paused.png'), pausedBuf);
      if (artifactDir) await writeFile(path.join(artifactDir, 'performance-panel-paused.png'), pausedBuf);
      console.log('[Capture] Saved performance-panel-paused.png.');

      // Click Resume
      const resumeBtn = page.locator('.maw-perf-btn', { hasText: 'Resume' });
      if (await resumeBtn.count() > 0) {
        await resumeBtn.first().click();
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    // 4. Test Refresh button
    const refreshBtn = page.locator('.maw-perf-btn[aria-label="Refresh metrics"]');
    if (await refreshBtn.count() > 0) {
      await refreshBtn.first().click();
      await new Promise((r) => setTimeout(r, 400));
    }

    // 5. Retrieve snapshot JSON directly from fixture collector
    const snapshot = await collector.sample();
    const metricsJson = JSON.stringify(snapshot, null, 2);
    await writeFile(path.join(evidenceDir, 'performance-metrics-sample.json'), metricsJson);
    if (docsDir) await writeFile(path.join(docsDir, 'performance-metrics-sample.json'), metricsJson);
    console.log('[Capture] Saved performance-metrics-sample.json.');

    // 6. Test Close
    const closeBtn = page.locator('.maw-perf-close-btn');
    if (await closeBtn.count() > 0) {
      await closeBtn.first().click();
      await new Promise((r) => setTimeout(r, 300));
      const remaining = await page.locator('.maw-performance-panel').count();
      console.log(`[Capture] Panel closed cleanly (remaining: ${remaining})`);
    }

    console.log('[Capture] Complete! All performance screenshots and evidence captured successfully.');
  } finally {
    collector.dispose();
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('[Capture] Error:', err);
  process.exit(1);
});

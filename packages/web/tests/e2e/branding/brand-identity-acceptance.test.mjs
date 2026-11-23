import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = WEB_ROOT;
const evidenceDir = path.join(webRoot, 'tests/evidence/brand');
const artifactEvidenceDir = '/home/user/.local/share/agy-5-profile/home/.gemini/antigravity-cli/brain/63d72703-9f11-400b-a643-fe0cc65e6ecd/visual-evidence';
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(artifactEvidenceDir, { recursive: true });

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

const fixtureCode = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchApp } from './src/app/WorkbenchApp.tsx';

class MockConnection {
  constructor() {
    this.statusListeners = new Set();
    this.messageListeners = new Set();
  }
  getStatus() { return 'open'; }
  onStatus(fn) { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }
  onReopen(fn) { return () => {}; }
  onMessage(fn) { this.messageListeners.add(fn); return () => this.messageListeners.delete(fn); }
  sendImmediate(data) {
    const msg = typeof data === 'string' ? JSON.parse(data) : data;
    this.handleClientMessage(msg);
    return true;
  }
  send(data) { this.sendImmediate(data); }
  handleClientMessage(m) {
    const reply = (type, payload) => {
      const resp = { type, requestId: m.requestId, ...payload };
      this.messageListeners.forEach(fn => fn(resp));
    };
    setTimeout(() => {
      switch (m.type) {
        case 'agency.projects.list':
          reply('agency.projects.snapshot', { projects: [] });
          break;
        case 'agency.workspaces.list':
          reply('agency.workspaces.snapshot', { workspaces: [] });
          break;
        case 'agency.sessions.list':
          reply('agency.sessions.snapshot', { sessions: [] });
          break;
        case 'agency.profiles.list':
          reply('agency.profiles.snapshot', { profiles: [] });
          break;
        case 'agency.webTabs.list':
          reply('agency.webTabs.snapshot', { tabs: [] });
          break;
        case 'agency.editorTabs.list':
          reply('agency.editorTabs.snapshot', { tabs: [] });
          break;
        case 'agency.notifications.list':
          reply('agency.notifications.snapshot', { notifications: [], activityStates: {} });
          break;
        default:
          break;
      }
    }, 10);
  }
}

const conn = new MockConnection();
createRoot(document.getElementById('root')).render(<WorkbenchApp connection={conn} />);
`;

test('Brand Identity Acceptance: canonical logo rendering across sidebar, topbar, welcome, settings about, and favicons', async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium executable not found');
    return;
  }

  const result = await build({
    stdin: {
      contents: fixtureCode,
      resolveDir: webRoot,
      sourcefile: 'brand-test-fixture.tsx',
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    loader: { '.png': 'dataurl', '.svg': 'text', '.css': 'empty' },
  });

  const bundleJs = result.outputFiles[0].text;
  const css = readFileSync(path.join(webRoot, 'src/app/workbench.css'), 'utf8');

  const server = createServer((req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    if (pathname === '/bundle.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(bundleJs);
      return;
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/x-icon' });
      res.end(readFileSync(path.join(webRoot, 'public/favicon.ico')));
      return;
    }

    if (pathname.startsWith('/brand/')) {
      const brandFile = path.join(webRoot, 'public', pathname);
      if (existsSync(brandFile)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(readFileSync(brandFile));
        return;
      }
    }

    if (pathname === '/favicon-32x32.png' || pathname === '/favicon-16x16.png' || pathname === '/apple-touch-icon.png') {
      const iconFile = path.join(webRoot, 'public', pathname.slice(1));
      if (existsSync(iconFile)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(readFileSync(iconFile));
        return;
      }
    }

    if (pathname === '/site.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
      res.end(readFileSync(path.join(webRoot, 'public/site.webmanifest')));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="icon" type="image/x-icon" href="/favicon.ico" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <style>
    ${css}
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: #0e0e10; }
  </style>
</head>
<body class="agency-app">
  <div id="root"></div>
  <script type="module" src="/bundle.js"></script>
</body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // Monitor favicon requests
  const requestedIcons = [];
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('favicon') || url.includes('apple-touch-icon') || url.includes('site.webmanifest')) {
      requestedIcons.push({ url, status: response.status() });
    }
  });

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('.agency-nav-logo');

  // 1. Expanded sidebar brand logo
  const navLogo = page.locator('.agency-nav-logo');
  await navLogo.waitFor({ state: 'visible' });
  const navLogoNaturalWidth = await navLogo.evaluate((img) => img.naturalWidth);
  assert.ok(navLogoNaturalWidth > 0, 'Expanded sidebar logo must load successfully with positive naturalWidth');
  const sidebarPath = path.join(evidenceDir, 'brand-expanded-sidebar.png');
  await page.locator('.agency-nav-brand').screenshot({ path: sidebarPath });
  copyFileSync(sidebarPath, path.join(artifactEvidenceDir, 'brand-expanded-sidebar.png'));

  // 2. Welcome screen logo
  const welcomeLogo = page.locator('.agency-welcome-logo');
  await welcomeLogo.waitFor({ state: 'visible' });
  const welcomeNaturalWidth = await welcomeLogo.evaluate((img) => img.naturalWidth);
  assert.ok(welcomeNaturalWidth > 0, 'Welcome screen logo must load successfully with positive naturalWidth');
  const welcomePath = path.join(evidenceDir, 'brand-welcome-screen.png');
  await page.locator('.agency-welcome').screenshot({ path: welcomePath });
  copyFileSync(welcomePath, path.join(artifactEvidenceDir, 'brand-welcome-screen.png'));

  // 3. Collapsed sidebar brand logo (topbar)
  await page.click('button.agency-brand-toggle');
  const topbarLogo = page.locator('.agency-topbar-logo');
  await topbarLogo.waitFor({ state: 'visible' });
  const topbarNaturalWidth = await topbarLogo.evaluate((img) => img.naturalWidth);
  assert.ok(topbarNaturalWidth > 0, 'Collapsed sidebar topbar logo must load successfully with positive naturalWidth');
  const topbarPath = path.join(evidenceDir, 'brand-collapsed-sidebar.png');
  await page.locator('.agency-topbar-collapsed-brand').screenshot({ path: topbarPath });
  copyFileSync(topbarPath, path.join(artifactEvidenceDir, 'brand-collapsed-sidebar.png'));

  // 4. Open Settings and verify About section logo
  await page.click('#maw-shell-menu-trigger');
  await page.waitForSelector('#menu-open-settings');
  await page.click('#menu-open-settings');
  await page.waitForSelector('.settings-dialog');
  await page.click('#settings-tab-about');
  await page.waitForSelector('.maw-settings-about-hero');

  const aboutLogo = page.locator('.maw-settings-about-logo');
  await aboutLogo.waitFor({ state: 'visible' });
  const aboutNaturalWidth = await aboutLogo.evaluate((img) => img.naturalWidth);
  assert.ok(aboutNaturalWidth > 0, 'About settings section logo must load successfully with positive naturalWidth');
  const aboutPath = path.join(evidenceDir, 'brand-about-section.png');
  await page.locator('.maw-settings-about-hero').screenshot({ path: aboutPath });
  copyFileSync(aboutPath, path.join(artifactEvidenceDir, 'brand-about-section.png'));

  // 5. Verify direct favicon fetch
  const faviconRes = await page.request.get(`http://127.0.0.1:${port}/favicon.ico`);
  assert.equal(faviconRes.status(), 200);
  assert.equal(faviconRes.headers()['content-type'], 'image/x-icon');

  const png32Res = await page.request.get(`http://127.0.0.1:${port}/favicon-32x32.png`);
  assert.equal(png32Res.status(), 200);
  assert.equal(png32Res.headers()['content-type'], 'image/png');
});

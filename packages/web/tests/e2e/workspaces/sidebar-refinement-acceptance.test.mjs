import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = WEB_ROOT;

const ARTIFACT_EVIDENCE_DIR = process.env.ARTIFACT_DIR || path.join(homedir(), '.gemini/antigravity-cli/brain/00000000-0000-4000-8000-000000000000');
const LOCAL_EVIDENCE_DIR = path.join(webRoot, 'tests/evidence');

try { mkdirSync(LOCAL_EVIDENCE_DIR, { recursive: true }); } catch {}
try { mkdirSync(ARTIFACT_EVIDENCE_DIR, { recursive: true }); } catch {}

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const p = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(p)) return p;
  }
  return undefined;
}

const fixtureCode = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchApp } from './src/app/WorkbenchApp.tsx';

const p1 = '11111111-1111-4111-8111-111111111111';
const p2 = '22222222-2222-4222-8222-222222222222';
const ws1 = '33333333-3333-4333-8333-333333333333';
const ws2 = '44444444-4444-4444-8444-444444444444';
const tab1 = '66666666-6666-4666-8666-666666666666';
const now = new Date().toISOString();

// Create multiple projects and workspaces to demonstrate scrolling in sidebar
let projects = [
  { id: p1, name: 'Anvilary Tools', status: 'active', createdAt: now, updatedAt: now },
  { id: p2, name: 'Secondary Suite', status: 'active', createdAt: now, updatedAt: now },
  { id: 'p3', name: 'Cloud Integration', status: 'active', createdAt: now, updatedAt: now },
  { id: 'p4', name: 'Infrastructure Ops', status: 'active', createdAt: now, updatedAt: now },
  { id: 'p5', name: 'Telemetry Runtime', status: 'active', createdAt: now, updatedAt: now },
];

let workspaces = [
  { id: ws1, projectId: p1, name: 'Workbench', status: 'active', cwd: '/home/user/Projects', createdAt: now, updatedAt: now, doneAt: null },
  { id: ws2, projectId: p1, name: 'Workbench Core', status: 'active', cwd: '/home/user/Projects/core', createdAt: now, updatedAt: now, doneAt: null },
  { id: 'ws3', projectId: p2, name: 'Service Bus', status: 'active', cwd: '/home/user/Projects/bus', createdAt: now, updatedAt: now, doneAt: null },
  { id: 'ws4', projectId: 'p3', name: 'Gateway', status: 'active', cwd: '/var/cloud/gateway', createdAt: now, updatedAt: now, doneAt: null },
  { id: 'ws5', projectId: 'p4', name: 'Orchestrator', status: 'active', cwd: '/var/ops/orch', createdAt: now, updatedAt: now, doneAt: null },
  { id: 'ws6', projectId: 'p5', name: 'Metrics Collector', status: 'active', cwd: '/opt/telemetry', createdAt: now, updatedAt: now, doneAt: null },
];

let sessions = [
  {
    id: 'session-1',
    workspaceId: ws1,
    kind: 'terminal',
    terminalId: 'term-1',
    lifecycle: 'running',
    activity: 'idle',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    stoppedAt: null,
    exitCode: null,
    tab: { id: tab1, order: 0, selected: true, current: true, closedAt: null, name: 'Main Terminal', terminalNumber: 1 },
  },
];

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
          reply('agency.projects.snapshot', { projects: structuredClone(projects) });
          break;
        case 'agency.workspaces.list':
          reply('agency.workspaces.snapshot', { workspaces: structuredClone(workspaces) });
          break;
        case 'agency.sessions.list':
          reply('agency.sessions.snapshot', { sessions: structuredClone(sessions) });
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
    }, 5);
  }
}

const conn = new MockConnection();
createRoot(document.getElementById('root')).render(<WorkbenchApp connection={conn} />);
`;

test('Sidebar, branding, header, and navigation pre-release UI refinement', async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium executable not found');
    return;
  }

  const result = await build({
    stdin: {
      contents: fixtureCode,
      resolveDir: webRoot,
      sourcefile: 'test-fixture.tsx',
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
    if (req.url === '/bundle.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(bundleJs);
    } else if (req.url === '/brand/workbench-logo-128.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(readFileSync(path.join(webRoot, 'public/brand/workbench-logo-128.png')));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
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
    }
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

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}`);

  await page.waitForSelector('.agency-side-heading');
  await page.waitForSelector('.agency-workspace-nav-row');

  // Helper for dual screenshot saving
  const saveShot = async (name, clip = null) => {
    try {
      const opts = { path: path.join(LOCAL_EVIDENCE_DIR, name) };
      if (clip) opts.clip = clip;
      await page.screenshot(opts);
    } catch {}
    try {
      const opts = { path: path.join(ARTIFACT_EVIDENCE_DIR, name) };
      if (clip) opts.clip = clip;
      await page.screenshot(opts);
    } catch {}
  };

  // 1. Expanded sidebar baseline capture
  await saveShot('1-expanded-sidebar.png');

  // 2. Section 2: Sidebar Scrollbar Verification
  const scrollbarStyles = await page.evaluate(() => {
    const el = document.querySelector('.agency-side-section');
    if (!el) return null;
    const style = window.getComputedStyle(el);
    return {
      scrollbarWidth: style.scrollbarWidth,
      scrollbarColor: style.scrollbarColor,
    };
  });
  assert.ok(scrollbarStyles, 'Side section exists');
  assert.equal(scrollbarStyles.scrollbarWidth, 'thin');

  // Force scroll to verify scroll thumb is visible
  await page.evaluate(() => {
    const el = document.querySelector('.agency-side-section');
    if (el) el.scrollTop = 100;
  });
  await saveShot('4-subtle-scrollbar.png', { x: 0, y: 0, width: 260, height: 400 });

  // 3. Section 3: Projects Heading & Add Project button
  const headingStyles = await page.evaluate(() => {
    const span = document.querySelector('.agency-side-heading > span');
    const btn = document.querySelector('.agency-side-heading .agency-add-project-btn');
    if (!span || !btn) return null;
    const spanStyle = window.getComputedStyle(span);
    const btnStyle = window.getComputedStyle(btn);
    const spanRect = span.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    return {
      fontSize: spanStyle.fontSize,
      textTransform: spanStyle.textTransform,
      btnBorder: btnStyle.borderColor,
      btnBg: btnStyle.backgroundColor,
      btnWidth: btnRect.width,
      btnHeight: btnRect.height,
      spanCenterY: spanRect.top + spanRect.height / 2,
      btnCenterY: btnRect.top + btnRect.height / 2,
    };
  });
  assert.ok(headingStyles, 'Heading and add button exist');
  assert.equal(headingStyles.fontSize, '14px', 'Projects heading must be 14px');
  assert.equal(headingStyles.textTransform, 'uppercase', 'Projects heading must be uppercase');
  // Add Project button must have transparent background and border
  assert.ok(headingStyles.btnBg === 'rgba(0, 0, 0, 0)' || headingStyles.btnBg === 'transparent');
  assert.ok(headingStyles.btnBorder === 'rgba(0, 0, 0, 0)' || headingStyles.btnBorder === 'transparent');
  // Centers aligned within 1.5px
  assert.ok(Math.abs(headingStyles.spanCenterY - headingStyles.btnCenterY) <= 1.5, 'Heading and Add button must be on same centerline');
  assert.ok(headingStyles.btnWidth >= 28 && headingStyles.btnHeight >= 28, 'Hit target must remain comfortable');

  await saveShot('3-projects-heading-and-add-button.png', { x: 0, y: 53, width: 260, height: 60 });

  // 4. Section 4 & 5: Logo & Collapse/Expand
  const expandedLogoStyles = await page.evaluate(() => {
    const img = document.querySelector('.agency-nav-logo');
    const btn = document.querySelector('.agency-nav-head .agency-brand-toggle');
    if (!img || !btn) return null;
    const style = window.getComputedStyle(img);
    const rect = img.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      filter: style.filter,
      ariaExpanded: btn.getAttribute('aria-expanded'),
      ariaLabel: btn.getAttribute('aria-label'),
    };
  });
  assert.ok(expandedLogoStyles, 'Logo exists in expanded sidebar');
  assert.ok(Math.abs(expandedLogoStyles.width - 38) <= 1.5, 'Expanded logo width must be ~38px');
  assert.ok(Math.abs(expandedLogoStyles.height - 38) <= 1.5, 'Expanded logo height must be ~38px');
  assert.equal(expandedLogoStyles.filter, 'none', 'Orange drop shadow glow must be completely removed');
  assert.equal(expandedLogoStyles.ariaExpanded, 'true', 'Expanded logo toggle button must have aria-expanded="true"');
  assert.equal(expandedLogoStyles.ariaLabel, 'Collapse sidebar');

  // Verify separate toggle icon is removed
  const separateToggleCount = await page.locator('.agency-nav-head button.agency-icon-button').count();
  assert.equal(separateToggleCount, 0, 'Separate toggle icon button must be removed');

  // Section 6: Header consistency in expanded state
  const expandedHeaderHeight = await page.evaluate(() => {
    const navHead = document.querySelector('.agency-nav-head');
    const topbar = document.querySelector('.agency-topbar');
    return {
      navHeadHeight: navHead?.getBoundingClientRect().height,
      topbarHeight: topbar?.getBoundingClientRect().height,
    };
  });
  assert.equal(expandedHeaderHeight.navHeadHeight, 53, 'Header height must remain 53px');
  assert.equal(expandedHeaderHeight.topbarHeight, 53, 'Topbar height must remain 53px');

  // Section 8: Breadcrumbs structure
  const breadcrumbText = await page.locator('.agency-breadcrumbs').innerText();
  assert.ok(breadcrumbText.includes('Anvilary Tools'), 'Project title first');
  assert.ok(breadcrumbText.includes('Workbench'), 'Workspace title second');
  assert.ok(breadcrumbText.includes('/home/user/Projects'), 'Workspace path last');

  // Click logo to collapse sidebar
  await page.click('.agency-nav-head .agency-brand-toggle');
  await page.waitForFunction(() => document.querySelector('.agency-sidebar.agency-sidebar-collapsed') !== null);

  // 5. Collapsed sidebar state verification
  await saveShot('2-collapsed-sidebar.png');
  await saveShot('5-header-separator-and-breadcrumbs.png', { x: 0, y: 0, width: 800, height: 53 });

  const collapsedHeaderStyles = await page.evaluate(() => {
    const topbar = document.querySelector('.agency-topbar');
    const logoBtn = document.querySelector('.agency-topbar .agency-brand-toggle');
    const logoImg = document.querySelector('.agency-topbar .agency-topbar-logo');
    const divider = document.querySelector('.agency-topbar-divider');
    const topbarRect = topbar?.getBoundingClientRect();
    const logoRect = logoImg?.getBoundingClientRect();
    const dividerRect = divider?.getBoundingClientRect();
    const style = logoImg ? window.getComputedStyle(logoImg) : null;
    return {
      topbarHeight: topbarRect?.height,
      logoWidth: logoRect?.width,
      logoHeight: logoRect?.height,
      logoFilter: style?.filter,
      dividerWidth: dividerRect?.width,
      dividerHeight: dividerRect?.height,
      ariaExpanded: logoBtn?.getAttribute('aria-expanded'),
      ariaLabel: logoBtn?.getAttribute('aria-label'),
    };
  });
  assert.ok(collapsedHeaderStyles, 'Collapsed header elements exist');
  assert.equal(collapsedHeaderStyles.topbarHeight, 53, 'Header height must remain 53px in collapsed state');
  assert.ok(Math.abs(collapsedHeaderStyles.logoWidth - 38) <= 1.5, 'Collapsed logo must be ~38px');
  assert.ok(Math.abs(collapsedHeaderStyles.logoHeight - 38) <= 1.5, 'Collapsed logo must be ~38px');
  assert.equal(collapsedHeaderStyles.logoFilter, 'none', 'Collapsed logo must have no glow');
  assert.equal(collapsedHeaderStyles.ariaExpanded, 'false', 'Collapsed logo toggle has aria-expanded="false"');
  assert.equal(collapsedHeaderStyles.ariaLabel, 'Expand sidebar');
  assert.equal(collapsedHeaderStyles.dividerWidth, 1, 'Divider must be 1px wide');
  assert.ok(collapsedHeaderStyles.dividerHeight >= 16 && collapsedHeaderStyles.dividerHeight <= 22, 'Divider must be vertically centered (~18px)');

  // Click logo in header to expand sidebar again
  await page.click('.agency-topbar .agency-brand-toggle');
  await page.waitForFunction(() => Math.abs((document.querySelector('.agency-sidebar')?.getBoundingClientRect().width ?? 0) - 240) < 2);

  // 6. Section 9: Sidebar Drag-to-Collapse
  const resizer = page.locator('.agency-sidebar-resizer');
  const resizerBox = await resizer.boundingBox();
  assert.ok(resizerBox, 'Resizer element exists');

  // Drag to 200px: normal resize
  await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(200, resizerBox.y + 100);
  await page.waitForTimeout(50);
  const widthAt200 = await page.evaluate(() => document.querySelector('.agency-sidebar')?.getBoundingClientRect().width);
  assert.ok(Math.abs(widthAt200 - 200) <= 2, `Sidebar resizes to 200px (was ${widthAt200})`);

  // Drag below 150px into collapse zone (e.g. 110px)
  await page.mouse.move(110, resizerBox.y + 100);
  await page.waitForTimeout(50);
  const inCollapseZone = await page.evaluate(() => document.querySelector('.agency-sidebar')?.classList.contains('agency-sidebar-collapsing'));
  assert.ok(inCollapseZone, 'Sidebar enters collapsing visual state when dragged < 150px');
  await saveShot('6-sidebar-resize-threshold.png', { x: 0, y: 0, width: 350, height: 400 });

  // Release in collapse zone -> collapses completely
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.agency-sidebar.agency-sidebar-collapsed') !== null);

  // Expanding restores usable width
  await page.click('.agency-topbar .agency-brand-toggle');
  await page.waitForFunction(() => Math.abs((document.querySelector('.agency-sidebar')?.getBoundingClientRect().width ?? 0) - 240) < 2);
  const restoredWidth = await page.evaluate(() => document.querySelector('.agency-sidebar')?.getBoundingClientRect().width);
  assert.ok(restoredWidth >= 180, 'Restored width must be usable (>= 180px)');

  // 7. Keyboard resizing and collapse
  await resizer.focus();
  // Press ArrowLeft repeatedly to reach minimum width and trigger collapse
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('ArrowLeft');
  }
  await page.waitForFunction(() => document.querySelector('.agency-sidebar.agency-sidebar-collapsed') !== null);
  // Expand with keyboard Enter
  const topbarToggle = page.locator('.agency-topbar .agency-brand-toggle');
  await topbarToggle.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.agency-sidebar.agency-sidebar-collapsed') === null);

  // 8. Responsive viewport tests
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
    { width: 480, height: 800 },
  ];

  for (const vp of viewports) {
    await page.setViewportSize(vp);
    const topbarBox = await page.locator('.agency-topbar').boundingBox();
    assert.ok(topbarBox, `Topbar exists at ${vp.width}x${vp.height}`);
    assert.equal(topbarBox.height, 53, `Topbar height is 53px at ${vp.width}x${vp.height}`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = WEB_ROOT;

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
const ws3 = '55555555-5555-4555-8555-555555555555';
const tab1 = '66666666-6666-4666-8666-666666666666';
const now = new Date().toISOString();

let projects = [
  { id: p1, name: 'Project Alpha', status: 'active', createdAt: now, updatedAt: now },
  { id: p2, name: 'Project Beta', status: 'active', createdAt: now, updatedAt: now },
];

let workspaces = [
  { id: ws1, projectId: p1, name: 'Workspace 1', status: 'active', cwd: '/workspaces/ws1', createdAt: now, updatedAt: now, doneAt: null },
  { id: ws2, projectId: p1, name: 'Workspace 2', status: 'active', cwd: '/workspaces/ws2', createdAt: now, updatedAt: now, doneAt: null },
  { id: ws3, projectId: p2, name: 'Workspace 3', status: 'active', cwd: '/workspaces/ws3', createdAt: now, updatedAt: now, doneAt: null },
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

const requests = [];
window.agencyTest = {
  requests,
  getState: () => ({ projects, workspaces, sessions }),
};

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
    requests.push(msg);
    this.handleClientMessage(msg);
    return true;
  }
  send(data) {
    this.sendImmediate(data);
  }
  handleClientMessage(m) {
    const reply = (type, payload) => {
      const resp = { type, requestId: m.requestId, ...payload };
      this.messageListeners.forEach(fn => fn(resp));
    };
    const broadcast = (payload) => {
      this.messageListeners.forEach(fn => fn(payload));
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
        case 'agency.projects.order':
          {
            const orderMap = new Map(m.projectIds.map((id, idx) => [id, idx]));
            projects.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
            reply('agency.projects.snapshot', { projects: structuredClone(projects) });
            broadcast({ type: 'agency.project.changed', change: 'reordered', projectId: m.projectIds[0], projects: structuredClone(projects) });
          }
          break;
        case 'agency.workspaces.order':
          {
            const orderMap = new Map(m.workspaceIds.map((id, idx) => [id, idx]));
            workspaces.sort((a, b) => {
              if (a.projectId !== m.projectId || b.projectId !== m.projectId) return 0;
              return (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999);
            });
            reply('agency.workspaces.snapshot', { workspaces: structuredClone(workspaces) });
            broadcast({ type: 'agency.workspace.changed', change: 'reordered', workspaceId: m.workspaceIds[0], workspaces: structuredClone(workspaces) });
          }
          break;
        case 'agency.project.update':
          {
            const p = projects.find(item => item.id === m.projectId);
            if (p) p.name = m.name;
            reply('agency.project.updated', { project: structuredClone(p) });
            broadcast({ type: 'agency.project.changed', change: 'updated', projectId: m.projectId, project: structuredClone(p) });
          }
          break;
        case 'agency.workspace.update':
          {
            const w = workspaces.find(item => item.id === m.workspaceId);
            if (w) w.name = m.name;
            reply('agency.workspace.updated', { workspace: structuredClone(w) });
            broadcast({ type: 'agency.workspace.changed', change: 'updated', workspaceId: m.workspaceId, workspace: structuredClone(w) });
          }
          break;
        case 'agency.tab.rename':
          {
            const s = sessions.find(item => item.tab.id === m.tabId);
            if (s) s.tab.name = m.name;
            reply('agency.sessions.snapshot', { sessions: structuredClone(sessions) });
            broadcast({ type: 'agency.session.changed', sessionId: s.id, session: structuredClone(s) });
          }
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

test('sidebar ux & branding acceptance suite: drag-and-drop, controls, lifecycle, renaming, tab styles', async (t) => {
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
  <style>${css}</style>
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

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  page.on('console', msg => console.log('BROWSER:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err));

  await page.goto(`http://127.0.0.1:${port}`);

  // Wait for sidebar and projects to load
  await page.waitForSelector('.agency-project-toggle');
  const projectToggles = page.locator('.agency-project-toggle');
  await assert.equal(await projectToggles.count(), 2);

  // 1. Task 3: Simplify Project Controls
  // Verify workspace counters (.agency-count) are removed entirely
  const counters = page.locator('.agency-project-row .agency-count');
  assert.equal(await counters.count(), 0, 'Workspace counters must be removed from project rows');

  // Verify inline project plus button (.agency-project-add) is removed
  const inlinePlus = page.locator('.agency-project-row .agency-icon-button.agency-project-add');
  assert.equal(await inlinePlus.count(), 0, 'Inline project plus buttons must be removed');

  // Verify global Add Project button in heading remains
  const globalAddProject = page.locator('.agency-side-heading .agency-icon-button');
  assert.equal(await globalAddProject.count(), 1, 'Global Add Project button in heading must remain');

  // 2. Task 4: Context Menu Lifecycle
  const projectMenuBtn = page.locator('.agency-project-row .agency-row-action').first();
  await projectMenuBtn.click();
  const dropdownMenu = page.locator('.agency-dropdown-menu');
  await dropdownMenu.waitFor({ state: 'visible' });

  // Exposes Add Workspace, Rename Project, Archive Project, Delete Project
  const menuItems = dropdownMenu.locator('[role="menuitem"]');
  const itemTexts = await menuItems.allTextContents();
  assert.ok(itemTexts.some((txt) => /workspace/i.test(txt)), 'Context menu must expose Add Workspace');
  assert.ok(itemTexts.some((txt) => /rename/i.test(txt)), 'Context menu must expose Rename Project');
  assert.ok(itemTexts.some((txt) => /archive/i.test(txt)), 'Context menu must expose Archive Project');
  assert.ok(itemTexts.some((txt) => /delete/i.test(txt)), 'Context menu must expose Delete Project');

  // Escape closes menu and restores focus
  await page.keyboard.press('Escape');
  await dropdownMenu.waitFor({ state: 'hidden' });
  const focusedTag = await page.evaluate(() => document.activeElement?.className);
  assert.ok(focusedTag.includes('agency-row-action'), 'Focus should return to 3-dot trigger after Escape');

  // Click outside closes menu
  await projectMenuBtn.click();
  await dropdownMenu.waitFor({ state: 'visible' });
  await page.mouse.click(600, 400); // Click outside in main area
  await dropdownMenu.waitFor({ state: 'hidden' });

  // 3. Task 5: Project Inline Renaming
  await projectMenuBtn.click();
  await dropdownMenu.waitFor({ state: 'visible' });
  const renameProjectItem = dropdownMenu.locator('[role="menuitem"]').filter({ hasText: /rename/i });
  await renameProjectItem.click();

  // Inline input should be visible and autofocused
  const projectInput = page.locator('.agency-project-row .agency-inline-rename-input');
  await projectInput.waitFor({ state: 'visible' });
  assert.equal(await projectInput.inputValue(), 'Project Alpha');

  // Enter saves and commits
  await projectInput.fill('Alpha Reborn');
  await projectInput.press('Enter');
  await page.waitForFunction(() => window.agencyTest.requests.some(m => m.type === 'agency.project.update' && m.name === 'Alpha Reborn'));
  await projectInput.waitFor({ state: 'detached' });
  assert.ok(await page.locator('.agency-project-name').first().textContent(), 'Alpha Reborn');

  // 4. Task 5: Workspace Inline Renaming
  const ws1Row = page.locator('.agency-workspace-nav-row').first();
  const ws1MenuBtn = ws1Row.locator('.agency-row-action');
  await ws1MenuBtn.click();
  const wsDropdown = page.locator('.agency-dropdown-menu');
  await wsDropdown.waitFor({ state: 'visible' });

  const renameWsItem = wsDropdown.locator('[role="menuitem"]').filter({ hasText: /rename/i });
  await renameWsItem.click();

  const wsInput = page.locator('.agency-workspace-nav-row .agency-inline-rename-input');
  await wsInput.waitFor({ state: 'visible' });
  assert.equal(await wsInput.inputValue(), 'Workspace 1');

  // Test Escape cancels rename
  await wsInput.fill('Workspace Canceled');
  await wsInput.press('Escape');
  await wsInput.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.agency-workspace-nav-row').first().locator('.agency-truncate').textContent(), 'Workspace 1');

  // Test Enter saves workspace name
  await ws1MenuBtn.click();
  await renameWsItem.click();
  await wsInput.waitFor({ state: 'visible' });
  await wsInput.fill('Workspace Prime');
  await wsInput.press('Enter');
  await page.waitForFunction(() => window.agencyTest.requests.some(m => m.type === 'agency.workspace.update' && m.name === 'Workspace Prime'));
  await wsInput.waitFor({ state: 'detached' });

  // 5. Tasks 1 & 2: Project and Workspace Keyboard Reordering
  // Project Beta is index 1. Alt+ArrowUp should move it to index 0.
  const projectBeta = page.locator('.agency-project-toggle').filter({ hasText: 'Project Beta' });
  await projectBeta.focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForFunction(() => window.agencyTest.requests.some(m => m.type === 'agency.projects.order' && m.projectIds[0] === '22222222-2222-4222-8222-222222222222'));

  // Workspace 2 is index 1 in Project Alpha. Alt+ArrowUp should move it to index 0.
  const ws2Btn = page.locator('.agency-workspace-nav-button').filter({ hasText: 'Workspace 2' });
  await ws2Btn.focus();
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForFunction(() => window.agencyTest.requests.some(m => m.type === 'agency.workspaces.order' && m.workspaceIds[0] === '44444444-4444-4444-8444-444444444444'));

  // 6. Tasks 7 & 8: Tab Rename Single Outline & Clean Caret Lifecycle
  // Select Workspace 1 so its terminal tab displays
  const wsPrimeBtn = page.locator('.agency-workspace-nav-button').filter({ hasText: 'Workspace Prime' });
  await wsPrimeBtn.click();

  const tab = page.locator('.wb-session-tab');
  await tab.waitFor({ state: 'visible' });

  // Double click tab to rename
  const tabButton = tab.locator('[role="tab"]');
  await tabButton.dblclick();

  const tabInput = tab.locator('.wb-tab-name-input');
  await tabInput.waitFor({ state: 'visible' });

  // Verify Single Outline (outline: none, only 1px border/box-shadow)
  const tabInputStyles = await tabInput.evaluate((el) => {
    const s = window.getComputedStyle(el);
    return {
      outlineStyle: s.outlineStyle,
      outlineWidth: s.outlineWidth,
      borderStyle: s.borderStyle,
      boxShadow: s.boxShadow,
    };
  });
  assert.equal(tabInputStyles.outlineStyle, 'none', 'Tab rename input outline must be none (no double border)');

  // Type new name and press Enter
  await tabInput.fill('Renamed Terminal');
  await tabInput.press('Enter');

  // Input closes after the server acknowledges the rename.
  await tabInput.waitFor({ state: 'detached' });

  // Focus restored to tab button with inset outline
  await page.waitForFunction(() => document.activeElement?.id?.startsWith('tab-'));
  const focusOffset = await page.evaluate(() => window.getComputedStyle(document.activeElement).outlineOffset);
  assert.equal(focusOffset, '-2px', 'Tab button focus outline must be inset (-2px) so no vertical line artifact leaks outside');

  // 7. Task 6: Verify Brand Logo and toggle behavior
  const navLogo = page.locator('.agency-nav-logo');
  await navLogo.waitFor({ state: 'visible' });
  const logoSrc = await navLogo.getAttribute('src');
  assert.ok(logoSrc?.includes('workbench-logo-128.png'), 'Sidebar logo must reference workbench-logo-128.png');
  const brand = page.locator('.agency-nav-brand');
  await brand.getByText('Workbench', { exact: true }).waitFor();
  const logoBox = await navLogo.boundingBox(), brandBox = await brand.boundingBox(), headBox = await page.locator('.agency-nav-head').boundingBox();
  assert.ok(Math.abs((logoBox?.width ?? 0) - 38) <= 2, 'Sidebar logo is consistently ~38px');
  assert.ok(brandBox.x - headBox.x <= 20, 'Logo and Workbench title are left-aligned near the left edge');

  // Verify Workbench logo acts as collapse toggle
  const brandToggle = page.locator('.agency-nav-head .agency-brand-toggle');
  assert.equal(await brandToggle.getAttribute('aria-expanded'), 'true');
  await brandToggle.click();

  // Sidebar is now collapsed: topbar brand toggle appears with logo
  const topbarBrandToggle = page.locator('.agency-topbar .agency-brand-toggle');
  await topbarBrandToggle.waitFor({ state: 'visible' });
  assert.equal(await topbarBrandToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.agency-topbar-logo').count(), 1);
  assert.equal(await page.locator('.agency-topbar-divider').count(), 1);

  // Click topbar brand logo to expand sidebar again
  await topbarBrandToggle.click();
  await navLogo.waitFor({ state: 'visible' });
});

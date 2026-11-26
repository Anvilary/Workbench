import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = WEB_ROOT;
const evidenceDir = path.join(tmpdir(), 'workbench-evidence', 'archived-items');
mkdirSync(evidenceDir, { recursive: true });

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

const pActive = '11111111-1111-4111-8111-111111111111';
const pArchived = '22222222-2222-4222-8222-222222222222';
const wsActive = '33333333-3333-4333-8333-333333333333';
const wsArchivedInActive = '44444444-4444-4444-8444-444444444444';
const wsArchivedInArchived = '55555555-5555-4555-8555-555555555555';
const now = new Date('2026-11-20T10:00:00Z').toISOString();

let projects = [
  { id: pActive, name: 'Active Project', status: 'active', createdAt: now, updatedAt: now, archivedAt: null },
  { id: pArchived, name: 'Archived Alpha', status: 'archived', createdAt: now, updatedAt: now, archivedAt: now },
];

let workspaces = [
  { id: wsActive, projectId: pActive, name: 'Active Workspace', status: 'active', cwd: '/tmp/ws1', createdAt: now, updatedAt: now, doneAt: null, archivedAt: null },
  { id: wsArchivedInActive, projectId: pActive, name: 'Archived in Active', status: 'archived', cwd: '/tmp/ws2', createdAt: now, updatedAt: now, doneAt: null, archivedAt: now },
  { id: wsArchivedInArchived, projectId: pArchived, name: 'Archived in Archived', status: 'archived', cwd: '/tmp/ws3', createdAt: now, updatedAt: now, doneAt: null, archivedAt: now },
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
        case 'agency.project.unarchive': {
          const p = projects.find(x => x.id === m.projectId);
          if (p) {
            p.status = 'active';
            p.archivedAt = null;
            reply('agency.project.unarchived', { project: structuredClone(p) });
          }
          break;
        }
        case 'agency.workspace.restore': {
          const w = workspaces.find(x => x.id === m.workspaceId);
          if (w) {
            w.status = 'active';
            w.archivedAt = null;
            reply('agency.workspace.restored', { workspace: structuredClone(w) });
          }
          break;
        }
        default:
          break;
      }
    }, 10);
  }
}

const conn = new MockConnection();
createRoot(document.getElementById('root')).render(<WorkbenchApp connection={conn} />);
`;

test('Archived Items acceptance: main menu trigger, tab switching, search filter, and parent restoration workflow', async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium executable not found');
    return;
  }

  const result = await build({
    stdin: {
      contents: fixtureCode,
      resolveDir: webRoot,
      sourcefile: 'archived-test-fixture.tsx',
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

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#wb-shell-menu-trigger');

  // 1. Open the main menu
  await page.click('#wb-shell-menu-trigger');
  await page.waitForSelector('#menu-open-archived');

  // Verify menu order: 1. Notifications, 2. Performance, 3. Archived Items, 4. Settings
  const menuItems = await page.locator('#wb-shell-menu-dropdown [role="menuitem"]').allInnerTexts();
  assert.ok(menuItems[0].includes('Notifications'), 'Item 1 should be Notifications');
  assert.ok(menuItems[1].includes('Performance'), 'Item 2 should be Performance');
  assert.ok(menuItems[2].includes('Archived Items'), 'Item 3 should be Archived Items');
  assert.ok(menuItems[3].includes('Settings'), 'Item 4 should be Settings');

  // 2. Open Archived Items dialog
  await page.click('#menu-open-archived');
  await page.waitForSelector('.wb-archived-dialog');

  // Verify dialog contents
  assert.ok(await page.locator('.wb-archived-dialog').isVisible(), 'Archived dialog is visible');
  assert.equal(await page.locator('#archived-tab-projects').innerText(), 'Projects (1)');
  assert.equal(await page.locator('#archived-tab-workspaces').innerText(), 'Workspaces (2)');

  // Capture screenshot of dialog
  await page.locator('.wb-archived-dialog').screenshot({
    path: path.join(evidenceDir, 'archived-items-dialog.png'),
  });

  // 3. Search filter
  await page.fill('#archived-search-input', 'NonExistent');
  await page.waitForTimeout(50);
  assert.ok(await page.locator('.agency-empty-state').isVisible());

  await page.fill('#archived-search-input', 'Alpha');
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.wb-archived-row').count(), 1);

  await page.fill('#archived-search-input', '');

  // 4. Switch to Workspaces tab
  await page.click('#archived-tab-workspaces');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.wb-archived-row').count(), 2);

  // 5. Test Parent Project Archived workflow:
  // "Archived in Archived" belongs to "Archived Alpha" which is archived.
  // Clicking Restore should trigger the explicit confirmation prompt
  const archivedInArchivedRow = page.locator('.wb-archived-row', { hasText: 'Archived in Archived' });
  await archivedInArchivedRow.locator('button').click();
  await page.waitForSelector('.wb-archived-parent-prompt');

  assert.ok(await page.locator('.wb-archived-parent-prompt').isVisible(), 'Parent prompt is shown');
  assert.ok((await page.locator('.wb-archived-prompt-text').innerText()).includes('Archived Alpha'));

  // Confirm restoring both
  await page.click('button:has-text("Restore Project & Workspace")');
  await page.waitForTimeout(100);

  // Now "Archived in Archived" is active, and "Archived Alpha" is active!
  assert.equal(await page.locator('#archived-tab-workspaces').innerText(), 'Workspaces (1)');
  assert.equal(await page.locator('#archived-tab-projects').innerText(), 'Projects (0)');

  // 6. Close the dialog with X button
  await page.click('.wb-archived-dialog .agency-icon-button');
  await page.waitForTimeout(100);
  assert.ok(!(await page.locator('.wb-archived-dialog').isVisible()), 'Dialog is closed');
});

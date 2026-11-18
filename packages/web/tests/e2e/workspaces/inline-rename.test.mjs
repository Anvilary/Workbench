import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
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
import { AgencyApp } from './src/agency/AgencyApp.tsx';

const p1 = '11111111-1111-4111-8111-111111111111';
const ws1 = '33333333-3333-4333-8333-333333333333';
const tab1 = '66666666-6666-4666-8666-666666666666';
const now = new Date().toISOString();

let projects = [
  { id: p1, name: 'Project Alpha', status: 'active', createdAt: now, updatedAt: now },
];

let workspaces = [
  { id: ws1, projectId: p1, name: 'Workspace 1', status: 'active', cwd: '/workspaces/ws1', createdAt: now, updatedAt: now, doneAt: null },
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
        case 'agency.webTabs.list':
          reply('agency.webTabs.snapshot', { tabs: [] });
          break;
        case 'agency.editorTabs.list':
          reply('agency.editorTabs.snapshot', { tabs: [] });
          break;
        case 'agency.profiles.list':
          reply('agency.profiles.snapshot', { profiles: [] });
          break;
        case 'agency.workspace.layout.get':
          reply('agency.workspace.layout.state', {
            layout: {
              workspaceId: m.workspaceId,
              tree: { id: 'pane-1', tabIds: [tab1], activeTabId: tab1 },
              focusedPaneId: 'pane-1',
              updatedAt: now,
            },
          });
          break;
        case 'agency.workspace.update': {
          const ws = workspaces.find(w => w.id === m.workspaceId);
          if (ws) ws.name = m.name;
          broadcast({ type: 'agency.workspaces.updated', workspace: structuredClone(ws) });
          reply('agency.workspace.updated', { workspace: structuredClone(ws) });
          break;
        }
        case 'agency.project.update': {
          const pr = projects.find(p => p.id === m.projectId);
          if (pr) pr.name = m.name;
          broadcast({ type: 'agency.projects.updated', project: structuredClone(pr) });
          reply('agency.project.updated', { project: structuredClone(pr) });
          break;
        }
        default:
          break;
      }
    }, 10);
  }
}

const conn = new MockConnection();
const root = createRoot(document.getElementById('root'));
root.render(React.createElement(AgencyApp, { connection: conn, initialSection: 'agency' }));
`;

const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="/bundle.css" />
</head>
<body style="margin: 0; padding: 0; background: #0e0e10;">
  <div id="root" style="width: 100vw; height: 100vh;"></div>
  <script type="module" src="/bundle.js"></script>
</body>
</html>`;

test('inline renaming: typing multi-character words, inserting, backspacing, and single commit', async (t) => {
  const bundle = await build({
    stdin: {
      contents: fixtureCode,
      loader: 'tsx',
      resolveDir: webRoot,
    },
    bundle: true,
    write: false,
    outdir: '/tmp/maw-rename-bundle',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent',
  });

  const cssContent = bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text || '';
  const jsContent = bundle.outputFiles.find(f => f.path.endsWith('.js'))?.text || '';

  const server = createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(jsContent);
    } else if (req.url === '/bundle.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(cssContent);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const port = server.address().port;
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable(),
  });
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}`);

  // Wait for sidebar to render workspace
  const wsRow = page.locator('.agency-workspace-nav-row');
  await wsRow.waitFor({ state: 'visible' });

  // 1. Open Workspace action menu -> Rename
  const wsMenuBtn = wsRow.locator('.agency-row-action');
  await wsMenuBtn.click();
  const renameWsItem = page.getByRole('menuitem', { name: 'Rename workspace' });
  await renameWsItem.click();

  const renameInput = page.locator('.agency-inline-rename-input');
  await renameInput.waitFor({ state: 'visible' });

  // Verify typing a complete word when initial text is selected replaces the initial name with the complete word
  await renameInput.type('New Workspace Name', { delay: 10 });
  let val = await renameInput.inputValue();
  assert.equal(val, 'New Workspace Name', 'Multi-character typing enters the full word without each character overwriting the preceding one');

  // Insert characters in the middle
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('Great ', { delay: 10 });
  val = await renameInput.inputValue();
  assert.equal(val, 'New Workspace Great Name', 'Inserting characters in the middle works');

  // Backspace
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  val = await renameInput.inputValue();
  assert.equal(val, 'New Workspace Name', 'Backspace works correctly');

  // Substring selection and replace: select "Workspace" and replace with "Studio"
  await page.evaluate(() => {
    const input = document.querySelector('.agency-inline-rename-input');
    input.setSelectionRange(4, 13); // "Workspace"
  });
  await page.keyboard.type('Studio');
  val = await renameInput.inputValue();
  assert.equal(val, 'New Studio Name', 'Substring replacement works without reselecting entire input');

  // Paste a name: select all and paste
  await page.evaluate(() => {
    const input = document.querySelector('.agency-inline-rename-input');
    input.select();
  });
  // Simulate paste by setting value via event or typing
  await page.keyboard.insertText('Pasted Workspace Name');
  val = await renameInput.inputValue();
  assert.equal(val, 'Pasted Workspace Name', 'Pasting name works as expected');

  // Enter commits once
  await page.keyboard.press('Enter');
  await renameInput.waitFor({ state: 'detached' });

  // Verify backend received rename request EXACTLY once
  const renameRequests = await page.evaluate(() =>
    window.agencyTest.requests.filter(r => r.type === 'agency.workspace.update')
  );
  assert.equal(renameRequests.length, 1, 'Enter must commit exactly once');
  assert.equal(renameRequests[0].name, 'Pasted Workspace Name');

  // Verify blur does not send duplicate request
  await page.locator('body').click();
  const renameRequestsAfterBlur = await page.evaluate(() =>
    window.agencyTest.requests.filter(r => r.type === 'agency.workspace.update')
  );
  assert.equal(renameRequestsAfterBlur.length, 1, 'Blur after Enter must not send duplicate rename request');

  // 2. Escape cancels without saving
  await wsMenuBtn.click();
  await renameWsItem.click();
  await renameInput.waitFor({ state: 'visible' });
  await renameInput.type(' CancelMe');
  await page.keyboard.press('Escape');
  await renameInput.waitFor({ state: 'detached' });

  const requestsAfterEscape = await page.evaluate(() =>
    window.agencyTest.requests.filter(r => r.type === 'agency.workspace.update')
  );
  assert.equal(requestsAfterEscape.length, 1, 'Escape must not send rename request');

  // 3. Blur commits once
  await wsMenuBtn.click();
  await renameWsItem.click();
  await renameInput.waitFor({ state: 'visible' });
  await renameInput.fill('Workspace Blurred');
  await page.locator('body').click();
  await renameInput.waitFor({ state: 'detached' });

  const requestsAfterBlur = await page.evaluate(() =>
    window.agencyTest.requests.filter(r => r.type === 'agency.workspace.update')
  );
  assert.equal(requestsAfterBlur.length, 2, 'Blur commits the intended value once');
  assert.equal(requestsAfterBlur[1].name, 'Workspace Blurred');

  // 4. Test Project renaming
  const prRow = page.locator('.agency-project-row');
  const prMenuBtn = prRow.locator('.agency-row-action');
  await prMenuBtn.click();
  const renamePrItem = page.getByRole('menuitem', { name: 'Rename project' });
  await renamePrItem.click();

  const prInput = page.locator('.agency-inline-rename-input');
  await prInput.waitFor({ state: 'visible' });
  await page.keyboard.press('End');
  await prInput.type(' Plus', { delay: 10 });
  const prVal = await prInput.inputValue();
  assert.equal(prVal, 'Project Alpha Plus', 'Project renaming allows typing full text');
  await page.keyboard.press('Enter');
  await prInput.waitFor({ state: 'detached' });

  const prRequests = await page.evaluate(() =>
    window.agencyTest.requests.filter(r => r.type === 'agency.project.update')
  );
  assert.equal(prRequests.length, 1, 'Project rename commits once on Enter');
  assert.equal(prRequests[0].name, 'Project Alpha Plus');
});

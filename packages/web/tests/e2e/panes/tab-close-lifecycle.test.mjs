import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const tabA = '11111111-aaaa-4111-8111-111111111111';
const tabB = '22222222-bbbb-4222-8222-222222222222';

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { WorkspaceView } from './src/features/workspaces/WorkspaceView.tsx';

const opened = [];
const origOpen = Terminal.prototype.open;
Terminal.prototype.open = function (element) {
  opened.push(this);
  window.terminals = opened;
  return origOpen.call(this, element);
};

window.sent = [];
window.failClose = false;

const ws = '11111111-1111-4111-8111-111111111111';
const now = new Date().toISOString();
const workspace = { id: ws, projectId: '22222222-2222-4222-8222-222222222222', name: 'Workspace', status: 'active', cwd: '/fixture', createdAt: now, updatedAt: now };

function session(id, tabId, name, terminalId, kind, order, selected) {
  return {
    id, workspaceId: ws, kind, profileId: null,
    terminalId, lifecycle: 'running', activity: 'idle', exitCode: null,
    nativeSessionId: null, selectedModel: null, selectedEffort: null,
    createdAt: now, updatedAt: now, startedAt: now, stoppedAt: null,
    tab: { id: tabId, order, selected, current: true, closedAt: null, name, terminalNumber: order + 1 },
  };
}

const listeners = new Set();
const connection = {
  getStatus: () => 'open',
  onStatus: () => () => {},
  onReopen: () => () => {},
  onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  send(message) { window.sent.push(message); return true; },
  sendImmediate(message) { window.sent.push(message); return true; },
};

function Harness() {
  const [sessions, setSessions] = useState([
    session('s-a', '${tabA}', 'Shell A', 'term-a', 'terminal', 0, true),
    session('s-b', '${tabB}', 'Shell B', 'term-b', 'terminal', 1, false),
  ]);

  const request = async (message) => {
    window.sent.push(message);
    if (message.type === 'agency.tab.action' && message.action === 'close') {
      if (window.failClose) {
        throw new Error('Termination not confirmed; tab remains visible');
      }
      // Delayed server confirmation to simulate graceful stop
      await new Promise((r) => setTimeout(r, 200));
      setSessions((prev) => prev.map((row) => row.tab.id === message.tabId
        ? { ...row, lifecycle: 'exited', tab: { ...row.tab, closedAt: now, current: false, selected: false } }
        : row));
    }
    return {};
  };

  return React.createElement(WorkspaceView, {
    workspace, profiles: [], sessions, webTabs: [], connection, request,
    sendImmediate: connection.sendImmediate, online: true, onDone() {}, onSaveLayout: async () => {},
  });
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
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

test('recoverable close lifecycle: immediate visual dismissal, background confirmation, and error rollback', { timeout: 60000 }, async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium is not installed');
    return;
  }
  const bundle = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: WEB_ROOT },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
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
    res.end(`<!doctype html><html><head><style>
      html,body,#root{height:100%;margin:0}
      .agency-workspace-view{display:flex;flex-direction:column;height:100%}
      .wb-split-workspace-content{flex:1;display:flex;min-height:0}
      .wb-split-container{display:flex;flex:1;min-width:0;min-height:0}
      .wb-split-pane{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
      .wb-pane-body{flex:1;display:flex;min-height:0;min-width:0;position:relative}
      .wb-session-holder{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}
      .agency-modal-backdrop{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;background:#090b10bb}
    </style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (err) => {
    console.error('PAGE ERROR:', err);
    errors.push(err.message);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('CONSOLE ERROR:', msg.text());
  });
  await page.goto('http://127.0.0.1:' + server.address().port);

  // Initial state: two tabs present
  await page.waitForFunction(() => window.terminals?.length === 2);
  const tabsInitial = await page.$$eval('.wb-session-tab', (els) => els.map((el) => el.textContent?.trim()));
  assert.ok(tabsInitial.some((t) => t?.includes('Shell A')));
  assert.ok(tabsInitial.some((t) => t?.includes('Shell B')));

  // Case 1: Failure injection with rollback
  await page.evaluate(() => { window.failClose = true; });
  await page.getByRole('button', { name: 'Close Shell A' }).click();
  // Confirmation dialog appears
  await page.waitForSelector('.agency-modal-backdrop');
  await page.getByRole('button', { name: 'Close session' }).click();

  // Modal dismisses immediately upon click
  await page.waitForSelector('.agency-modal-backdrop', { state: 'detached' });

  // Because backend failed, error appears and Shell A is restored
  await page.waitForSelector('.agency-error-bar');
  const errorText = await page.$eval('.agency-error-bar', (el) => el.textContent);
  assert.match(errorText, /Termination not confirmed/);

  // Tab rolled back to visible
  const tabsAfterRollback = await page.$$eval('.wb-session-tab', (els) => els.map((el) => el.textContent?.trim()));
  assert.ok(tabsAfterRollback.some((t) => t?.includes('Shell A')));

  // Case 2: Successful close with immediate visual removal
  await page.evaluate(() => { window.failClose = false; window.sent = []; });
  await page.getByRole('button', { name: 'Close Shell A' }).click();
  await page.waitForSelector('.agency-modal-backdrop');
  await page.getByRole('button', { name: 'Close session' }).click();

  // Modal disappears immediately
  await page.waitForSelector('.agency-modal-backdrop', { state: 'detached' });

  // Tab Shell A is immediately gone from the tab bar (0ms perceived latency)
  const tabsDuringClose = await page.$$eval('.wb-session-tab', (els) => els.map((el) => el.textContent?.trim()));
  assert.equal(tabsDuringClose.some((t) => t?.includes('Shell A')), false, 'Shell A must be removed from tab bar immediately');

  // Wait for server delayed response
  await page.waitForTimeout(300);

  // Verify only 1 close action was sent (idempotent)
  const sentClose = await page.evaluate(() => window.sent.filter((m) => m.type === 'agency.tab.action' && m.action === 'close'));
  assert.equal(sentClose.length, 1);
});

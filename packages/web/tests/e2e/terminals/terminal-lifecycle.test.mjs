// Live terminals stay mounted across tab switches and pane moves.
// Run: node --test packages/web/src/agency/split/terminal-lifecycle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const tabA = '33333333-3333-4333-8333-333333333333';
const tabB = '44444444-4444-4444-8444-444444444444';

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { AgencyWorkspaceView } from './src/agency/AgencyWorkspaceView.tsx';

const opened = [];
const origOpen = Terminal.prototype.open;
Terminal.prototype.open = function (element) {
  this.__n = opened.length;
  opened.push(this);
  window.terminals = opened;
  return origOpen.call(this, element);
};
const origDispose = Terminal.prototype.dispose;
Terminal.prototype.dispose = function () {
  window.disposed = (window.disposed || 0) + 1;
  return origDispose.call(this);
};
window.disposed = 0;
window.sent = [];

const ws = '11111111-1111-4111-8111-111111111111';
const now = new Date().toISOString();
const workspace = { id: ws, projectId: '22222222-2222-4222-8222-222222222222', name: 'Workspace', status: 'active', cwd: '/fixture', createdAt: now, updatedAt: now };
function session(id, tabId, name, terminalId, kind, order, selected) {
  return {
    id, workspaceId: ws, kind, profileId: kind === 'agent' ? 'codex-0' : null,
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
window.emit = (message) => { for (const fn of listeners) fn(message); };

function Harness() {
  const [sessions, setSessions] = useState([
    session('s-a', '${tabA}', 'Shell A', 'term-a', 'terminal', 0, true),
    session('s-b', '${tabB}', 'CLI B', 'term-b', 'agent', 1, false),
  ]);
  const [mounted, setMounted] = useState(true);
  window.unmountWorkspace = () => setMounted(false);
  const request = async (message) => {
    window.sent.push(message);
    if (message.type === 'agency.tab.action' && message.action === 'select') {
      setSessions((prev) => prev.map((row) => ({ ...row, tab: { ...row.tab, selected: row.tab.id === message.tabId } })));
    }
    if (message.type === 'agency.tab.action' && message.action === 'close') {
      setSessions((prev) => prev.map((row) => row.tab.id === message.tabId
        ? { ...row, lifecycle: 'exited', tab: { ...row.tab, closedAt: now, current: false, selected: false } }
        : row));
    }
    if (message.type === 'agency.session.create') {
      const tabC = '55555555-5555-4555-8555-555555555555';
      const created = session('s-c', tabC, 'Shell C', 'term-c', message.kind, 2, true);
      setSessions((prev) => [...prev, created]);
      return { type: 'agency.session.created', session: created };
    }
    return {};
  };
  if (!mounted) return React.createElement('div', { id: 'workspace-gone' });
  return React.createElement(AgencyWorkspaceView, {
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

test('live terminals keep scrollback, selection and the PTY attachment across switches and pane moves', { timeout: 120000 }, async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium is not installed; set PLAYWRIGHT_CHROMIUM_EXECUTABLE');
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
      .maw-split-workspace-content{flex:1;display:flex;min-height:0}
      .maw-split-container{display:flex;flex:1;min-width:0;min-height:0}
      .maw-split-pane{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
      .maw-pane-body{flex:1;display:flex;min-height:0;min-width:0;position:relative}
      .maw-session-holder{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}
      .maw-session-holder[hidden],.maw-session-pane[hidden],.maw-terminal-park{display:none !important}
      .agency-modal-backdrop{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;background:#090b10bb}
      .maw-session-pane{display:flex;flex:1;flex-direction:column;min-height:0}
      .agency-agent-body{flex:1;position:relative;min-height:0}
      .agency-xterm-host,.terminal-surface{position:absolute;inset:0}
      .terminal-surface-hidden{visibility:hidden}
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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.terminals?.length === 2);

  const snapshot = () => page.evaluate(() => ({
    attaches: window.sent.filter((message) => message.type === 'terminal.attach').map((message) => message.terminalId),
    detaches: window.sent.filter((message) => message.type === 'terminal.detach').map((message) => message.terminalId),
    disposed: window.disposed,
    inputs: window.sent.filter((message) => message.type === 'input').map((message) => [message.terminalId, message.data]),
  }));
  const read = (tabId) => page.evaluate((id) => {
    const term = window.terminals.find((item) => item.element?.closest('#pane-' + id));
    const buffer = term.buffer.active;
    const text = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '').join('\n');
    return {
      n: term.__n,
      connected: term.element.isConnected,
      viewportY: buffer.viewportY,
      selection: term.getSelection(),
      cols: term.cols,
      rows: term.rows,
      height: term.element.closest('.terminal-surface')?.clientHeight ?? 0,
      pane: term.element.closest('[id^="pane-container-"]')?.id ?? '',
      text,
    };
  }, tabId);

  const initial = await snapshot();
  assert.deepEqual(initial.attaches.sort(), ['term-a', 'term-b']);
  assert.deepEqual(initial.detaches, []);
  assert.equal(initial.disposed, 0);

  // Let the initial 60ms ResizeObserver fit settle before simulating a user scroll.
  // During that fit TerminalView intentionally ignores transient scroll events.
  await page.waitForTimeout(100);
  const before = await page.evaluate(async (id) => {
    const term = window.terminals.find((item) => item.element?.closest('#pane-' + id));
    const lines = Array.from({ length: 40 }, (_, index) => 'LINE-' + String(index).padStart(2, '0')).join('\r\n') + '\r\n';
    await new Promise((resolve) => term.write(lines, resolve));
    term.scrollToLine(0);
    term.select(0, 0, 7);
    return { viewportY: term.buffer.active.viewportY, selection: term.getSelection(), n: term.__n };
  }, tabA);
  assert.equal(before.viewportY, 0);
  assert.equal(before.selection, 'LINE-00');

  for (let i = 0; i < 4; i += 1) {
    await page.getByRole('tab', { name: /CLI B/ }).click();
    await page.getByRole('tab', { name: /Shell A/ }).click();
  }
  await page.waitForFunction((id) => {
    const pane = document.getElementById('pane-' + id);
    return pane && !pane.hidden && pane.contains(document.activeElement);
  }, tabA);
  const switched = await read(tabA);
  assert.equal(switched.n, before.n);
  assert.equal(switched.connected, true);
  assert.equal(switched.viewportY, 0);
  assert.equal(switched.selection, 'LINE-00');
  assert.match(switched.text, /LINE-00/);
  assert.match(switched.text, /LINE-39/);

  await page.getByRole('tab', { name: /CLI B/ }).click();
  await page.evaluate(() => window.emit({ type: 'terminal.output', terminalId: 'term-a', data: 'LIVE-CLI-STILL-HERE\r\n' }));
  await page.getByRole('tab', { name: /Shell A/ }).click();
  await page.waitForFunction((id) => {
    const term = window.terminals.find((item) => item.element?.closest('#pane-' + id));
    const buffer = term.buffer.active;
    const text = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '').join('\n');
    return text.includes('LIVE-CLI-STILL-HERE');
  }, tabA);

  await page.evaluate((id) => {
    window.terminals.find((item) => item.element?.closest('#pane-' + id)).input('Z');
  }, tabA);
  const typed = await snapshot();
  assert.deepEqual(typed.attaches.sort(), ['term-a', 'term-b']);
  assert.deepEqual(typed.detaches, []);
  assert.deepEqual(typed.inputs, [['term-a', 'Z']]);

  // Pane actions menu: Escape cancels without modifying layout
  await page.getByRole('button', { name: 'Pane actions' }).click();
  await page.locator('.maw-pane-menu').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.maw-pane-menu').length === 0);
  assert.equal(await page.locator('.maw-split-pane').count(), 1);

  // Pane actions -> Split vertically creates the second pane with the new session immediately
  await page.getByRole('button', { name: 'Pane actions' }).click();
  await page.getByRole('menuitem', { name: 'Split vertically' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.maw-split-pane').length === 2);
  const shellPane = await read(tabA);
  const tabC = '55555555-5555-4555-8555-555555555555';
  const newPane = await read(tabC);
  assert.equal(shellPane.n, 0);
  assert.equal(newPane.n, 2);
  assert.notEqual(shellPane.pane, newPane.pane);
  assert.equal(shellPane.height > 0 && newPane.height > 0, true);
  assert.equal(shellPane.cols > 0 && newPane.cols > 0 && shellPane.rows > 0 && newPane.rows > 0, true);
  assert.match(shellPane.text, /LIVE-CLI-STILL-HERE/);
  assert.equal((await snapshot()).disposed, 0);
  assert.deepEqual((await snapshot()).attaches.sort(), ['term-a', 'term-b', 'term-c']);

  await page.evaluate(async (id) => {
    const header = document.querySelectorAll('.maw-pane-header')[1];
    const transfer = new DataTransfer();
    transfer.setData('application/maw-tab-id', id);
    header.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }, tabA);
  const moved = await read(tabA);
  assert.equal(moved.n, shellPane.n);
  assert.equal(moved.connected, true);
  assert.match(moved.text, /LINE-00/);
  assert.equal(moved.pane, newPane.pane);
  assert.deepEqual((await snapshot()).detaches, []);

  await page.getByRole('button', { name: 'Pane actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Close pane' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.maw-split-pane').length === 1);
  assert.equal((await read(tabA)).n, 0);
  assert.equal((await read(tabB)).n, 1);
  assert.equal((await snapshot()).disposed, 0);

  await page.getByRole('button', { name: 'Close Shell A' }).click();
  assert.equal((await snapshot()).disposed, 0);
  await page.getByRole('button', { name: 'Close session' }).click();
  await page.waitForFunction(() => window.disposed === 1);
  const afterClose = await snapshot();
  assert.deepEqual(afterClose.detaches, ['term-a']);
  assert.equal((await read(tabB)).connected, true);
  assert.equal((await read(tabB)).n, 1);

  await page.evaluate(() => window.unmountWorkspace());
  await page.waitForFunction(() => window.disposed === 3 && document.getElementById('workspace-gone'));
  const gone = await snapshot();
  assert.deepEqual(gone.detaches.sort(), ['term-a', 'term-b', 'term-c']);
  assert.deepEqual(errors, []);
});

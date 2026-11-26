// Bounded warm set (WB-05): only the visible terminals plus the WARM_TERMINAL_LIMIT most
// recently visible ones keep an xterm instance. The rest unmount, detach, and come back
// from the server replay with their size reported again.
// Run: node --test packages/web/tests/e2e/terminals/terminal-warm-set.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';
import { WARM_TERMINAL_LIMIT } from '../../../src/features/terminals/terminal-warm-set.ts';

const TAB_COUNT = 10;

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { WorkspaceView } from './src/features/workspaces/WorkspaceView.tsx';

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
const tabId = (index) => '6666666' + index + '-6666-4666-8666-666666666666';
function session(index, selected) {
  return {
    id: 's-' + index, workspaceId: ws, kind: 'terminal', profileId: null,
    terminalId: 'term-' + index, lifecycle: 'running', activity: 'idle', exitCode: null,
    nativeSessionId: null, selectedModel: null, selectedEffort: null,
    createdAt: now, updatedAt: now, startedAt: now, stoppedAt: null,
    tab: { id: tabId(index), order: index, selected, current: true, closedAt: null, name: 'Shell ' + index, terminalNumber: index + 1 },
  };
}
const listeners = new Set();
// The server answers every attach with a screen checkpoint, like renderingReplay does
// when the client has no offset to resume from.
const replayFor = new Map();
const connection = {
  getStatus: () => 'open',
  onStatus: () => () => {},
  onReopen: () => () => {},
  onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  send(message) {
    window.sent.push(message);
    if (message.type === 'terminal.attach') {
      const seq = (replayFor.get(message.terminalId) || 0) + 1;
      replayFor.set(message.terminalId, seq);
      const data = '\\x1b[?1049h\\x1b[H\\x1b[1;38;2;9;99;199mSCREEN-' + message.terminalId + '-' + seq + ' café 漢\\x1b[0m';
      queueMicrotask(() => window.emit({
        type: 'terminal.replay', terminalId: message.terminalId, data,
        reset: true, truncated: false, startOffset: 0, endOffset: 1000 * seq,
        offset: 1000 * seq, cols: message.cols, rows: message.rows,
      }));
    }
    return true;
  },
  sendImmediate(message) { window.sent.push(message); return true; },
};
window.emit = (message) => { for (const fn of listeners) fn(message); };

function Harness() {
  const [sessions, setSessions] = useState(
    Array.from({ length: ${TAB_COUNT} }, (_, index) => session(index, index === 0)),
  );
  const request = async (message) => {
    window.sent.push(message);
    if (message.type === 'agency.tab.action' && message.action === 'select') {
      setSessions((prev) => prev.map((row) => ({ ...row, tab: { ...row.tab, selected: row.tab.id === message.tabId } })));
    }
    if (message.type === 'agency.tab.action' && message.action === 'close') {
      setSessions((prev) => prev.filter((row) => row.tab.id !== message.tabId));
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

const PAGE_CSS = `
  html,body,#root{height:100%;margin:0}
  .agency-workspace-view{display:flex;flex-direction:column;height:100%}
  .wb-split-workspace-content{flex:1;display:flex;min-height:0}
  .wb-split-container{display:flex;flex:1;min-width:0;min-height:0}
  .wb-split-pane{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
  .wb-pane-body{flex:1;display:flex;min-height:0;min-width:0;position:relative}
  .wb-session-holder{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}
  .wb-session-holder[hidden],.wb-session-pane[hidden],.wb-terminal-park{display:none !important}
  .wb-session-pane{display:flex;flex:1;flex-direction:column;min-height:0}
  .agency-agent-body{flex:1;position:relative;min-height:0}
  .agency-xterm-host,.terminal-surface{position:absolute;inset:0}
  .terminal-surface-hidden{visibility:hidden}
`;

test('terminals beyond the warm set unmount and come back from the replay', { timeout: 180000 }, async (t) => {
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
    res.end(`<!doctype html><html><head><style>${PAGE_CSS}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.terminals?.length === 1);

  const snapshot = () => page.evaluate(() => ({
    attaches: window.sent.filter((m) => m.type === 'terminal.attach'),
    detaches: window.sent.filter((m) => m.type === 'terminal.detach').map((m) => m.terminalId),
    resizes: window.sent.filter((m) => m.type === 'resize'),
    disposed: window.disposed,
    mountedXterms: document.querySelectorAll('.xterm').length,
    dormant: document.querySelectorAll('.agency-xterm-dormant').length,
  }));

  // Only the selected tab mounts an xterm. Background tabs that were never shown
  // never build one, so opening a workspace with many tabs costs one instance.
  const initial = await snapshot();
  assert.equal(initial.attaches.length, 1, 'only the visible terminal attaches');
  assert.equal(initial.attaches[0].terminalId, 'term-0');
  assert.equal(initial.attaches[0].sinceOffset, undefined, 'a fresh mount asks for the full checkpoint');
  assert.equal(initial.mountedXterms, 1);
  assert.equal(initial.dormant, TAB_COUNT - 1, 'the rest keep a sized placeholder');
  assert.deepEqual(initial.detaches, []);

  for (let index = 1; index < TAB_COUNT; index += 1) {
    await page.locator('[role="tab"]').nth(index).click();
    await page.waitForFunction((n) => window.terminals.length === n + 1, index);
  }
  await page.waitForFunction(
    (limit) => document.querySelectorAll('.xterm').length <= limit + 1,
    WARM_TERMINAL_LIMIT,
  );

  const cycled = await snapshot();
  assert.equal(cycled.mountedXterms, WARM_TERMINAL_LIMIT + 1, 'visible terminal plus the warm budget');
  const evicted = TAB_COUNT - (WARM_TERMINAL_LIMIT + 1);
  assert.equal(cycled.disposed, evicted, 'every terminal pushed out of the warm set disposed its xterm');
  assert.deepEqual(
    cycled.detaches,
    Array.from({ length: evicted }, (_, index) => 'term-' + index),
    'unmounting detaches from the pty in least-recently-visible order',
  );
  // One attach per mount, never two without an intervening detach.
  assert.equal(cycled.attaches.length, TAB_COUNT);
  for (const attach of cycled.attaches) {
    assert.equal(attach.sinceOffset, undefined, 'mount attaches request the checkpoint, not a delta');
    assert.ok(attach.cols > 0 && attach.rows > 0, 'the attach reports a real size');
  }

  // The checkpoint painted the restored screen in the terminal that is on screen.
  const lastIndex = TAB_COUNT - 1;
  const visibleText = await page.evaluate((index) => {
    const term = window.terminals.find((item) => item.element?.isConnected && item.element.closest('.wb-session-pane:not([hidden])'));
    const buffer = term.buffer.active;
    return {
      type: buffer.type,
      cols: term.cols,
      rows: term.rows,
      text: Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n'),
      expected: 'SCREEN-term-' + index,
    };
  }, lastIndex);
  assert.equal(visibleText.type, 'alternate');
  assert.ok(visibleText.text.includes(visibleText.expected), 'the replay checkpoint painted the restored screen');
  assert.ok(visibleText.text.includes('café 漢'), 'multibyte characters survive the restore');
  assert.ok(visibleText.cols > 0 && visibleText.rows > 0);

  // Going back to an evicted terminal mounts a new instance, attaches again and
  // reports the size of the box it was remounted into.
  const beforeRestore = await snapshot();
  await page.locator('[role="tab"]').nth(0).click();
  await page.waitForFunction(
    (n) => window.terminals.length === n + 1,
    beforeRestore.attaches.length,
  );
  await page.waitForFunction(() => {
    const term = window.terminals.find((item) => item.element?.isConnected && item.element.closest('.wb-session-pane:not([hidden])'));
    if (!term) return false;
    const buffer = term.buffer.active;
    const text = Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n');
    return text.includes('SCREEN-term-0-2');
  });

  const restored = await snapshot();
  const remountAttach = restored.attaches[restored.attaches.length - 1];
  assert.equal(remountAttach.terminalId, 'term-0');
  assert.equal(remountAttach.sinceOffset, undefined, 'a remount cannot use a delta: its screen is empty');
  assert.ok(remountAttach.cols > 1 && remountAttach.rows > 1, 'the remount fit measured a real box, not the 80x24 fallback');
  assert.equal(restored.mountedXterms, WARM_TERMINAL_LIMIT + 1, 'the warm set stays bounded after the restore');
  assert.deepEqual(errors, []);
});

// WB-05 measurement: graphical working set and restore latency with 30 terminals
// spread over three workspaces, each with output.
//
// Reports JS heap (CDP Runtime.getHeapUsage after a forced collection), DOM node count,
// mounted .xterm elements and restore latency over 20 switches. Run it on this branch
// and with SessionPane.tsx reverted to compare before and after.
//
// Run: node --test packages/web/tests/e2e/terminals/terminal-warm-set-measurement.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const WORKSPACES = 3;
const TABS_PER_WORKSPACE = 10;
const TERMINAL_COUNT = WORKSPACES * TABS_PER_WORKSPACE;
const OUTPUT_LINES = 2000;

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
window.disposed = 0;
const origDispose = Terminal.prototype.dispose;
Terminal.prototype.dispose = function () { window.disposed += 1; return origDispose.call(this); };
window.sent = [];

const now = new Date().toISOString();
const wsId = (w) => '1111111' + w + '-1111-4111-8111-111111111111';
const tabId = (w, t) => '2222222' + w + '-2222-4222-8222-22222222222' + t.toString(36);
function workspace(w) {
  return { id: wsId(w), projectId: '33333333-3333-4333-8333-333333333333', name: 'WS' + w,
    status: 'active', cwd: '/fixture', createdAt: now, updatedAt: now };
}
function session(w, t, selected) {
  return {
    id: 's-' + w + '-' + t, workspaceId: wsId(w), kind: 'terminal', profileId: null,
    terminalId: 'term-' + w + '-' + t, lifecycle: 'running', activity: 'idle', exitCode: null,
    nativeSessionId: null, selectedModel: null, selectedEffort: null,
    createdAt: now, updatedAt: now, startedAt: now, stoppedAt: null,
    tab: { id: tabId(w, t), order: t, selected, current: true, closedAt: null,
      name: 'Shell ' + w + '-' + t, terminalNumber: t + 1 },
  };
}
const listeners = new Set();
const replaySeq = new Map();
const connection = {
  getStatus: () => 'open',
  onStatus: () => () => {},
  onReopen: () => () => {},
  onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  send(message) {
    window.sent.push(message);
    if (message.type === 'terminal.attach') {
      const seq = (replaySeq.get(message.terminalId) || 0) + 1;
      replaySeq.set(message.terminalId, seq);
      const screen = '\\x1b[?1049h\\x1b[H\\x1b[1mRESTORED-' + message.terminalId + '-' + seq + '\\x1b[0m';
      queueMicrotask(() => window.emit({
        type: 'terminal.replay', terminalId: message.terminalId, data: screen, reset: true,
        truncated: false, startOffset: 0, endOffset: 1000 * seq, offset: 1000 * seq,
        cols: message.cols, rows: message.rows,
      }));
    }
    return true;
  },
  sendImmediate(message) { window.sent.push(message); return true; },
};
window.emit = (message) => { for (const fn of listeners) fn(message); };

function Harness() {
  const [sessions, setSessions] = useState(
    Array.from({ length: ${WORKSPACES} }, (_, w) =>
      Array.from({ length: ${TABS_PER_WORKSPACE} }, (_, t) => session(w, t, t === 0)),
    ).flat(),
  );
  const [current, setCurrent] = useState(0);
  window.switchWorkspace = (index) => setCurrent(index);
  const request = async (message) => {
    window.sent.push(message);
    if (message.type === 'agency.tab.action' && message.action === 'select') {
      setSessions((prev) => prev.map((row) => {
        if (row.workspaceId !== message.workspaceId) return row;
        return { ...row, tab: { ...row.tab, selected: row.tab.id === message.tabId } };
      }));
    }
    return {};
  };
  // Same shape as WorkbenchApp: every workspace stays rendered, the inactive ones hidden.
  return React.createElement('div', { className: 'maw-workspace-slots' },
    Array.from({ length: ${WORKSPACES} }, (_, w) => React.createElement('div', {
      key: w, className: 'maw-workspace-slot', 'data-workspace': w,
      style: { display: current === w ? 'flex' : 'none', flex: 1, minHeight: 0 },
    }, React.createElement(WorkspaceView, {
      workspace: workspace(w), profiles: [], sessions: sessions.filter((s) => s.workspaceId === wsId(w)),
      webTabs: [], connection, request, sendImmediate: connection.sendImmediate,
      online: true, activeWorkspace: current === w, onDone() {}, onSaveLayout: async () => {},
    }))),
  );
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
  .maw-workspace-slots{display:flex;flex-direction:column;height:100%}
  .agency-workspace-view{display:flex;flex-direction:column;flex:1;min-height:0}
  .maw-split-workspace-content{flex:1;display:flex;min-height:0}
  .maw-split-container{display:flex;flex:1;min-width:0;min-height:0}
  .maw-split-pane{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
  .maw-pane-body{flex:1;display:flex;min-height:0;min-width:0;position:relative}
  .maw-session-holder{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}
  .maw-session-holder[hidden],.maw-session-pane[hidden],.maw-terminal-park{display:none !important}
  .maw-session-pane{display:flex;flex:1;flex-direction:column;min-height:0}
  .agency-agent-body{flex:1;position:relative;min-height:0}
  .agency-xterm-host,.terminal-surface{position:absolute;inset:0}
  .terminal-surface-hidden{visibility:hidden}
`;

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
};

test('30 terminals across three workspaces: working set and restore latency', { timeout: 600000 }, async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium is not installed; set PLAYWRIGHT_CHROMIUM_EXECUTABLE');
    return;
  }
  const bundle = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: WEB_ROOT },
    bundle: true, write: false, format: 'esm', jsx: 'automatic',
    loader: { '.css': 'empty' }, logLevel: 'silent',
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
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--js-flags=--expose-gc'] });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.terminals?.length >= 1);

  const measure = async (label) => {
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(250);
    const heap = await cdp.send('Runtime.getHeapUsage');
    const dom = await page.evaluate(() => ({
      nodes: document.getElementsByTagName('*').length,
      xterms: document.querySelectorAll('.xterm').length,
      rows: document.querySelectorAll('.xterm-rows').length,
      instances: window.terminals.length,
      disposed: window.disposed,
    }));
    const row = {
      label,
      heapUsedMiB: Number((heap.usedSize / (1024 * 1024)).toFixed(2)),
      heapTotalMiB: Number((heap.totalSize / (1024 * 1024)).toFixed(2)),
      ...dom,
    };
    console.log('MEASURE ' + JSON.stringify(row));
    return row;
  };

  const visitTab = async (workspace, tab) => {
    await page.evaluate((index) => window.switchWorkspace(index), workspace);
    await page.waitForFunction((index) => {
      const slot = document.querySelector('[data-workspace="' + index + '"]');
      return !!slot && getComputedStyle(slot).display !== 'none';
    }, workspace);
    const tabs = page.locator('[data-workspace="' + workspace + '"] [role="tab"]');
    await tabs.nth(tab).click();
    await page.waitForFunction(() => {
      const term = window.terminals.find((item) => item.element?.isConnected
        && item.element.closest('.maw-session-pane:not([hidden])')
        && item.element.closest('[data-workspace]')?.style.display !== 'none');
      return !!term && term.cols > 1;
    });
  };

  const fillVisible = () => page.evaluate(async (lines) => {
    const term = window.terminals.find((item) => item.element?.isConnected
      && item.element.closest('.maw-session-pane:not([hidden])')
      && item.element.closest('[data-workspace]')?.style.display !== 'none');
    if (!term) return false;
    const payload = Array.from({ length: lines }, (_, index) => 'OUT-' + String(index).padStart(5, '0') + ' ' + 'x'.repeat(60)).join('\r\n') + '\r\n';
    await new Promise((resolve) => term.write(payload, resolve));
    return true;
  }, OUTPUT_LINES);

  // Every terminal is shown once and produces output, so each one has real scrollback.
  for (let workspace = 0; workspace < WORKSPACES; workspace += 1) {
    for (let tab = 0; tab < TABS_PER_WORKSPACE; tab += 1) {
      await visitTab(workspace, tab);
      assert.equal(await fillVisible(), true, `terminal ${workspace}-${tab} received output`);
    }
  }

  const loaded = await measure('30-terminals-with-output');
  assert.ok(loaded.instances >= TERMINAL_COUNT, 'every terminal was mounted at least once');

  // Restore latency: 20 switches, alternating a recently used tab and an old one, so both
  // the warm path and the remount plus replay path are measured.
  const latencies = [];
  for (let step = 0; step < 20; step += 1) {
    const workspace = step % WORKSPACES;
    const tab = step % 2 === 0 ? (step % TABS_PER_WORKSPACE) : TABS_PER_WORKSPACE - 1 - (step % TABS_PER_WORKSPACE);
    await page.evaluate((index) => window.switchWorkspace(index), workspace);
    await page.waitForFunction((index) => {
      const slot = document.querySelector('[data-workspace="' + index + '"]');
      return !!slot && getComputedStyle(slot).display !== 'none';
    }, workspace);
    const tabs = page.locator('[data-workspace="' + workspace + '"] [role="tab"]');
    const started = Date.now();
    await tabs.nth(tab).click();
    await page.waitForFunction(() => {
      const term = window.terminals.find((item) => item.element?.isConnected
        && item.element.closest('.maw-session-pane:not([hidden])')
        && item.element.closest('[data-workspace]')?.style.display !== 'none');
      if (!term || term.cols <= 1) return false;
      const buffer = term.buffer.active;
      const text = Array.from({ length: Math.min(buffer.length, 200) }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n');
      return text.includes('RESTORED-') || text.includes('OUT-');
    });
    latencies.push(Date.now() - started);
  }
  const switched = await measure('after-20-switches');
  const report = {
    switches: latencies.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: Math.max(...latencies),
  };
  console.log('LATENCY ' + JSON.stringify(report));

  assert.ok(report.p95Ms < 500, `restore p95 must stay under 500 ms (was ${report.p95Ms})`);
  assert.ok(switched.xterms <= loaded.xterms, 'switching does not grow the graphical working set');
  assert.deepEqual(errors, []);
});

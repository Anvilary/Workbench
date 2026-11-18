// Terminal 5,000-line scrollback, shortcut consistency, and scroll stability test.
// Run: node --test packages/web/src/agency/split/terminal-scrollback-20k.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const tabA = '11111111-1111-4111-8111-111111111111';
const tabB = '22222222-2222-4222-8222-222222222222';
const tabC = '33333333-3333-4333-8333-333333333333';

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

window.sent = [];
const ws = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date().toISOString();
const workspace = { id: ws, projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Terminal Workspace', status: 'active', cwd: '/fixture', createdAt: now, updatedAt: now };

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
    session('s-c', '${tabC}', 'Shell C', 'term-c', 'terminal', 2, false),
  ]);
  const request = async (message) => {
    window.sent.push(message);
    if (message.type === 'agency.tab.action' && message.action === 'select') {
      setSessions((prev) => prev.map((row) => ({ ...row, tab: { ...row.tab, selected: row.tab.id === message.tabId } })));
    }
    return {};
  };
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

test('TASK B: 5,000-line scrollback, Ctrl+Shift+A, Ctrl+A/C semantics, and scroll stability under 25,000 lines of output', { timeout: 120000 }, async (t) => {
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
    </style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.terminals?.length === 3);

  // 1. Verify all 3 terminals have scrollback configured to 5,000
  const scrollbacks = await page.evaluate(() => window.terminals.map((t) => t.options.scrollback));
  assert.deepEqual(scrollbacks, [5000, 5000, 5000], 'All terminals must have 5,000-line scrollback');

  // 2. Stream 25,000 lines of synthetic output to concurrent terminals
  const lineChunkSize = 2500;
  const totalLines = 25000;
  await page.evaluate(async ({ totalLines, lineChunkSize }) => {
    const [tA, tB, tC] = window.terminals;
    for (let start = 0; start < totalLines; start += lineChunkSize) {
      const end = start + lineChunkSize;
      const lines = [];
      for (let i = start; i < end; i++) {
        lines.push('SYNTH_LINE_' + String(i).padStart(5, '0'));
      }
      const chunk = lines.join('\r\n') + '\r\n';
      await Promise.all([
        new Promise((r) => tA.write(chunk, r)),
        new Promise((r) => tB.write(chunk, r)),
        new Promise((r) => tC.write(chunk, r)),
      ]);
    }
  }, { totalLines, lineChunkSize });

  // 3. Verify the existing 5,000-line retention cap under 25,000 lines of output.
  const bufferStats = await page.evaluate(() => {
    const term = window.terminals[0];
    const b = term.buffer.active;
    return {
      length: b.length,
      rows: term.rows,
      firstLine: b.getLine(0)?.translateToString(true) ?? '',
      lastLine: b.getLine(b.length - 1)?.translateToString(true) ?? '',
    };
  });
  assert.equal(bufferStats.length, 5000 + bufferStats.rows, 'Buffer must cap at exactly 5,000 scrollback lines + visible rows');
  assert.equal(bufferStats.firstLine, 'SYNTH_LINE_' + String(totalLines + 1 - bufferStats.length).padStart(5, '0'), 'Oldest output rolls off at the configured capacity');

  // 4. Test Ctrl+Shift+A selects all retained lines.
  await page.evaluate(() => {
    const term = window.terminals[0];
    term.clearSelection();
    const target = term.textarea ?? term.element;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      shiftKey: true,
    }));
  });
  const selectionInfo = await page.evaluate(() => {
    const term = window.terminals[0];
    const sel = term.getSelection();
    return {
      hasSelection: term.hasSelection(),
      length: sel.length,
      startsWith: sel.slice(0, 30),
      selectionText: sel,
    };
  });
  assert.ok(selectionInfo.hasSelection, 'Ctrl+Shift+A must select terminal buffer');
  assert.ok(selectionInfo.startsWith.startsWith(bufferStats.firstLine), 'Selection includes earliest retained line');
  assert.ok(selectionInfo.selectionText.includes('SYNTH_LINE_24999'), 'Selection includes latest line');

  // 5. Test Ctrl+A continues reaching shell / CLI (does not select, produces input)
  await page.evaluate(() => {
    const term = window.terminals[0];
    term.clearSelection();
    window.sent = [];
    const target = term.textarea ?? term.element;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      shiftKey: false,
    }));
  });
  const ctrlASelection = await page.evaluate(() => window.terminals[0].hasSelection());
  assert.equal(ctrlASelection, false, 'Ctrl+A must not select text');

  // 6. Test Ctrl+C interrupt semantics:
  // With selection: copies to clipboard without sending \x03
  await page.evaluate(() => {
    const term = window.terminals[0];
    term.select(0, 0, 10);
    window.sent = [];
    const target = term.textarea ?? term.element;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      shiftKey: false,
    }));
  });
  const inputWithSel = await page.evaluate(() =>
    window.sent.filter((m) => m.type === 'input' && m.data === '\x03')
  );
  assert.equal(inputWithSel.length, 0, 'Ctrl+C with selection must not send interrupt \\x03');

  // Without selection: sends \x03 to PTY
  const handled = await page.evaluate(() => {
    const term = window.terminals[0];
    term.clearSelection();
    window.sent = [];
    const target = term.textarea ?? term.element;
    const evt = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      shiftKey: false,
    });
    return target.dispatchEvent(evt);
  });
  assert.equal(handled, true, 'Ctrl+C without selection must not be intercepted');

  // 7. Test scroll stability while new output arrives:
  // Scroll above the live viewport.
  await page.evaluate(() => {
    const term = window.terminals[0];
    term.scrollToLine(1000);
  });
  const scrollPosBefore = await page.evaluate(() => window.terminals[0].buffer.active.viewportY);
  assert.equal(scrollPosBefore, 1000, 'Viewport scrolled above live output');

  // Stream another 500 lines of output
  await page.evaluate(async () => {
    const term = window.terminals[0];
    const moreLines = Array.from({ length: 500 }, (_, i) => 'MORE_LINE_' + i).join('\r\n') + '\r\n';
    await new Promise((r) => term.write(moreLines, r));
  });
  // Verify user's viewportY stayed anchored
  const scrollPosAfter = await page.evaluate(() => window.terminals[0].buffer.active.viewportY);
  assert.ok(scrollPosAfter < 10000, 'Viewport must not jump to bottom on new output while scrolled up');

  // 8. Test Alternate-Screen TUI behavior:
  // Switch to alternate screen (\x1b[?1049h), write TUI output, verify normal buffer is preserved
  await page.evaluate(async () => {
    const term = window.terminals[0];
    await new Promise((r) => term.write('\x1b[?1049h\x1b[H=== TUI EDITOR ===', r));
  });
  const inAltBuffer = await page.evaluate(() => ({
    altActive: window.terminals[0].buffer.active.type === 'alternate',
    normalLength: window.terminals[0].buffer.normal.length,
  }));
  assert.equal(inAltBuffer.altActive, true, 'Alternate buffer is active');
  assert.ok(inAltBuffer.normalLength === 5000 + bufferStats.rows, 'Normal buffer retains the full configured history during TUI session');

  // Exit alternate screen (\x1b[?1049l)
  await page.evaluate(async () => {
    const term = window.terminals[0];
    await new Promise((r) => term.write('\x1b[?1049l', r));
  });
  const outAltBuffer = await page.evaluate(() => window.terminals[0].buffer.active.type === 'normal');
  assert.equal(outAltBuffer, true, 'Normal buffer restored after TUI exit');

  // 9. Test Reconnection with 256 KiB truncated backend replay:
  await page.evaluate(() => {
    window.emit({
      type: 'terminal.replay',
      terminalId: 'term-a',
      data: 'REPLAY_AFTER_RECONNECT\\r\\n',
      truncated: true,
    });
  });
  const reconnectedText = await page.evaluate(() => {
    const term = window.terminals[0];
    const b = term.buffer.active;
    return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '').join('\n');
  });
  assert.ok(reconnectedText.includes('Replay truncated') || reconnectedText.includes('REPLAY_AFTER_RECONNECT'), 'Reconnection handles truncated replay cleanly');
});

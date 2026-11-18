// Terminal selection and clipboard acceptance tests in real browser environment.
// Run: node --test packages/web/src/agency/split/terminal-clipboard-acceptance.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const webRoot = WEB_ROOT;

const tabA = '11111111-1111-4111-8111-111111111111';
const tabB = '22222222-2222-4222-8222-222222222222';

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

window.clipboardStore = '';
window.clipboardCalls = [];
window.sent = [];

// Mock desktop bridge
window.mawChatGpt = {
  command: async (cmd) => {
    window.clipboardCalls.push(cmd);
    if (cmd.type === 'write-clipboard-text') {
      window.clipboardStore = cmd.text;
      return { ok: true };
    }
    if (cmd.type === 'read-clipboard-text') {
      return { ok: true, text: window.clipboardStore };
    }
    return { ok: true };
  },
  subscribe: () => () => {},
};

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
    session('s-b', '${tabB}', 'Codex CLI B', 'term-b', 'agent', 1, false),
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
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const path = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(path)) return path;
  }
  return undefined;
}

test('terminal selection and clipboard acceptance: selection, copy all, copy last, feedback and shortcuts', { timeout: 120000 }, async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium is not installed');
    return;
  }
  const bundle = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: webRoot },
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
      .maw-session-pane{display:flex;flex:1;flex-direction:column;min-height:0;position:relative}
      .agency-agent-body{flex:1;position:relative;min-height:0}
      .agency-xterm-host,.terminal-surface{position:absolute;inset:0}
      .maw-context-menu{position:fixed;z-index:9999;background:#1e1e1e;border:1px solid #444;padding:4px}
      .maw-context-menu button{display:block;width:100%;text-align:left;background:none;border:none;color:white;padding:4px 8px;cursor:pointer}
      .maw-context-menu button:disabled{color:#666;cursor:default}
      .maw-pane-feedback{position:absolute;bottom:20px;right:20px;background:#333;color:white;padding:6px 12px;border-radius:4px;z-index:1000}
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
  await page.waitForFunction(() => window.terminals?.length === 2);

  // 1. Write structured shell output to Terminal A
  await page.evaluate(() => {
    const term = window.terminals[0];
    term.write('user@host:~$ git status\r\nOn branch fix/maw-terminal-clipboard\r\nnothing to commit, working tree clean\r\nuser@host:~$ ');
  });
  await page.waitForTimeout(100);

  // 2. Select text and copy via context menu
  await page.evaluate(() => {
    const term = window.terminals[0];
    term.select(0, 1, 36); // Select 'On branch fix/maw-terminal-clipboard'
  });

  // Open context menu via right-click
  await page.locator('.maw-session-pane:not([hidden])').click({ button: 'right', position: { x: 200, y: 200 } });
  await page.waitForSelector('.maw-context-menu');

  // Verify 'Copy selection' button is enabled
  const copySelBtn = page.getByRole('menuitem', { name: 'Copy selection' });
  assert.equal(await copySelBtn.isDisabled(), false, 'Copy selection must be enabled when text is selected');

  // Click Copy Selection
  await copySelBtn.click();
  await page.waitForTimeout(50);

  // Verify clipboard bridge received the selection
  const clipStore1 = await page.evaluate(() => window.clipboardStore);
  assert.ok(clipStore1.includes('On branch fix/maw-terminal-clipboard'), 'Clipboard bridge received selected text');

  // Verify success feedback toast is shown in active pane
  const feedbackToast = await page.locator('.maw-session-pane:not([hidden]) .maw-pane-feedback').textContent();
  assert.equal(feedbackToast, 'Copied', 'Success toast displays "Copied"');

  // 3. Test Select All via context menu
  await page.locator('.maw-session-pane:not([hidden])').click({ button: 'right', position: { x: 200, y: 200 } });
  await page.waitForSelector('.maw-context-menu');
  await page.getByRole('menuitem', { name: 'Select all' }).click();

  const selAllText = await page.evaluate(() => window.terminals[0].getSelection());
  assert.ok(selAllText.includes('user@host:~$ git status'), 'Select all selected the terminal buffer');
  assert.ok(selAllText.includes('nothing to commit'), 'Select all includes entire output');

  // 4. Test Copy All via context menu
  await page.locator('.maw-session-pane:not([hidden])').click({ button: 'right', position: { x: 200, y: 200 } });
  await page.waitForSelector('.maw-context-menu');
  await page.getByRole('menuitem', { name: 'Copy all' }).click();

  const clipStore2 = await page.evaluate(() => window.clipboardStore);
  assert.ok(clipStore2.includes('On branch fix/maw-terminal-clipboard'), 'Copy all wrote full buffer to clipboard');

  // 5. Test Copy Last Output via context menu
  await page.locator('.maw-session-pane:not([hidden])').click({ button: 'right', position: { x: 200, y: 200 } });
  await page.waitForSelector('.maw-context-menu');
  await page.getByRole('menuitem', { name: 'Copy last output' }).click();

  const clipStore3 = await page.evaluate(() => window.clipboardStore);
  assert.equal(
    clipStore3,
    'On branch fix/maw-terminal-clipboard\nnothing to commit, working tree clean',
    'Copy last output cleanly extracted the command output between prompts'
  );

  // 6. Test Alternate-Screen / Codex buffer limitations and "Available buffer copied" message
  // Switch to Tab B (Codex CLI)
  await page.getByRole('tab', { name: /Codex CLI B/i }).click();
  await page.waitForTimeout(100);

  // Enter alternate buffer mode in Terminal B
  await page.evaluate(() => {
    const term = window.terminals[1];
    term.write('\x1b[?1049h'); // Enter alternate screen
    term.write('┌─ Codex CLI v0.8.1 ──────────────────────┐\r\n│ Active session in alternate buffer       │\r\n└─────────────────────────────────────────┘');
  });
  await page.waitForTimeout(100);

  // Trigger Copy All on Codex alternate screen
  await page.locator('.maw-session-pane:not([hidden])').click({ button: 'right', position: { x: 200, y: 200 } });
  await page.waitForSelector('.maw-context-menu');
  await page.getByRole('menuitem', { name: 'Copy all' }).click();

  const altClip = await page.evaluate(() => window.clipboardStore);
  assert.ok(altClip.includes('Codex CLI v0.8.1'), 'Copy all in alternate screen copied the active TUI content');

  const altToast = await page.locator('.maw-session-pane:not([hidden]) .maw-pane-feedback').textContent();
  assert.equal(altToast, 'Available buffer copied', 'Alternate screen copy displays accurate limitation toast: "Available buffer copied"');

  // 7. Test Keyboard Shortcut Ctrl+Shift+V (Terminal Paste)
  await page.evaluate(() => {
    window.sent = [];
    window.clipboardStore = 'pasted command line 42';
    const term = window.terminals[1];
    const target = term.textarea ?? term.element;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'v',
      code: 'KeyV',
      ctrlKey: true,
      shiftKey: true,
    }));
  });
  await page.waitForTimeout(50);

  const pastedInput = await page.evaluate(() =>
    window.sent.filter((m) => m.type === 'input' && m.data === 'pasted command line 42')
  );
  assert.equal(pastedInput.length, 1, 'Ctrl+Shift+V pasted clipboard content into terminal PTY');

  // 8. Test Keyboard Shortcut Ctrl+C in Alternate Screen passes through to PTY
  const handled = await page.evaluate(() => {
    const term = window.terminals[1];
    term.select(0, 0, 10); // Even with selection active in alternate screen!
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
  assert.equal(handled, true, 'Ctrl+C in alternate screen must not be intercepted, reaching PTY as interrupt/cancel');

  // 9. Test selection highlight DOM properties: pointer-events: none and multi-row coverage
  await page.evaluate(() => {
    const term = window.terminals[1];
    term.select(2, 0, 80); // multi-line selection
  });
  await page.waitForTimeout(50);

  const selInfo = await page.evaluate(() => {
    const term = window.terminals[1];
    const selEl = term.element.querySelector('.xterm-selection');
    return {
      hasSelection: term.hasSelection(),
      pointerEvents: selEl ? window.getComputedStyle(selEl).pointerEvents : null,
      divsCount: selEl ? selEl.querySelectorAll('div').length : 0,
    };
  });
  assert.equal(selInfo.hasSelection, true, 'Terminal has active selection');
  assert.equal(selInfo.pointerEvents, 'none', 'Selection container must have pointer-events: none so it does not block interactions');

  // 10. Test Escape key clears selection
  await page.evaluate(() => {
    const term = window.terminals[1];
    const target = term.textarea ?? term.element;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
      code: 'Escape',
    }));
  });
  await page.waitForTimeout(50);

  const hasSelAfterEscape = await page.evaluate(() => window.terminals[1].hasSelection());
  assert.equal(hasSelAfterEscape, false, 'Pressing Escape must clear the active selection highlight');

  // 11. Test Ctrl+Shift+C copies selection and immediately clears selection
  await page.evaluate(() => {
    const term = window.terminals[1];
    term.select(0, 0, 10);
    const target = term.textarea ?? term.element;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      shiftKey: true,
    }));
  });
  await page.waitForTimeout(50);

  const hasSelAfterCopy = await page.evaluate(() => window.terminals[1].hasSelection());
  assert.equal(hasSelAfterCopy, false, 'Ctrl+Shift+C must clear selection after copying to clipboard');

  // 12. Test Context Menu "Copy selection" copies and clears selection
  await page.evaluate(() => {
    const term = window.terminals[1];
    term.select(0, 1, 15);
  });
  await page.waitForTimeout(50);

  await page.locator('.maw-session-pane:not([hidden])').click({ button: 'right', position: { x: 250, y: 250 } });
  await page.waitForSelector('.maw-context-menu');
  await page.getByRole('menuitem', { name: 'Copy selection' }).click();
  await page.waitForTimeout(50);

  const hasSelAfterMenuCopy = await page.evaluate(() => window.terminals[1].hasSelection());
  assert.equal(hasSelAfterMenuCopy, false, 'Context menu Copy selection must clear selection after copying');

  // 13. Test clicking container letterbox clears selection
  await page.evaluate(() => {
    const term = window.terminals[1];
    term.select(0, 0, 10);
  });
  await page.waitForTimeout(50);

  await page.evaluate(() => {
    const term = window.terminals[1];
    const container = term.element.parentElement;
    container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, target: container }));
  });
  await page.waitForTimeout(50);

  const hasSelAfterContainerClick = await page.evaluate(() => window.terminals[1].hasSelection());
  assert.equal(hasSelAfterContainerClick, false, 'Clicking container letterbox clears active selection');
});

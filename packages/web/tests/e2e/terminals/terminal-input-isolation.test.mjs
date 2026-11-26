// Keyboard ownership for terminals, against the real WorkspaceView and real xterm in Chromium.
// A recording connection stub captures every message the shell renderer would send to the backend.
// Run: node --test packages/web/tests/e2e/terminals/terminal-input-isolation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '99999999-9999-4999-8999-999999999999';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const TAB_A1 = '33333333-3333-4333-8333-333333333333';
const TAB_A2 = '44444444-4444-4444-8444-444444444444';
const TAB_B1 = '55555555-5555-4555-8555-555555555555';

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceView } from './src/features/workspaces/WorkspaceView.tsx';

window.sent = [];
const now = new Date().toISOString();
const mkWorkspace = (id, name) => ({ id, projectId: '${PROJECT}', name, status: 'active', cwd: '/fixture', createdAt: now, updatedAt: now });
const workspaces = { '${WS_A}': mkWorkspace('${WS_A}', 'Workspace A'), '${WS_B}': mkWorkspace('${WS_B}', 'Odysseus') };
function session(ws, id, tabId, name, terminalId, kind, order, selected) {
  return {
    id, workspaceId: ws, kind, profileId: kind === 'agent' ? 'codex-a' : null, terminalId, lifecycle: 'running',
    activity: 'idle', exitCode: null, nativeSessionId: null, selectedModel: null, selectedEffort: null,
    createdAt: now, updatedAt: now, startedAt: now, stoppedAt: null,
    tab: { id: tabId, order, selected, current: true, closedAt: null, name, terminalNumber: order + 1 },
  };
}
const sessionsByWorkspace = {
  '${WS_A}': [
    session('${WS_A}', 's-a1', '${TAB_A1}', 'Shell A1', 'term-a1', 'terminal', 0, true),
    session('${WS_A}', 's-a2', '${TAB_A2}', 'CLI A2', 'term-a2', 'agent', 1, false),
  ],
  '${WS_B}': [session('${WS_B}', 's-b1', '${TAB_B1}', 'Odysseus shell', 'term-b1', 'terminal', 0, true)],
};
const listeners = new Set();
const reopenHandlers = new Set();
const connection = {
  getStatus: () => 'open', onStatus: () => () => {},
  onReopen(fn) { reopenHandlers.add(fn); return () => reopenHandlers.delete(fn); },
  onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  send(m) { window.sent.push(m); return true; }, sendImmediate(m) { window.sent.push(m); return true; },
};
window.emit = (m) => { for (const fn of listeners) fn(m); };
window.reopen = () => { for (const fn of reopenHandlers) fn(); };
window.subscriberCount = () => ({ message: listeners.size, reopen: reopenHandlers.size });

function Harness() {
  const [current, setCurrent] = useState('${WS_A}');
  window.switchWorkspace = (id) => setCurrent(id);
  const sessions = sessionsByWorkspace[current];
  const request = async (m) => { window.sent.push(m); return {}; };
  return React.createElement(WorkspaceView, {
    key: current, workspace: workspaces[current], profiles: [], sessions, webTabs: [], connection, request,
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
  #browser-stand-in{position:fixed;right:8px;top:8px;width:200px;z-index:50}
`;

async function setup(t) {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium is not installed; set PLAYWRIGHT_CHROMIUM_EXECUTABLE');
    return null;
  }
  const bundle = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: WEB_ROOT },
    bundle: true, write: false, format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return; }
    res.setHeader('Content-Type', 'text/html');
    // #browser-stand-in plays the role of an embedded browser view: a focusable text field that is not a terminal.
    res.end(`<!doctype html><html><head><style>${PAGE_CSS}</style></head><body><div id="root"></div><input id="browser-stand-in" aria-label="browser stand-in"><script type="module" src="/bundle.js"></script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForSelector('.xterm-helper-textarea', { state: 'attached' });
  await page.waitForTimeout(150); // initial 60ms ResizeObserver fit settles
  const inputs = () => page.evaluate(() => window.sent.filter((m) => m.type === 'input').map((m) => [m.terminalId, m.data]));
  const clearSent = () => page.evaluate(() => { window.sent.length = 0; });
  const focusedTerminal = () => page.evaluate(() => document.activeElement?.className ?? '');
  return { page, errors, inputs, clearSent, focusedTerminal };
}

/** Dispatches a keyboard gesture (keydown + keypress + input) straight at one terminal's textarea. */
const syntheticKeys = (page, tabId, text) => page.evaluate(({ tabId, text }) => {
  const area = document.querySelector('#pane-' + tabId + ' .xterm-helper-textarea');
  for (const ch of text) {
    area.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true, cancelable: true }));
    area.dispatchEvent(new KeyboardEvent('keypress', { key: ch, charCode: ch.charCodeAt(0), keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0), bubbles: true, cancelable: true }));
  }
}, { tabId, text });

test('keyboard reaches only the focused, active terminal; browser focus and lost window focus send nothing', { timeout: 90000 }, async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { page, inputs, clearSent } = ctx;

  // Control: real keys in the focused terminal are delivered exactly once, to that terminal only.
  await page.locator('#pane-' + TAB_A1 + ' .xterm-helper-textarea').focus();
  await page.keyboard.type('abc');
  assert.deepEqual(await inputs(), [['term-a1', 'a'], ['term-a1', 'b'], ['term-a1', 'c']]);

  // Embedded-browser stand-in owns focus: typing, IME text and paste there must never reach any PTY.
  await clearSent();
  await page.locator('#browser-stand-in').focus();
  await page.keyboard.type('CHATGPT-TEXT');
  await page.keyboard.insertText('日本語');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'PASTED-INTO-BROWSER');
    document.getElementById('browser-stand-in').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  assert.deepEqual(await inputs(), [], 'nothing typed in the browser stand-in reaches any terminal');

  // Even if keyboard events are mis-routed to the terminal textarea while the browser view owns window
  // focus (the shell document is not focused), the terminal must not forward them.
  await page.locator('#pane-' + TAB_A1 + ' .xterm-helper-textarea').focus();
  await page.evaluate(() => { document.hasFocus = () => false; });
  await page.keyboard.type('MISROUTED');
  await page.keyboard.insertText('ime-mis');
  assert.deepEqual(await inputs(), [], 'keyboard-origin data is dropped while the shell document lacks window focus');

  // Window focus returns: delivery resumes, exactly once per key.
  await page.evaluate(() => { delete document.hasFocus; });
  await page.keyboard.type('ok');
  assert.deepEqual(await inputs(), [['term-a1', 'o'], ['term-a1', 'k']]);
  assert.deepEqual(ctx.errors, []);
});

test('an inactive terminal never emits keyboard input, even when events are dispatched at its textarea', { timeout: 90000 }, async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { page, inputs, clearSent } = ctx;

  await page.getByRole('tab', { name: /CLI A2/ }).click();
  await page.waitForFunction((id) => !document.getElementById('pane-' + id).hidden, TAB_A2);
  await clearSent();

  // term-a1 is now hidden. Stale events aimed at it (keys, composition, paste) must produce nothing.
  await syntheticKeys(page, TAB_A1, 'STALE');
  await page.evaluate((tab) => {
    const area = document.querySelector('#pane-' + tab + ' .xterm-helper-textarea');
    area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    area.value = '日本';
    area.dispatchEvent(new CompositionEvent('compositionend', { data: '日本', bubbles: true }));
    const dt = new DataTransfer();
    dt.setData('text/plain', 'STALE-PASTE');
    area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, TAB_A1);
  await page.waitForTimeout(150);
  assert.deepEqual((await inputs()).filter(([id]) => id === 'term-a1'), [], 'hidden term-a1 received no input');

  // The visible terminal still works and is the only recipient.
  await page.locator('#pane-' + TAB_A2 + ' .xterm-helper-textarea').focus();
  await page.keyboard.type('xy');
  assert.deepEqual(await inputs(), [['term-a2', 'x'], ['term-a2', 'y']]);
});

test('composition and paste are delivered once to the focused terminal only', { timeout: 90000 }, async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { page, inputs, clearSent } = ctx;
  await page.locator('#pane-' + TAB_A1 + ' .xterm-helper-textarea').focus();
  await clearSent();

  await page.keyboard.insertText('héllo');
  await page.evaluate((tab) => {
    const area = document.querySelector('#pane-' + tab + ' .xterm-helper-textarea');
    const dt = new DataTransfer();
    dt.setData('text/plain', 'PASTE-ME');
    area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, TAB_A1);
  await page.waitForTimeout(100);
  const got = await inputs();
  assert.ok(got.length >= 2 && got.every(([id]) => id === 'term-a1'), 'all input went to the focused terminal');
  assert.equal(got.map(([, data]) => data).join('').split('PASTE-ME').length - 1, 1, 'paste delivered exactly once');
  assert.equal(got.map(([, data]) => data).join('').split('héllo').length - 1, 1, 'composition text delivered exactly once');
});

test('background output and protocol replies still work for inactive terminals but never look like typed input', { timeout: 90000 }, async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { page, inputs, clearSent } = ctx;
  await page.getByRole('tab', { name: /CLI A2/ }).click();
  await page.waitForFunction((id) => !document.getElementById('pane-' + id).hidden, TAB_A2);
  await clearSent();

  // Plain background output must never cause input.
  await page.evaluate(() => window.emit({ type: 'terminal.output', terminalId: 'term-a1', data: 'background build output\r\n' }));
  await page.waitForTimeout(100);
  assert.deepEqual(await inputs(), []);

  // A background CLI asking for the cursor position still gets its answer: replies are protocol, not keyboard.
  await page.evaluate(() => window.emit({ type: 'terminal.output', terminalId: 'term-a1', data: '\x1b[6n' }));
  await page.waitForFunction(() => window.sent.some((m) => m.type === 'input' && m.terminalId === 'term-a1'));
  const replies = await inputs();
  assert.ok(replies.every(([id, data]) => id === 'term-a1' && /^\x1b\[\d+;\d+R$/.test(data)), 'only the cursor-position reply was sent, for the asking terminal');
});

test('rapid workspace switching leaves no stale terminal, subscription or input route', { timeout: 120000 }, async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { page, inputs, clearSent } = ctx;
  const subscribers = () => page.evaluate(() => window.subscriberCount());
  const baseline = await subscribers();
  await clearSent();

  for (let i = 0; i < 12; i += 1) {
    const target = i % 2 === 0 ? WS_B : WS_A;
    await page.evaluate((id) => window.switchWorkspace(id), target);
    await page.waitForFunction((id) => {
      const live = [...document.querySelectorAll('.xterm-helper-textarea')];
      return live.length === (id === '99999999-9999-4999-8999-999999999999' ? 1 : 2);
    }, target);
    // Whatever is mounted is the only thing that can take keys; focus the visible shell and type.
    const visible = target === WS_B ? TAB_B1 : TAB_A1;
    await page.locator('#pane-' + visible + ' .xterm-helper-textarea').focus();
    await page.keyboard.type(String(i % 10));
  }
  const got = await inputs();
  assert.equal(got.length, 12, 'exactly one input per keystroke, no duplicates');
  got.forEach(([id], i) => assert.equal(id, i % 2 === 0 ? 'term-b1' : 'term-a1', `keystroke ${i} reached the workspace on screen`));

  // Subscriptions of unmounted workspaces were released; only the mounted ones remain.
  const after = await subscribers();
  assert.ok(after.message <= baseline.message + 1 && after.reopen <= baseline.reopen + 1, `no leaked subscriptions: ${JSON.stringify({ baseline, after })}`);

  // The inactive workspace's terminal does not exist in the DOM, so there is nothing for stray keys to hit.
  await page.evaluate((id) => window.switchWorkspace(id), WS_A);
  await page.waitForFunction(() => document.querySelectorAll('.xterm-helper-textarea').length === 2);
  assert.equal(await page.locator('#pane-' + TAB_B1).count(), 0);
  assert.deepEqual(ctx.errors, []);
});

test('reconnects re-attach without duplicating input subscriptions', { timeout: 90000 }, async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { page, inputs, clearSent } = ctx;
  const before = await page.evaluate(() => window.subscriberCount());
  for (let i = 0; i < 5; i += 1) await page.evaluate(() => window.reopen());
  const after = await page.evaluate(() => window.subscriberCount());
  assert.deepEqual(after, before, 'reconnect handlers do not add subscriptions');

  // Initial attach plus one per reconnect, for each live terminal; read before the recorder is cleared.
  const attaches = await page.evaluate(() => window.sent.filter((m) => m.type === 'terminal.attach').map((m) => m.terminalId).sort());
  assert.deepEqual(attaches, ['term-a1', 'term-a2'].flatMap((id) => Array(6).fill(id)).sort(), 'each reconnect re-attaches each live terminal once');

  await clearSent();
  await page.locator('#pane-' + TAB_A1 + ' .xterm-helper-textarea').focus();
  await page.keyboard.type('q');
  assert.deepEqual(await inputs(), [['term-a1', 'q']], 'one keystroke is still one input after five reconnects');
});

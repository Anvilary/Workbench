import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { AgencyWorkspaceView } from './src/agency/AgencyWorkspaceView.tsx';

Terminal.prototype.open = function () {};

const ws = '11111111-1111-4111-8111-111111111111';
const now = new Date().toISOString();
const workspace = { id: ws, projectId: '22222222-2222-4222-8222-222222222222', name: 'Workspace', status: 'active', cwd: '/fixture', createdAt: now, updatedAt: now };

// Create 15 tabs to overflow horizontal tab bar
const sessions = Array.from({ length: 15 }, (_, i) => ({
  id: 'session-' + i,
  workspaceId: ws,
  kind: 'terminal',
  terminalId: 'term-' + i,
  lifecycle: 'running',
  activity: 'idle',
  exitCode: null,
  tab: { id: 'tab-' + i, order: i, selected: i === 0, current: true, closedAt: null, name: 'Tab ' + (i + 1), terminalNumber: i + 1 },
}));

const connection = {
  getStatus: () => 'open',
  onStatus: () => () => {},
  onReopen: () => () => {},
  onMessage: () => () => {},
  send: () => true,
  sendImmediate: () => true,
};

function Harness() {
  const [currentSessions, setCurrentSessions] = useState(sessions);
  const request = async (message) => {
    if (message.type === 'agency.tab.action' && message.action === 'select') {
      setCurrentSessions((prev) => prev.map((s) => ({ ...s, tab: { ...s.tab, selected: s.tab.id === message.tabId } })));
    }
    return {};
  };
  return React.createElement(AgencyWorkspaceView, {
    workspace, profiles: [], sessions: currentSessions, webTabs: [], connection, request,
    sendImmediate: connection.sendImmediate, online: true, onDone() {}, onSaveLayout: async () => {},
  });
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
`;

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter((n) => n.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const p = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(p)) return p;
  }
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

test('natural horizontal scrolling: touchpad passthrough, mousewheel line scaling, boundary bubbling, and active tab visibility', { timeout: 60000 }, async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium is not installed');
    return;
  }
  const bundle = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: process.cwd() + '/packages/web' },
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
      .maw-pane-header{display:flex;align-items:center;height:40px;background:#181b24}
      .maw-pane-tabs{display:flex;flex:1;min-width:0;overflow-x:auto;white-space:nowrap}
      .maw-session-tab{display:inline-flex;min-width:120px;height:36px;padding:0 8px}
    </style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForSelector('.maw-pane-tabs');

  // Verify tab strip overflows horizontally
  const overflow = await page.evaluate(() => {
    const strip = document.querySelector('.maw-pane-tabs');
    return {
      scrollWidth: strip.scrollWidth,
      clientWidth: strip.clientWidth,
      overflows: strip.scrollWidth > strip.clientWidth,
      scrollLeft: strip.scrollLeft,
    };
  });
  assert.ok(overflow.overflows, '15 tabs must cause horizontal overflow in 800px viewport');
  assert.equal(overflow.scrollLeft, 0);

  // 1. Touchpad horizontal gesture (deltaX > deltaY) must NOT be preventDefault'd
  const touchpadEvent = await page.evaluate(() => {
    const strip = document.querySelector('.maw-pane-tabs');
    const evt = new WheelEvent('wheel', { deltaX: 40, deltaY: 0, deltaMode: 0, cancelable: true, bubbles: true });
    strip.dispatchEvent(evt);
    return { defaultPrevented: evt.defaultPrevented };
  });
  assert.equal(touchpadEvent.defaultPrevented, false, 'Touchpad horizontal swipe must pass through to native momentum scrolling');

  // 2. Left boundary bubbling: scrolling further left when at scrollLeft === 0 must NOT preventDefault
  const leftBoundaryEvent = await page.evaluate(() => {
    const strip = document.querySelector('.maw-pane-tabs');
    strip.scrollLeft = 0;
    const evt = new WheelEvent('wheel', { deltaX: 0, deltaY: -2, deltaMode: 1, cancelable: true, bubbles: true });
    strip.dispatchEvent(evt);
    return { defaultPrevented: evt.defaultPrevented };
  });
  assert.equal(leftBoundaryEvent.defaultPrevented, false, 'Scrolling left at left boundary must bubble without preventDefault');

  // 3. Vertical mouse wheel in line mode (deltaMode 1) translates delta to horizontal scroll
  const scrollForward = await page.evaluate(() => {
    const strip = document.querySelector('.maw-pane-tabs');
    const before = strip.scrollLeft;
    const evt = new WheelEvent('wheel', { deltaX: 0, deltaY: 3, deltaMode: 1, cancelable: true, bubbles: true });
    strip.dispatchEvent(evt);
    return {
      defaultPrevented: evt.defaultPrevented,
      scrolled: strip.scrollLeft > before,
      deltaApplied: strip.scrollLeft - before,
    };
  });
  assert.equal(scrollForward.defaultPrevented, true, 'Vertical wheel within bounds must preventDefault and scroll strip');
  assert.ok(scrollForward.scrolled, 'Line mode deltaY must scroll the tab strip horizontally');
  assert.equal(scrollForward.deltaApplied, 3 * 18, 'Line mode delta must be scaled by line factor (~18px)');

  // 4. Right boundary bubbling: scrolling further right when at end must NOT preventDefault
  const rightBoundaryEvent = await page.evaluate(() => {
    const strip = document.querySelector('.maw-pane-tabs');
    strip.scrollLeft = strip.scrollWidth - strip.clientWidth;
    const evt = new WheelEvent('wheel', { deltaX: 0, deltaY: 5, deltaMode: 1, cancelable: true, bubbles: true });
    strip.dispatchEvent(evt);
    return { defaultPrevented: evt.defaultPrevented };
  });
  assert.equal(rightBoundaryEvent.defaultPrevented, false, 'Scrolling right at right boundary must bubble without preventDefault');

  // 5. Active tab visibility: selecting a tab scrolled out of view ensures it becomes visible
  await page.evaluate(() => {
    const strip = document.querySelector('.maw-pane-tabs');
    strip.scrollLeft = 0;
  });
  // Tab 15 is at the far right
  const tab15 = page.locator('.maw-session-tab').filter({ hasText: 'Tab 15' });
  await tab15.click({ force: true });
  await page.waitForFunction(() => {
    const strip = document.querySelector('.maw-pane-tabs');
    return strip.scrollLeft > 200;
  });
  const finalScrollLeft = await page.evaluate(() => document.querySelector('.maw-pane-tabs').scrollLeft);
  assert.ok(finalScrollLeft > 0, 'Selecting out-of-view tab must scroll it into view');
});

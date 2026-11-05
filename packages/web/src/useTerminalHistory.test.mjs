// Test for useTerminalHistory hook and TerminalView scrollback reduction / pagination.
// Run: node --test packages/web/src/useTerminalHistory.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const path = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(path)) return path;
  }
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useTerminalHistory, HISTORY_PAGE_SIZE, MAX_CACHED_PAGES } from './src/useTerminalHistory.ts';
import { TerminalView } from './src/TerminalView.tsx';

window.HISTORY_PAGE_SIZE = HISTORY_PAGE_SIZE;
window.MAX_CACHED_PAGES = MAX_CACHED_PAGES;

const listeners = new Set();
const sent = [];
window.sent = sent;

const connection = {
  getStatus: () => 'open',
  onStatus: () => () => {},
  onReopen: () => () => {},
  onMessage: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  send(m) {
    sent.push(m);
    return true;
  },
  sendImmediate(m) {
    sent.push(m);
    return true;
  },
};

window.emitServerMessage = (m) => {
  for (const fn of listeners) fn(m);
};

function TestHarness() {
  const [terminalId, setTerminalId] = useState('term-1');
  const [enabled, setEnabled] = useState(true);
  const [topScrolledCount, setTopScrolledCount] = useState(0);

  const history = useTerminalHistory(terminalId, connection, enabled);

  window.historyHook = history;
  window.setTerminalId = setTerminalId;
  window.setEnabled = setEnabled;
  window.topScrolledCount = topScrolledCount;

  return (
    <div style={{ width: 800, height: 400 }}>
      <TerminalView
        terminalId={terminalId}
        connection={connection}
        active={true}
        theme="dark"
        onTerminalInstance={(t) => { window.terminalInstance = t; }}
        onScrolledToTop={() => {
          setTopScrolledCount((c) => c + 1);
          history.loadOlder();
        }}
        historyHandlers={{
          onData: history._handleHistoryData,
          onError: history._handleHistoryError,
        }}
      />
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<TestHarness />);
`;

test('useTerminalHistory and TerminalView history pagination', { timeout: 60000 }, async (t) => {
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
    res.end('<!doctype html><html><head><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const browser = await chromium.launch({ headless: true, executablePath, chromiumSandbox: true });
  t.after(async () => { await browser.close(); });

  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.terminalInstance !== undefined && window.historyHook !== undefined);

  // 1. Verify constants
  const constants = await page.evaluate(() => ({
    pageSize: window.HISTORY_PAGE_SIZE,
    maxCachedPages: window.MAX_CACHED_PAGES,
  }));
  assert.equal(constants.pageSize, 1000, 'HISTORY_PAGE_SIZE must be 1,000');
  assert.equal(constants.maxCachedPages, 20, 'MAX_CACHED_PAGES must be 20');

  // 2. Verify xterm scrollback is reduced to 5,000
  const scrollback = await page.evaluate(() => window.terminalInstance.options.scrollback);
  assert.equal(scrollback, 5000, 'TerminalView scrollback must be 5,000');

  // 3. Verify initial hook state
  const initialState = await page.evaluate(() => ({
    pagesCount: window.historyHook.pages.length,
    hasMore: window.historyHook.hasMore,
    loading: window.historyHook.loading,
    error: window.historyHook.error,
  }));
  assert.equal(initialState.pagesCount, 0);
  assert.equal(initialState.hasMore, true);
  assert.equal(initialState.loading, false);
  assert.equal(initialState.error, null);

  // 4. Trigger loadOlder() and check sent message
  await page.evaluate(() => {
    window.sent.length = 0;
    window.historyHook.loadOlder();
  });

  const loadState = await page.evaluate(() => ({
    loading: window.historyHook.loading,
    sent: window.sent.filter((m) => m.type === 'terminal.history.page'),
  }));
  assert.equal(loadState.loading, true, 'loading should be true after loadOlder()');
  assert.equal(loadState.sent.length, 1);
  const page0Request = loadState.sent[0];
  assert.equal(page0Request.page, 0);
  assert.equal(page0Request.pageSize, 1000);
  assert.equal(page0Request.terminalId, 'term-1');
  assert.ok(page0Request.requestId.startsWith('hist-term-1-0-'));

  // 5. Calling loadOlder() while loading does not fire another request
  await page.evaluate(() => {
    window.sent.length = 0;
    window.historyHook.loadOlder();
  });
  const ignoredCount = await page.evaluate(() => window.sent.filter((m) => m.type === 'terminal.history.page').length);
  assert.equal(ignoredCount, 0, 'loadOlder while loading is a no-op');

  // 6. Simulate stale response (mismatched requestId) -> should be ignored
  await page.evaluate(() => {
    window.emitServerMessage({
      type: 'terminal.history.data',
      terminalId: 'term-1',
      requestId: 'wrong-id',
      page: 0,
      pageSize: 1000,
      totalLines: 1500,
      totalPages: 2,
      lines: ['line 1', 'line 2'],
      hasMore: true,
    });
  });
  const afterStale = await page.evaluate(() => ({
    loading: window.historyHook.loading,
    pagesCount: window.historyHook.pages.length,
  }));
  assert.equal(afterStale.loading, true, 'Stale response must not settle loading');
  assert.equal(afterStale.pagesCount, 0);

  // 7. Receive valid matching history data via connection message
  await page.evaluate((reqId) => {
    window.emitServerMessage({
      type: 'terminal.history.data',
      terminalId: 'term-1',
      requestId: reqId,
      page: 0,
      pageSize: 1000,
      totalLines: 1500,
      totalPages: 2,
      lines: ['page 0 line 1', 'page 0 line 2'],
      hasMore: true,
      prunedLines: 50,
      droppedBytes: 123,
      incomplete: true,
    });
  }, page0Request.requestId);

  await page.waitForFunction(() => !window.historyHook.loading);
  const afterData = await page.evaluate(() => ({
    loading: window.historyHook.loading,
    pages: window.historyHook.pages,
    hasMore: window.historyHook.hasMore,
    droppedBytes: window.historyHook.droppedBytes,
    incomplete: window.historyHook.incomplete,
  }));
  assert.equal(afterData.loading, false);
  assert.equal(afterData.hasMore, true);
  assert.equal(afterData.droppedBytes, 123);
  assert.equal(afterData.incomplete, true);
  assert.equal(afterData.pages.length, 1);
  assert.equal(afterData.pages[0].page, 0);
  assert.deepEqual(afterData.pages[0].lines, ['page 0 line 1', 'page 0 line 2']);

  // 8. Request next page (page 1)
  await page.evaluate(() => {
    window.sent.length = 0;
    window.historyHook.loadOlder();
  });
  const page1Req = await page.evaluate(() => window.sent.find((m) => m.type === 'terminal.history.page'));
  assert.equal(page1Req.page, 1, 'Next request should be page 1');

  // Deliver page 1 with hasMore = false
  await page.evaluate((reqId) => {
    window.emitServerMessage({
      type: 'terminal.history.data',
      terminalId: 'term-1',
      requestId: reqId,
      page: 1,
      pageSize: 1000,
      totalLines: 1500,
      totalPages: 2,
      lines: ['page 1 line 1'],
      hasMore: false,
    });
  }, page1Req.requestId);

  await page.waitForFunction(() => window.historyHook.pages.length === 2);
  const afterPage1 = await page.evaluate(() => ({
    pagesCount: window.historyHook.pages.length,
    hasMore: window.historyHook.hasMore,
  }));
  assert.equal(afterPage1.pagesCount, 2);
  assert.equal(afterPage1.hasMore, false);

  // 9. When hasMore is false, loadOlder() does nothing
  await page.evaluate(() => {
    window.sent.length = 0;
    window.historyHook.loadOlder();
  });
  const noMoreSent = await page.evaluate(() => window.sent.filter((m) => m.type === 'terminal.history.page').length);
  assert.equal(noMoreSent, 0, 'No more requests when hasMore is false');

  // 10. Test error handling
  await page.evaluate(() => {
    window.historyHook.reset();
  });
  const afterReset = await page.evaluate(() => ({
    pagesCount: window.historyHook.pages.length,
    hasMore: window.historyHook.hasMore,
    error: window.historyHook.error,
    droppedBytes: window.historyHook.droppedBytes,
    incomplete: window.historyHook.incomplete,
    totalLines: window.historyHook.totalLines,
    prunedLines: window.historyHook.prunedLines,
  }));
  assert.equal(afterReset.droppedBytes, 0);
  assert.equal(afterReset.incomplete, false);
  assert.equal(afterReset.totalLines, 0);
  assert.equal(afterReset.prunedLines, 0);
  assert.equal(afterReset.pagesCount, 0);
  assert.equal(afterReset.hasMore, true);
  assert.equal(afterReset.error, null);

  await page.evaluate(() => {
    window.sent.length = 0;
    window.historyHook.loadOlder();
  });
  const errReq = await page.evaluate(() => window.sent.find((m) => m.type === 'terminal.history.page'));
  await page.evaluate((reqId) => {
    window.emitServerMessage({
      type: 'terminal.history.error',
      terminalId: 'term-1',
      requestId: reqId,
      reason: 'Database read error',
    });
  }, errReq.requestId);

  await page.waitForFunction(() => window.historyHook.error !== null);
  const afterErr = await page.evaluate(() => ({
    loading: window.historyHook.loading,
    error: window.historyHook.error,
  }));
  assert.equal(afterErr.loading, false);
  assert.equal(afterErr.error, 'Database read error');

  // 11. Test LRU cache limit (MAX_CACHED_PAGES = 20)
  await page.evaluate(() => {
    window.historyHook.reset();
    for (let p = 0; p < 25; p++) {
      window.sent.length = 0;
      window.historyHook.loadOlder();
      const req = window.sent[window.sent.length - 1];
      window.historyHook._handleHistoryData({
        requestId: req.requestId,
        page: p,
        pageSize: 1000,
        totalLines: 50000,
        totalPages: 50,
        lines: ['line-' + p],
        hasMore: true,
      });
    }
  });

  const cacheTest = await page.evaluate(() => ({
    count: window.historyHook.pages.length,
    firstPage: window.historyHook.pages[0]?.page,
    lastPage: window.historyHook.pages[window.historyHook.pages.length - 1]?.page,
  }));
  assert.equal(cacheTest.count, 20, 'Pages cache must not exceed MAX_CACHED_PAGES (20)');
  assert.equal(cacheTest.firstPage, 5, 'Oldest pages (0-4) must be evicted');
  assert.equal(cacheTest.lastPage, 24, 'Latest page (24) must be retained');

  // 12. Test scroll to top detection in TerminalView
  const initialScrollCount = await page.evaluate(() => window.topScrolledCount);
  await page.evaluate(() => {
    // Fill buffer with enough lines to enable scrolling
    const lines = Array.from({ length: 50 }, (_, i) => 'Line ' + i).join('\r\n') + '\r\n';
    window.terminalInstance.write(lines);
  });
  // Scroll down then scroll to top
  await page.evaluate(() => {
    window.terminalInstance.scrollToBottom();
    window.terminalInstance.scrollToTop();
  });
  await page.waitForFunction((initial) => window.topScrolledCount > initial, initialScrollCount);
  const finalScrollCount = await page.evaluate(() => window.topScrolledCount);
  assert.ok(finalScrollCount > initialScrollCount, 'onScrolledToTop must be triggered when scrolling to viewportY === 0');

  // Persistent loss must be visible in the drawer, not only in hook state.
  await page.evaluate(() => { window.sent.length = 0; });
  await page.getByRole('button', { name: 'Open Persistent History' }).click();
  await page.waitForFunction(() => window.sent.some(m => m.type === 'terminal.history.page'));
  const drawerRequest = await page.evaluate(() => window.sent.find(m => m.type === 'terminal.history.page'));
  await page.evaluate(requestId => window.emitServerMessage({
    type: 'terminal.history.data', terminalId: 'term-1', requestId,
    page: 0, pageSize: 1000, totalLines: 1, totalPages: 1,
    lines: ['retained output'], hasMore: false, droppedBytes: 42, incomplete: true,
  }), drawerRequest.requestId);
  await page.waitForFunction(() => document.querySelector('.terminal-history-loss')?.textContent.includes('42 bytes lost'));
  assert.match(await page.locator('.terminal-history-loss').innerText(), /History is incomplete/);

});

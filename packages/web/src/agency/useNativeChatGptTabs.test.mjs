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
import { useNativeChatGptTabs } from './src/agency/useNativeChatGptTabs.ts';

window.ipcCommands = [];
window.navigateRequests = [];

window.mawChatGpt = {
  command(cmd) {
    window.ipcCommands.push(JSON.parse(JSON.stringify(cmd)));
    return Promise.resolve({ ok: true });
  },
  subscribe(cb) {
    window.onBridgeState = cb;
    return () => {};
  },
};

function TestHarness() {
  const [tabs, setTabs] = useState([]);
  const [synchronized, setSynchronized] = useState(false);

  window.setTabs = (next) => setTabs(next);
  window.setSynchronized = (next) => setSynchronized(next);

  const mockRequest = (payload) => {
    window.navigateRequests.push(payload);
    return Promise.resolve({ ok: true });
  };

  useNativeChatGptTabs(tabs, synchronized, mockRequest);
  return React.createElement('div', { id: 'test-root' }, 'ready');
}

const root = createRoot(document.getElementById('root'));
root.render(React.createElement(TestHarness));
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

test('useNativeChatGptTabs eliminates redundant update and retain IPC', { timeout: 60000 }, async (t) => {
  const executablePath = browserExecutable();
  if (!executablePath) {
    t.skip('Chromium is not installed; set PLAYWRIGHT_CHROMIUM_EXECUTABLE');
    return;
  }

  const bundle = await build({
    stdin: { contents: fixture, loader: 'tsx', resolveDir: process.cwd() + '/packages/web' },
    bundle: true,
    write: false,
    format: 'esm',
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
    res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => typeof window.setTabs === 'function');

  // Step 1: Initial mount with 2 tabs while synchronized=true
  await page.evaluate(() => {
    window.ipcCommands = [];
    window.setTabs([
      { id: 'tab-1', workspaceId: 'ws-1', url: 'https://chatgpt.com/', title: 'ChatGPT Tab 1', runtimeState: 'client-managed', closedAt: null },
      { id: 'tab-2', workspaceId: 'ws-1', url: 'https://www.perplexity.ai/', title: 'Perplexity Tab 2', runtimeState: 'client-managed', closedAt: null },
    ]);
    window.setSynchronized(true);
  });

  await page.waitForFunction(() => window.ipcCommands.length === 3);
  let commands = await page.evaluate(() => window.ipcCommands);
  assert.equal(commands.length, 3, 'initial synchronization sends 2 updates and 1 retain');
  assert.equal(commands[0].type, 'update');
  assert.equal(commands[0].id, 'tab-1');
  assert.equal(commands[0].provider, 'chatgpt');
  assert.equal(commands[1].type, 'update');
  assert.equal(commands[1].id, 'tab-2');
  assert.equal(commands[1].provider, 'perplexity');
  assert.equal(commands[2].type, 'retain');
  assert.deepEqual(commands[2].ids.sort(), ['tab-1', 'tab-2']);

  // Step 2: Tab array reference changes due to title or metadata change (zero navigation changes)
  await page.evaluate(() => {
    window.ipcCommands = [];
    window.setTabs([
      { id: 'tab-1', workspaceId: 'ws-1', url: 'https://chatgpt.com/', title: 'Updated Title 1', runtimeState: 'client-managed', closedAt: null },
      { id: 'tab-2', workspaceId: 'ws-1', url: 'https://www.perplexity.ai/', title: 'Updated Title 2', runtimeState: 'client-managed', closedAt: null },
    ]);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  commands = await page.evaluate(() => window.ipcCommands);
  assert.equal(commands.length, 0, 'metadata change produces ZERO redundant IPC commands');

  // Step 3: Navigation on tab-1
  await page.evaluate(() => {
    window.ipcCommands = [];
    window.setTabs([
      { id: 'tab-1', workspaceId: 'ws-1', url: 'https://chatgpt.com/g/g-abc', title: 'ChatGPT Custom', runtimeState: 'client-managed', closedAt: null },
      { id: 'tab-2', workspaceId: 'ws-1', url: 'https://www.perplexity.ai/', title: 'Updated Title 2', runtimeState: 'client-managed', closedAt: null },
    ]);
  });
  await page.waitForFunction(() => window.ipcCommands.length === 1);
  commands = await page.evaluate(() => window.ipcCommands);
  assert.equal(commands.length, 1, 'URL navigation sends only 1 update command and no redundant retain');
  assert.equal(commands[0].type, 'update');
  assert.equal(commands[0].id, 'tab-1');
  assert.equal(commands[0].url, 'https://chatgpt.com/g/g-abc');

  // Step 4: Adding a new tab (tab-3)
  await page.evaluate(() => {
    window.ipcCommands = [];
    window.setTabs([
      { id: 'tab-1', workspaceId: 'ws-1', url: 'https://chatgpt.com/g/g-abc', title: 'ChatGPT Custom', runtimeState: 'client-managed', closedAt: null },
      { id: 'tab-2', workspaceId: 'ws-1', url: 'https://www.perplexity.ai/', title: 'Updated Title 2', runtimeState: 'client-managed', closedAt: null },
      { id: 'tab-3', workspaceId: 'ws-1', url: 'https://chatgpt.com/', title: 'ChatGPT Tab 3', runtimeState: 'client-managed', closedAt: null },
    ]);
  });
  await page.waitForFunction(() => window.ipcCommands.length === 2);
  commands = await page.evaluate(() => window.ipcCommands);
  assert.equal(commands.length, 2, 'adding tab-3 sends 1 update for tab-3 and 1 retain');
  assert.equal(commands[0].type, 'update');
  assert.equal(commands[0].id, 'tab-3');
  assert.equal(commands[1].type, 'retain');
  assert.deepEqual(commands[1].ids.sort(), ['tab-1', 'tab-2', 'tab-3']);

  // Step 5: Closing tab-2
  await page.evaluate(() => {
    window.ipcCommands = [];
    window.setTabs([
      { id: 'tab-1', workspaceId: 'ws-1', url: 'https://chatgpt.com/g/g-abc', title: 'ChatGPT Custom', runtimeState: 'client-managed', closedAt: null },
      { id: 'tab-2', workspaceId: 'ws-1', url: 'https://www.perplexity.ai/', title: 'Updated Title 2', runtimeState: 'client-managed', closedAt: new Date().toISOString() },
      { id: 'tab-3', workspaceId: 'ws-1', url: 'https://chatgpt.com/', title: 'ChatGPT Tab 3', runtimeState: 'client-managed', closedAt: null },
    ]);
  });
  await page.waitForFunction(() => window.ipcCommands.length === 1);
  commands = await page.evaluate(() => window.ipcCommands);
  assert.equal(commands.length, 1, 'closing a tab sends only 1 retain command');
  assert.equal(commands[0].type, 'retain');
  assert.deepEqual(commands[0].ids.sort(), ['tab-1', 'tab-3']);

  // Step 6: Backend reconnect resynchronization
  await page.evaluate(() => {
    window.ipcCommands = [];
    window.setSynchronized(false);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await page.evaluate(() => {
    window.setSynchronized(true);
  });
  await page.waitForFunction(() => window.ipcCommands.length === 3);
  commands = await page.evaluate(() => window.ipcCommands);
  assert.equal(commands.length, 3, 'reconnect triggers clean resynchronization of all active tabs');
  assert.deepEqual(commands.map((c) => c.id).filter(Boolean).sort(), ['tab-1', 'tab-3']);

  // Step 7: Committed navigation pre-synchronization
  await page.evaluate(() => {
    window.ipcCommands = [];
    window.onBridgeState({ type: 'committed', id: 'tab-3', url: 'https://chatgpt.com/c/chat-session-xyz' });
  });
  const navigateRequests = await page.evaluate(() => window.navigateRequests);
  assert.equal(navigateRequests.length, 1);
  assert.equal(navigateRequests[0].tabId, 'tab-3');
  assert.equal(navigateRequests[0].url, 'https://chatgpt.com/c/chat-session-xyz');

  // When store updates with that committed URL, zero redundant IPC is sent
  await page.evaluate(() => {
    window.ipcCommands = [];
    window.setTabs([
      { id: 'tab-1', workspaceId: 'ws-1', url: 'https://chatgpt.com/g/g-abc', title: 'ChatGPT Custom', runtimeState: 'client-managed', closedAt: null },
      { id: 'tab-3', workspaceId: 'ws-1', url: 'https://chatgpt.com/c/chat-session-xyz', title: 'Committed Chat', runtimeState: 'client-managed', closedAt: null },
    ]);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  commands = await page.evaluate(() => window.ipcCommands);
  assert.equal(commands.length, 0, 'committed URL update does not send redundant update IPC');

  assert.equal(errors.length, 0, 'no page errors during execution');
});

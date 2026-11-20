import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { WEB_ROOT } from '../../helpers/paths.mjs';

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const p = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(p)) return p;
  }
  return undefined;
}

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserContextMenu } from './src/features/browser/BrowserContextMenu.tsx';
import { BrowserFindBar } from './src/features/browser/BrowserFindBar.tsx';
import './src/app/workbench.css';

const tabId = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';

const listeners = new Set();
window.__commands = [];

window.mawChatGpt = {
  command: async (cmd) => {
    window.__commands.push(cmd);
    if (cmd.type === 'find-in-page') {
      const count = cmd.text === 'none' ? 0 : 3;
      for (const listener of listeners) {
        listener({
          type: 'found-in-page',
          id: cmd.id,
          matches: count,
          activeMatchOrdinal: count > 0 ? 1 : 0,
        });
      }
    }
    return { ok: true };
  },
  subscribe: (callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};

window.__emitState = (state) => {
  for (const listener of listeners) {
    listener(state);
  }
};

function TestApp() {
  const [findOpen, setFindOpen] = useState(false);

  React.useEffect(() => {
    const onOpen = () => setFindOpen(true);
    window.addEventListener('workbench:open-find-in-page', onOpen);
    return () => window.removeEventListener('workbench:open-find-in-page', onOpen);
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111', color: '#fff', position: 'relative' }}>
      <button id="open-find-btn" onClick={() => setFindOpen(true)}>Open Find</button>
      <div id="browser-pane" className="maw-browser-pane" style={{ width: 800, height: 600, margin: '20px auto' }}>
        {findOpen && (
          <BrowserFindBar id={tabId} onClose={() => setFindOpen(false)} />
        )}
        <div id="browser-viewer" className="maw-browser-viewer" data-native-id={tabId} style={{ background: '#222' }}>
          Browser View Area
        </div>
      </div>
      <BrowserContextMenu />
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<TestApp />);
`;

test('Browser Native UX: Spellchecking Suggestions, 6-Item Context Menu, and Find in Page', async () => {
  const executable = browserExecutable();
  if (!executable) {
    console.log('Skipping Playwright browser test (no executable available)');
    return;
  }

  const bundle = await build({
    stdin: {
      contents: fixture,
      resolveDir: WEB_ROOT,
      sourcefile: 'test-app.tsx',
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"test"' },
  });

  const js = bundle.outputFiles[0]?.text || '';
  const css = existsSync(WEB_ROOT + '/src/app/workbench.css')
    ? (await import('node:fs')).readFileSync(WEB_ROOT + '/src/app/workbench.css', 'utf8')
    : '';

  const server = createServer((req, res) => {
    if (req.url === '/test.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(css);
    } else if (req.url === '/test.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(js);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/test.css"></head><body><div id="root"></div><script type="module" src="/test.js"></script></body></html>`);
    }
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await chromium.launch({
    executablePath: executable,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('#browser-pane');

    const tabId = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';

    // 1. Regular right-click: Exactly 6 standard items, no spelling section
    await page.evaluate((id) => {
      window.__emitState({
        type: 'browser-context',
        id,
        x: 100,
        y: 100,
        linkURL: '',
        selection: false,
        canGoBack: true,
        canGoForward: false,
        isEditable: false,
        misspelledWord: '',
        dictionarySuggestions: [],
      });
    }, tabId);

    await page.waitForSelector('.maw-context-menu');
    const menuButtons = await page.$$eval('.maw-context-menu button', btns => btns.map(b => b.textContent.trim()));
    assert.deepEqual(menuButtons, ['Copy', 'Open URL', 'Reload', 'Back', 'Forward', 'Search']);

    // Check Open URL is disabled when no link/selection
    const openUrlDisabled = await page.$eval('.maw-context-menu button:nth-child(2)', b => b.disabled);
    assert.equal(openUrlDisabled, true, 'Open URL must be disabled when no link or URL is selected');

    // Check Back is enabled, Forward is disabled
    const backDisabled = await page.$eval('.maw-context-menu button:nth-child(4)', b => b.disabled);
    const forwardDisabled = await page.$eval('.maw-context-menu button:nth-child(5)', b => b.disabled);
    assert.equal(backDisabled, false, 'Back should be enabled when canGoBack is true');
    assert.equal(forwardDisabled, true, 'Forward should be disabled when canGoForward is false');

    // Dismiss menu
    await page.keyboard.press('Escape');
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });

    // 2. Right-click on link: Copy copies link, Open URL is enabled
    await page.evaluate((id) => {
      window.__emitState({
        type: 'browser-context',
        id,
        x: 150,
        y: 150,
        linkURL: 'https://github.com/microsoft/vscode',
        selection: false,
        canGoBack: false,
        canGoForward: false,
        isEditable: false,
        misspelledWord: '',
        dictionarySuggestions: [],
      });
    }, tabId);

    await page.waitForSelector('.maw-context-menu');
    const openUrlEnabledOnLink = await page.$eval('.maw-context-menu button:nth-child(2)', b => !b.disabled);
    assert.equal(openUrlEnabledOnLink, true, 'Open URL must be enabled when right clicking a valid link');

    // Click Open URL -> sends open-link command
    await page.click('.maw-context-menu button:nth-child(2)');
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });

    let commands = await page.evaluate(() => window.__commands);
    const lastCmd = commands[commands.length - 1];
    assert.deepEqual(lastCmd, {
      type: 'browser-action',
      id: tabId,
      action: 'open-link',
      url: 'https://github.com/microsoft/vscode',
    });

    // 3. Right-click on misspelled word in editable field: Suggestions appear above standard items
    await page.evaluate((id) => {
      window.__emitState({
        type: 'browser-context',
        id,
        x: 120,
        y: 120,
        linkURL: '',
        selection: false,
        canGoBack: false,
        canGoForward: false,
        isEditable: true,
        misspelledWord: 'defalt',
        dictionarySuggestions: ['default', 'defeat'],
      });
    }, tabId);

    await page.waitForSelector('.maw-context-menu');
    const suggestions = await page.$$eval('.maw-context-menu-suggestion', btns => btns.map(b => b.textContent.trim()));
    assert.deepEqual(suggestions, ['default', 'defeat'], 'Spelling suggestions must appear at top of context menu');

    const hasDivider = await page.$('.maw-context-menu-divider');
    assert.ok(hasDivider, 'Divider must separate suggestions from standard items');

    // Click suggestion -> replaces misspelling
    await page.click('.maw-context-menu-suggestion:first-child');
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });

    commands = await page.evaluate(() => window.__commands);
    const replaceCmd = commands[commands.length - 1];
    assert.deepEqual(replaceCmd, {
      type: 'browser-action',
      id: tabId,
      action: 'replace-misspelling',
      word: 'default',
    });

    // 4. Misspelled word with NO suggestions: "No spelling suggestions" disabled item
    await page.evaluate((id) => {
      window.__emitState({
        type: 'browser-context',
        id,
        x: 120,
        y: 120,
        linkURL: '',
        selection: false,
        canGoBack: false,
        canGoForward: false,
        isEditable: true,
        misspelledWord: 'xyzqwertynomatch',
        dictionarySuggestions: [],
      });
    }, tabId);

    await page.waitForSelector('.maw-context-menu');
    const noSuggText = await page.$eval('.maw-context-menu-disabled-item', b => b.textContent.trim());
    assert.equal(noSuggText, 'No spelling suggestions');
    const noSuggDisabled = await page.$eval('.maw-context-menu-disabled-item', b => b.disabled);
    assert.equal(noSuggDisabled, true);

    // 5. Context menu Search item triggers Find in Page
    await page.click('.maw-context-menu button:last-child');
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });
    await page.waitForSelector('.maw-browser-find-bar');

    // 6. Find in Page functionality
    const findInput = page.locator('.maw-browser-find-input');
    await assert.rejects(async () => {
      await findInput.waitFor({ state: 'attached', timeout: 1000 });
    }, { name: 'AssertionError' }).catch(() => {});

    // Type query
    await findInput.fill('hello');
    commands = await page.evaluate(() => window.__commands);
    const findCmd = commands.find(c => c.type === 'find-in-page' && c.text === 'hello');
    assert.ok(findCmd, 'find-in-page command must be sent when query is typed');

    // Match counter check
    const counterText = await page.$eval('.maw-browser-find-counter', el => el.textContent.trim());
    assert.equal(counterText, '1/3', 'Match counter must show activeOrdinal/matches');

    // Enter -> findNext
    await findInput.press('Enter');
    commands = await page.evaluate(() => window.__commands);
    const nextCmd = commands[commands.length - 1];
    assert.deepEqual(nextCmd, {
      type: 'find-in-page',
      id: tabId,
      text: 'hello',
      forward: true,
      findNext: true,
    });

    // Shift+Enter -> previous
    await findInput.press('Shift+Enter');
    commands = await page.evaluate(() => window.__commands);
    const prevCmd = commands[commands.length - 1];
    assert.deepEqual(prevCmd, {
      type: 'find-in-page',
      id: tabId,
      text: 'hello',
      forward: false,
      findNext: true,
    });

    // Escape closes find bar and stops search
    await findInput.press('Escape');
    await page.waitForSelector('.maw-browser-find-bar', { state: 'detached' });

    commands = await page.evaluate(() => window.__commands);
    const stopCmd = commands[commands.length - 1];
    assert.deepEqual(stopCmd, {
      type: 'stop-find-in-page',
      id: tabId,
      action: 'clearSelection',
    });
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }
});

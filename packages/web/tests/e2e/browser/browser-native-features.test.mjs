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

    // 1. Regular right-click: Standard items + Inspect Page, no spelling section
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
    assert.deepEqual(menuButtons, ['Copy Page URL', 'Open URL', 'Open in external browser', 'Reload', 'Back', 'Forward', 'Search', 'Inspect Page']);

    // Check Open URL is disabled when no link/selection
    const openUrlBtn = page.locator('.maw-context-menu button', { hasText: 'Open URL' });
    assert.equal(await openUrlBtn.isDisabled(), true, 'Open URL must be disabled when no link or URL is selected');

    // Check Back is enabled, Forward is disabled
    const backBtn = page.locator('.maw-context-menu button', { hasText: 'Back' });
    const forwardBtn = page.locator('.maw-context-menu button', { hasText: 'Forward' });
    assert.equal(await backBtn.isDisabled(), false, 'Back should be enabled when canGoBack is true');
    assert.equal(await forwardBtn.isDisabled(), true, 'Forward should be disabled when canGoForward is false');

    // Dismiss menu
    await page.keyboard.press('Escape');
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });

    // 2. Right-click on link: Copy Link Address + Copy Page URL, Open URL is enabled
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
    const linkMenuButtons = await page.$$eval('.maw-context-menu button', btns => btns.map(b => b.textContent.trim()));
    assert.deepEqual(linkMenuButtons, ['Copy Link Address', 'Open link in external browser', 'Copy Page URL', 'Open URL', 'Open in external browser', 'Reload', 'Back', 'Forward', 'Search', 'Inspect Page']);

    const openUrlEnabledOnLink = await page.locator('.maw-context-menu button', { hasText: 'Open URL' }).isEnabled();
    assert.equal(openUrlEnabledOnLink, true, 'Open URL must be enabled when right clicking a valid link');

    // Click Open URL -> sends open-link command
    await page.locator('.maw-context-menu button', { hasText: 'Open URL' }).click();
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

    // 5. Inspect Page action sends inspect-page command with coordinates
    await page.locator('.maw-context-menu button', { hasText: 'Inspect Page' }).click();
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });

    commands = await page.evaluate(() => window.__commands);
    const inspectCmd = commands[commands.length - 1];
    assert.deepEqual(inspectCmd, {
      type: 'inspect-page',
      id: tabId,
      x: 120,
      y: 120,
    });

    // 6. Multilingual context menu: suggestions are shown once (not duplicated), active dictionaries toggle separately, Add to Dictionary scopes to profileId
    await page.evaluate(() => {
      localStorage.setItem('agency-ui.browser-settings.v1', JSON.stringify({
        defaultSearchEngine: 'duckduckgo',
        favorites: [],
        spellCheck: {
          enabled: true,
          languages: ['en-US', 'pt-PT'],
          configuredLanguages: ['en-US', 'pt-PT'],
          customWordsByProfile: {},
        },
      }));
      window.__openSettingsEvents = [];
      window.addEventListener('workbench:open-settings', (e) => window.__openSettingsEvents.push(e.detail));
    });

    // Reload page so useBrowserSettings initializes from seeded localStorage cleanly
    await page.reload();
    await page.waitForSelector('#browser-pane');

    await page.evaluate((id) => {
      window.__emitState({
        type: 'browser-context',
        id,
        profileId: 'custom-profile-1',
        x: 130,
        y: 140,
        linkURL: '',
        selection: false,
        canGoBack: false,
        canGoForward: false,
        isEditable: true,
        misspelledWord: 'computadorr',
        dictionarySuggestions: ['computador', 'computer'],
      });
    }, tabId);

    await page.waitForSelector('.maw-context-menu');
    const multiSuggestions = await page.$$eval('.maw-context-menu-suggestion', btns => btns.map(b => b.textContent.trim()));
    assert.deepEqual(multiSuggestions, ['computador', 'computer'], 'Combined suggestions must not be duplicated across language categories');

    const activeLangBtn = page.locator('.maw-context-menu-category-btn', { hasText: 'Active dictionaries (2)' });
    assert.equal(await activeLangBtn.getAttribute('aria-expanded'), 'false');
    await activeLangBtn.click();
    assert.equal(await activeLangBtn.getAttribute('aria-expanded'), 'true');
    const indicators = await page.$$eval('.maw-context-menu-lang-indicator', els => els.map(e => e.textContent.trim()));
    assert.equal(indicators.length, 2);

    await page.locator('.maw-context-menu-action-item', { hasText: 'Add to Dictionary' }).click();
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });

    commands = await page.evaluate(() => window.__commands);
    const addDictCmd = commands.find(c => c.type === 'add-custom-dictionary-word');
    assert.deepEqual(addDictCmd, {
      type: 'add-custom-dictionary-word',
      word: 'computadorr',
      profileId: 'custom-profile-1',
    });

    // Reopen menu and test Context menu Search item triggers Find in Page
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
        isEditable: false,
        misspelledWord: '',
        dictionarySuggestions: [],
      });
    }, tabId);
    await page.waitForSelector('.maw-context-menu');
    await page.locator('.maw-context-menu button', { hasText: 'Search' }).click();
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });
    await page.waitForSelector('.maw-browser-find-bar');

    // 6. Find in Page functionality
    const findInput = page.locator('.maw-browser-find-input');
    await assert.rejects(async () => {
      await findInput.waitFor({ state: 'attached', timeout: 1000 });
    }, { name: 'AssertionError' }).catch(() => {});

    // Type query
    await findInput.fill('hello');
    await page.waitForFunction(() => window.__commands.some(c => c.type === 'find-in-page' && c.text === 'hello'));
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
      searchId: 1,
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
      searchId: 1,
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

const integrationFixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserContextMenu } from './src/features/browser/BrowserContextMenu.tsx';
import { useBrowserSettings, resetBrowserSettingsStoreForTests } from './src/features/browser/useBrowserSettings.ts';
import { SettingsDialog } from './src/features/settings/SettingsDialog.tsx';
import './src/app/workbench.css';

resetBrowserSettingsStoreForTests();

const tabId = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';
const listeners = new Set();
window.__commands = [];
window.__serverUpdates = [];
window.__failNextBackendCommit = false;
window.__failNextReconcile = false;
window.__preexistingStatus = {
  enabled: true,
  languages: ['en-US', 'fr'],
  statuses: {
    'en-US': { status: 'ready', failedPartitions: [] },
    'fr': { status: 'failed', failedPartitions: ['persist:maw-chatgpt'] },
  },
};

window.mawChatGpt = {
  command: async (cmd) => {
    window.__commands.push(cmd);
    if (cmd.type === 'get-available-spellcheck-languages') {
      return { ok: true, languages: ['en-US', 'fr', 'pt-PT'] };
    }
    if (cmd.type === 'get-spellcheck-status') {
      return { ok: true, ...window.__preexistingStatus };
    }
    if (cmd.type === 'reconcile-custom-dictionary') {
      if (window.__failNextReconcile) {
        window.__failNextReconcile = false;
        return { ok: false, failedPartitions: ['persist:maw-chatgpt'], error: 'Simulated partition sync failure' };
      }
      return { ok: true, failedPartitions: [] };
    }
    return { ok: true };
  },
  subscribe: (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

window.__emitState = (s) => {
  for (const l of listeners) l(s);
};

function applyServerChange(prev, change) {
  const next = {
    ...prev,
    ...(change.browser?.defaultSearchEngine !== undefined ? { defaultSearchEngine: change.browser.defaultSearchEngine } : {}),
    ...(change.browser?.favorites !== undefined ? { favorites: change.browser.favorites } : {}),
    ...(change.browser?.searchEngines !== undefined ? { searchEngines: change.browser.searchEngines } : {}),
    spellCheck: {
      ...prev.spellCheck,
      ...(change.browser?.spellCheck ?? {}),
      customWordsByProfile: { ...(prev.spellCheck.customWordsByProfile ?? {}) },
    },
  };
  if (change.customDictionary) {
    const { action, profileId, word } = change.customDictionary;
    const map = { ...next.spellCheck.customWordsByProfile };
    const cur = map[profileId] ?? [];
    if (action === 'add' && !cur.includes(word)) {
      map[profileId] = [...cur, word].sort();
    } else if (action === 'remove') {
      const filtered = cur.filter((w) => w !== word);
      if (filtered.length > 0) map[profileId] = filtered;
      else delete map[profileId];
    }
    next.spellCheck.customWordsByProfile = map;
  }
  return next;
}

function IntegrationApp() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [remoteClient, setRemoteClient] = useState(false);
  const [browserState, setBrowserState] = useState({
    defaultSearchEngine: 'duckduckgo',
    favorites: [{ id: 'chatgpt', title: 'ChatGPT', url: 'https://chatgpt.com/' }],
    searchEngines: [{ id: 'duckduckgo', name: 'DuckDuckGo', homeUrl: 'https://duckduckgo.com/', searchUrl: 'https://duckduckgo.com/?q=%s', isBuiltin: true }],
    spellCheck: {
      enabled: true,
      languages: ['en-US', 'fr'],
      configuredLanguages: ['en-US', 'fr'],
      customWordsByProfile: { main: ['initialword'] },
    },
  });
  const latestBrowserRef = React.useRef(browserState);
  latestBrowserRef.current = browserState;

  const makeStatus = (browser) => ({
    consoleShell: 'auto',
    consoleShells: [{ id: 'bash', label: 'Bash (/bin/bash)' }],
    shellName: 'bash',
    disabledAgents: [],
    disabledAtStart: [],
    browser,
  });

  const appSettings = {
    status: makeStatus(browserState),
    problem: null,
    setConsoleShell: () => {},
    setDisabledAgents: () => {},
    setBrowserSettings: (patch) => {
      const next = applyServerChange(latestBrowserRef.current, { browser: patch });
      latestBrowserRef.current = next;
      window.__serverUpdates.push(next);
      setBrowserState(next);
    },
    updateBrowserSettings: async (change) => {
      if (window.__failNextBackendCommit) {
        window.__failNextBackendCommit = false;
        return { ok: false, code: 'rejected', error: 'Simulated server write failure' };
      }
      const next = applyServerChange(latestBrowserRef.current, change);
      latestBrowserRef.current = next;
      window.__serverUpdates.push(next);
      setBrowserState(next);
      return { ok: true, settings: makeStatus(next) };
    },
    dismissProblem: () => {},
  };

  window.__pushServerStatus = (nextBrowser) => {
    latestBrowserRef.current = nextBrowser;
    setBrowserState(nextBrowser);
  };

  // Multiple mounted consumers sharing authoritative appSettings (never duplicates IPC)
  useBrowserSettings(appSettings);
  useBrowserSettings(appSettings);

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111', color: '#fff' }}>
      <button id="open-settings-btn" onClick={() => setSettingsOpen(true)}>Open Settings</button>
      <button id="toggle-remote-btn" style={{ position: 'fixed', top: 8, right: 8, zIndex: 99999 }} onClick={() => setRemoteClient((v) => !v)}>Toggle Remote</button>
      <div className="maw-browser-pane" style={{ width: 800, height: 600 }}>
        <div className="maw-browser-viewer" data-native-id={tabId}>Viewer</div>
      </div>
      <BrowserContextMenu appSettings={appSettings} />
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          terminalTheme={{ preference: 'dark', current: 'dark', setPreference: () => {} }}
          appSettings={appSettings}
          agents={[]}
          remoteClient={remoteClient}
          initialTab="browser"
          browserProfiles={[
            { id: 'main', name: 'Main', createdAt: '', updatedAt: '', isDefault: true },
            { id: 'work-profile', name: 'Work Profile', createdAt: '', updatedAt: '' },
          ]}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<IntegrationApp />);
`;

test('R1/R2/R4/R5: context-menu dictionary persistence without Settings, failure handling, empty configured languages, and pre-existing status', async () => {
  const executable = browserExecutable();
  if (!executable) {
    console.log('Skipping Playwright browser test (no executable available)');
    return;
  }

  const bundle = await build({
    stdin: { contents: integrationFixture, resolveDir: WEB_ROOT, sourcefile: 'integration-app.tsx', loader: 'tsx' },
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
      res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/test.css"></head><body><div id="root"></div><script type="module" src="/test.js"></script></body></html>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: executable, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('.maw-browser-pane');

    // Deduplicated IPC across multiple mounted hooks
    const updateCmds = await page.evaluate(() => window.__commands.filter((c) => c.type === 'update-spellcheck-settings').length);
    assert.equal(updateCmds, 1, 'Multiple mounted useBrowserSettings hooks must deduplicate native IPC');

    // 1. Add word via BrowserContextMenu BEFORE SettingsDialog has ever been opened!
    await page.evaluate(() => {
      window.__emitState({
        type: 'browser-context',
        id: '8e4fefc1-e565-40cc-b85b-f7d43a16b1df',
        profileId: 'work-profile',
        x: 100,
        y: 100,
        linkURL: '',
        selection: false,
        canGoBack: false,
        canGoForward: false,
        isEditable: true,
        misspelledWord: 'ctxnewword',
        dictionarySuggestions: [],
      });
    });
    await page.waitForSelector('.maw-context-menu');
    await page.locator('.maw-context-menu-action-item', { hasText: 'Add to Dictionary' }).click();
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });

    await page.waitForFunction(() => window.__serverUpdates.length >= 1);
    const afterCtxSave = await page.evaluate(() => window.__serverUpdates.at(-1));
    assert.deepEqual(afterCtxSave.spellCheck.customWordsByProfile['work-profile'], ['ctxnewword']);

    // 2. Backend commit rejection prevents state mutation and skips native reconciliation
    const prevRecCount = await page.evaluate(() => window.__commands.filter((c) => c.type === 'reconcile-custom-dictionary').length);
    const prevUpdateCount = await page.evaluate(() => window.__serverUpdates.length);
    await page.evaluate(() => {
      window.__failNextBackendCommit = true;
      window.__emitState({
        type: 'browser-context',
        id: '8e4fefc1-e565-40cc-b85b-f7d43a16b1df',
        profileId: 'main',
        x: 100,
        y: 100,
        linkURL: '',
        selection: false,
        canGoBack: false,
        canGoForward: false,
        isEditable: true,
        misspelledWord: 'shouldnotpersist',
        dictionarySuggestions: [],
      });
    });
    await page.waitForSelector('.maw-context-menu');
    await page.locator('.maw-context-menu-action-item', { hasText: 'Add to Dictionary' }).click();
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.__serverUpdates.length), prevUpdateCount, 'Rejected server commit must not record update');
    assert.equal(
      await page.evaluate(() => window.__commands.filter((c) => c.type === 'reconcile-custom-dictionary').length),
      prevRecCount,
      'Rejected backend commit must not mutate native dictionary',
    );

    // 2b. Authoritative commit + failed native reconciliation surfaces recoverable Retry sync banner in Settings
    await page.evaluate(() => {
      window.__failNextReconcile = true;
      window.__emitState({
        type: 'browser-context',
        id: '8e4fefc1-e565-40cc-b85b-f7d43a16b1df',
        profileId: 'work-profile',
        x: 100,
        y: 100,
        linkURL: '',
        selection: false,
        canGoBack: false,
        canGoForward: false,
        isEditable: true,
        misspelledWord: 'durablepending',
        dictionarySuggestions: [],
      });
    });
    await page.waitForSelector('.maw-context-menu');
    await page.locator('.maw-context-menu-action-item', { hasText: 'Add to Dictionary' }).click();
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });

    // 3. Open SettingsDialog later -> pre-existing dictionary failure, retry sync warning, and committed words must all be visible!
    await page.click('#open-settings-btn');
    await page.waitForSelector('#setting-card-spellcheck');
    const spellCard = page.locator('#setting-card-spellcheck');
    const retryBtn = spellCard.locator('button', { hasText: 'Retry sync' });
    await retryBtn.waitFor();
    await retryBtn.click();
    await retryBtn.waitFor({ state: 'detached' });
    const warningText = await spellCard.locator('.maw-settings-warning-text').textContent();
    assert.ok(warningText?.includes('French'), `Expected pre-existing French failure warning, got: ${warningText}`);

    await spellCard.locator('select.maw-settings-select').selectOption('work-profile');
    const dictWords = await spellCard.locator('.maw-settings-dict-word').allTextContents();
    assert.deepEqual(dictWords, ['ctxnewword', 'durablepending']);

    // 4. Remove all configured languages -> preserves empty state without restoring en-US
    const removeButtons = spellCard.locator('.maw-settings-lang-item button[aria-label^="Remove"]');
    while ((await removeButtons.count()) > 0) {
      await removeButtons.first().click();
    }
    await spellCard.locator('.maw-settings-empty-hint', { hasText: 'No spell check languages configured.' }).waitFor();
    const emptySave = await page.evaluate(() => window.__serverUpdates.at(-1));
    assert.deepEqual(emptySave.spellCheck.configuredLanguages, []);
    assert.deepEqual(emptySave.spellCheck.languages, []);

    // 5. Remote client without local desktop editing shows explicit read-only state
    await page.click('#toggle-remote-btn');
    await spellCard.locator('div[role="status"]', { hasText: 'desktop app' }).waitFor();
    assert.equal(await spellCard.locator('.maw-settings-dict-add-form input').isDisabled(), true);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  validateBrowserFavoriteUrl,
  resolveAddressBarInput,
  getSearchEngine,
  SEARCH_ENGINES,
  DEFAULT_BROWSER_FAVORITES,
  parseBrowserSettings,
  validateFaviconUrl,
  selectBestFavicon,
} from '@agent-workbench/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(webRoot, '../..');
const require = createRequire(path.join(projectRoot, 'package.json'));
const { build } = require('esbuild');
const { chromium } = require('playwright');

const artifactDir = '/home/user/.local/share/agy-2-profile/home/.gemini/antigravity-cli/brain/be5152c3-72cd-4309-8c79-631f1ff8eae9';
const screenshotsDir = path.join(artifactDir, 'screenshots');
mkdirSync(screenshotsDir, { recursive: true });

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

// ---------------------------------------------------------------------------
// UNIT TESTS: URL Validation, Address Bar Resolution, Favicon Security
// ---------------------------------------------------------------------------

test('validateBrowserFavoriteUrl: handles schemes, loopback, normalization, and security', () => {
  // Normalization to HTTPS
  assert.equal(validateBrowserFavoriteUrl('chatgpt.com').normalizedUrl, 'https://chatgpt.com/');
  assert.equal(validateBrowserFavoriteUrl('https://github.com/torvalds').normalizedUrl, 'https://github.com/torvalds');
  assert.equal(validateBrowserFavoriteUrl('https://news.ycombinator.com/').normalizedUrl, 'https://news.ycombinator.com/');

  // Loopback auto-prefixing with HTTP
  assert.equal(validateBrowserFavoriteUrl('localhost:3000').normalizedUrl, 'http://localhost:3000/');
  assert.equal(validateBrowserFavoriteUrl('127.0.0.1:8080/app').normalizedUrl, 'http://127.0.0.1:8080/app');
  assert.equal(validateBrowserFavoriteUrl('http://localhost:5173').normalizedUrl, 'http://localhost:5173/');

  // Rejection of dangerous or non-HTTP(S) schemes
  assert.equal(validateBrowserFavoriteUrl('javascript:alert(1)').valid, false);
  assert.equal(validateBrowserFavoriteUrl('file:///etc/passwd').valid, false);
  assert.equal(validateBrowserFavoriteUrl('data:text/html,test').valid, false);
  assert.equal(validateBrowserFavoriteUrl('chrome://settings').valid, false);

  // Rejection of credentials
  assert.equal(validateBrowserFavoriteUrl('https://user:pass@example.com').valid, false);

  // Rejection of invalid inputs, control characters, empty strings
  assert.equal(validateBrowserFavoriteUrl('').valid, false);
  assert.equal(validateBrowserFavoriteUrl('   ').valid, false);
  assert.equal(validateBrowserFavoriteUrl('https://evil.com/\u0000bad').valid, false);
});

test('resolveAddressBarInput: direct URL detection vs search engine query resolution', () => {
  const ddg = getSearchEngine('duckduckgo');
  const google = getSearchEngine('google');

  // Direct URLs remain URLs
  assert.equal(resolveAddressBarInput('https://github.com/google', ddg).url, 'https://github.com/google');
  assert.equal(resolveAddressBarInput('github.com', ddg).url, 'https://github.com/');
  assert.equal(resolveAddressBarInput('localhost:3000/api', ddg).url, 'http://localhost:3000/api');

  // Free text search queries are safely encoded with encodeURIComponent
  assert.equal(
    resolveAddressBarInput('quantum computing algorithms', ddg).url,
    'https://duckduckgo.com/?q=quantum%20computing%20algorithms',
  );
  assert.equal(
    resolveAddressBarInput('hello & world = test + 1', google).url,
    'https://www.google.com/search?q=hello%20%26%20world%20%3D%20test%20%2B%201',
  );
});

test('validateFaviconUrl & selectBestFavicon: strict schema, safe data URIs, scheme protection', () => {
  // Valid HTTPS URLs
  assert.equal(validateFaviconUrl('https://chatgpt.com/favicon.ico'), 'https://chatgpt.com/favicon.ico');
  assert.equal(validateFaviconUrl('https://github.githubassets.com/favicon.png'), 'https://github.githubassets.com/favicon.png');

  // Valid base64 data URIs
  const validDataPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  assert.equal(validateFaviconUrl(validDataPng), validDataPng);

  // Dangerous / forbidden schemes
  assert.equal(validateFaviconUrl('file:///etc/passwd'), null);
  assert.equal(validateFaviconUrl('javascript:alert(1)'), null);
  assert.equal(validateFaviconUrl('chrome://settings/icon.png'), null);
  assert.equal(validateFaviconUrl('about:blank'), null);
  assert.equal(validateFaviconUrl('blob:https://chatgpt.com/uuid'), null);

  // Credentials and non-standard HTTPS ports
  assert.equal(validateFaviconUrl('https://admin:secret@site.com/icon.png'), null);
  assert.equal(validateFaviconUrl('https://site.com:8443/icon.png'), null);

  // Oversized data payloads (>64KB)
  assert.equal(validateFaviconUrl('data:image/png;base64,' + 'A'.repeat(70000)), null);

  // selectBestFavicon picks first valid candidate
  const candidates = [
    'file:///private/key.png',
    'javascript:alert(1)',
    'https://chatgpt.com/favicon.ico',
    validDataPng,
  ];
  assert.equal(selectBestFavicon(candidates), 'https://chatgpt.com/favicon.ico');
  assert.equal(selectBestFavicon(['file:///etc/hosts']), null);
});

test('parseBrowserSettings: parses versioned settings and restores defaults on corruption', () => {
  // Undefined input returns null
  assert.equal(parseBrowserSettings(undefined), null);

  // Empty record falls back to defaults
  const def = parseBrowserSettings({});
  assert.notEqual(def, null);
  assert.equal(def.defaultSearchEngine, 'duckduckgo');
  assert.equal(def.favorites.length, 3);
  assert.equal(def.favorites[0].title, 'ChatGPT');

  // Valid custom settings
  const custom = parseBrowserSettings({
    defaultSearchEngine: 'brave',
    favorites: [
      { id: 'fav-1', title: 'Docs', url: 'https://docs.rs' },
    ],
  });
  assert.notEqual(custom, null);
  assert.equal(custom.defaultSearchEngine, 'brave');
  assert.equal(custom.favorites.length, 1);
  assert.equal(custom.favorites[0].title, 'Docs');

  // Corrupted / invalid input recovers safely
  const corrupted = parseBrowserSettings({
    defaultSearchEngine: 'non-existent-engine',
    favorites: 'not-an-array',
  });
  assert.notEqual(corrupted, null);
  assert.equal(corrupted.defaultSearchEngine, 'duckduckgo');
  assert.equal(corrupted.favorites.length, 3);
});

// ---------------------------------------------------------------------------
// PLAYWRIGHT INTEGRATION & VISUAL ACCEPTANCE SUITE
// ---------------------------------------------------------------------------

const clientHarnessCode = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsDialog } from './src/SettingsDialog.tsx';
import { BrowserDestinationPicker } from './src/agency/split/BrowserDestinationPicker.tsx';
import { GlobeIcon } from './src/agency/GlobeIcon.tsx';
import { TabNameInput } from './src/agency/TabNameInput.tsx';
import { DEFAULT_BROWSER_FAVORITES, getSearchEngine } from '@agent-workbench/shared';

let currentTheme = 'dark';
const mockTheme = {
  preference: 'dark',
  current: 'dark',
  setPreference: (p) => { currentTheme = p; },
};

const mockPanels = {
  hidden: new Set(['memory']),
  isVisible: (p) => p !== 'memory',
  setVisible: () => {},
};

const mockAgents = {
  activeFamily: 'codex',
  families: [
    { id: 'codex', name: 'OpenAI Codex', description: 'Advanced code reasoning and synthesis' },
    { id: 'claude', name: 'Claude Code', description: 'Deep code search and implementation' },
  ],
  profiles: [],
  defaultProfileId: 'codex-general',
  recentProfiles: [],
  disabledAgents: [],
  autoStartAgents: true,
};

let currentBrowserSettings = {
  defaultSearchEngine: 'duckduckgo',
  favorites: [
    { id: 'fav-chatgpt', title: 'ChatGPT', url: 'https://chatgpt.com/' },
    { id: 'fav-perplexity', title: 'Perplexity', url: 'https://www.perplexity.ai/' },
    { id: 'fav-github', title: 'GitHub', url: 'https://github.com/' },
  ],
};

const mockAppSettings = {
  status: {
    consoleShell: 'auto',
    consoleShells: [
      { id: 'login', label: 'Login Shell (/bin/bash)' },
      { id: 'bash', label: 'Bash (/usr/bin/bash)' },
    ],
    shellName: 'bash',
    disabledAgents: [],
    disabledAtStart: [],
    browser: currentBrowserSettings,
  },
  problem: null,
  setConsoleShell: () => {},
  setDisabledAgents: () => {},
  dismissProblem: () => {},
  setBrowserSettings: (patch) => {
    currentBrowserSettings = { ...currentBrowserSettings, ...patch };
  },
  patchSettings: () => Promise.resolve(),
};

const mockConnection = {
  send: () => {},
  onMessage: () => () => {},
  isRemoteClient: () => false,
};

// Sample verified data URI for favicon
const sampleFaviconDataUri = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2Ij48Y2lyY2xlIGN4PSI4IiBjeT0iOCIgcj0iNyIgZmlsbD0iIzEwYTM3ZiIvPjxwYXRoIGQ9Ik04IDRhNCA0IDAgMSA0IDQgNCA0IDAgMS00IDQgNCA0IDAgMS00LTQgNCA0IDAgMSA0LTQiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';

function AcceptanceHarness() {
  const [view, setView] = useState('settings'); // 'settings' | 'picker' | 'tabs' | 'split-panes'
  const [renamingTabId, setRenamingTabId] = useState(null);
  const [tabs, setTabs] = useState([
    { id: 'tab-1', title: 'ChatGPT', kind: 'web', provider: 'chatgpt', favicon: sampleFaviconDataUri, selected: false },
    { id: 'tab-2', title: 'Project Dashboard', kind: 'web', provider: 'other', favicon: sampleFaviconDataUri, selected: true },
    { id: 'tab-3', title: 'Search - DuckDuckGo', kind: 'web', provider: 'other', favicon: null, selected: false },
    { id: 'tab-4', title: 'Terminal 1', kind: 'terminal', selected: false },
    { id: 'tab-5', title: 'Codex Agent', kind: 'agent', selected: false },
  ]);

  const activeTab = tabs.find(t => t.id === 'tab-2') || tabs[0];

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#121316', color: '#ececec', display: 'flex', flexDirection: 'column' }}>
      {/* Top Test Navigation Bar */}
      <div id="test-nav" style={{ padding: '8px 16px', background: '#1c1d22', borderBottom: '1px solid #2a2b32', display: 'flex', gap: '8px', position: 'relative', zIndex: 99999 }}>
        <button id="show-settings-btn" onClick={() => setView('settings')} style={{ padding: '4px 12px', background: view === 'settings' ? '#2563eb' : '#2a2b32', color: '#fff', border: 0, borderRadius: '4px', cursor: 'pointer' }}>Settings &gt; Browser</button>
        <button id="show-picker-btn" onClick={() => setView('picker')} style={{ padding: '4px 12px', background: view === 'picker' ? '#2563eb' : '#2a2b32', color: '#fff', border: 0, borderRadius: '4px', cursor: 'pointer' }}>Destination Picker</button>
        <button id="show-tabs-btn" onClick={() => setView('tabs')} style={{ padding: '4px 12px', background: view === 'tabs' ? '#2563eb' : '#2a2b32', color: '#fff', border: 0, borderRadius: '4px', cursor: 'pointer' }}>Tab Strip &amp; Favicons</button>
        <button id="show-split-btn" onClick={() => setView('split-panes')} style={{ padding: '4px 12px', background: view === 'split-panes' ? '#2563eb' : '#2a2b32', color: '#fff', border: 0, borderRadius: '4px', cursor: 'pointer' }}>Split Panes</button>
      </div>

      {/* Main View Area */}
      <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {view === 'settings' && (
          <SettingsDialog
            onClose={() => {}}
            terminalTheme={mockTheme}
            panels={mockPanels}
            showPanels={true}
            consoleCount={2}
            onHideConsole={() => {}}
            appSettings={mockAppSettings}
            agents={mockAgents}
            remoteClient={false}
            onOpenVault={() => {}}
            onOpenRemote={() => {}}
            connection={mockConnection}
            initialTab="browser"
          />
        )}

        {view === 'picker' && (
          <div style={{ background: '#18191e', border: '1px solid #2e303b', borderRadius: '8px', padding: '6px', width: '280px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
            <BrowserDestinationPicker
              favorites={currentBrowserSettings.favorites}
              searchEngine={getSearchEngine(currentBrowserSettings.defaultSearchEngine)}
              onSelectFavorite={(fav) => alert('Selected favorite: ' + fav.title)}
              onSelectOther={() => alert('Selected other')}
            />
          </div>
        )}

        {view === 'tabs' && (
          <div style={{ width: '800px', background: '#18191e', borderRadius: '8px', border: '1px solid #2a2b32', overflow: 'hidden' }}>
            <div className="maw-pane-header is-focused" style={{ background: '#1c1d22', borderBottom: '1px solid #2a2b32', display: 'flex', alignItems: 'center' }}>
              <div className="maw-tabs-strip" role="tablist" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {tabs.map((tab) => {
                  const isRenaming = renamingTabId === tab.id;
                  const isSelected = tab.selected;
                  return (
                    <div
                      key={tab.id}
                      className={'maw-session-tab ' + (isSelected ? 'active ' : '') + (isRenaming ? 'renaming' : '')}
                      data-tab-id={tab.id}
                      style={{ minWidth: '140px', maxWidth: '200px' }}
                    >
                      {isRenaming ? (
                        <div className="maw-tab-rename-row">
                          <span className="maw-tab-icon" aria-hidden="true">
                            {tab.favicon ? (
                              <span className="maw-tab-icon-wrapper">
                                <img className="maw-tab-favicon" src={tab.favicon} alt="" />
                              </span>
                            ) : (
                              <span className="maw-tab-icon-fallback">
                                <GlobeIcon size={14} />
                              </span>
                            )}
                          </span>
                          <TabNameInput
                            name={tab.title}
                            report={(err) => alert(err)}
                            onSave={async (newTitle) => {
                              setTabs(tabs.map(t => t.id === tab.id ? { ...t, title: newTitle } : t));
                              setRenamingTabId(null);
                            }}
                            onClose={() => setRenamingTabId(null)}
                          />
                          <span className="agency-status-dot idle" />
                        </div>
                      ) : (
                        <button
                          type="button"
                          role="tab"
                          id={'tab-' + tab.id}
                          aria-selected={isSelected}
                          onDoubleClick={() => setRenamingTabId(tab.id)}
                          onClick={() => setTabs(tabs.map(t => ({ ...t, selected: t.id === tab.id })))}
                        >
                          <span className="maw-tab-icon" aria-hidden="true">
                            {tab.kind === 'web' ? (
                              tab.favicon ? (
                                <span className="maw-tab-icon-wrapper">
                                  <img className="maw-tab-favicon" src={tab.favicon} alt="" />
                                </span>
                              ) : (
                                <span className="maw-tab-icon-fallback">
                                  <GlobeIcon size={14} />
                                </span>
                              )
                            ) : tab.kind === 'terminal' ? (
                              <span>&gt;_</span>
                            ) : (
                              <span>◇</span>
                            )}
                          </span>
                          <span className="agency-truncate" onDoubleClick={() => setRenamingTabId(tab.id)}>
                            {tab.title}
                          </span>
                          <span className="agency-status-dot idle" />
                        </button>
                      )}
                      <button type="button" data-close aria-label="Close tab">×</button>
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={{ height: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#71717a' }}>
              Tab Content Area ({activeTab.title})
            </div>
          </div>
        )}

        {view === 'split-panes' && (
          <div style={{ width: '900px', height: '400px', display: 'flex', gap: '8px', padding: '8px', boxSizing: 'border-box' }}>
            {/* Left Split Pane */}
            <div style={{ flex: 1, background: '#18191e', borderRadius: '8px', border: '1px solid #2a2b32', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div className="maw-pane-header is-focused" style={{ background: '#1c1d22', borderBottom: '1px solid #2a2b32' }}>
                <div className="maw-tabs-strip" role="tablist">
                  <div className="maw-session-tab active">
                    <button type="button" role="tab" aria-selected="true">
                      <span className="maw-tab-icon"><img className="maw-tab-favicon" src={sampleFaviconDataUri} alt="" /></span>
                      <span className="agency-truncate">ChatGPT</span>
                      <span className="agency-status-dot idle" />
                    </button>
                    <button type="button" data-close>×</button>
                  </div>
                </div>
              </div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#71717a' }}>
                ChatGPT Pane WebContentsView
              </div>
            </div>

            {/* Right Split Pane */}
            <div style={{ flex: 1, background: '#18191e', borderRadius: '8px', border: '1px solid #2a2b32', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div className="maw-pane-header is-focused" style={{ background: '#1c1d22', borderBottom: '1px solid #2a2b32' }}>
                <div className="maw-tabs-strip" role="tablist">
                  <div className="maw-session-tab active">
                    <button type="button" role="tab" aria-selected="true">
                      <span className="maw-tab-icon"><img className="maw-tab-favicon" src={sampleFaviconDataUri} alt="" /></span>
                      <span className="agency-truncate">Project Dashboard</span>
                      <span className="agency-status-dot idle" />
                    </button>
                    <button type="button" data-close>×</button>
                  </div>
                  <div className="maw-session-tab">
                    <button type="button" role="tab" aria-selected="false">
                      <span className="maw-tab-icon"><GlobeIcon size={14} /></span>
                      <span className="agency-truncate">Other Search</span>
                      <span className="agency-status-dot idle" />
                    </button>
                    <button type="button" data-close>×</button>
                  </div>
                </div>
              </div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#71717a' }}>
                Dashboard WebContentsView (Isolated Partition)
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<AcceptanceHarness />);
`;

test('Browser Acceptance Suite: Settings, Destination Picker, Favicons, Minimal Inline Rename, Split Panes', async (t) => {
  const buildResult = await build({
    stdin: {
      contents: clientHarnessCode,
      resolveDir: webRoot,
      sourcefile: 'acceptance-harness.tsx',
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.css': 'text' },
    define: {
      'process.env.NODE_ENV': '"development"',
    },
  });

  const bundledJs = buildResult.outputFiles[0].text;
  const cssPath = path.join(webRoot, 'src', 'agency', 'agency.css');
  const cssContent = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Browser Favorites &amp; Favicons Acceptance Harness</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #121316; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #ececec; }
    ${cssContent}
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module">${bundledJs}</script>
</body>
</html>`;

  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  const executablePath = browserExecutable();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  page.on('console', msg => console.log('BROWSER:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  try {
    await page.goto(url);
    await page.waitForSelector('.maw-settings-window');

    // =========================================================================
    // 1. SETTINGS > BROWSER TAB VERIFICATION & SCREENSHOT
    // =========================================================================
    const browserSectionTitle = await page.textContent('.maw-settings-section-title');
    assert.equal(browserSectionTitle.trim(), 'Browser');

    // Check Search Engine Radios
    const radioItems = page.locator('input[name="default-search-engine"]');
    const radioCount = await radioItems.count();
    assert.equal(radioCount, 5, 'Should display all 5 HTTPS search engines');

    // Check Initial Favorites (ChatGPT, Perplexity, GitHub)
    const favRows = page.locator('.maw-settings-favorite-row');
    const favCount = await favRows.count();
    assert.equal(favCount, 3, 'Should display 3 initial favorites');

    // Add a new favorite
    await page.click('.maw-settings-action-btn');
    await page.fill('.maw-settings-form-field input[type="text"]', 'Hacker News');
    await page.fill('.maw-settings-form-field input[type="url"]', 'news.ycombinator.com');
    await page.click('.maw-settings-form-actions button[type="submit"]');
    await page.waitForTimeout(100);

    const updatedFavCount = await page.locator('.maw-settings-favorite-row').count();
    assert.equal(updatedFavCount, 4, 'Should have 4 favorites after adding');
    const lastFavUrl = await page.locator('.maw-settings-fav-url').last().textContent();
    assert.equal(lastFavUrl.trim(), 'https://news.ycombinator.com/');

    // Capture Settings > Browser screenshot
    await page.screenshot({ path: path.join(screenshotsDir, 'settings-browser-tab.png') });

    // =========================================================================
    // 2. BROWSER DESTINATION PICKER VERIFICATION & SCREENSHOT
    // =========================================================================
    await page.click('#show-picker-btn');
    await page.waitForSelector('.maw-browser-dest-picker');

    const pickerItems = page.locator('.maw-browser-dest-item');
    const pickerCount = await pickerItems.count();
    // 4 favorites (3 initial + 1 added) + 1 "Other" item = 5 items
    assert.equal(pickerCount, 5, 'Should show 4 favorites plus Other item');

    const dividerCount = await page.locator('.maw-browser-dest-divider').count();
    assert.equal(dividerCount, 1, 'Should display thin divider between favorites and Other');

    const otherName = await page.locator('.maw-browser-dest-item').last().locator('.maw-browser-dest-name').textContent();
    assert.equal(otherName.trim(), 'Other');
    const otherEngine = await page.locator('.maw-browser-dest-item').last().locator('.maw-browser-dest-url').textContent();
    assert.equal(otherEngine.trim(), 'DuckDuckGo');

    // Capture Browser Destination Picker screenshot
    await page.screenshot({ path: path.join(screenshotsDir, 'browser-destination-picker.png') });

    // =========================================================================
    // 3. BROWSER TAB WITH ACTUAL FAVICON & CUSTOM MAW TITLE
    // =========================================================================
    await page.click('#show-tabs-btn');
    await page.waitForSelector('.maw-tabs-strip');

    // Tab 1: ChatGPT has actual website favicon
    const tab1 = page.locator('[data-tab-id="tab-1"]');
    const tab1Favicon = tab1.locator('.maw-tab-favicon');
    assert.equal(await tab1Favicon.count(), 1, 'Tab 1 should display website favicon');
    await page.screenshot({ path: path.join(screenshotsDir, 'browser-tab-with-favicon.png') });

    // Tab 2: Custom MaW title ("Project Dashboard") with favicon
    const tab2 = page.locator('[data-tab-id="tab-2"]');
    const tab2Title = await tab2.locator('.agency-truncate').textContent();
    assert.equal(tab2Title.trim(), 'Project Dashboard');
    assert.equal(await tab2.locator('.maw-tab-favicon').count(), 1, 'Custom titled tab preserves website favicon');
    await page.screenshot({ path: path.join(screenshotsDir, 'browser-tab-custom-title.png') });

    // Tab 3: Fallback globe icon when no favicon available
    const tab3 = page.locator('[data-tab-id="tab-3"]');
    assert.equal(await tab3.locator('.maw-globe-icon').count(), 1, 'Tab without favicon displays fallback globe icon');

    // =========================================================================
    // 4. MINIMAL INLINE TAB RENAMING (NO ORANGE CONTAINER/GLOW)
    // =========================================================================
    // Double click Tab 2 title to enter rename mode
    await tab2.locator('.agency-truncate').dblclick();
    await page.waitForSelector('.maw-tab-name-input');

    // Favicon MUST remain visible during renaming!
    assert.equal(await tab2.locator('.maw-tab-favicon').count(), 1, 'Favicon remains visible while renaming');

    // Check inline input styles: verify orange container and border glow are gone
    const inputStyle = await page.evaluate(() => {
      const input = document.querySelector('.maw-tab-name-input');
      if (!input) return null;
      const computed = window.getComputedStyle(input);
      return {
        background: computed.backgroundColor,
        borderRadius: computed.borderRadius,
        boxShadow: computed.boxShadow,
      };
    });

    assert.equal(inputStyle.borderRadius, '0px', 'Orange rounded container must be removed');
    assert.equal(inputStyle.boxShadow, 'none', 'Orange focus glow / box-shadow must be removed');
    assert.equal(inputStyle.background, 'rgba(0, 0, 0, 0)', 'Input background must be transparent');

    // Capture Minimal Inline Renaming screenshot
    await page.screenshot({ path: path.join(screenshotsDir, 'tab-renaming-minimal-inline.png') });

    // Edit title and press Enter to save
    await page.fill('.maw-tab-name-input', 'Work Dashboard V2');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);

    // Verify title updated and rename input closed
    const updatedTitle = await tab2.locator('.agency-truncate').textContent();
    assert.equal(updatedTitle.trim(), 'Work Dashboard V2');
    assert.equal(await page.locator('.maw-tab-name-input').count(), 0);

    // =========================================================================
    // 5. SPLIT PANES WITH BROWSER TABS
    // =========================================================================
    await page.click('#show-split-btn');
    await page.waitForTimeout(100);

    // Capture Split Panes screenshot
    await page.screenshot({ path: path.join(screenshotsDir, 'split-panes-browser-tabs.png') });

  } finally {
    await browser.close();
    server.close();
  }
});

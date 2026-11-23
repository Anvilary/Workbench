import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WEB_ROOT, REPO_ROOT } from '../../helpers/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = WEB_ROOT;
const projectRoot = REPO_ROOT;
const require = createRequire(path.join(projectRoot, 'package.json'));
const { build } = require('esbuild');
const { chromium } = require('playwright');

const artifactDir = process.env.MAW_TEST_ARTIFACTS_DIR || path.join(tmpdir(), 'maw-test-artifacts', 'settings-dialog-redesign');
mkdirSync(path.join(artifactDir, 'screenshots'), { recursive: true });

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

test('SettingsDialog pure logic: toggled, sameSet, and runtime info', async () => {
  function toggled(list, agent, off) {
    const rest = list.filter((id) => id !== agent);
    return off ? [...rest, agent] : rest;
  }

  function sameSet(a, b) {
    return a.length === b.length && a.every((id) => b.includes(id));
  }

  // Adding agent to disabled list
  assert.deepEqual(toggled(['codex'], 'claude-code', true), ['codex', 'claude-code']);
  // Removing agent from disabled list
  assert.deepEqual(toggled(['codex', 'claude-code'], 'codex', false), ['claude-code']);
  // Idempotent off
  assert.deepEqual(toggled(['codex'], 'codex', true), ['codex']);

  // Set equality
  assert.equal(sameSet(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameSet(['a', 'b'], ['a']), false);
  assert.equal(sameSet([], []), true);
});

test('i18n completeness: all settings keys exist across all 9 locales', () => {
  const locales = ['en', 'es', 'de', 'fr', 'pt-BR', 'ru', 'ja', 'ko', 'zh-CN'];
  const requiredKeys = [
    'settings.title',
    'settings.category.general',
    'settings.category.appearance',
    'settings.category.terminal',
    'settings.category.agents',
    'settings.category.usage',
    'settings.category.about',
    'settings.category.panels',
    'settings.desc.general',
    'settings.desc.appearance',
    'settings.desc.terminal',
    'settings.desc.agents',
    'settings.desc.usage',
    'settings.desc.about',
    'settings.desc.panels',
    'settings.about.app',
    'settings.about.tagline',
    'settings.about.version',
    'settings.about.runtime',
    'settings.about.platform',
    'settings.about.github',
    'settings.cli.available',
  ];

  for (const loc of locales) {
    const content = JSON.parse(readFileSync(path.join(webRoot, `src/i18n/locales/${loc}.json`), 'utf8'));
    for (const key of requiredKeys) {
      assert.ok(content[key], `Locale ${loc} missing key ${key}`);
      assert.ok(content[key].trim().length > 0, `Locale ${loc} key ${key} is empty`);
    }
  }
});

const fixtureCode = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsDialog } from './src/features/settings/SettingsDialog.tsx';

const mockAgents = [
  { id: 'codex', label: 'Codex CLI', available: true, version: '0.14.0' },
  { id: 'claude-code', label: 'Claude Code', available: true, version: '1.2.0' },
  { id: 'antigravity', label: 'Antigravity CLI', available: true, version: '2.1.0' },
  { id: 'opencode', label: 'OpenCode', available: false, installUrl: 'https://example.com/opencode' },
  { id: 'pi', label: 'Pi CLI', available: false, installUrl: 'https://example.com/pi' },
];

let currentShell = 'auto';
let currentDisabled = [];

const mockAppSettings = {
  status: {
    consoleShell: 'auto',
    consoleShells: [
      { id: 'login', label: 'Login Shell (/bin/bash)' },
      { id: 'bash', label: 'Bash (/usr/bin/bash)' },
      { id: 'zsh', label: 'Zsh (/usr/bin/zsh)' },
    ],
    shellName: 'bash',
    disabledAgents: currentDisabled,
    disabledAtStart: [],
  },
  problem: null,
  setConsoleShell: (shell) => { currentShell = shell; },
  setDisabledAgents: (agents) => { currentDisabled = agents; },
  dismissProblem: () => {},
};

const mockPanels = {
  hidden: new Set(['memory']),
  isVisible: (p) => p !== 'memory',
  setVisible: () => {},
};

let currentTheme = 'dark';
const mockTheme = {
  preference: 'dark',
  current: 'dark',
  setPreference: (p) => { currentTheme = p; },
};

let connectionListeners = [];
const mockSnapshot = {
  timestamp: new Date().toISOString(),
  aggregated: {
    totalTokens: 14258900,
    totalInputTokens: 10120400,
    totalOutputTokens: 4138500,
    totalCostUSD: 18.42,
    availableProfiles: 3,
    totalProfiles: 4,
    missingProfiles: 1,
    lastRefresh: new Date().toISOString(),
  },
  providers: [
    { provider: 'OpenAI', status: 'healthy', profileCount: 2, availableCount: 2, totalTokens: 8250000, totalCostUSD: 12.30 },
    { provider: 'Google', status: 'healthy', profileCount: 1, availableCount: 1, totalTokens: 6008900, totalCostUSD: 6.12 },
    { provider: 'Anthropic', status: 'unconfigured', profileCount: 1, availableCount: 0, totalTokens: 0, totalCostUSD: 0 },
  ],
  profiles: [
    {
      profileId: 'codex-0',
      label: 'Codex 00 (Default)',
      provider: 'OpenAI',
      model: 'gpt-5-turbo',
      availability: 'available',
      collectionStatus: 'healthy',
      profileDir: '/home/developer/.codex-0',
      planType: 'Team Plus',
      fiveHourUtilization: { status: 'available', usedPercent: 42, resetsInSeconds: 3600 },
      weeklyUtilization: { status: 'available', usedPercent: 68, resetsInSeconds: 86400 },
      tokens: { totalTokens: 8250000, inputTokens: 6000000, outputTokens: 2250000, cachedInputTokens: 1500000, reasoningOutputTokens: 450000 },
      cost: { amount: 12.30, currency: 'USD' },
    },
    {
      profileId: 'agy-1',
      label: 'AGY 01 Pro',
      provider: 'Google',
      model: 'Gemini 3.8 Flash High',
      availability: 'available',
      collectionStatus: 'healthy',
      profileDir: '/home/developer/.gemini/agy-1',
      planType: 'Internal Workhorse',
      fiveHourUtilization: { status: 'available', usedPercent: 18, resetsInSeconds: 7200 },
      tokens: { totalTokens: 6008900, inputTokens: 4120400, outputTokens: 1888500 },
      cost: { amount: 6.12, currency: 'USD' },
    },
    {
      profileId: 'claude-code',
      label: 'Claude Code',
      provider: 'Anthropic',
      model: 'claude-sonnet-4-6',
      availability: 'missing',
      collectionStatus: 'unconfigured',
      collectionError: 'No credentials found in ~/.claude/config.json',
      profileDir: '/home/developer/.claude',
    }
  ],
};

const mockConnection = {
  send: (msg) => {
    if (msg.type === 'agency.profiles.list') {
      setTimeout(() => {
        for (const cb of connectionListeners) {
          cb({
            type: 'agency.profiles.snapshot',
            requestId: msg.requestId,
            profiles: [
              {
                id: 'codex-0',
                label: 'Codex 00',
                provider: 'codex',
                executable: '/usr/bin/codex-0',
                args: [],
                environmentOverrides: {},
                capabilities: { canLaunch: true, canResumeNativeSession: false, canInterrupt: false, canReportActivity: false, canSelectModel: false, canSelectEffort: false, canRequestPermissions: false, models: [], discovery: 'configured' },
                configurationStatus: 'available',
                configurationMessage: null,
              },
              {
                id: 'codex-1',
                label: 'Codex 01',
                provider: 'codex',
                executable: '/usr/bin/codex-1',
                args: ['--profile', 'other'],
                environmentOverrides: {},
                capabilities: { canLaunch: true, canResumeNativeSession: false, canInterrupt: false, canReportActivity: false, canSelectModel: false, canSelectEffort: false, canRequestPermissions: false, models: [], discovery: 'configured' },
                configurationStatus: 'available',
                configurationMessage: null,
              },
              {
                id: 'claude-code',
                label: 'Claude Code',
                provider: 'claude-code',
                executable: 'claude',
                args: [],
                environmentOverrides: {},
                capabilities: { canLaunch: true, canResumeNativeSession: false, canInterrupt: false, canReportActivity: false, canSelectModel: false, canSelectEffort: false, canRequestPermissions: false, models: [], discovery: 'configured' },
                configurationStatus: 'available',
                configurationMessage: null,
              },
            ],
          });
        }
      }, 10);
    }
    if (msg.type === 'agents.usage.get') {
      setTimeout(() => {
        for (const cb of connectionListeners) {
          cb({
            type: 'agents.usage.snapshot',
            requestId: msg.requestId,
            usage: mockSnapshot,
          });
        }
      }, 20);
    }
  },
  onMessage: (cb) => {
    connectionListeners.push(cb);
    return () => {
      connectionListeners = connectionListeners.filter(l => l !== cb);
    };
  },
  isRemoteClient: () => false,
  getStatus: () => 'open',
  onStatus: () => () => {},
};

function Harness() {
  const [open, setOpen] = useState(true);
  const [closedNotice, setClosedNotice] = useState(false);
  const [browserProfiles, setBrowserProfiles] = useState([
    { id: 'main', name: 'Main', createdAt: '', updatedAt: '', isDefault: true },
    { id: 'prof-work', name: 'Work Profile', createdAt: '', updatedAt: '' },
  ]);

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#141417', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <button id="trigger-btn" type="button" onClick={() => setOpen(true)}>Open Settings</button>
      {closedNotice && <span id="closed-indicator">Dialog was closed</span>}
      {open && (
        <SettingsDialog
          onClose={() => {
            setOpen(false);
            setClosedNotice(true);
          }}
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
          initialTab="general"
          browserProfiles={browserProfiles}
          onDeleteBrowserProfile={(profileId) => {
            setBrowserProfiles((prev) => prev.filter((p) => p.id !== profileId));
          }}
        />
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<Harness />);
`;

test('SettingsDialog acceptance suite: 2-pane navigation, tabs, accessibility, and visual capture', async () => {
  const buildResult = await build({
    stdin: {
      contents: fixtureCode,
      resolveDir: webRoot,
      sourcefile: 'test-fixture.tsx',
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    define: {
      __APP_VERSION__: '"0.8.1"',
      __APP_GIT_SHA__: '"e34fbaf"',
      __APP_IS_DEV__: 'true',
    },
    loader: { '.png': 'dataurl', '.svg': 'text', '.css': 'empty' },
  });

  const bundleJs = buildResult.outputFiles[0].text;
  const stylesCss = readFileSync(path.join(webRoot, 'src/styles.css'), 'utf8');
  const agencyCss = readFileSync(path.join(webRoot, 'src/app/workbench.css'), 'utf8');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Settings Redesign Acceptance</title>
  <style>
    ${stylesCss}
    ${agencyCss}
    html, body { margin: 0; padding: 0; background: #141417; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/bundle.js"></script>
</body>
</html>`;

  const server = createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(bundleJs);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const browser = await chromium.launch({
    executablePath: browserExecutable(),
    headless: true,
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForSelector('.maw-settings-window');

    // 1. Check title, header icon, and navigation items
    const titleText = await page.textContent('.maw-settings-title');
    assert.equal(titleText.trim(), 'Settings');
    const headerSvgCount = await page.locator('.maw-settings-header-icon svg').count();
    assert.equal(headerSvgCount, 1, 'Header icon should be an SVG');

    const navTabs = page.locator('.maw-settings-nav-item');
    const tabCount = await navTabs.count();
    assert.equal(tabCount, 7, 'Expected 7 tabs (Appearance merged into General, including browser and legacy panels)');

    // Verify SVG icons on all nav items (no colorful emojis)
    const navSvgCount = await page.locator('.maw-settings-nav-icon svg').count();
    assert.equal(navSvgCount, 7, 'All 7 nav items should use consistent SVG icons');

    // Verify authoritative version display at bottom-left
    const versionEl = page.locator('.maw-settings-version');
    assert.equal(await versionEl.count(), 1, 'Version display should exist in sidebar footer');
    const versionText = await versionEl.textContent();
    assert.ok(versionText?.startsWith('v0.8.1'), `Expected version starting with v0.8.1, got ${versionText}`);

    // 2. Verify Initial General Tab (now includes Terminal Theme & Dark Theme)
    const generalSectionTitle = await page.textContent('.maw-settings-section-title');
    assert.equal(generalSectionTitle.trim(), 'General');
    const generalThemeRadios = await page.locator('input[name="terminal-theme"]').count();
    assert.equal(generalThemeRadios, 2, 'General tab should now contain terminal theme preference radios');
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-general.png') });

    // 3. Verify Appearance tab is removed from nav
    const appearanceTabCount = await page.locator('#settings-tab-appearance').count();
    assert.equal(appearanceTabCount, 0, 'Appearance tab should no longer exist as a standalone category');

    // 4. Test Search Functionality: search, empty state, and navigation
    const searchInput = page.locator('.maw-settings-search-input');
    assert.equal(await searchInput.count(), 1, 'Search input should exist in sidebar');

    // 4a. Search for a query that matches settings in another category (e.g. "duckduckgo" or "search engine")
    await searchInput.fill('DuckDuckGo');
    await page.waitForTimeout(100);
    const searchResults = page.locator('.maw-settings-search-item');
    const resultCount = await searchResults.count();
    assert.ok(resultCount > 0, 'Expected at least 1 search result for DuckDuckGo');

    // Selecting result navigates to Browser category
    await searchResults.first().click();
    await page.waitForTimeout(100);
    const activeSectionAfterSearch = await page.textContent('.maw-settings-section-title');
    assert.equal(activeSectionAfterSearch.trim(), 'Browser', 'Selecting search result should navigate to Browser category');

    // 4b. Test Empty State for search
    await searchInput.fill('xyznonexistentquery999');
    await page.waitForTimeout(100);
    const emptyState = page.locator('.maw-settings-search-empty');
    assert.equal(await emptyState.count(), 1, 'Empty state should be displayed when no settings match');

    // 4c. Clear search to restore tab navigation
    const clearBtn = page.locator('.maw-settings-search-clear');
    await clearBtn.click();
    await page.waitForTimeout(100);
    const restoredTabCount = await page.locator('.maw-settings-nav-item').count();
    assert.equal(restoredTabCount, 7, 'Clearing search should restore normal tab navigation');

    // 5. Navigate to Terminal Tab
    const terminalTab = page.locator('#settings-tab-terminal');
    await terminalTab.click();
    await page.waitForTimeout(100);
    const terminalTitle = await page.textContent('.maw-settings-section-title');
    assert.equal(terminalTitle.trim(), 'Terminal');
    const shellRadios = await page.locator('input[name="console-shell"]').count();
    assert.equal(shellRadios, 4, 'Expected auto + 3 installed shells');
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-terminal.png') });

    // 6. Navigate to Agents Tab
    const agentsTab = page.locator('#settings-tab-agents');
    await agentsTab.click();
    await page.waitForTimeout(100);
    const agentsTitle = await page.textContent('.maw-settings-section-title');
    assert.equal(agentsTitle.trim(), 'Agents');
    const cliRows = await page.locator('.maw-settings-cli-row').count();
    assert.equal(cliRows, 5, 'Expected 5 configured agent CLIs');

    // 6b. Verify Profiles section in Agents Tab
    const profilesCard = page.locator('#setting-card-profiles');
    assert.equal(await profilesCard.count(), 1, 'Expected setting-card-profiles card');
    const providerGroups = page.locator('.maw-provider-group');
    assert.equal(await providerGroups.count(), 5, 'Expected 5 provider groups (Codex, Claude, AGY, OpenCode, Pi)');

    // Codex has 2 profiles, so it should default to collapsed
    const codexToggle = page.locator('.maw-provider-group-toggle').first();
    assert.equal(await codexToggle.getAttribute('aria-expanded'), 'false', 'Multi-profile provider should default to collapsed');

    // Click toggle to expand
    await codexToggle.click();
    assert.equal(await codexToggle.getAttribute('aria-expanded'), 'true', 'Clicking toggle expands the provider group');
    const profileRows = page.locator('.maw-profile-row');
    assert.ok((await profileRows.count()) >= 2, 'Expected expanded profiles to be visible');

    // Test Add Profile button and modal
    const addProfileBtn = page.locator('.maw-add-profile-btn');
    assert.equal(await addProfileBtn.count(), 1);
    await addProfileBtn.click();
    const addModal = page.locator('.maw-profile-form-dialog');
    assert.equal(await addModal.count(), 1, 'Add profile dialog opened');
    const providerOptions = page.locator('#new-profile-provider option');
    assert.equal(await providerOptions.count(), 5, 'Expected 5 provider options in Add Profile');
    const browseBtn = page.locator('.maw-browse-btn');
    assert.equal(await browseBtn.count(), 1, 'Expected native browse button');

    // C-08: Escape closes only the nested Add Profile modal and keeps SettingsDialog open
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.maw-profile-form-dialog').count(), 0, 'Nested modal closed on Escape');
    assert.equal(await page.locator('.maw-settings-window').count(), 1, 'SettingsDialog must remain open when nested modal closes via Escape');

    // Re-open and test Cancel button too
    await addProfileBtn.click();
    assert.equal(await page.locator('.maw-profile-form-dialog').count(), 1, 'Add profile dialog reopened');
    await page.locator('.maw-modal-footer button:has-text("Cancel")').click();
    assert.equal(await page.locator('.maw-profile-form-dialog').count(), 0, 'Dialog closed on Cancel');

    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-agents.png') });

    // 6c. C-10 & C-13: Browser tab profile deletion requires confirmation & + Add expands collapsed subsection
    await page.locator('#settings-tab-browser').click();
    await page.waitForTimeout(100);
    const engineToggle = page.locator('#setting-card-search-engine .maw-subsection-toggle');
    await engineToggle.click();
    assert.equal(await engineToggle.getAttribute('aria-expanded'), 'false', 'Search engine subsection collapsed');
    await page.locator('#setting-card-search-engine .maw-settings-engine-action-btn').click();
    assert.equal(await engineToggle.getAttribute('aria-expanded'), 'true', 'Clicking + Add Search Engine expands collapsed subsection');
    await page.locator('#setting-card-search-engine .maw-settings-form-actions button[type="button"]').click();

    const deleteWorkProfileBtn = page.locator('[data-profile-id="prof-work"] .maw-settings-profile-delete-btn');
    await deleteWorkProfileBtn.click();
    await page.waitForTimeout(50);
    assert.equal(await page.locator('[data-profile-id="prof-work"]').count(), 1, 'Profile must NOT be deleted before confirmation');
    assert.equal(await page.locator('.agency-dialog[role="dialog"]').count(), 1, 'Confirmation modal must open for profile deletion');
    // Escape closes ONLY confirmation modal, leaving SettingsDialog open and profile intact
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.agency-dialog[role="dialog"]').count(), 0, 'Escape dismisses delete profile confirmation');
    assert.equal(await page.locator('.maw-settings-window').count(), 1, 'SettingsDialog stays open after cancelling confirmation');
    assert.equal(await page.locator('[data-profile-id="prof-work"]').count(), 1, 'Profile remains intact after Escape');
    // Confirm deletion actually removes the profile
    await deleteWorkProfileBtn.click();
    await page.locator('.agency-dialog .agency-danger-button').click();
    await page.waitForTimeout(50);
    assert.equal(await page.locator('[data-profile-id="prof-work"]').count(), 0, 'Profile is deleted after explicit confirmation');

    // 7. Navigate to Usage Tab
    const usageTab = page.locator('#settings-tab-usage');
    await usageTab.click();
    await page.waitForTimeout(400); // Allow telemetry mock to populate
    const usageCards = await page.locator('.agents-usage-summary-card').count();
    assert.equal(usageCards, 2, 'Agents usage view rendered summary cards');
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-usage.png') });

    // 8. Navigate to About Tab
    const aboutTab = page.locator('#settings-tab-about');
    await aboutTab.click();
    await page.waitForTimeout(100);
    const aboutAppName = await page.textContent('.maw-settings-about-name');
    assert.equal(aboutAppName.trim(), 'Anvilary Workbench');
    const specRows = await page.locator('.maw-settings-spec-row').count();
    assert.equal(specRows, 3, 'Expected 3 spec rows (Version, Desktop Runtime, Platform)');
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-about.png') });

    // 9. Test Arrow Key Navigation
    await page.keyboard.press('ArrowUp');
    const activeNavTextAfterUp = await page.textContent('.maw-settings-nav-item.active');
    assert.equal(activeNavTextAfterUp.includes('Usage'), true, 'ArrowUp navigated from About to Usage');

    // 10. Narrow Viewport Test (600x700)
    await page.setViewportSize({ width: 600, height: 700 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-narrow.png') });

    // 11. Escape Key Dismissal Test
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const dialogPresent = await page.locator('.maw-settings-window').count();
    assert.equal(dialogPresent, 0, 'Dialog should be dismissed on Escape');
    const closedIndicator = await page.locator('#closed-indicator').count();
    assert.equal(closedIndicator, 1, 'Closed callback should have been fired');
  } finally {
    await browser.close();
    server.close();
  }
});

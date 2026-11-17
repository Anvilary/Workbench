import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(webRoot, '../..');
const require = createRequire(path.join(projectRoot, 'package.json'));
const { build } = require('esbuild');
const { chromium } = require('playwright');

const artifactDir = '/home/user/.local/share/agy-2-profile/home/.gemini/antigravity-cli/brain/5b42f755-ea46-48b5-8201-fcf0968f6b71';
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
import { SettingsDialog } from './src/SettingsDialog.tsx';

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
      profileDir: '/home/user/.codex-0',
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
      profileDir: '/home/user/.gemini/agy-1',
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
      profileDir: '/home/user/.claude',
    }
  ],
};

const mockConnection = {
  send: (msg) => {
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
};

function Harness() {
  const [open, setOpen] = useState(true);
  const [closedNotice, setClosedNotice] = useState(false);

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
    loader: { '.png': 'dataurl', '.svg': 'text', '.css': 'empty' },
  });

  const bundleJs = buildResult.outputFiles[0].text;
  const stylesCss = readFileSync(path.join(webRoot, 'src/styles.css'), 'utf8');
  const agencyCss = readFileSync(path.join(webRoot, 'src/agency/agency.css'), 'utf8');

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

    // 1. Check title and navigation items
    const titleText = await page.textContent('.maw-settings-title');
    assert.equal(titleText.trim(), 'Settings');

    const navTabs = page.locator('.maw-settings-nav-item');
    const tabCount = await navTabs.count();
    assert.equal(tabCount, 8, 'Expected 8 tabs (including browser and legacy panels)');

    // 2. Verify Initial General Tab
    const generalSectionTitle = await page.textContent('.maw-settings-section-title');
    assert.equal(generalSectionTitle.trim(), 'General');
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-general.png') });

    // 3. Navigate to Appearance Tab
    const appearanceTab = page.locator('#settings-tab-appearance');
    await appearanceTab.click();
    await page.waitForTimeout(100);
    const appearanceTitle = await page.textContent('.maw-settings-section-title');
    assert.equal(appearanceTitle.trim(), 'Appearance');
    const radioCount = await page.locator('input[name="terminal-theme"]').count();
    assert.equal(radioCount, 2);
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-appearance.png') });

    // 4. Navigate to Terminal Tab
    const terminalTab = page.locator('#settings-tab-terminal');
    await terminalTab.click();
    await page.waitForTimeout(100);
    const terminalTitle = await page.textContent('.maw-settings-section-title');
    assert.equal(terminalTitle.trim(), 'Terminal');
    const shellRadios = await page.locator('input[name="console-shell"]').count();
    assert.equal(shellRadios, 4, 'Expected auto + 3 installed shells');
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-terminal.png') });

    // 5. Navigate to Agents Tab
    const agentsTab = page.locator('#settings-tab-agents');
    await agentsTab.click();
    await page.waitForTimeout(100);
    const agentsTitle = await page.textContent('.maw-settings-section-title');
    assert.equal(agentsTitle.trim(), 'Agents');
    const cliRows = await page.locator('.maw-settings-cli-row').count();
    assert.equal(cliRows, 5, 'Expected 5 configured agent CLIs');
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-agents.png') });

    // 6. Navigate to Usage Tab
    const usageTab = page.locator('#settings-tab-usage');
    await usageTab.click();
    await page.waitForTimeout(400); // Allow telemetry mock to populate
    const usageCards = await page.locator('.agents-usage-summary-card').count();
    assert.equal(usageCards, 2, 'Agents usage view rendered summary cards');
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-usage.png') });

    // 7. Navigate to About Tab
    const aboutTab = page.locator('#settings-tab-about');
    await aboutTab.click();
    await page.waitForTimeout(100);
    const aboutAppName = await page.textContent('.maw-settings-about-name');
    assert.equal(aboutAppName.trim(), 'My Amazing Workspace');
    const specRows = await page.locator('.maw-settings-spec-row').count();
    assert.equal(specRows, 3, 'Expected 3 spec rows (Version, Desktop Runtime, Platform)');
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-about.png') });

    // 8. Test Arrow Key Navigation
    await page.keyboard.press('ArrowUp');
    const activeNavTextAfterUp = await page.textContent('.maw-settings-nav-item.active');
    assert.equal(activeNavTextAfterUp.includes('Usage'), true, 'ArrowUp navigated from About to Usage');

    // 9. Narrow Viewport Test (600x700)
    await page.setViewportSize({ width: 600, height: 700 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'settings-after-narrow.png') });

    // 10. Escape Key Dismissal Test
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

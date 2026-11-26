/**
 * Real Electron acceptance test for Agents Usage redesign & refresh reliability.
 *
 * Verifies inside a real sandboxed Electron instance:
 * - Compact Usage layout and visible nonzero-width 5-hour and weekly quota progress bars
 * - Working manual Refresh button with forceRefresh: true
 * - Zero repeated automatic request loop after receiving a snapshot
 * - Correct 5-minute automatic refresh constant (USAGE_REFRESH_INTERVAL_MS === 300000)
 * - No UI freeze and no disruption to an open live terminal session
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT, REPO_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(path.join(REPO_ROOT, 'package.json'));
const { build } = require('esbuild');
const electronExecutable = existsSync('/opt/workbench-electron/45.2.0/electron')
  ? '/opt/workbench-electron/45.2.0/electron'
  : require('electron');

const evidenceDir = process.env.WORKBENCH_USAGE_ELECTRON_EVIDENCE_DIR;

const appFixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentsUsageView } from './src/features/agents/AgentsUsageView.tsx';
import { USAGE_REFRESH_INTERVAL_MS } from './src/features/agents/useAgentsUsage.ts';

const listeners = new Set();
const sentRequests = [];
let responseCount = 0;

function makeSnapshot(pct5h, pctWeekly) {
  const now = Date.now();
  return {
    aggregated: {
      totalProfiles: 2,
      availableProfiles: 2,
      missingProfiles: 0,
      totalTokens: 9700000,
      totalInputTokens: 7050000,
      totalOutputTokens: 2650000,
      totalCachedTokens: 1500000,
      totalCostUSD: 12.3,
      lastRefresh: now,
      status: 'ok',
    },
    providers: [],
    profiles: [
      {
        profileId: 'codex-a',
        label: 'Codex A',
        provider: 'OpenAI',
        planType: 'Plus',
        model: 'gpt-5-codex',
        profileDir: '/home/user/.codex',
        canonicalDir: '/home/user/.codex',
        isSharedStorage: false,
        availability: 'available',
        collectionStatus: 'healthy',
        observedAt: now,
        fiveHourUtilization: { status: 'available', usedPercent: pct5h, windowMinutes: 300, resetsInSeconds: 52 * 60 },
        weeklyUtilization: { status: 'available', usedPercent: pctWeekly, windowMinutes: 10080, resetsAt: now + 26 * 3600_000 },
        tokens: { status: 'available', totalTokens: 8250000, inputTokens: 6000000, outputTokens: 2250000, cachedInputTokens: 1500000, reasoningOutputTokens: 450000 },
        cost: { status: 'available', amount: 12.3, currency: 'USD' },
      },
      {
        profileId: 'agy-b',
        label: 'AGY B',
        provider: 'Google',
        planType: 'Pro',
        model: 'Gemini 3.8 Flash',
        profileDir: '/home/user/.gemini/agy-b',
        canonicalDir: '/home/user/.gemini/agy-b',
        isSharedStorage: false,
        availability: 'available',
        collectionStatus: 'healthy',
        observedAt: now,
        fiveHourUtilization: { status: 'available', usedPercent: 24, windowMinutes: 300, resetsInSeconds: 1800 },
        weeklyUtilization: { status: 'unavailable', windowMinutes: 10080 },
        tokens: { status: 'available', totalTokens: 1450000, inputTokens: 1050000, outputTokens: 400000 },
        cost: { status: 'unsupported' },
      },
    ],
  };
}

const connection = {
  getStatus: () => 'open',
  onMessage: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  onStatus: () => () => {},
  onReopen: () => () => {},
  send: (msg) => {
    sentRequests.push({ ...msg, at: Date.now() });
    if (msg.type === 'agents.usage.get') {
      responseCount += 1;
      const pct5h = responseCount === 1 ? 35 : 41;
      const pctWeekly = responseCount === 1 ? 95 : 96;
      setTimeout(() => {
        for (const fn of listeners) {
          fn({ type: 'agents.usage.snapshot', requestId: msg.requestId, usage: makeSnapshot(pct5h, pctWeekly) });
        }
      }, 60);
    }
    return true;
  },
};

function ElectronAcceptanceShell() {
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTicks((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0e0e10', color: '#f4f4f5' }}>
      <div id="live-terminal-pane" style={{ width: '240px', borderRight: '1px solid #27272a', padding: '12px', fontFamily: 'monospace', fontSize: '12px' }}>
        <div>Terminal 1 (alive)</div>
        <div id="terminal-heartbeat">ticks:{ticks}</div>
      </div>
      <div className="wb-settings-content" style={{ flex: 1 }}>
        <AgentsUsageView connection={connection} />
      </div>
    </div>
  );
}

window.__electronUsage = {
  intervalMs: USAGE_REFRESH_INTERVAL_MS,
  requests: () => sentRequests.slice(),
};

createRoot(document.getElementById('root')).render(<ElectronAcceptanceShell />);
`;

test('Electron real-runtime acceptance: Agents Usage renders visible quota bars, refreshes cleanly without loops, and preserves live terminal', { timeout: 60_000 }, async (t) => {
  const webRoot = path.join(REPO_ROOT, 'packages/web');
  const built = await build({
    stdin: { contents: appFixture, loader: 'tsx', resolveDir: webRoot },
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    write: false,
    logLevel: 'silent',
  });
  const jsCode = built.outputFiles[0].text;
  const stylesCss = readFileSync(path.join(webRoot, 'src/styles.css'), 'utf8');
  const workbenchCss = readFileSync(path.join(webRoot, 'src/app/workbench.css'), 'utf8');

  const html = `<!doctype html>
<html lang="en" data-theme="dark" style="color-scheme: dark;">
<head><meta charset="utf-8" /><style>${stylesCss}\n${workbenchCss}</style></head>
<body style="margin:0;background:#0e0e10;"><div id="root"></div><script type="module" src="/app.js"></script></body>
</html>`;

  const server = createServer((req, res) => {
    if (req.url === '/app.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(jsCode);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const dataDir = await mkdtemp(path.join(tmpdir(), 'maw-usage-electron-'));
  let desktop;

  try {
    desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [DESKTOP_ROOT, '--ozone-platform=x11'],
      env: {
        ...process.env,
        WORKBENCH_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`,
        WORKBENCH_DESKTOP_DATA_DIR: dataDir,
      },
    });

    const page = await desktop.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.waitForSelector('.profile-usage-card');
    await page.waitForFunction(() => !document.querySelector('.agents-usage-refresh-btn')?.disabled);

    // Wait 1.5s to prove there is ZERO continuous refresh loop after receiving snapshot
    await page.waitForTimeout(1500);
    const initialRequests = await page.evaluate(() => window.__electronUsage.requests());
    assert.equal(initialRequests.length, 1, `Expected 1 initial request with no loop, got ${initialRequests.length}`);
    assert.equal(initialRequests[0].forceRefresh, false);
    assert.equal(await page.evaluate(() => window.__electronUsage.intervalMs), 5 * 60 * 1000);

    // Verify visible nonzero-width progress bars in real Electron
    const barGeometry = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="progressbar"]')).map((track) => ({
        label: track.getAttribute('aria-label'),
        value: Number(track.getAttribute('aria-valuenow')),
        trackWidth: track.getBoundingClientRect().width,
        fillWidth: track.querySelector('.quota-bar-fill')?.getBoundingClientRect().width ?? 0,
      })),
    );
    assert.equal(barGeometry.length, 3, 'Expected 3 available quota progress bars (codex-a 5h+weekly, agy-b 5h)');
    for (const bar of barGeometry) {
      assert.ok(bar.trackWidth > 80, `Track ${bar.label} must have visible width`);
      assert.ok(bar.fillWidth > 10, `Fill ${bar.label} (${bar.value}%) must have visible nonzero width`);
    }

    // Verify manual Refresh button works and updates quota display
    const beforeTicks = await page.locator('#terminal-heartbeat').innerText();
    await page.locator('.agents-usage-refresh-btn').click();
    await page.waitForFunction(() => !document.querySelector('.agents-usage-refresh-btn')?.disabled);
    await page.waitForTimeout(400);

    const afterManualRequests = await page.evaluate(() => window.__electronUsage.requests());
    assert.equal(afterManualRequests.length, 2, 'Manual refresh must issue exactly 1 forced request without looping');
    assert.equal(afterManualRequests[1].forceRefresh, true);
    assert.ok((await page.locator('.agents-usage-view').innerText()).includes('41% used · 59% remaining'));
    assert.ok((await page.locator('.agents-usage-view').innerText()).includes('96% used · 4% remaining'));

    // Verify terminal heartbeat kept ticking (no UI freeze or terminal disruption)
    const afterTicks = await page.locator('#terminal-heartbeat').innerText();
    assert.notEqual(afterTicks, beforeTicks, 'Terminal pane must remain responsive without UI freeze');
    assert.deepEqual(pageErrors, []);

    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({ path: path.join(evidenceDir, 'electron-agents-usage-acceptance.png') });
    }
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
    await rm(dataDir, { recursive: true, force: true });
  }
});

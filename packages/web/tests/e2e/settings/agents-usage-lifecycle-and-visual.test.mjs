/**
 * Comprehensive Playwright test suite for Agents Usage:
 * 1. Deterministic hook refresh lifecycle (all 12 scenarios using Playwright fake clock).
 * 2. Production CSS visual & accessibility verification (real nonzero progress bar widths,
 *    no horizontal overflow, no nested scrollbars, and 8 acceptance screenshots).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WEB_ROOT, REPO_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(path.join(REPO_ROOT, 'package.json'));
const { build } = require('esbuild');
const { chromium } = require('playwright');

const artifactDir =
  process.env.MAW_USAGE_EVIDENCE_DIR ||
  path.join(tmpdir(), 'maw-test-artifacts', 'agents-usage-redesign');
mkdirSync(artifactDir, { recursive: true });

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  for (const bin of [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    if (existsSync(bin)) return bin;
  }
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache)
    ? readdirSync(cache)
        .filter((name) => name.startsWith('chromium_headless_shell-'))
        .sort()
        .reverse()
    : []) {
    const p = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(p)) return p;
  }
  return undefined;
}

const harnessSource = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentsUsageView } from './src/features/agents/AgentsUsageView.tsx';
import { USAGE_REFRESH_INTERVAL_MS, USAGE_REQUEST_TIMEOUT_MS } from './src/features/agents/useAgentsUsage.ts';

const messageHandlers = new Set();
const statusHandlers = new Set();
const reopenHandlers = new Set();
let connStatus = 'open';
const sentMessages = [];

const mockConnection = {
  getStatus: () => connStatus,
  send: (msg) => {
    sentMessages.push({ ...msg, sentAt: Date.now() });
    return true;
  },
  onMessage: (fn) => {
    messageHandlers.add(fn);
    return () => messageHandlers.delete(fn);
  },
  onStatus: (fn) => {
    statusHandlers.add(fn);
    return () => statusHandlers.delete(fn);
  },
  onReopen: (fn) => {
    reopenHandlers.add(fn);
    return () => reopenHandlers.delete(fn);
  },
};

let setMountedGlobal = () => {};

function App() {
  const [mounted, setMounted] = useState(true);
  setMountedGlobal = setMounted;
  return (
    <div className="maw-settings-backdrop" style={{ position: 'static', minHeight: '100vh', padding: '16px', boxSizing: 'border-box' }}>
      <div className="maw-settings-window" style={{ width: '100%', maxWidth: '720px', height: 'auto', maxHeight: 'none', margin: '0 auto' }}>
        <main className="maw-settings-content" style={{ maxHeight: '760px' }}>
          {mounted ? <AgentsUsageView connection={mockConnection} /> : <div id="usage-unmounted">Closed</div>}
        </main>
      </div>
    </div>
  );
}

window.__usageHarness = {
  USAGE_REFRESH_INTERVAL_MS,
  USAGE_REQUEST_TIMEOUT_MS,
  sent: () => sentMessages.slice(),
  clearSent: () => { sentMessages.length = 0; },
  emitMessage: (msg) => {
    for (const fn of messageHandlers) fn(msg);
  },
  setConnectionStatus: (next) => {
    connStatus = next;
    for (const fn of statusHandlers) fn(next);
  },
  triggerReopen: () => {
    connStatus = 'open';
    for (const fn of reopenHandlers) fn();
  },
  setMounted: (v) => setMountedGlobal(v),
  setVisibility: (state) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  },
};

createRoot(document.getElementById('root')).render(<App />);
`;

async function startHarnessServer(t) {
  const built = await build({
    stdin: {
      contents: harnessSource,
      loader: 'tsx',
      resolveDir: WEB_ROOT,
    },
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    write: false,
    logLevel: 'silent',
  });
  const jsCode = built.outputFiles[0].text;
  const stylesCss = readFileSync(path.join(WEB_ROOT, 'src/styles.css'), 'utf8');
  const workbenchCss = readFileSync(path.join(WEB_ROOT, 'src/app/workbench.css'), 'utf8');

  const html = `<!doctype html>
<html lang="en" data-theme="dark" style="color-scheme: dark;">
<head>
  <meta charset="utf-8" />
  <style>${stylesCss}\n${workbenchCss}</style>
</head>
<body style="margin:0;background:#0e0e10;">
  <div id="root"></div>
  <script type="module" src="/app.js"></script>
</body>
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
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function makeSnapshot(nowMs, profiles) {
  const available = profiles.filter((p) => p.availability === 'available').length;
  const missing = profiles.filter((p) => p.availability === 'missing').length;
  let totalTokens = 0;
  let totalInput = 0;
  let totalOutput = 0;
  for (const p of profiles) {
    if (p.tokens?.totalTokens) totalTokens += p.tokens.totalTokens;
    if (p.tokens?.inputTokens) totalInput += p.tokens.inputTokens;
    if (p.tokens?.outputTokens) totalOutput += p.tokens.outputTokens;
  }
  return {
    aggregated: {
      totalProfiles: profiles.length,
      availableProfiles: available,
      missingProfiles: missing,
      totalTokens,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCachedTokens: 0,
      totalCostUSD: 12.3,
      lastRefresh: nowMs,
      status: 'ok',
    },
    providers: [],
    profiles,
  };
}

test('useAgentsUsage hook lifecycle: all 12 deterministic request, interval, timeout, error, reconnect, and visibility scenarios', async (t) => {
  const url = await startHarnessServer(t);
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
  t.after(() => browser.close());

  const context = await browser.newContext({ viewport: { width: 920, height: 820 } });
  const page = await context.newPage();

  const baseTime = new Date('2026-11-24T10:00:00.000Z').getTime();
  await page.clock.install({ time: baseTime });
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__usageHarness));

  // Deterministically flush React 18's MessageChannel scheduler without advancing fake time.
  const flushReact = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = () => resolve();
          ch.port2.postMessage(null);
        }),
    );

  const sampleProfile = (usedPct) => ({
    profileId: 'codex-a',
    label: 'Codex A',
    provider: 'OpenAI',
    planType: 'Plus',
    model: 'gpt-5-codex',
    profileDir: '/home/developer/.codex',
    canonicalDir: '/home/developer/.codex',
    isSharedStorage: false,
    availability: 'available',
    collectionStatus: 'healthy',
    observedAt: baseTime,
    fiveHourUtilization: { status: 'available', usedPercent: usedPct, windowMinutes: 300, resetsInSeconds: 3120 },
    weeklyUtilization: { status: 'available', usedPercent: 64, windowMinutes: 10080, resetsAt: baseTime + 25 * 3600_000 },
    tokens: { status: 'available', totalTokens: 420000, inputTokens: 300000, outputTokens: 120000 },
    cost: { status: 'unsupported' },
  });

  // 1. Opening Usage sends exactly one initial request (forceRefresh: false)
  let sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 1, 'Expected exactly 1 initial request on mount');
  assert.equal(sent[0].type, 'agents.usage.get');
  assert.equal(sent[0].forceRefresh, false);
  const firstReqId = sent[0].requestId;

  // Refresh button must be disabled while initial request is in flight
  assert.equal(await page.locator('.agents-usage-refresh-btn').isDisabled(), true);

  // 7. Concurrent requests never overlap while request is in flight
  await page.evaluate(() => {
    window.__usageHarness.triggerReopen();
  });
  sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 1, 'In-flight request must block duplicate concurrent requests');

  // 2. Receiving snapshot updates UI, re-enables Refresh, and triggers ZERO follow-up requests
  await page.evaluate(
    ({ reqId, snap }) =>
      window.__usageHarness.emitMessage({ type: 'agents.usage.snapshot', requestId: reqId, usage: snap }),
    { reqId: firstReqId, snap: makeSnapshot(baseTime, [sampleProfile(32)]) },
  );
  await flushReact();
  await page.clock.runFor(5_000);
  await flushReact();
  sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 1, 'Snapshot arrival must NOT trigger a refresh loop');
  assert.equal(await page.locator('.agents-usage-refresh-btn').isDisabled(), false, 'Refresh button must be enabled after snapshot');
  assert.ok((await page.locator('.quota-values').first().innerText()).includes('32% used'));

  // 3. Manual Refresh sends one forced request (forceRefresh: true) and preserves previous snapshot while refreshing
  await page.locator('.agents-usage-refresh-btn').click();
  await flushReact();
  sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 2, 'Manual Refresh must send exactly 1 forced request');
  assert.equal(sent[1].forceRefresh, true);
  assert.equal(await page.locator('.agents-usage-refresh-btn').isDisabled(), true);
  assert.ok((await page.locator('.profile-usage-card').count()) === 1, 'Previous snapshot stays visible while refreshing');

  // 8. Stale response (old requestId) is strictly ignored and cannot replace newer state or clear pending
  await page.evaluate(
    ({ staleId, snap }) =>
      window.__usageHarness.emitMessage({ type: 'agents.usage.snapshot', requestId: staleId, usage: snap }),
    { staleId: firstReqId, snap: makeSnapshot(baseTime, [sampleProfile(99)]) },
  );
  await flushReact();
  assert.equal(await page.locator('.agents-usage-refresh-btn').isDisabled(), true, 'Stale response must not clear active request');
  assert.ok((await page.locator('.quota-values').first().innerText()).includes('32% used'), 'Stale response must not overwrite snapshot');

  // Complete manual refresh with matching requestId
  const manualReqId = sent[1].requestId;
  await page.evaluate(
    ({ reqId, snap }) =>
      window.__usageHarness.emitMessage({ type: 'agents.usage.snapshot', requestId: reqId, usage: snap }),
    { reqId: manualReqId, snap: makeSnapshot(baseTime + 5_000, [sampleProfile(44)]) },
  );
  await flushReact();
  assert.equal(await page.locator('.agents-usage-refresh-btn').isDisabled(), false);
  assert.ok((await page.locator('.quota-values').first().innerText()).includes('44% used'));

  // 4. Automatic refresh occurs at exactly USAGE_REFRESH_INTERVAL_MS (5 minutes) with forceRefresh: false
  await page.clock.runFor(4 * 60 * 1000);
  await flushReact();
  assert.equal((await page.evaluate(() => window.__usageHarness.sent())).length, 2, 'No auto-refresh before 5 minutes');
  await page.clock.runFor(60 * 1000);
  await flushReact();
  sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 3, 'Auto-refresh must fire at 5 minutes');
  assert.equal(sent[2].forceRefresh, false, 'Periodic refresh must respect backend cache (forceRefresh: false)');

  // 9. Request timeout releases refreshing state, shows error, preserves previous snapshot, and re-enables Refresh
  await page.clock.runFor(15_000);
  await flushReact();
  assert.equal(await page.locator('.agents-usage-refresh-btn').isDisabled(), false, 'Timeout must re-enable Refresh');
  assert.equal(await page.locator('.agents-usage-banner.error').count(), 1, 'Timeout must display concise error');
  assert.ok((await page.locator('.quota-values').first().innerText()).includes('44% used'), 'Timeout must preserve previous snapshot');

  // 10. Failed refresh preserves previous snapshot, displays error, and allows manual retry recovery
  await page.locator('.agents-usage-refresh-btn').click();
  await flushReact();
  sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 4);
  await page.evaluate(
    ({ reqId }) =>
      window.__usageHarness.emitMessage({
        type: 'agents.usage.failed',
        requestId: reqId,
        error: 'Collector temporarily unavailable',
      }),
    { reqId: sent[3].requestId },
  );
  await flushReact();
  assert.equal(await page.locator('.agents-usage-refresh-btn').isDisabled(), false);
  assert.ok((await page.locator('.agents-usage-banner.error').innerText()).includes('Collector temporarily unavailable'));
  assert.ok((await page.locator('.quota-values').first().innerText()).includes('44% used'));

  // 11. Connection loss cancels in-flight refresh cleanly; reconnection triggers recovery
  await page.locator('.agents-usage-refresh-btn').click();
  await flushReact();
  sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 5);
  assert.equal(await page.locator('.agents-usage-refresh-btn').isDisabled(), true);
  await page.evaluate(() => window.__usageHarness.setConnectionStatus('reconnecting'));
  await flushReact();
  assert.equal(await page.locator('.agents-usage-refresh-btn').isDisabled(), false, 'Disconnect must release disabled state');
  await page.evaluate(() => window.__usageHarness.triggerReopen());
  await flushReact();
  sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 6, 'Reconnection must trigger a recovery request');
  await page.evaluate(
    ({ reqId, snap }) =>
      window.__usageHarness.emitMessage({ type: 'agents.usage.snapshot', requestId: reqId, usage: snap }),
    { reqId: sent[5].requestId, snap: makeSnapshot(baseTime + 320_000, [sampleProfile(50)]) },
  );
  await flushReact();
  assert.equal(await page.locator('.agents-usage-banner.error').count(), 0, 'Successful recovery clears error banner');

  // 12. Hidden document pauses polling and catches up ONCE when returning if stale
  await page.evaluate(() => window.__usageHarness.setVisibility('hidden'));
  await page.clock.runFor(10 * 60 * 1000); // 10 minutes hidden
  await flushReact();
  sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 6, 'No background polling while document is hidden and no accumulated ticks');
  await page.evaluate(() => window.__usageHarness.setVisibility('visible'));
  await flushReact();
  sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 7, 'Returning to visible when stale triggers 1 catch-up refresh');
  await page.evaluate(
    ({ reqId, snap }) =>
      window.__usageHarness.emitMessage({ type: 'agents.usage.snapshot', requestId: reqId, usage: snap }),
    { reqId: sent[6].requestId, snap: makeSnapshot(baseTime + 920_000, [sampleProfile(55)]) },
  );
  await flushReact();

  // 5. Closing Usage stops automatic refresh completely
  await page.evaluate(() => window.__usageHarness.setMounted(false));
  await flushReact();
  await page.waitForSelector('#usage-unmounted');
  await page.clock.runFor(10 * 60 * 1000);
  await flushReact();
  sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 7, 'Unmounted Usage view must send 0 automatic requests');

  // 6. Reopening Usage starts a clean new lifecycle with 1 initial request
  await page.evaluate(() => window.__usageHarness.setMounted(true));
  await flushReact();
  sent = await page.evaluate(() => window.__usageHarness.sent());
  assert.equal(sent.length, 8, 'Reopening Usage triggers 1 fresh initial request');
});

test('AgentsUsageView visual, layout, progressbar geometry, and 8 acceptance screenshots', async (t) => {
  const url = await startHarnessServer(t);
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 820, height: 840 } });
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__usageHarness));

  const now = Date.now();
  const deliver = async (profiles, errorMsg = null) => {
    const sent = await page.evaluate(() => window.__usageHarness.sent());
    const last = sent[sent.length - 1];
    if (errorMsg) {
      await page.evaluate(
        ({ reqId, err }) =>
          window.__usageHarness.emitMessage({ type: 'agents.usage.failed', requestId: reqId, error: err }),
        { reqId: last.requestId, err: errorMsg },
      );
    } else {
      await page.evaluate(
        ({ reqId, snap }) =>
          window.__usageHarness.emitMessage({ type: 'agents.usage.snapshot', requestId: reqId, usage: snap }),
        { reqId: last.requestId, snap: makeSnapshot(now, profiles) },
      );
    }
    await page.waitForTimeout(80);
  };

  // Screenshot 1: Codex profiles with available quotas
  const codexProfiles = [
    {
      profileId: 'codex-a',
      label: 'Codex A',
      provider: 'OpenAI',
      planType: 'Plus',
      model: 'gpt-5-codex',
      profileDir: '/home/developer/.codex',
      canonicalDir: '/home/developer/.codex',
      isSharedStorage: false,
      availability: 'available',
      collectionStatus: 'healthy',
      observedAt: now,
      fiveHourUtilization: { status: 'available', usedPercent: 32, windowMinutes: 300, resetsInSeconds: 52 * 60 },
      weeklyUtilization: { status: 'available', usedPercent: 74, windowMinutes: 10080, resetsInSeconds: 3 * 3600 + 15 * 60 },
      tokens: { status: 'available', totalTokens: 8250000, inputTokens: 6000000, outputTokens: 2250000, cachedInputTokens: 1500000, reasoningOutputTokens: 450000 },
      cost: { status: 'available', amount: 12.3, currency: 'USD' },
    },
    {
      profileId: 'codex-b',
      label: 'Codex B',
      provider: 'OpenAI',
      planType: 'Team',
      model: 'gpt-5-codex',
      profileDir: '/home/developer/.codex-work',
      canonicalDir: '/home/developer/.codex-work',
      isSharedStorage: false,
      availability: 'available',
      collectionStatus: 'healthy',
      observedAt: now,
      fiveHourUtilization: { status: 'zero', usedPercent: 0, windowMinutes: 300, resetsInSeconds: 4 * 3600 },
      weeklyUtilization: { status: 'available', usedPercent: 48, windowMinutes: 10080, resetsAt: now + 26 * 3600_000 },
      tokens: { status: 'available', totalTokens: 1450000, inputTokens: 1050000, outputTokens: 400000 },
      cost: { status: 'unsupported' },
    },
  ];
  await deliver(codexProfiles);

  // Verify real rendered progress bar geometry with production styles
  const geometry = await page.evaluate(() => {
    const view = document.querySelector('.agents-usage-view');
    const bars = Array.from(document.querySelectorAll('[role="progressbar"]')).map((track) => {
      const fill = track.querySelector('.quota-bar-fill');
      const trackRect = track.getBoundingClientRect();
      const fillRect = fill ? fill.getBoundingClientRect() : null;
      return {
        label: track.getAttribute('aria-label'),
        now: Number(track.getAttribute('aria-valuenow')),
        trackWidth: trackRect.width,
        trackHeight: trackRect.height,
        fillWidth: fillRect ? fillRect.width : 0,
        fillHeight: fillRect ? fillRect.height : 0,
      };
    });
    return {
      overflowX: view.scrollWidth > view.clientWidth,
      overflowY: getComputedStyle(view).overflowY,
      bars,
    };
  });
  assert.equal(geometry.overflowX, false, 'Usage view must not overflow horizontally');
  assert.notEqual(geometry.overflowY, 'auto', 'Usage view must not create a nested scrollbar');
  assert.equal(geometry.bars.length, 4, 'Both profiles render 5-hour and weekly progressbars');
  assert.ok(geometry.bars[0].trackWidth > 100 && geometry.bars[0].trackHeight >= 5);
  assert.ok(geometry.bars[0].fillWidth > 20, `32% bar must have visible nonzero width (got ${geometry.bars[0].fillWidth})`);
  assert.ok(geometry.bars[1].fillWidth > geometry.bars[0].fillWidth, '74% bar must be wider than 32% bar');
  await page.screenshot({ path: path.join(artifactDir, '01-codex-available-quotas.png'), fullPage: true });

  // Screenshot 2: Profile with 95% weekly usage
  await page.locator('.agents-usage-refresh-btn').click();
  await deliver([
    {
      ...codexProfiles[0],
      fiveHourUtilization: { status: 'available', usedPercent: 78, windowMinutes: 300, resetsInSeconds: 52 * 60 },
      weeklyUtilization: { status: 'available', usedPercent: 95, windowMinutes: 10080, resetsAt: now + 26 * 3600_000 },
    },
  ]);
  const text95 = await page.locator('.agents-usage-view').innerText();
  assert.ok(text95.includes('95% used · 5% remaining'), 'Must display 95% used · 5% remaining');
  assert.ok(text95.includes('Critical'), '95% bar must include non-color accessible severity tag');
  const fill95Width = await page.locator('.quota-bar-fill.fill-critical').evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(fill95Width > 150, `95% critical bar must have visible width (got ${fill95Width})`);
  await page.screenshot({ path: path.join(artifactDir, '02-weekly-95-percent-critical.png'), fullPage: true });

  // Screenshot 3: Profile with unavailable / unsupported quota data
  await page.locator('.agents-usage-refresh-btn').click();
  await deliver([
    {
      profileId: 'claude-code',
      label: 'Claude Code',
      provider: 'Anthropic',
      model: 'claude-sonnet-4-6',
      profileDir: '/home/developer/.claude',
      canonicalDir: '/home/developer/.claude',
      isSharedStorage: false,
      availability: 'available',
      collectionStatus: 'partial',
      collectionError: 'Quota window telemetry is not exposed by this CLI version.',
      fiveHourUtilization: { status: 'unsupported', windowMinutes: 300 },
      weeklyUtilization: { status: 'unavailable', windowMinutes: 10080 },
      tokens: { status: 'unavailable' },
      cost: { status: 'unsupported' },
    },
  ]);
  assert.equal(await page.locator('[role="progressbar"]').count(), 0, 'Unavailable/unsupported quotas must not render 0% progress bars');
  const unavailText = await page.locator('.agents-usage-view').innerText();
  assert.ok(unavailText.includes('Not supported') && unavailText.includes('Unavailable'));
  await page.screenshot({ path: path.join(artifactDir, '03-unavailable-quota-data.png'), fullPage: true });

  // Restore multi-provider dataset for Screenshots 4, 5, 6, 7, 8
  const multiProviderProfiles = [
    codexProfiles[0],
    {
      profileId: 'agy-b',
      label: 'AGY B',
      provider: 'Google',
      planType: 'Pro',
      model: 'Gemini 3.8 Flash',
      profileDir: '/home/developer/.local/share/agy-b-profile/home/.gemini/antigravity-cli',
      canonicalDir: '/home/developer/.local/share/agy-b-profile/home/.gemini/antigravity-cli',
      isSharedStorage: false,
      availability: 'available',
      collectionStatus: 'healthy',
      observedAt: now,
      fiveHourUtilization: { status: 'available', usedPercent: 18, windowMinutes: 300, resetsInSeconds: 2 * 3600 + 10 * 60 },
      weeklyUtilization: { status: 'unavailable', windowMinutes: 10080 },
      tokens: { status: 'available', totalTokens: 6008900, inputTokens: 4120400, outputTokens: 1888500 },
      cost: { status: 'available', amount: 6.12, currency: 'USD' },
    },
    {
      profileId: 'claude-code',
      label: 'Claude Code',
      provider: 'Anthropic',
      model: 'claude-sonnet-4-6',
      profileDir: '/home/developer/.claude',
      canonicalDir: '/home/developer/.claude',
      isSharedStorage: false,
      availability: 'missing',
      collectionStatus: 'missing',
      collectionError: 'No local session history found in ~/.claude',
      fiveHourUtilization: { status: 'unavailable', windowMinutes: 300 },
      weeklyUtilization: { status: 'unavailable', windowMinutes: 10080 },
      tokens: { status: 'unavailable' },
      cost: { status: 'unsupported' },
    },
  ];
  await page.locator('.agents-usage-refresh-btn').click();
  await deliver(multiProviderProfiles);

  // Screenshot 7: Multiple providers
  await page.screenshot({ path: path.join(artifactDir, '07-multiple-providers.png'), fullPage: true });

  // Screenshot 6: Expanded token details
  await page.locator('.profile-details-toggle').first().click();
  await page.waitForSelector('.profile-details-body');
  const detailsText = await page.locator('.profile-details-body').first().innerText();
  assert.ok(detailsText.includes('8.25M') && detailsText.includes('$12.30') && detailsText.includes('~/.codex'));
  await page.screenshot({ path: path.join(artifactDir, '06-expanded-token-details.png'), fullPage: true });

  // Screenshot 4: Manual refreshing state (button disabled with spinner, snapshot preserved)
  await page.locator('.agents-usage-refresh-btn').click();
  assert.equal(await page.locator('.agents-usage-refresh-btn').isDisabled(), true);
  assert.equal(await page.locator('.agents-usage-btn-spinner').count(), 1);
  await page.screenshot({ path: path.join(artifactDir, '04-manual-refreshing.png'), fullPage: true });

  // Screenshot 5: Refresh failure (error banner shown, Refresh re-enabled, snapshot preserved)
  await deliver([], 'Local collector failed: EACCES reading profile rollout');
  assert.equal(await page.locator('.agents-usage-refresh-btn').isDisabled(), false);
  assert.equal(await page.locator('.agents-usage-banner.error').count(), 1);
  assert.equal(await page.locator('.profile-usage-card').count(), 3, 'Snapshot preserved after failure');
  await page.screenshot({ path: path.join(artifactDir, '05-refresh-failure.png'), fullPage: true });

  // Recover cleanly and test Screenshot 8: Narrow Settings content
  await page.locator('.agents-usage-refresh-btn').click();
  await deliver(multiProviderProfiles);
  await page.setViewportSize({ width: 520, height: 780 });
  await page.waitForTimeout(120);
  const narrowOverflow = await page.evaluate(() => {
    const view = document.querySelector('.agents-usage-view');
    return view.scrollWidth > view.clientWidth;
  });
  assert.equal(narrowOverflow, false, 'Narrow Settings Usage panel must not overflow horizontally');
  await page.screenshot({ path: path.join(artifactDir, '08-narrow-settings-content.png'), fullPage: true });
});

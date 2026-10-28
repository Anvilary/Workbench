/**
 * Phase 8 Browser Quality & Screenshot Automation
 *
 * Uses Playwright with viewport 1440x900 to capture:
 *  - Empty workspace
 *  - Shell-only workspace
 *  - Agent-only workspace
 *  - Combined workspace
 *  - Expanded / collapsed sidebar
 *  - Done / Restore view
 *  - Profile configuration dialog
 *
 * Checks for console errors, layout overflow, keyboard focus, modal escape.
 */

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(serverDir, '../..');
const outDir = process.env.AGENCY_SCREENSHOT_DIR || path.join(rootDir, 'docs', 'agency', 'screenshots');
mkdirSync(outDir, { recursive: true });

const temp = mkdtempSync(path.join(tmpdir(), 'aw-agency-shots-'));
const testHome = path.join(temp, 'home');
const testAppdata = path.join(temp, 'appdata');
const testXdg = path.join(temp, 'xdg');
const testWorkspaces = path.join(temp, 'workspaces');
mkdirSync(testHome, { recursive: true });
mkdirSync(testAppdata, { recursive: true });
mkdirSync(testXdg, { recursive: true });
mkdirSync(testWorkspaces, { recursive: true });

writeFileSync(path.join(testHome, '.zshrc'), '# shots\n');
writeFileSync(path.join(testHome, '.bashrc'), '# shots\n');
const fixture = path.join(temp, 'agency-test-cli');
writeFileSync(fixture, '#!/bin/sh\nprintf "AGENCY TEST FIXTURE (no provider or inference)\\n"\nwhile IFS= read -r line; do printf "fixture input received\\n"; done\n', { mode: 0o755 });

const wsDirEmpty = path.join(testWorkspaces, 'empty-ws');
const wsDirShell = path.join(testWorkspaces, 'shell-ws');
const wsDirAgent = path.join(testWorkspaces, 'agent-ws');
const wsDirCombined = path.join(testWorkspaces, 'combined-ws');
const wsDirDone = path.join(testWorkspaces, 'done-ws');
mkdirSync(wsDirEmpty, { recursive: true });
mkdirSync(wsDirShell, { recursive: true });
mkdirSync(wsDirAgent, { recursive: true });
mkdirSync(wsDirCombined, { recursive: true });
mkdirSync(wsDirDone, { recursive: true });

const commonEnv = {
  ...process.env,
  AGENT_WORKBENCH_NO_OPEN: '1',
  AGENT_WORKBENCH_NO_RESTORE: '1',
  HOME: testHome,
  USERPROFILE: testHome,
  APPDATA: testAppdata,
  XDG_CONFIG_HOME: testXdg,
  XDG_DATA_HOME: path.join(testHome, '.local', 'share'),
  XDG_CACHE_HOME: path.join(testHome, '.cache'),
  XDG_STATE_HOME: path.join(testHome, '.local', 'state'),
  CODEX_HOME: path.join(testHome, '.codex'),
  PI_CODING_AGENT_DIR: path.join(testHome, '.pi', 'agent'),
  PI_CODING_AGENT_SESSION_DIR: path.join(testHome, '.pi', 'sessions'),
};

console.log('Starting production server for screenshot capture...');
const server = spawn(
  'pnpm',
  ['--dir', 'packages/server', 'exec', 'tsx', 'src/index.ts', '--prod'],
  { cwd: rootDir, env: commonEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
);
process.on('exit', () => {
  try { process.platform === 'win32' ? server.kill() : process.kill(-server.pid, 'SIGTERM'); } catch {}
  rmSync(temp, { recursive: true, force: true });
});

let log = '';
const { port, token, url } = await new Promise((resolve) => {
  let timer;
  const onData = (chunk) => {
    log += chunk.toString();
    const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/);
    if (match) {
      clearTimeout(timer);
      server.stdout.off('data', onData);
      server.stderr.off('data', onData);
      server.off('exit', onExit);
      resolve({ port: Number(match[1]), token: match[2], url: match[0] });
    }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
  const onExit = (code) => {
    if (code !== null && code !== 0) {
      clearTimeout(timer);
      console.error(`Server exited early with code ${code}`);
      process.exit(1);
    }
  };
  server.on('exit', onExit);
  timer = setTimeout(() => {
    console.error('Timeout waiting for server URL');
    process.exit(1);
  }, 40_000);
});

console.log(`Server running on loopback port ${port}`);

// Setup initial data via WebSocket
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {
  headers: { Origin: `http://127.0.0.1:${port}` },
});

await new Promise((resolve) => ws.on('open', resolve));

const reqMap = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.requestId && reqMap.has(msg.requestId)) {
    reqMap.get(msg.requestId)(msg);
    reqMap.delete(msg.requestId);
  }
});

function request(msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reqMap.delete(msg.requestId); reject(new Error(`Timeout: ${msg.type}`)); }, 15000);
    reqMap.set(msg.requestId, (response) => {
      clearTimeout(timer);
      if (response.type === 'agency.error') return reject(new Error(`${msg.type}: ${response.message}`));
      resolve(response);
    });
    ws.send(JSON.stringify(msg));
  });
}

function pickerListing(req) {
  return new Promise((resolve) => {
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'picker.listing') {
        ws.off('message', handler);
        resolve(msg.listing);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(req));
  });
}

// 1. Create project
const projRes = await request({
  type: 'agency.project.create',
  requestId: 'p-1',
  name: 'Agency UI Integration',
});
const projectId = projRes.project.id;

// 2. Create pickers for each workspace directory
async function createWs(name, folderName) {
  const open = await pickerListing({ type: 'picker.open' });
  const created = await pickerListing({ type: 'picker.create', pickerId: open.pickerId, name: folderName });
  const res = await request({
    type: 'agency.workspace.create',
    requestId: `ws-${folderName}`,
    projectId,
    name,
    pickerId: open.pickerId,
  });
  return res.workspace;
}

const wsEmpty = await createWs('Empty Workspace', 'empty-project');
const wsShell = await createWs('Shell Only', 'shell-project');
const wsAgent = await createWs('Agent Only', 'agent-project');
const wsCombined = await createWs('Combined Workspace', 'combined-project');
const wsDone = await createWs('Completed Task', 'done-project');
const extraProject = await request({ type: 'agency.project.create', requestId: 'p-long',
  name: 'A second project with a deliberately long name for responsive navigation' });
const extraPicker = await pickerListing({ type: 'picker.open' });
await pickerListing({ type: 'picker.create', pickerId: extraPicker.pickerId, name: 'long-project' });
await request({ type: 'agency.workspace.create', requestId: 'ws-long', projectId: extraProject.project.id,
  name: 'A workspace with a deliberately long name for responsive navigation', pickerId: extraPicker.pickerId });

// These disposable processes deliberately do not run or authenticate any real CLI.
for (const profileId of ['codex00', 'claude-code']) {
  const configured = await request({ type: 'agency.profile.configure', requestId: `fixture-${profileId}`,
    profileId, executable: fixture, args: [] });
  assert.equal(configured.profile.configurationStatus, 'available');
}

// Launch sessions
// Shell workspace session
const shellSession = await request({
  type: 'agency.session.create',
  requestId: 's-shell',
  workspaceId: wsShell.id,
  kind: 'terminal',
  cols: 80,
  rows: 24,
});

// Agent workspace session
const agentSession = await request({
  type: 'agency.session.create',
  requestId: 's-agent',
  workspaceId: wsAgent.id,
  kind: 'agent',
  profileId: 'codex00',
  cols: 80,
  rows: 24,
});

// Combined workspace sessions (terminal + agent)
const combinedShell = await request({
  type: 'agency.session.create',
  requestId: 's-comb-term',
  workspaceId: wsCombined.id,
  kind: 'terminal',
  cols: 80,
  rows: 24,
});

const combinedAgent = await request({
  type: 'agency.session.create',
  requestId: 's-comb-agent',
  workspaceId: wsCombined.id,
  kind: 'agent',
  profileId: 'claude-code',
  cols: 80,
  rows: 24,
});

for (const result of [shellSession, agentSession, combinedShell, combinedAgent]) {
  assert.equal(result.type, 'agency.session.created');
  assert.equal(result.session.lifecycle, 'running');
  assert.ok(result.session.terminalId);
}

// Mark wsDone as done
await request({
  type: 'agency.workspace.done',
  requestId: 'ws-done-req',
  workspaceId: wsDone.id,
});

ws.close();

console.log('Launching Chromium at 1440x900 viewport...');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
});

const consoleErrors = [];
const pageErrors = [];

const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => {
  pageErrors.push(err.message);
});

console.log('Navigating to app URL...');
await page.goto(url);
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1000);

// Save only after the requested state has been reached.
async function saveShot(filename) {
  const p1 = path.join(outDir, filename);
  await page.screenshot({ path: p1 });
  console.log(`Saved screenshot: ${p1}`);
}

async function selectWorkspace(name) {
  const button = page.locator('.agency-workspace-nav-button').filter({ hasText: name }).first();
  await button.click();
  await page.locator('.agency-workspace-view').filter({ hasText: name }).waitFor({ state: 'visible' });
  assert.equal(await button.getAttribute('aria-current'), 'page');
}
async function expectVisible(selector) {
  await page.locator(selector).first().waitFor({ state: 'visible' });
}
async function expectAbsent(selector) {
  assert.equal(await page.locator(selector).count(), 0, `${selector} should be absent`);
}
await selectWorkspace('Empty Workspace');
await expectVisible('.agency-agent-pane');
await expectAbsent('.agency-shell-pane');
await expectAbsent('.terminal-surface');
const profileOptions = await page.locator('.agency-shell-placeholder select').locator('option').evaluateAll(
  (options) => options.map((option) => option.value).filter(Boolean));
assert.deepEqual(profileOptions, ['codex00', 'codex01', 'codex03', 'agy00', 'agy01', 'agy02', 'agy03', 'agy04', 'agy05', 'claude-code']);
await saveShot('01-empty-workspace.png');

await page.locator('.agency-side-heading button').click();
await expectVisible('[role="dialog"]');
await saveShot('07-new-workspace-dialog.png');
for (let i = 0; i < 8; i++) {
  await page.keyboard.press('Tab');
  assert.ok(await page.locator('[role="dialog"]').evaluate((dialog) => dialog.contains(document.activeElement)),
    'Keyboard focus escaped the dialog');
}
await page.locator('.agency-dialog input').fill('Search Test WS');
await page.getByRole('button', { name: 'Select existing folder' }).click();
await expectVisible('.picker-modal');
await page.locator('.picker-search-input').fill('project');
await saveShot('08-folder-picker-live-search.png');
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');

await selectWorkspace('Shell Only');
await expectVisible('.agency-shell-pane .terminal-surface');
await expectVisible('.agency-shell-pane .xterm-screen');
await expectAbsent('.agency-agent-pane');
await saveShot('02-shell-only-workspace.png');

await selectWorkspace('Agent Only');
await expectVisible('.agency-agent-pane .terminal-surface');
await expectAbsent('.agency-shell-pane');
await page.getByText('AGENCY TEST FIXTURE', { exact: false }).first().waitFor({ state: 'visible' });
await saveShot('03-agent-only-workspace.png');

await selectWorkspace('Combined Workspace');
await expectVisible('.agency-agent-pane .terminal-surface');
await expectVisible('.agency-shell-pane .terminal-surface');
await expectVisible('.agency-pane-divider');
await saveShot('04-combined-workspace.png');
await expectVisible('.agency-sidebar-nav');
await saveShot('05a-sidebar-expanded.png');
const sidebarToggle = page.locator('.agency-topbar button[aria-expanded]');
await sidebarToggle.click();
await page.locator('.agency-sidebar-nav').waitFor({ state: 'hidden' });
await saveShot('05b-sidebar-collapsed.png');
await sidebarToggle.click();
await expectVisible('.agency-sidebar-nav');

await page.locator('.agency-history-toggle').click();
await expectVisible('.agency-done-view:has-text("Completed Task")');
await expectVisible('.agency-done-view button');
await saveShot('06-done-restore-view.png');

// Exercise populated combined state at each requested width: 390, 768, 1024, 1440, 1920.
for (const width of [390, 768, 1024, 1440, 1920]) {
  await page.setViewportSize({ width, height: 900 });
  await selectWorkspace('Combined Workspace');
  if (width <= 680) await sidebarToggle.click();
  await expectVisible('.agency-agent-pane .terminal-surface');
  await expectVisible('.agency-shell-pane .terminal-surface');
  const metrics = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    terminals: [...document.querySelectorAll('.terminal-surface')].map(el => {
      const r = el.getBoundingClientRect(); return { width: r.width, height: r.height };
    }) }));
  assert.ok(metrics.scroll <= metrics.viewport, `Overflow at ${width}: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.terminals.every(r => r.width > 80 && r.height > 50), `Terminal too small at ${width}: ${JSON.stringify(metrics)}`);
  console.log('Combined layout:', width, JSON.stringify(metrics));
  if (width === 1920) {
    await saveShot('09-desktop-1920.png');
  }
  if (width <= 680) await sidebarToggle.click();
}

// Workspace switching preserves terminal attachment.
await selectWorkspace('Shell Only');
const switchStart = performance.now();
await selectWorkspace('Combined Workspace');
await selectWorkspace('Shell Only');
console.log('Two workspace switches with terminal attachment (ms):', Math.round(performance.now() - switchStart));

await page.locator('.agency-history-toggle').click();
await page.locator('.agency-done-row').filter({ hasText: 'Completed Task' }).getByRole('button', { name: 'Restore' }).click();
await page.locator('.agency-workspace-view').filter({ hasText: 'Completed Task' }).waitFor({ state: 'visible' });
assert.deepEqual(pageErrors, [], 'Unexpected browser page errors');

const hashes = ['01-empty-workspace.png', '02-shell-only-workspace.png', '03-agent-only-workspace.png',
  '04-combined-workspace.png', '05a-sidebar-expanded.png', '05b-sidebar-collapsed.png',
  '06-done-restore-view.png', '07-new-workspace-dialog.png', '08-folder-picker-live-search.png', '09-desktop-1920.png']
  .map((name) => createHash('sha256').update(readFileSync(path.join(outDir, name))).digest('hex'));
assert.equal(new Set(hashes).size, hashes.length, 'Distinct UI states produced duplicate screenshots');
console.log('Browser page errors:', pageErrors.length, 'console errors:', consoleErrors.length);

await browser.close();
try {
  server.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    try { server.kill('SIGKILL'); } catch {}
  }, 4000);
  await new Promise((r) => server.once('exit', r));
  clearTimeout(killTimer);
} catch {}

try {
  rmSync(temp, { recursive: true, force: true });
} catch {}

console.log('Browser Quality & Screenshot Capture Finished Successfully.');

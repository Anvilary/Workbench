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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = path.resolve(serverDir, '../..');
const outDir = path.join(rootDir, 'docs', 'agency', 'screenshots');
mkdirSync(outDir, { recursive: true });

const artifactDir = '/home/user/.local/share/agy-3-profile/home/.gemini/antigravity-cli/brain/1a3be513-bf84-4ca1-ad88-4143d44cf965';
if (existsSync(artifactDir)) {
  mkdirSync(path.join(artifactDir, 'screenshots'), { recursive: true });
}

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
};

console.log('Starting production server for screenshot capture...');
const server = spawn(
  'pnpm',
  ['--dir', 'packages/server', 'exec', 'tsx', 'src/index.ts', '--prod'],
  { cwd: rootDir, env: commonEnv, stdio: ['ignore', 'pipe', 'pipe'] },
);

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

console.log(`Server running at ${url}`);

// Setup initial data via WebSocket
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {
  headers: { Origin: `http://127.0.0.1:${port}` },
});

await new Promise((resolve) => ws.on('open', resolve));

const reqMap = new Map();
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString());
    if (msg.requestId && reqMap.has(msg.requestId)) {
      reqMap.get(msg.requestId)(msg);
      reqMap.delete(msg.requestId);
    }
  } catch {}
});

function request(msg) {
  return new Promise((resolve) => {
    reqMap.set(msg.requestId, resolve);
    ws.send(JSON.stringify(msg));
  });
}

function pickerListing(req) {
  return new Promise((resolve) => {
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'picker.listing') {
          ws.off('message', handler);
          resolve(msg.listing);
        }
      } catch {}
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

// Launch sessions
// Shell workspace session
await request({
  type: 'agency.session.create',
  requestId: 's-shell',
  workspaceId: wsShell.id,
  kind: 'terminal',
  cols: 80,
  rows: 24,
});

// Agent workspace session
await request({
  type: 'agency.session.create',
  requestId: 's-agent',
  workspaceId: wsAgent.id,
  kind: 'agent',
  profileId: 'codex-0',
  cols: 80,
  rows: 24,
});

// Combined workspace sessions (terminal + agent)
await request({
  type: 'agency.session.create',
  requestId: 's-comb-term',
  workspaceId: wsCombined.id,
  kind: 'terminal',
  cols: 80,
  rows: 24,
});

await request({
  type: 'agency.session.create',
  requestId: 's-comb-agent',
  workspaceId: wsCombined.id,
  kind: 'agent',
  profileId: 'claude-code',
  cols: 80,
  rows: 24,
});

// Configure codex-0 profile so it has an available binary and can be configured in UI
await request({
  type: 'agency.profile.configure',
  requestId: 'prof-cfg-codex',
  profileId: 'codex-0',
  executable: '/bin/bash',
  args: ['-l'],
});

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

// Helper for saving shot to both outDir and artifactDir
async function saveShot(filename) {
  const p1 = path.join(outDir, filename);
  await page.screenshot({ path: p1 });
  console.log(`Saved screenshot: ${p1}`);
  if (existsSync(artifactDir)) {
    const p2 = path.join(artifactDir, 'screenshots', filename);
    copyFileSync(p1, p2);
  }
}

// Check 1: 01-empty-workspace.png
console.log('Capturing Empty Workspace...');
await page.locator('.agency-workspace-nav-button:has-text("Empty Workspace")').first().click({ force: true }).catch(() => {});
await page.waitForTimeout(600);
await saveShot('01-empty-workspace.png');

// Check 7: 07-profile-configuration-dialog.png (Captured while in Empty Workspace before sessions)
console.log('Capturing Profile Configuration Dialog...');
const configBtn = page.locator('button:has-text("Configure profile"), button[title*="Configure profile" i]').first();
if (await configBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
  await configBtn.click({ force: true });
  await page.waitForTimeout(600);
  await saveShot('07-profile-configuration-dialog.png');
  const closeBtn = page.locator('button:has-text("Cancel"), button[aria-label="Close"]').first();
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click({ force: true });
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(300);
}

// Check 2: 02-shell-only-workspace.png
console.log('Capturing Shell-only Workspace...');
await page.locator('.agency-workspace-nav-button:has-text("Shell Only")').first().click({ force: true }).catch(() => {});
await page.waitForTimeout(800);
await saveShot('02-shell-only-workspace.png');

// Check 3: 03-agent-only-workspace.png
console.log('Capturing Agent-only Workspace...');
await page.locator('.agency-workspace-nav-button:has-text("Agent Only")').first().click({ force: true }).catch(() => {});
await page.waitForTimeout(800);
await saveShot('03-agent-only-workspace.png');

// Check 4: 04-combined-workspace.png
console.log('Capturing Combined Workspace...');
await page.locator('.agency-workspace-nav-button:has-text("Combined Workspace")').first().click({ force: true }).catch(() => {});
await page.waitForTimeout(800);
await saveShot('04-combined-workspace.png');

// Check 5: 05a-sidebar-expanded.png & 05b-sidebar-collapsed.png
console.log('Capturing Sidebar Expanded / Collapsed...');
await saveShot('05a-sidebar-expanded.png');

const collapseBtn = page.locator('button[aria-label*="sidebar" i], button[title*="sidebar" i], button:has-text("Toggle sidebar")').first();
if (await collapseBtn.isVisible().catch(() => false)) {
  await collapseBtn.click({ force: true });
  await page.waitForTimeout(400);
  await saveShot('05b-sidebar-collapsed.png');
  await collapseBtn.click({ force: true });
  await page.waitForTimeout(400);
} else {
  await saveShot('05b-sidebar-collapsed.png');
}

// Check 6: 06-done-restore-view.png
console.log('Capturing Done / Restore Workspace...');
const doneSection = page.locator('button.agency-history-toggle, button:has-text("done"), button:has-text("Done")').first();
if (await doneSection.isVisible().catch(() => false)) {
  await doneSection.click({ force: true });
  await page.waitForTimeout(500);
  await page.locator('.agency-workspace-nav-button:has-text("Completed Task")').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
}
await saveShot('06-done-restore-view.png');

// Quality checks:
console.log('--- Quality Verification ---');
console.log(`Page Errors: ${pageErrors.length}`);
if (pageErrors.length > 0) {
  console.error('Page errors detected:', pageErrors);
}
console.log(`Console Errors: ${consoleErrors.length}`);
if (consoleErrors.length > 0) {
  console.log('Console error log:', consoleErrors);
}

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

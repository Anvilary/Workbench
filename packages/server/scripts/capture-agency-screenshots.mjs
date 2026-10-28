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
const outDir = process.env.AGENCY_SCREENSHOT_DIR || path.join(rootDir, 'docs', 'maw', 'multi-session-screenshots');
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
  process.execPath,
  ['--import', path.join(rootDir, 'packages/server/node_modules/tsx/dist/loader.mjs'), path.join(rootDir, 'packages/server/src/index.ts'), '--prod'],
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
for (const profileId of ['codex00', 'codex01', 'agy03', 'claude-code']) {
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

// Keep the disposable control socket for per-session routing assertions.

console.log('Launching Chromium at 1440x900 viewport...');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
});

const consoleErrors = [];
const pageErrors = [];

const page = await context.newPage();
const browserCreates = [];
page.on('websocket', socket => socket.on('framesent', frame => {
  try { if (JSON.parse(frame.payload).type === 'agency.session.create') browserCreates.push(frame.payload); } catch {}
}));
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


let serial = 0;
const api = msg => request({ ...msg, requestId: 'multi-' + (++serial) });
const snapshot = async () => (await api({ type: 'agency.sessions.list' })).sessions;
const openTabs = rows => rows.filter(row => row.workspaceId === wsCombined.id && row.tab?.current && !row.tab.closedAt).sort((a,b) => a.tab.order - b.tab.order);
async function until(predicate) { for(let i=0;i<200;i++) { if(await predicate()) return; await new Promise(resolve=>setTimeout(resolve,40)); } throw new Error('Assertion timed out: '+predicate); }
async function shot(name) { await page.screenshot({ path: path.join(outDir,name+'.png') }); console.log('Screenshot', name); }
async function selectWorkspace(name) {
  await page.locator('.agency-workspace-nav-button').filter({hasText:name}).first().click();
  await page.getByRole('region',{name:'Workspace '+name,exact:true}).waitFor();
}
const add = page.getByRole('button',{name:'Add tab',exact:true});
async function addCLI(profile) {
  await add.click(); await page.getByRole('menuitem',{name:'New CLI',exact:true}).click();
  await page.locator('[role=dialog] select').selectOption(profile);
  await page.getByRole('button',{name:'Start new CLI session',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
}
async function addShell() { await add.click();await page.getByRole('menuitem',{name:'New Terminal',exact:true}).click(); }
async function selectTab(id) { await page.locator(`[data-tab-id="${id}"] [role=tab]`).click();await until(async()=>await page.locator(`[data-tab-id="${id}"] [role=tab]`).getAttribute('aria-selected')==='true'); }

await selectWorkspace('Empty Workspace');
assert.equal(await page.getByRole('tab').count(),0);
await shot('01-empty');
await selectWorkspace('Combined Workspace');
assert.equal(await page.getByRole('tab').count(),2);
await add.click();await shot('02-add-open');await add.click();assert.equal(await page.getByRole('menu').count(),0);
await add.click();await page.keyboard.press('Escape');assert.equal(await add.evaluate(el=>document.activeElement===el),true);
await add.click();await page.locator('.agency-breadcrumbs').click();assert.equal(await page.getByRole('menu').count(),0);
await addCLI('codex00'); await addCLI('agy03'); await addCLI('claude-code');
await addShell(); await addShell();
let rows = openTabs(await snapshot());
assert.equal(rows.length,7); assert.equal(rows.filter(s=>s.kind==='agent').length,4); assert.equal(rows.filter(s=>s.kind==='terminal').length,3);
const sameProfile = rows.filter(s=>s.profileId==='claude-code');assert.equal(sameProfile.length,2);assert.notEqual(sameProfile[0].nativeSessionId,sameProfile[1].nativeSessionId);
assert.equal(new Set(rows.map(s=>s.terminalId)).size,7);
await until(async()=>await page.getByRole('tab').count()===7);
await until(async()=>await page.locator(`[data-tab-id="${rows.at(-1).tab.id}"] [role=tab]`).getAttribute('aria-selected')==='true');
await shot('03-mixed-seven-tabs');
const shellRows=rows.filter(s=>s.kind==='terminal');
const captures=new Map();
ws.on('message',raw=>{const msg=JSON.parse(raw);if(msg.type==='terminal.output')captures.set(msg.terminalId,(captures.get(msg.terminalId)??'')+msg.data);});
for(const row of rows) ws.send(JSON.stringify({type:'terminal.attach',terminalId:row.terminalId,cols:100,rows:30}));
await selectTab(shellRows[0].tab.id);
await page.locator('.maw-session-pane:visible .xterm-helper-textarea').focus();
await page.keyboard.type("printf '\\nUI_FOCUS_ONLY\\n'");await page.keyboard.press('Enter');
await until(()=>captures.get(shellRows[0].terminalId)?.includes('UI_FOCUS_ONLY'));
for(const row of rows.filter(s=>s.id!==shellRows[0].id))assert.ok(!(captures.get(row.terminalId)??'').includes('UI_FOCUS_ONLY'),'Input leaked to another session');
ws.send(JSON.stringify({type:'resize',terminalId:shellRows[1].terminalId,cols:93,rows:31}));
ws.send(JSON.stringify({type:'input',terminalId:shellRows[1].terminalId,data:'stty size\r'}));
await until(()=>captures.get(shellRows[1].terminalId)?.includes('31 93'));
assert.ok(!(captures.get(shellRows[0].terminalId)??'').includes('31 93'));
await shot('04-terminal-focus-and-routing');
const starts = browserCreates.length;
for(const row of rows)await selectTab(row.tab.id);
assert.equal(browserCreates.length,starts); assert.equal((await snapshot()).length,9); // includes shell-only and agent-only fixture workspaces
assert.equal(await page.locator('.maw-session-pane:visible').count(),1);
assert.equal(await page.locator('.agency-pane-divider,.agency-content-split').count(),0);
const selectedBeforeReload=(await snapshot()).find(s=>s.workspaceId===wsCombined.id&&s.tab?.selected&&s.tab.current);
await page.reload();await page.waitForLoadState('networkidle');await page.getByRole('tab').last().waitFor();
assert.equal(await page.locator(`[data-tab-id="${selectedBeforeReload.tab.id}"] [role=tab]`).getAttribute('aria-selected'),'true');
assert.equal(browserCreates.length,starts);
// Four actual creation flows: initial mode affects only the first launches.
for(const [mode,count] of [['empty',0],['agent',1],['terminal',1],['combined',2]]) {
  await page.locator('.agency-project-add[aria-label^="New workspace"]').first().click();
  await page.locator('[role=dialog] input').fill('Created '+mode);
  await page.getByLabel('Initial sessions').selectOption(mode);
  if(mode==='agent'||mode==='combined') await page.getByLabel('CLI profile').selectOption('claude-code');
  await page.getByRole('button',{name:'Select existing folder',exact:true}).click();
  await page.locator('.picker-entry').filter({hasText:/^empty-project$/}).click();
  await page.locator('.picker-open').click();
  await page.getByRole('region',{name:'Workspace Created '+mode,exact:true}).waitFor();
  await until(async()=>await page.getByRole('tab').count()===count);
  await shot('creation-'+mode);
}
await page.locator('.agency-project-add[aria-label^="New workspace"]').first().click();
await page.locator('[role=dialog] input').fill('Combined launch failure');
await page.getByLabel('Initial sessions').selectOption('combined');await page.getByLabel('CLI profile').selectOption('codex03');
await page.getByRole('button',{name:'Select existing folder',exact:true}).click();
await page.locator('.picker-entry').filter({hasText:/^empty-project$/}).click();await page.locator('.picker-open').click();
await page.getByRole('region',{name:'Workspace Combined launch failure',exact:true}).waitFor();
await until(async()=>await page.getByRole('tab').count()===2);
const failedWorkspace=(await api({type:'agency.workspaces.list'})).workspaces.find(row=>row.name==='Combined launch failure');
const partial=(await snapshot()).filter(row=>row.workspaceId===failedWorkspace.id);
assert.equal(partial.find(row=>row.kind==='agent').profileId,'codex03');assert.equal(partial.find(row=>row.kind==='agent').lifecycle,'failed');
assert.equal(partial.find(row=>row.kind==='terminal').lifecycle,'running');
await shot('creation-combined-partial-failure');
await selectWorkspace('Combined Workspace');
// Deliberately exited PTY shows its real code; closing it never closes another PTY.
await selectTab(shellRows[2].tab.id);
ws.send(JSON.stringify({type:'terminal.attach',terminalId:shellRows[2].terminalId,cols:100,rows:30}));
ws.send(JSON.stringify({type:'input',terminalId:shellRows[2].terminalId,data:'\x03'}));
await new Promise(resolve=>setTimeout(resolve,100));
ws.send(JSON.stringify({type:'input',terminalId:shellRows[2].terminalId,data:'\x15exit 7\r'}));
await until(async()=>(await snapshot()).find(row=>row.id===shellRows[2].id)?.lifecycle==='exited').catch(async error=>{console.log('Exit fixture diagnostic',JSON.stringify((await snapshot()).find(row=>row.id===shellRows[2].id)),JSON.stringify(captures.get(shellRows[2].terminalId)?.slice(-600)));throw error;});
await page.locator('.maw-session-pane:visible .agency-shell-placeholder').waitFor();
assert.equal((await snapshot()).find(row=>row.id===shellRows[2].id).exitCode,7);
await shot('05-exited-code-seven');
await page.locator(`[data-tab-id="${shellRows[2].tab.id}"] [data-close]`).click();
await until(async()=>await page.getByRole('tab').count()===6);
assert.equal(await page.getByRole('dialog').count(),0);
await selectTab(shellRows[1].tab.id);await page.locator(`[data-tab-id="${shellRows[1].tab.id}"] [data-close]`).click();
await page.getByRole('dialog').waitFor();await shot('06-close-confirmation');
await page.getByRole('button',{name:'Cancel',exact:true}).click();
assert.equal((await snapshot()).find(row=>row.id===shellRows[1].id).lifecycle,'running');
await page.locator(`[data-tab-id="${shellRows[1].tab.id}"] [data-close]`).click();await page.getByRole('button',{name:'Close session',exact:true}).click();
await until(async()=>await page.getByRole('tab').count()===5);
rows=openTabs(await snapshot());assert.ok(rows.every(row=>row.lifecycle==='running'));
assert.ok((await snapshot()).find(row=>row.id===shellRows[1].id).stoppedByUser);
await shot('07-close-only-one');
// More logical tabs than fit, without exceeding the process ceiling.
for(let index=0;index<9;index++)await api({type:'agency.session.create',workspaceId:wsCombined.id,kind:'terminal',launchId:crypto.randomUUID(),cols:100,rows:30});
await until(async()=>await page.getByRole('tab').count()===14);
let before=openTabs(await snapshot());const active=before.find(row=>row.tab.selected);
const strip=page.getByRole('tablist');await strip.evaluate(el=>{el.scrollLeft=0;});
const rect=await strip.boundingBox();await page.mouse.move(rect.x+45,rect.y+8);await page.mouse.down();await page.mouse.move(rect.x-180,rect.y+8,{steps:12});await page.mouse.up();
assert.ok(await strip.evaluate(el=>el.scrollLeft)>40,'Drag should scroll overflowing tabs');
assert.equal(openTabs(await snapshot()).find(row=>row.tab.selected).tab.id,active.tab.id,'Dragging activated a tab');
await selectTab(before[0].tab.id);await page.getByRole('tab',{selected:true}).focus();
await page.keyboard.press('ArrowRight');await until(async()=>openTabs(await snapshot()).find(row=>row.tab.selected).tab.id===before[1].tab.id);
await until(async()=>await page.locator(`[data-tab-id="${before[1].tab.id}"] [role=tab]`).getAttribute('aria-selected')==='true');
console.log('Keyboard focus before reorder',await page.evaluate(()=>document.activeElement?.getAttribute('id')));
await page.keyboard.press('Alt+ArrowRight');await until(async()=>openTabs(await snapshot())[2].tab.id===before[1].tab.id);
const order=openTabs(await snapshot()).map(row=>row.tab.id);const chosen=before[1].tab.id;
await page.reload();await page.waitForLoadState('networkidle');assert.deepEqual(openTabs(await snapshot()).map(row=>row.tab.id),order);
assert.equal(await page.locator(`[data-tab-id="${chosen}"] [role=tab]`).getAttribute('aria-selected'),'true');
await shot('08-overflow-and-order');
for(const width of [390,768,1024,1440,1920]) {
  await page.setViewportSize({width,height:900});
  if(width===390)await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
  const metrics=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,panes:[...document.querySelectorAll('.maw-session-pane')].filter(el=>!el.hidden).length,strip:document.querySelector('.maw-tabs-strip').getBoundingClientRect().height}));
  assert.ok(metrics.scroll<=metrics.width,JSON.stringify(metrics));assert.equal(metrics.panes,1);assert.ok(metrics.strip<55);
  await until(async()=>await strip.evaluate(el=>{const tab=el.querySelector('[aria-selected="true"]');if(!tab)return false;const a=tab.parentElement.getBoundingClientRect(),b=el.getBoundingClientRect();return a.left>=b.left-1 && a.right<=b.right+1;}));
  await shot('responsive-'+width);
  await add.click();await add.click();assert.equal(await page.getByRole('menu').count(),0);
}
await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
await shot('09-sidebar-and-breadcrumb');
assert.deepEqual(pageErrors,[]);assert.deepEqual(consoleErrors,[]);
console.log('PASS multi-session creation, coexistence, native IDs, routing/resize, close isolation, refresh, order, dragging, keyboard, responsive/no-split assertions.');
await browser.close();ws.close();
const exit=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await exit;
rmSync(temp,{recursive:true,force:true});
console.log('Browser Quality & Screenshot Capture Finished Successfully.');

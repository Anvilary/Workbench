/** Real isolated MAW/PTY/UI acceptance; native tabs with browser compatibility.
 * pnpm --filter @anvilary/workbench-server exec tsx scripts/check-workbench-integration.mjs
 * Never supplies a provider prompt or reuses an installed application's store.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = await mkdtemp(path.join(tmpdir(), 'maw-integrated-e2e-'));
const out = process.env.WORKBENCH_INTEGRATION_EVIDENCE ?? path.join(root, 'evidence');
const home = path.join(root, 'home');
const config = path.join(root, 'config', 'workbench');
await Promise.all([mkdir(home, { recursive: true }), mkdir(config, { recursive: true }), mkdir(out, { recursive: true })]);
const now = new Date().toISOString();
const project = { id: randomUUID(), name: 'Integration', status: 'active', createdAt: now, updatedAt: now, archivedAt: null };
const workspaces = ['Alpha', 'Beta'].map(name => ({ id: randomUUID(), projectId: project.id, name, cwd: root,
  status: 'active', createdAt: now, updatedAt: now, doneAt: null, archivedAt: null }));
await writeFile(path.join(config, 'agency-state.json'), JSON.stringify({ version: 1, projects: [project], workspaces }));
await writeFile(path.join(home, '.bashrc'), '# disposable integration fixture\n');
const env = { ...process.env, HOME: home, USERPROFILE: home, SHELL: '/bin/bash',
  XDG_CONFIG_HOME: path.dirname(config), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_STATE_HOME: path.join(root, 'state'), CODEX_HOME: path.join(home, '.codex'), APPDATA: path.join(root, 'appdata'),
  PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), PI_CODING_AGENT_SESSION_DIR: path.join(home, '.pi', 'sessions'),
  WORKBENCH_NO_OPEN: '1', WORKBENCH_NO_RESTORE: '1' };

let child, socket, browser, page;
let log = '';
let address;
const pending = new Map();
const traffic = [];
const errors = [];
const results = [];
const measurements = {startupsMs:[],switchMs:[],renderMs:null,selectionEvents:null};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(work, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await work(); if (value) return value; } catch (error) { last = error; }
    await delay(75);
  }
  throw new Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
}
function check(label, details = {}) { results.push({ label, ...details }); console.log('PASS ' + label); }
async function start() {
  const began=performance.now();
  log = '';
  child = spawn(process.execPath, ['--import', path.join(repo, 'packages/server/node_modules/tsx/dist/loader.mjs'),
    path.join(repo, 'packages/server/src/index.ts'), '--prod'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const data = chunk => { log += chunk; };
  child.stdout.on('data', data); child.stderr.on('data', data);
  address = await eventually(() => {
    if (child.exitCode !== null) throw new Error('Disposable server exited: ' + log.replace(/token=[\w-]+/g, 'token=REDACTED'));
    const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/);
    return match ? { origin: `http://127.0.0.1:${match[1]}`, token: match[2], url: match[0] } : null;
  }, 'isolated startup', 45_000);
  socket = new WebSocket(address.origin.replace('http:', 'ws:') + '/ws?token=' + address.token, { headers: { Origin: address.origin } });
  socket.on('message', raw => {
    const message = JSON.parse(String(raw)); traffic.push(message);
    if (pending.has(message.requestId)) {
      const task = pending.get(message.requestId); clearTimeout(task.timer); pending.delete(message.requestId);
      message.type === 'agency.error' ? task.reject(Object.assign(new Error(message.message), { code: message.code })) : task.resolve(message);
    }
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await request({ type: 'agency.notifications.list' });
  measurements.startupsMs.push(performance.now()-began);
}
function request(message) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Request timeout: ' + message.type)); }, 20_000);
    pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ ...message, requestId }));
  });
}
async function stop() {
  socket?.close();
  if (!child || child.exitCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([ended, delay(10_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]);
}
async function notifications() { return request({ type: 'agency.notifications.list' }); }
const snapshot = () => request({ type: 'agency.sessions.list' });
const webSnapshot = () => request({ type: 'agency.webTabs.list' });
const selectNative = session => request({ type: 'agency.tab.action', workspaceId: session.workspaceId, tabId: session.tab.id, action: 'select' });
const selectWeb = tab => request({ type: 'agency.webTab.select', workspaceId: tab.workspaceId, tabId: tab.id });
const command = (session, data) => socket.send(JSON.stringify({ type: 'input', terminalId: session.terminalId, data: data + '\r' }));

try {
  await start();
  assert.equal((await fetch(address.origin + '/')).status, 401);
  assert.equal((await fetch(address.url, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  check('isolated loopback MAW HTTP authentication');
  const [alpha, beta] = workspaces;
  const shellA = (await request({ type: 'agency.session.create', workspaceId: alpha.id, kind: 'terminal', cols: 100, rows: 30, launchId: randomUUID() })).session;
  const shellB = (await request({ type: 'agency.session.create', workspaceId: beta.id, kind: 'terminal', cols: 90, rows: 25, launchId: randomUUID() })).session;
  await eventually(async () => (await notifications()).activityStates.some(record => record.tabId === shellA.tab.id), 'shell activity attached');
  assert.equal((await notifications()).notifications.length, 0, 'initial shell prompt is not command completion');
  socket.send(JSON.stringify({ type: 'terminal.attach', terminalId: shellA.terminalId }));
  command(shellA, "sleep 1; printf 'WORKBENCH_BACKGROUND_COMMAND_OK\\n'");
  await eventually(async () => (await notifications()).activityStates.some(record => record.tabId === shellA.tab.id && record.state === 'working'), 'working shell');
  await selectNative(shellB);
  await eventually(async () => (await notifications()).activityStates.some(record => record.tabId === shellA.tab.id && record.state === 'idle'), 'shell returns to idle');
  assert.equal((await notifications()).notifications.length, 0, 'ordinary shell command produces zero inbox notifications');
  check('real Bash background completion returns to idle without notification spam');
  await selectNative(shellA);
  assert.equal((await notifications()).activityStates.find(record => record.tabId === shellA.tab.id).state, 'idle', 'selection retains idle state');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(id => { if (!localStorage.getItem('agency-ui.selected-workspace.v1')) localStorage.setItem('agency-ui.selected-workspace.v1', id); }, beta.id);
  const renderStart=performance.now();
  await page.goto(address.url);
  await page.locator('.agency-app').waitFor();
  measurements.renderMs=performance.now()-renderStart;
  await page.locator('.maw-bell-button').click();
  await page.locator('.maw-notification-inbox').waitFor();
  assert.equal(await page.locator('.maw-inbox-item').count(), 0);
  await page.keyboard.press('Escape');
  check('real notification inbox shows zero spam notifications for shell commands');

  await selectNative(shellB);
  command(shellA, 'false');
  await delay(1000);
  assert.equal((await notifications()).notifications.length, 0, 'failed shell command produces zero notifications');
  assert.equal(await page.locator('.maw-toast-item').count(), 0, 'failed shell command produces zero toasts');
  check('real failed shell command produces zero notification spam and zero toasts');

  const trafficStart=traffic.length;
  for(let i=0;i<40;i++){const began=performance.now();await selectNative(i%2?shellA:shellB);measurements.switchMs.push(performance.now()-began);}
  measurements.selectionEvents=traffic.slice(trafficStart).length;
  measurements.serverSmaps=await readFile('/proc/'+child.pid+'/smaps_rollup','utf8').then(text=>text.split('\n').filter(line=>/^(Rss|Pss):/.test(line))).catch(()=>[]);
  const webA = (await request({ type: 'agency.webTab.create', workspaceId: alpha.id, title: 'ChatGPT A', url: 'https://chatgpt.com/', launchId: randomUUID() })).tab;
  assert.equal(webA.runtimeState, 'client-managed');
  await selectWeb(webA);
  await page.evaluate(id => localStorage.setItem('agency-ui.selected-workspace.v1', id), alpha.id);
  await page.reload();
  await page.getByRole('link', { name: 'Open ChatGPT', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  check('logical ChatGPT tab uses external fallback in an ordinary browser');
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: path.join(out, 'integrated-workspace.png'), fullPage: true });
  await request({type:'agency.tab.rename',workspaceId:alpha.id,tabId:shellA.tab.id,name:'Audit shell'});
  assert.equal((await snapshot()).sessions.find(s=>s.id===shellA.id).terminalId,shellA.terminalId);
  await page.evaluate(id => localStorage.setItem('agency-ui.selected-workspace.v1', id), alpha.id);
  await page.reload();
  await page.getByRole('tab',{name:'Audit shell'}).waitFor();
  const notificationsBeforeRestart = (await notifications()).notifications;
  const targetBeforeRestart = webA?.targetRef;
  await page.close();
  await stop(); await start();
  const state = await notifications();
  assert.equal((await snapshot()).sessions.find(s=>s.tab?.id===shellA.tab.id && s.tab.current).tab.name,'Audit shell');
  check('stable native tab rename survives page refresh and MAW restart');
  assert.deepEqual(state.notifications.map(item => [item.id, item.read]).sort(), notificationsBeforeRestart.map(item => [item.id, item.read]).sort());
  if (webA) {
    const restored = (await selectWeb(webA)).tab;
    assert.equal(restored.targetRef, targetBeforeRestart);
    assert.equal(restored.runtimeState, 'client-managed');
  }
  check(webA ? 'MAW restart retains notification IDs/read state and stable logical browser tab' : 'MAW restart retains notification IDs and independent read state');
  assert.deepEqual(errors, []);
  await writeFile(path.join(out, 'results.json'), JSON.stringify({ results, measurements, pageErrors: errors,
    realChatGPTResponse: 'UNVERIFIED: disposable browser has no user authentication; no completion claim',
    evidence: out }, null, 2));
  console.log(`Evidence: ${out}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => undefined);
  await writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, pageErrors: errors, results }, null, 2));
  throw error;
} finally {
  for (const task of pending.values()) clearTimeout(task.timer);
  await browser?.close(); await stop();
  await writeFile(path.join(out, 'server-redacted.log'), log.replace(/token=[\w-]+/g, 'token=REDACTED'));
  if (!out.startsWith(root + path.sep)) await rm(root, { recursive: true, force: true });
}

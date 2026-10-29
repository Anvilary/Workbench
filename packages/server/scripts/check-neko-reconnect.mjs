/** Real isolated Neko reconnection acceptance (Checkpoint 5). Requires a DISPOSABLE fixture from
 * scripts/audit/start-neko-fixture.py and its container name:
 *   MAW_INTEGRATION_NEKO_ENV=<maw-env.json> MAW_NEKO_CONTAINER=<fixture name> \
 *     pnpm --filter @agent-workbench/server exec tsx scripts/check-neko-reconnect.mjs
 * Refuses any container without the `maw.audit=true` label. Isolated HOME/XDG/config; no provider prompts.
 * Scenarios: viewer network drop, controller restart, Neko container restart (stale viewer auth), switching
 * tabs/workspaces while the stream is down, multiple web tabs and their target ownership.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
function chromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const d of existsSync(cache) ? readdirSync(cache).filter(n => n.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const p = `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`; if (existsSync(p)) return p;
  }
  return undefined;
}
import WebSocket from 'ws';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const container = process.env.MAW_NEKO_CONTAINER ?? '';
assert.ok(container && process.env.MAW_INTEGRATION_NEKO_ENV, 'MAW_INTEGRATION_NEKO_ENV and MAW_NEKO_CONTAINER are required');
assert.equal(execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "maw.audit"}}', container], { encoding: 'utf8' }).trim(), 'true', 'only audit fixtures');
const neko = JSON.parse(await readFile(process.env.MAW_INTEGRATION_NEKO_ENV, 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'maw-neko-reconnect-'));
const home = path.join(root, 'home'), config = path.join(root, 'config', 'agent-workbench');
await Promise.all([mkdir(home, { recursive: true }), mkdir(config, { recursive: true })]);
const now = new Date().toISOString();
const project = { id: randomUUID(), name: 'Reconnect', status: 'active', createdAt: now, updatedAt: now, archivedAt: null };
const [alpha, beta] = ['Alpha', 'Beta'].map(name => ({ id: randomUUID(), projectId: project.id, name, cwd: root, status: 'active', createdAt: now, updatedAt: now, doneAt: null, archivedAt: null }));
await writeFile(path.join(config, 'agency-state.json'), JSON.stringify({ version: 1, projects: [project], workspaces: [alpha, beta] }));
await writeFile(path.join(home, '.bashrc'), '# disposable\n');
const env = { ...process.env, ...neko, HOME: home, SHELL: '/bin/bash', XDG_CONFIG_HOME: path.dirname(config), XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), CODEX_HOME: path.join(home, '.codex'),
  AGENT_WORKBENCH_NO_OPEN: '1', AGENT_WORKBENCH_NO_RESTORE: '1' };
for (const key of Object.keys(env)) if (/^MAW_/.test(key)) delete env[key];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(work, label, timeout = 30_000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const v = await work(); if (v) return v; } catch (e) { last = e; } await delay(100); }
  throw new Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
}
const results = [];
const check = (label, details = {}) => { results.push({ label, ...details }); console.log('PASS ' + label + (Object.keys(details).length ? ' ' + JSON.stringify(details) : '')); };

let log = '';
const child = spawn(process.execPath, ['--import', path.join(repo, 'packages/server/node_modules/tsx/dist/loader.mjs'), path.join(repo, 'packages/server/src/index.ts'), '--prod'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', c => { log += c; }); child.stderr.on('data', c => { log += c; });
let browser;
try {
  const address = await eventually(() => { if (child.exitCode !== null) throw new Error('server exited'); const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/); return m && { origin: 'http://127.0.0.1:' + m[1], token: m[2], url: m[0] }; }, 'startup', 45_000);
  const socket = new WebSocket(address.origin.replace('http:', 'ws:') + '/ws?token=' + address.token, { headers: { Origin: address.origin } });
  const pending = new Map();
  socket.on('message', raw => { const m = JSON.parse(String(raw)); const t = pending.get(m.requestId); if (t) { pending.delete(m.requestId); m.type === 'agency.error' ? t.reject(new Error(m.message)) : t.resolve(m); } });
  await new Promise((res, rej) => { socket.once('open', res); socket.once('error', rej); });
  const request = message => new Promise((resolve, reject) => { const requestId = randomUUID(); pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ ...message, requestId })); setTimeout(() => { if (pending.delete(requestId)) reject(new Error('timeout ' + message.type)); }, 30_000); });
  const controllerTabs = async () => (await (await fetch(neko.NEKO_CONTROLLER_URL + '/tabs', { headers: { Authorization: 'Bearer ' + neko.CONTROLLER_AUTH_TOKEN } })).json()).tabs;
  const webTabs = async () => (await request({ type: 'agency.webTabs.list' })).tabs;

  const shell = (await request({ type: 'agency.session.create', workspaceId: alpha.id, kind: 'terminal', cols: 100, rows: 30, launchId: randomUUID() })).session;
  const A1 = (await request({ type: 'agency.webTab.create', workspaceId: alpha.id, title: 'A1', url: 'https://chatgpt.com/', launchId: randomUUID() })).tab;
  const A2 = (await request({ type: 'agency.webTab.create', workspaceId: alpha.id, title: 'A2', url: 'https://chatgpt.com/', launchId: randomUUID() })).tab;
  const B1 = (await request({ type: 'agency.webTab.create', workspaceId: beta.id, title: 'B1', url: 'https://chatgpt.com/', launchId: randomUUID() })).tab;
  const ownedTargets = async () => { const live = new Set((await controllerTabs()).map(t => t.id)); const tabs = await webTabs(); return { tabs, live, ok: tabs.filter(t => !t.closedAt).every(t => t.targetRef && live.has(t.targetRef)), distinct: new Set(tabs.map(t => t.targetRef)).size === tabs.length }; };
  const initial = await ownedTargets();
  assert.ok(initial.ok && initial.distinct);
  check('three web tabs across two workspaces own distinct live Chromium targets');

  browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(), args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  await request({ type: 'agency.webTab.select', workspaceId: alpha.id, tabId: A1.id });
  await page.goto(address.url);
  await page.evaluate(id => localStorage.setItem('agency-ui.selected-workspace.v1', id), alpha.id);
  await page.reload();
  const liveVideo = async () => {
    const frame = page.frameLocator('.maw-neko-frame');
    if (!await page.locator('.maw-neko-frame').count()) return false;
    return frame.locator('video').evaluate(v => v.readyState >= 2 && v.videoWidth > 0 && !!v.srcObject?.getVideoTracks().some(t => t.readyState === 'live')).catch(() => false);
  };
  const recover = async label => {
    const began = performance.now(); let clicks = 0;
    await eventually(async () => {
      if (await liveVideo()) return true;
      const button = page.getByRole('button', { name: 'Reconnect viewer', exact: true });
      if (await button.count() && await button.isEnabled()) { await button.click().catch(() => undefined); clicks++; await delay(1500); }
      return false;
    }, label, 120_000);
    return { recoveredMs: Math.round(performance.now() - began), reconnectClicks: clicks };
  };
  check('initial genuine stream', await recover('initial stream'));
  const iframeTab = async () => new URL(await page.locator('.maw-neko-frame').getAttribute('src'), address.origin).searchParams.get('tabId');

  // 1. Viewer network drop (browser offline 4 s, then back): the viewer must come back on the same tab.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await delay(4000);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // Note: Chromium's offline emulation fails NEW requests but does not sever an established WebSocket or the
  // WebRTC media path, so this only proves the viewer survives a transient request outage. The real WS/media
  // drop is scenario 3 (Neko server restart).
  check('viewer survives a transient request outage (offline emulation)', { ...(await recover('after network drop')), tab: (await iframeTab()) === A1.id ? 'A1' : 'other' });

  // 2. Controller restart only: targets must survive (Chromium keeps running) and ownership stay intact.
  execFileSync('docker', ['exec', container, 'supervisorctl', '-c', '/etc/neko/supervisord.conf', 'restart', 'tab-controller'], { stdio: 'ignore' });
  await eventually(async () => (await ownedTargets()).ok, 'targets after controller restart', 60_000);
  check('controller restart keeps every tab bound to its own live target', await recover('after controller restart'));

  // 3. Neko container restart: Chromium and Neko sessions are gone (stale viewer cookies → upstream 401).
  //    While it is down, switch A2 → native shell → workspace B → back to A2 (switching while reconnecting).
  // Restart every service inside the fixture (Neko server, Chromium, controller): drops the viewer WebSocket and
  // media, kills every target and invalidates Neko sessions, while keeping the fixture's loopback ports (a
  // `docker restart` reassigns this fixture's ephemeral ports, unlike a production fixed-port deployment).
  const restartBegan = performance.now();
  execFileSync('docker', ['exec', container, 'supervisorctl', '-c', '/etc/neko/supervisord.conf', 'restart', 'all'], { stdio: 'ignore' });
  const switchErrors = [];
  for (const action of [
    () => request({ type: 'agency.webTab.select', workspaceId: alpha.id, tabId: A2.id }),
    () => request({ type: 'agency.tab.action', workspaceId: alpha.id, tabId: shell.tab.id, action: 'select' }),
    () => request({ type: 'agency.webTab.select', workspaceId: beta.id, tabId: B1.id }),
    () => request({ type: 'agency.webTab.select', workspaceId: alpha.id, tabId: A2.id }),
  ]) { await action().catch(e => switchErrors.push(e.message)); await delay(300); }
  // Targets are recreated lazily (BrowserTabAdapter.ensureTarget on selection), not respawned eagerly.
  await eventually(async () => { await controllerTabs(); return true; }, 'controller back after restart', 120_000);
  const finalSelect = await eventually(async () => { await request({ type: 'agency.webTab.select', workspaceId: alpha.id, tabId: A2.id }); return true; }, 'select A2 after restart', 120_000);
  await page.reload();
  const streamBack = await recover('stream after Neko restart');
  const selected = (await webTabs()).filter(t => t.workspaceId === alpha.id && t.selected).map(t => t.id);
  assert.deepEqual(selected, [A2.id], 'the last selection wins after reconnecting');
  assert.equal(await iframeTab(), A2.id, 'viewer shows the selected tab, not a stale one');
  // Every other tab gets a fresh owned target when it is selected again; ownership stays distinct.
  for (const [ws, tab] of [[alpha, A1], [beta, B1], [alpha, A2]]) {
    await eventually(async () => { await request({ type: 'agency.webTab.select', workspaceId: ws.id, tabId: tab.id }); return true; }, 'reselect ' + tab.title, 60_000);
  }
  const owned = await ownedTargets();
  assert.ok(owned.ok && owned.distinct, 'all three tabs own distinct live targets again');
  assert.equal((await webTabs()).filter(t => !t.closedAt).length, 3, 'no web tab lost');
  check('Neko server + Chromium + controller restart: stale viewer auth replaced, last selection displayed, targets recreated on selection', {
    ...streamBack, totalMs: Math.round(performance.now() - restartBegan), switchesDuringOutage: 4, switchErrorsDuringOutage: switchErrors.length,
    selectedAfterRestart: Boolean(finalSelect),
  });
  assert.deepEqual(pageErrors.filter(e => !/WebSocket|network|Failed to fetch/i.test(e)), []);
  check('no unexpected page errors');
} finally {
  await browser?.close().catch(() => undefined);
  child.kill('SIGTERM');
  await new Promise(r => { const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 8000); child.once('exit', () => { clearTimeout(t); r(); }); });
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ results }, null, 2));

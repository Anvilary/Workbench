/** Bounded real server/PTY/Chromium audit. No production state or providers. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(repo, 'packages/server/package.json'));
const WebSocket = require('ws');
const root = await mkdtemp(path.join(tmpdir(), 'maw-round2-soak-'));
const out = path.resolve(process.env.WORKBENCH_ROUND2_OUT || path.join(root, 'evidence'));
const duration = Number(process.env.WORKBENCH_ROUND2_SECONDS || 60);
assert.ok(Number.isFinite(duration) && duration >= 0 && duration <= 3600);
const home = path.join(root, 'home'), config = path.join(root, 'config/workbench'), runtime = path.join(root, 'runtime');
await Promise.all([mkdir(home), mkdir(config, { recursive: true }), mkdir(out, { recursive: true }), mkdir(runtime, { recursive: true, mode: 0o700 })]);
const now = new Date().toISOString();
const projects = ['One', 'Two'].map(name => ({ id: randomUUID(), name, status: 'active', createdAt: now, updatedAt: now, archivedAt: null }));
const workspaces = Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(), projectId: projects[i % 2].id, name: 'Workspace ' + i, cwd: root, status: 'active', createdAt: now, updatedAt: now, doneAt: null, archivedAt: null }));
await writeFile(path.join(config, 'agency-state.json'), JSON.stringify({ version: 1, projects, workspaces }), { mode: 0o600 });
await writeFile(path.join(home, '.bashrc'), '# isolated shell\n');
const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) {
  if (/^(WORKBENCH_|MAW_|AGENT_WORKBENCH_|ELECTRON_RUN_AS_NODE$)/.test(key)) delete baseEnv[key];
}
const env = {
  ...baseEnv,
  HOME: home,
  USERPROFILE: home,
  SHELL: '/bin/bash',
  XDG_CONFIG_HOME: path.dirname(config),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_STATE_HOME: path.join(root, 'state'),
  XDG_RUNTIME_DIR: runtime,
  CODEX_HOME: path.join(home, '.codex'),
  APPDATA: path.join(root, 'appdata'),
  PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
  PI_CODING_AGENT_SESSION_DIR: path.join(home, '.pi/sessions'),
  WORKBENCH_NO_OPEN: '1',
  WORKBENCH_NO_RESTORE: '1',
  WORKBENCH_DISABLE_PTYD: '1',
  WORKBENCH_PERSISTENT_PTY: '0',
  WORKBENCH_AUTO_SPAWN_PTYD: '0',
  WORKBENCH_PTYD_SOCKET: path.join(runtime, 'ptyd.sock'),
  WORKBENCH_PTYD_AUTH_FILE: path.join(runtime, 'ptyd.sock.auth'),
};
let child, socket, browser, address, log = '', messages = 0, bytes = 0, reconnects = 0;
const pending = new Map(), samples = [], errors = [];
let cdp;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(work, label, timeout = 15000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await work(); if (value) return value; await delay(25); } throw Error('Timeout: ' + label); }
async function connect() {
  socket = new WebSocket(address.origin.replace('http:', 'ws:') + '/ws?token=' + address.token, { headers: { Origin: address.origin } });
  socket.on('message', raw => { messages++; bytes += raw.length; const m = JSON.parse(String(raw)); const task = pending.get(m.requestId); if (task) { clearTimeout(task.timer); pending.delete(m.requestId); m.type === 'agency.error' ? task.reject(Error(m.message)) : task.resolve(m); } });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await request({ type: 'agency.sessions.list' });
}
function request(message) { return new Promise((resolve, reject) => { const requestId = randomUUID(); const timer = setTimeout(() => { pending.delete(requestId); reject(Error('Request timeout: ' + message.type)); }, 10000); pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ ...message, requestId })); }); }
async function disconnect() { if (socket?.readyState === WebSocket.OPEN) { const closed = new Promise(resolve => socket.once('close', resolve)); socket.close(); await closed; } }
async function start() {
  log = ''; const began = performance.now();
  child = spawn(process.execPath, ['--import', path.join(repo, 'packages/server/node_modules/tsx/dist/loader.mjs'), path.join(repo, 'packages/server/src/index.ts'), '--prod'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const data = chunk => { log = (log + chunk).slice(-1024 * 1024); }; child.stdout.on('data', data); child.stderr.on('data', data);
  address = await until(() => { if (child.exitCode !== null) throw Error('Disposable server exited'); const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/); return m && { origin: 'http://127.0.0.1:' + m[1], url: m[0], token: m[2] }; }, 'startup');
  await connect(); return performance.now() - began;
}
async function stop() {
  await disconnect();
  if (!child || child.exitCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
  await ended; clearTimeout(timer);
}
async function sample(phase) {
  const text = await readFile('/proc/' + child.pid + '/smaps_rollup', 'utf8');
  const stat = (await readFile('/proc/' + child.pid + '/stat', 'utf8')).split(')').at(-1).trim().split(/\s+/);
  const children = await readFile('/proc/' + child.pid + '/task/' + child.pid + '/children', 'utf8');
  const rows = (await request({ type: 'agency.sessions.list' })).sessions;
  const row = { activePtys: rows.filter(s => s.terminalId && ['starting','running','stopping'].includes(s.lifecycle)).length, knownClients: 1 + (browser ? 1 : 0), phase, at: performance.now(), rssKiB: Number(text.match(/^Rss:\s+(\d+)/m)[1]), pssKiB: Number(text.match(/^Pss:\s+(\d+)/m)[1]), fds: (await readdir('/proc/' + child.pid + '/fd')).length, cpuTicks: Number(stat[11]) + Number(stat[12]), childProcesses: children.trim().split(/\s+/).filter(Boolean).length, sessions: (await request({ type: 'agency.sessions.list' })).sessions.length };
  if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) Object.assign(row, await page.evaluate(() => ({ domNodes: document.querySelectorAll('*').length, heapBytes: performance.memory?.usedJSHeapSize }))); }
  if (cdp) Object.assign(row, await cdp.send('Memory.getDOMCounters'));
  samples.push(row); await writeFile(path.join(out, 'progress.json'), JSON.stringify({ samples, reconnects, messages, bytes }, null, 2)); return row;
}
const summarize = values => { const sorted = [...values].sort((a,b) => a-b); return { n: values.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], p99: sorted[Math.floor(sorted.length * .99)] }; };
const results = { fixture: 'real server, disposable Bash PTYs, production UI; shared host; double-rAF paint opportunity, not hardware paint', node: process.version, durationSeconds: duration, samples, errors };
try {
  results.startupMs = await start();
  const idleStart = await sample('idle-start');
  await delay(3000);
  const idleEnd = await sample('idle-end');
  results.idle = {
    durationMs: idleEnd.at - idleStart.at,
    cpuTicks: idleEnd.cpuTicks - idleStart.cpuTicks,
    rssKiB: idleEnd.rssKiB,
    pssKiB: idleEnd.pssKiB,
  };
  const sessions = [];
  for (let i = 0; i < 15; i++) sessions.push((await request({ type: 'agency.session.create', workspaceId: workspaces[i % 4].id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID() })).session);
  const select = s => request({ type: 'agency.tab.action', workspaceId: s.workspaceId, tabId: s.tab.id, action: 'select' });
  await delay(500); await sample('warm');
  for (const mode of ['repeat', 'alternate']) {
    await select(sessions[0]); await delay(100); const before = { messages, bytes }; const times = [];
    for (let i = 0; i < 100; i++) { const began = performance.now(); await select(sessions[mode === 'repeat' ? 0 : (i % 2) * 4]); times.push(performance.now() - began); }
    results[mode] = { wsResponseMs: summarize(times), messages: messages - before.messages, bytes: bytes - before.bytes };
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage(); cdp = await context.newCDPSession(page); page.on('pageerror', e => errors.push(e.message));
  const activeWorkspace = page.locator('.agency-workspace-slot:not([hidden])');
  const activeTerminal = activeWorkspace.locator('.maw-session-pane:not([hidden])');
  await page.addInitScript(id => { localStorage.setItem('agency-ui.selected-workspace.v1', id); window.auditLongTasks = []; window.auditShifts = []; new PerformanceObserver(list => window.auditLongTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask', buffered: true }); new PerformanceObserver(list => window.auditShifts.push(...list.getEntries().filter(e => !e.hadRecentInput).map(e => e.value))).observe({ type: 'layout-shift', buffered: true }); }, workspaces[0].id);
  await page.goto(address.url); await activeTerminal.locator('.xterm-screen').waitFor();
  const switchTimes = await page.evaluate(async ids => {
    const times = [];
    for (let i = 0; i < 100; i++) {
      const tab = document.getElementById('tab-' + ids[i % 2]); const start = performance.now(); tab.click();
      while (document.getElementById(tab.id)?.getAttribute('aria-selected') !== 'true') { if (performance.now() - start > 5000) throw Error('Tab selection timeout: ' + tab.id); await new Promise(requestAnimationFrame); }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      times.push(performance.now() - start);
    }
    return times;
  }, [sessions[0].tab.id, sessions[4].tab.id]);
  results.visibleTabSwitchMs = summarize(switchTimes);
  const settingsTimes = [];
  for (let i = 0; i < 12; i++) {
    const began = performance.now();
    await page.locator('.maw-menu-button').click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor();
    settingsTimes.push(performance.now() - began);
    await page.keyboard.press('Escape');
  }
  results.settingsOpenMs = summarize(settingsTimes);
  const workspaceTimes = [];
  for (let i = 0; i < 12; i++) {
    const workspace = workspaces[1 - i % 2];
    const began = performance.now();
    const control = page.locator(`[data-sidebar-workspace-id="${workspace.id}"] .agency-workspace-nav-button`);
    await control.click();
    await page.waitForFunction(id => document.querySelector(`[data-sidebar-workspace-id="${id}"] button[aria-current="page"]`), workspace.id);
    await activeTerminal.locator('.xterm-screen').waitFor();
    workspaceTimes.push(performance.now() - began);
  }
  results.workspaceSwitchMs = summarize(workspaceTimes);
  for (const [width,height] of [[390,844],[768,1024],[1280,720],[1366,768],[1920,1080],[2560,1440]]) {
    await page.setViewportSize({width,height});
    const tab = activeWorkspace.getByRole('tab', { selected: true }); await tab.press('F2');
    const input = page.getByLabel('Tab title',{exact:true}); await input.fill('Shell ' + width); await input.press('Enter'); await page.getByRole('tab',{name:'Shell ' + width}).waitFor();
    await page.locator('.maw-menu-button').click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({path:path.join(out, 'controls-' + width + 'x' + height + '.png')}); await page.keyboard.press('Escape');
    await activeTerminal.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('printf "ROUND2_INPUT_OK\\n"'); await page.keyboard.press('Enter');
  }
  results.interactionUi = await page.evaluate(() => ({ longTasksMs: window.auditLongTasks, layoutShift: window.auditShifts.reduce((a,b)=>a+b,0) }));
  await sample('ui-warm');
  const deadline = Date.now() + duration * 1000; let cycle = 0;
  while (Date.now() < deadline) {
    for (let i = 0; i < 20; i++) await select(sessions[(cycle + i) % sessions.length]);
    await disconnect(); await connect(); reconnects++;
    const s = (await request({ type: 'agency.session.create', workspaceId: workspaces[0].id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID() })).session;
    socket.send(JSON.stringify({ type: 'terminal.attach', terminalId: s.terminalId, cols: 80, rows: 24 }));
    socket.send(JSON.stringify({ type: 'input', terminalId: s.terminalId, data: 'printf "SOAK_OUTPUT\\n"\r' }));
    await request({ type: 'agency.tab.action', workspaceId: s.workspaceId, tabId: s.tab.id, action: 'close' });
    if (cycle % 10 === 0) { await page.reload(); await page.locator('.agency-app').waitFor(); await sample('workload-' + cycle); console.log('cycle', cycle); }
    cycle++; await delay(500);
  }
  results.cycles = cycle; results.reconnects = reconnects;
  results.ui = await page.evaluate(() => ({ longTasksMs: window.auditLongTasks, layoutShift: window.auditShifts.reduce((a,b)=>a+b,0) }));
  const reloads = Number(process.env.WORKBENCH_ROUND2_RELOADS || 0);
  assert.ok(Number.isInteger(reloads) && reloads >= 0 && reloads <= 100);
  if (reloads) {
    for (let i = 0; i < reloads; i++) { await page.reload(); await page.locator('.agency-app').waitFor(); }
    results.reloadDiagnostic = { reloads, beforeGC: await cdp.send('Memory.getDOMCounters') };
    // Diagnostic only: never force GC in interaction latency measurements.
    await cdp.send('HeapProfiler.collectGarbage');
    results.reloadDiagnostic.afterGC = await cdp.send('Memory.getDOMCounters');
  }
  await context.tracing.stop({path:path.join(out, 'interaction-trace.zip')});
  await browser.close(); browser = null; cdp = null;
  for (const s of sessions) await request({ type: 'agency.tab.action', workspaceId: s.workspaceId, tabId: s.tab.id, action: 'close' });
  await delay(2000); await sample('cleanup'); await delay(3000); await sample('settled');
  await stop(); results.restartMs = await start(); await sample('recovery');
  assert.deepEqual(errors, []);
} catch (error) {
  results.failure = error.message;
  await browser?.contexts()[0]?.pages()[0]?.screenshot({path:path.join(out, 'failure.png')}).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await stop();
  for (const task of pending.values()) clearTimeout(task.timer);
  await writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  await writeFile(path.join(out, 'server-redacted.log'), log.replace(/token=[\w-]+/g, 'token=REDACTED'));
  if (!out.startsWith(root + path.sep)) await rm(root, { recursive: true, force: true });
  console.log('Evidence:', out);
}

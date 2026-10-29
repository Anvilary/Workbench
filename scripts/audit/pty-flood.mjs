/**
 * Checkpoint 5 — high-volume terminal output against a REAL disposable MAW server and REAL bash PTYs.
 * Isolated HOME/XDG/config; no providers, no production state. Measures:
 *  - integrity: `seq 1 N` lines arrive complete and in order (no loss / reorder / duplication)
 *  - throughput and server CPU / RSS during the flood
 *  - input latency during the flood: time from sending a marker keystroke to its tty echo reaching the client
 *  - background-tab isolation: a second terminal flooding concurrently does not corrupt the first
 *  - slow consumer: the client stops reading for a few seconds; server memory stays bounded, stream resumes
 * Usage: node scripts/audit/pty-flood.mjs [lines=1000000]
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(repo, 'packages/server/package.json'));
const WebSocket = require('ws');
const N = Number(process.argv[2] || 1_000_000);
const root = await mkdtemp(path.join(tmpdir(), 'maw-pty-flood-'));
const home = path.join(root, 'home'), config = path.join(root, 'config/agent-workbench');
await Promise.all([mkdir(home), mkdir(config, { recursive: true })]);
const now = new Date().toISOString();
const project = { id: randomUUID(), name: 'Flood', status: 'active', createdAt: now, updatedAt: now, archivedAt: null };
const workspace = { id: randomUUID(), projectId: project.id, name: 'Flood', cwd: root, status: 'active', createdAt: now, updatedAt: now, doneAt: null, archivedAt: null };
await writeFile(path.join(config, 'agency-state.json'), JSON.stringify({ version: 1, projects: [project], workspaces: [workspace] }), { mode: 0o600 });
await writeFile(path.join(home, '.bashrc'), 'PS1="$ "\n');
const env = { ...process.env, HOME: home, SHELL: '/bin/bash', XDG_CONFIG_HOME: path.dirname(config), XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), CODEX_HOME: path.join(home, '.codex'),
  AGENT_WORKBENCH_NO_OPEN: '1', AGENT_WORKBENCH_NO_RESTORE: '1' };
for (const key of Object.keys(env)) if (/^(NEKO_|CONTROLLER_|AGENT_WORKBENCH_PORT|MAW_)/.test(key)) delete env[key];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(work, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const v = await work(); if (v) return v; await delay(20); } throw Error('Timeout: ' + label); }

let log = '';
const child = spawn(process.execPath, ['--import', path.join(repo, 'packages/server/node_modules/tsx/dist/loader.mjs'), path.join(repo, 'packages/server/src/index.ts'), '--prod'],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', c => { log = (log + c).slice(-65536); }); child.stderr.on('data', c => { log = (log + c).slice(-65536); });
const results = {};
try {
  const address = await until(() => { if (child.exitCode !== null) throw Error('server exited: ' + log); const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/); return m && { origin: 'http://127.0.0.1:' + m[1], token: m[2] }; }, 'startup');
  const socket = new WebSocket(address.origin.replace('http:', 'ws:') + '/ws?token=' + address.token, { headers: { Origin: address.origin } });
  const pending = new Map(); const outputs = new Map(); const arrivals = []; const replays = new Map();
  socket.on('message', raw => {
    const m = JSON.parse(String(raw));
    if (m.type === 'terminal.output' || m.type === 'terminal.replay') {
      const now = performance.now();
      // Like TerminalView: a replay is the complete state the server knows, it replaces what was shown.
      if (m.type === 'terminal.replay') { replays.set(m.terminalId, (replays.get(m.terminalId) ?? 0) + 1); outputs.set(m.terminalId, ''); }
      outputs.set(m.terminalId, (outputs.get(m.terminalId) ?? '') + m.data);
      arrivals.push({ id: m.terminalId, at: now, len: m.data.length, data: m.data.includes('ZQ') ? m.data : '' });
    }
    const task = pending.get(m.requestId); if (task) { pending.delete(m.requestId); m.type === 'agency.error' ? task.reject(Error(m.message)) : task.resolve(m); }
  });
  await new Promise((res, rej) => { socket.once('open', res); socket.once('error', rej); });
  const request = msg => new Promise((resolve, reject) => { const requestId = randomUUID(); pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ ...msg, requestId })); });
  const create = async () => (await request({ type: 'agency.session.create', workspaceId: workspace.id, kind: 'terminal', cols: 120, rows: 40, launchId: randomUUID() })).session;
  const fg = await create(), bg = await create();
  for (const s of [fg, bg]) socket.send(JSON.stringify({ type: 'terminal.attach', terminalId: s.terminalId, cols: 120, rows: 40 }));
  await until(() => (outputs.get(fg.terminalId) ?? '').length > 0 && (outputs.get(bg.terminalId) ?? '').length > 0, 'prompts', 15000)
    .catch(error => { console.error(JSON.stringify({ fg: fg.terminalId, out: [...outputs.entries()].map(([k, v]) => [k, v.slice(0, 200)]) })); throw error; });
  await delay(500);
  const input = (s, data) => socket.send(JSON.stringify({ type: 'input', terminalId: s.terminalId, data }));
  const serverStat = async () => { const stat = (await readFile(`/proc/${child.pid}/stat`, 'utf8')).split(') ')[1].split(' '); const status = await readFile(`/proc/${child.pid}/status`, 'utf8'); return { cpu: (Number(stat[11]) + Number(stat[12])) / 100, rssMB: Number(status.match(/VmRSS:\s+(\d+)/)[1]) / 1024 }; };

  // 1) Flood both terminals concurrently; probe input latency on the foreground one during the flood.
  outputs.set(fg.terminalId, ''); outputs.set(bg.terminalId, '');
  const s0 = await serverStat(); const t0 = performance.now();
  input(bg, `seq 1 ${N}; echo BG-$((40+2))-DONE\r`);
  input(fg, `seq 1 ${N}; echo FG-$((40+2))-DONE\r`);
  const latencies = []; let rssPeak = s0.rssMB;
  for (let k = 0; k < 20; k++) {
    await delay(150);
    const marker = 'ZQ' + k + 'X';
    const sent = performance.now();
    input(fg, marker);   // tty echo (canonical mode) returns it while seq is still printing
    await until(() => (outputs.get(fg.terminalId) ?? '').includes(marker), 'echo ' + marker, 20000).catch(() => null);
    const seen = arrivals.find(a => a.id === fg.terminalId && a.at >= sent && a.data.includes(marker));
    if (seen) latencies.push(seen.at - sent);
    rssPeak = Math.max(rssPeak, (await serverStat()).rssMB);
    if ((outputs.get(fg.terminalId) ?? '').includes('FG-42-DONE')) break;
  }
  await until(() => (outputs.get(fg.terminalId) ?? '').includes('FG-42-DONE') && (outputs.get(bg.terminalId) ?? '').includes('BG-42-DONE'), 'flood done', 600000);
  const t1 = performance.now(); const s1 = await serverStat();
  const check = (text, extraMarkers, dropFirst = false) => {
    // eslint-disable-next-line no-control-regex
    let clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
    for (const m of extraMarkers) clean = clean.split(m).join('');
    let nums = clean.split(/\r?\n/).map(l => l.trim()).filter(l => /^\d+$/.test(l)).map(Number);
    // After a truncated replay the first line can be the cut tail of a number; it is not data loss.
    if (dropFirst && nums.length > 1 && nums[1] !== nums[0] + 1) nums = nums.slice(1);
    const start = nums[0] ?? 1;
    let firstBad = -1; for (let i = 0; i < nums.length; i++) if (nums[i] !== start + i) { firstBad = i; break; }
    return { lines: nums.length, first: start, last: nums.at(-1) ?? null, ordered: firstBad === -1, firstBad: firstBad === -1 ? null : { index: firstBad, value: nums[firstBad] } };
  };
  const markers = Array.from({ length: 20 }, (_, k) => 'ZQ' + k + 'X');
  if (process.env.FLOOD_DEBUG) console.error(JSON.stringify((outputs.get(fg.terminalId) ?? '').slice(0, 400)));
  const fgCheck = check(outputs.get(fg.terminalId), markers), bgCheck = check(outputs.get(bg.terminalId), []);
  if (fgCheck.firstBad) {
    const text = outputs.get(fg.terminalId); const needle = '\n' + (fgCheck.firstBad.value - 2) + '\r';
    const at = text.indexOf(needle); fgCheck.context = JSON.stringify(text.slice(Math.max(0, at - 20), at + 120));
  }
  const bytes = (outputs.get(fg.terminalId)?.length ?? 0) + (outputs.get(bg.terminalId)?.length ?? 0);
  latencies.sort((a, b) => a - b);
  results.flood = { linesPerTerminal: N, bytes, seconds: +((t1 - t0) / 1000).toFixed(2), MBps: +(bytes / 1048576 / ((t1 - t0) / 1000)).toFixed(2),
    serverCpuSeconds: +(s1.cpu - s0.cpu).toFixed(2), rssBeforeMB: +s0.rssMB.toFixed(1), rssPeakMB: +rssPeak.toFixed(1), rssAfterMB: +s1.rssMB.toFixed(1),
    foreground: fgCheck, background: bgCheck,
    echoLatencyMs: latencies.length ? { samples: latencies.length, p50: +latencies[Math.floor(latencies.length * 0.5)].toFixed(1), p95: +latencies[Math.floor((latencies.length - 1) * 0.95)].toFixed(1), max: +latencies.at(-1).toFixed(1) } : null };

  // 2) Slow consumer: stop reading the socket while the PTY floods; memory must stay bounded; stream resumes.
  // The marker keystrokes typed during phase 1 are still in bash's line buffer: kill the line first.
  input(fg, '\x15'); await delay(300);
  outputs.set(fg.terminalId, '');
  const s2 = await serverStat();
  const SLOW_LINES = Number(process.env.SLOW_LINES || N), PAUSE = Number(process.env.PAUSE_SECONDS || 5);
  replays.set(fg.terminalId, 0);
  input(fg, `seq 1 ${SLOW_LINES}; echo SLOW-$((40+2))-DONE\r`);
  socket._socket.pause();
  let slowPeak = s2.rssMB; const rssTrace = [];
  for (let k = 0; k < PAUSE * 2; k++) { await delay(500); const r = (await serverStat()).rssMB; rssTrace.push(+r.toFixed(0)); slowPeak = Math.max(slowPeak, r); }
  socket._socket.resume();
  await until(() => (outputs.get(fg.terminalId) ?? '').includes('SLOW-42-DONE'), 'slow consumer done', 600000);
  const slowCheck = check(outputs.get(fg.terminalId), [], (replays.get(fg.terminalId) ?? 0) > 0);
  slowCheck.replays = (replays.get(fg.terminalId) ?? 0);
  slowCheck.completeTail = slowCheck.last === SLOW_LINES;
  results.slowConsumer = { pausedSeconds: PAUSE, slowLines: SLOW_LINES, rssTraceMB: rssTrace, rssBeforeMB: +s2.rssMB.toFixed(1), rssPeakWhilePausedMB: +slowPeak.toFixed(1), rssAfterMB: +(await serverStat()).rssMB.toFixed(1), ...slowCheck };
  socket.close();
} finally {
  child.kill('SIGTERM');
  await new Promise(r => { const timer = setTimeout(() => { child.kill('SIGKILL'); r(); }, 5000); child.once('exit', () => { clearTimeout(timer); r(); }); });
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));

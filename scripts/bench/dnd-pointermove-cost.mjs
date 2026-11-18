// Tab-drag cost on the real built UI + disposable server (shell tabs only; no CLI launched, no network).
// Prereq: `pnpm --filter @agent-workbench/web build` (packages/web/dist).
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright';

const WebSocket = createRequire(new URL('../../packages/server/package.json', import.meta.url))('ws');

function chromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = homedir() + '/.cache/ms-playwright';
  for (const f of existsSync(cache) ? readdirSync(cache).filter(n => n.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const p = cache + '/' + f + '/chrome-headless-shell-linux64/chrome-headless-shell'; if (existsSync(p)) return p;
  }
  return undefined;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const out = path.resolve(process.argv[2]);
const TABS = Number(process.argv[3] ?? 6), MOVES = Number(process.argv[4] ?? 120), REPS = Number(process.argv[5] ?? 3);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const root = await mkdtemp(path.join(tmpdir(), 'maw-dnd-'));
const home = path.join(root, 'home'); await mkdir(home, { recursive: true });
for (const f of ['.zshrc', '.zshenv', '.bashrc']) await writeFile(path.join(home, f), '# bench\n');
const env = { ...process.env, AGENT_WORKBENCH_NO_OPEN: '1', AGENT_WORKBENCH_NO_RESTORE: '1', HOME: home, USERPROFILE: home, APPDATA: path.join(root, 'appdata'), XDG_CONFIG_HOME: path.join(root, 'xdg'),
  XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'), CODEX_HOME: path.join(home, '.codex'),
  PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), PI_CODING_AGENT_SESSION_DIR: path.join(home, '.pi/sessions') };
delete env.MAW_UNSAFE_LOCAL_NO_AUTH;
const child = spawn(process.execPath, ['--import', path.join(repo, 'packages/server/node_modules/tsx/dist/loader.mjs'), path.join(repo, 'packages/server/src/index.ts'), '--prod'], { cwd: path.join(repo, 'packages/server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
const ready = await new Promise(resolve => { const on = c => { log += c; const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/); if (m) resolve({ port: +m[1], token: m[2], url: m[0] }); }; child.stdout.on('data', on); child.stderr.on('data', on); child.on('exit', () => resolve({ error: log.slice(-600) })); setTimeout(() => resolve({ error: 'timeout ' + log.slice(-600) }), 60000); });
if (ready.error) { console.error(ready.error); process.exit(1); }
const base = `http://127.0.0.1:${ready.port}`;
const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws?token=${ready.token}`, { headers: { Origin: base } });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
const waiters = []; ws.on('message', raw => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].f(m)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.t); w.r(m); } });
const send = m => ws.send(JSON.stringify(m)); const waitFor = (f, ms = 20000) => new Promise((r, j) => { const t = setTimeout(() => j(new Error('timeout')), ms); waiters.push({ f, r, t }); });
send({ type: 'agency.project.create', requestId: 'p', name: 'Bench' }); const proj = (await waitFor(m => m.type === 'agency.project.created')).project;
send({ type: 'picker.open' }); const pk = (await waitFor(m => m.type === 'picker.listing')).listing.pickerId;
send({ type: 'picker.create', pickerId: pk, name: 'dnd-ws' }); await waitFor(m => m.type === 'picker.listing' && m.listing.pickerId === pk);
send({ type: 'agency.workspace.create', requestId: 'w', projectId: proj.id, name: 'DnD Workspace', pickerId: pk }); const wsp = (await waitFor(m => m.type === 'agency.workspace.created')).workspace;
for (let i = 0; i < TABS; i++) { send({ type: 'agency.session.create', requestId: 's' + i, workspaceId: wsp.id, kind: 'terminal', cols: 100, rows: 30 }); await waitFor(m => m.type === 'agency.session.created' && m.requestId === 's' + i); }

const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
const results = [];
try {
  for (let rep = 0; rep < REPS; rep++) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(ready.url);
    await page.locator('.agency-app').waitFor({ state: 'visible', timeout: 20000 });
    if (!(await page.locator('.maw-session-tab').first().isVisible().catch(() => false))) {
      await page.getByText('DnD Workspace', { exact: false }).first().click({ timeout: 10000 }).catch(() => {});
    }
    await page.waitForFunction(n => document.querySelectorAll('.maw-session-tab').length >= n, TABS, { timeout: 20000 });
    await sleep(1500);
    const cdp = await ctx.newCDPSession(page); await cdp.send('Performance.enable');
    await page.evaluate(() => {
      window.__m = { gbcr: 0, efp: 0, moves: 0, frames: [], long: [] };
      const g = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function () { window.__m.gbcr++; return g.call(this); };
      const e = document.elementFromPoint.bind(document); document.elementFromPoint = (x, y) => { window.__m.efp++; return e(x, y); };
      window.addEventListener('pointermove', () => { window.__m.moves++; }, true);
      let last = performance.now(); const tick = t => { window.__m.frames.push(t - last); last = t; window.__m.run && requestAnimationFrame(tick); }; window.__m.run = true; requestAnimationFrame(tick);
      new PerformanceObserver(l => { for (const x of l.getEntries()) window.__m.long.push(x.duration); }).observe({ entryTypes: ['longtask'] });
    });
    const boxes = await page.locator('.maw-session-tab').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
    const a = boxes[1], b = boxes[Math.min(boxes.length - 1, 4)];
    const sx = a.x + a.w / 2, sy = a.y + a.h / 2, ex = b.x + b.w / 2 + 10;
    const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    await page.evaluate(() => { window.__m.gbcr = 0; window.__m.efp = 0; window.__m.moves = 0; window.__m.frames = []; window.__m.long = []; });
    await page.mouse.move(sx, sy); await page.mouse.down();
    const t0 = Date.now();
    for (let i = 1; i <= MOVES; i++) { await page.mouse.move(sx + (ex - sx) * i / MOVES, sy + Math.sin(i / 9) * 3); await sleep(8); }
    const dragMs = Date.now() - t0;
    await page.mouse.up(); await sleep(300);
    const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const m = await page.evaluate(() => { window.__m.run = false; return { gbcr: window.__m.gbcr, efp: window.__m.efp, moves: window.__m.moves, frames: window.__m.frames, long: window.__m.long }; });
    const d = k => +((after[k] - before[k]) * 1000).toFixed(1);
    const fr = m.frames.slice(1).sort((x, y) => x - y); const q = p => fr.length ? +fr[Math.min(fr.length - 1, Math.floor(p * fr.length))].toFixed(1) : 0;
    results.push({ rep, tabs: boxes.length, moves: m.moves, dragMs, scriptMs: d('ScriptDuration'), layoutMs: d('LayoutDuration'), recalcStyleMs: d('RecalcStyleDuration'), layoutCount: after.LayoutCount - before.LayoutCount, recalcStyleCount: after.RecalcStyleCount - before.RecalcStyleCount,
      getBoundingClientRectPerMove: +(m.gbcr / Math.max(1, m.moves)).toFixed(1), elementFromPointPerMove: +(m.efp / Math.max(1, m.moves)).toFixed(2), frames: fr.length, frameMsP50: q(0.5), frameMsP95: q(0.95), frameMsMax: fr.length ? +fr[fr.length - 1].toFixed(1) : 0,
      framesOver25ms: fr.filter(x => x > 25).length, longTasks: m.long.length, longTaskMaxMs: m.long.length ? +Math.max(...m.long).toFixed(1) : 0 });
    console.log(JSON.stringify(results.at(-1)));
    await ctx.close();
  }
} finally { await browser.close(); ws.close(); child.kill('SIGTERM'); await sleep(800); await writeFile(out, JSON.stringify(results, null, 1)); await rm(root, { recursive: true, force: true }); }
process.exit(0);

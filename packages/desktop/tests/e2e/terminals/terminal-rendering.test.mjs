// Real MAW server, real bash/node/Codex PTYs, real Electron and production UI
// components. All state and credentials live in a disposable HOME/XDG tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT, REPO_ROOT } from '../../helpers/paths.mjs';

const here = DESKTOP_ROOT;
const repo = process.env.MAW_RENDERING_REPO || REPO_ROOT;
const evidence = path.resolve(process.env.MAW_RENDERING_EVIDENCE || path.join(repo, 'docs/maw/terminal-rendering/evidence'));
const baseline = process.env.MAW_RENDERING_BASELINE === '1';
const require = createRequire(import.meta.url);
const electronExecutable = process.env.MAW_ELECTRON_EXECUTABLE || (existsSync('/opt/maw-electron/45.2.0/electron') ? '/opt/maw-electron/45.2.0/electron' : require('electron'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(30); }
  throw Error('Timed out: ' + label);
}

test('terminal rendering, recovery, scrollbars and isolated Codex soak in Electron', { timeout: 240000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-rendering-electron-'));
  const home = path.join(root, 'home'), config = path.join(root, 'config/agent-workbench');
  await Promise.all([mkdir(path.join(home, '.codex'), {recursive:true}), mkdir(config, { recursive: true }), mkdir(evidence, { recursive: true })]);
  const now = new Date().toISOString();
  const project = { id: randomUUID(), name: 'Rendering fixture', status: 'active', createdAt: now, updatedAt: now, archivedAt: null };
  const workspace = { id: randomUUID(), projectId: project.id, name: 'Rendering fixture', cwd: root, status: 'active', createdAt: now, updatedAt: now, doneAt: null, archivedAt: null };
  await writeFile(path.join(config, 'agency-state.json'), JSON.stringify({ version: 1, projects: [project], workspaces: [workspace] }));
  await writeFile(path.join(home, '.bashrc'), 'PS1="fixture$ "\n');
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash', CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.dirname(config), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'), AGENT_WORKBENCH_NO_OPEN: '1', AGENT_WORKBENCH_NO_RESTORE: '1' };
  for (const key of Object.keys(env)) if (/^(MAW_|AGENT_WORKBENCH_PORT)|(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET)/.test(key)) delete env[key];
  env.MAW_PERSISTENT_PTY = '0';
  env.MAW_RUNTIME_DIR = path.join(root, 'runtime');
  let serverLog = '', desktop, originalIndex;
  const child = spawn(process.execPath, ['--import', path.join(repo, 'packages/server/node_modules/tsx/dist/loader.mjs'),
    path.join(repo, 'packages/server/src/index.ts'), '--prod'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => { serverLog = (serverLog + c).slice(-65536); });
  child.stderr.on('data', c => { serverLog = (serverLog + c).slice(-65536); });
  const result = { baseline, scenarios: {}, errors: [] };
  try {
    const address = await until(async () => {
      if (child.exitCode !== null) throw Error('Fixture backend exited: ' + serverLog);
      try { return JSON.parse(await readFile(path.join(env.MAW_RUNTIME_DIR, 'maw-ready.json'), 'utf8')).url; }
      catch { return null; }
    }, 'backend startup');
    const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import {AgentConnection} from './src/connection.ts';
import {AgencyWorkspaceView} from './src/agency/AgencyWorkspaceView.tsx';
import './src/styles.css';
import '@xterm/xterm/css/xterm.css';
import './src/agency/agency.css';
const opened = []; const open = Terminal.prototype.open;
Terminal.prototype.open = function(el) { opened.push(this); return open.call(this, el); };
window.terminals = opened; window.messages = []; window.sent = []; window.sessions = [];
const connection = new AgentConnection(); window.connection = connection;
const send = connection.send.bind(connection);
connection.send = message => { window.sent.push(message); return send(message); };
const pending = new Map();
connection.onMessage(message => {
  window.messages.push(message);
  if (message.requestId && pending.has(message.requestId)) {
    const task = pending.get(message.requestId); pending.delete(message.requestId);
    message.type === 'agency.error' ? task.reject(Error(message.message)) : task.resolve(message);
  }
});
const request = message => new Promise((resolve,reject) => {
  const requestId = crypto.randomUUID(); pending.set(requestId, {resolve,reject});
  connection.send({...message, requestId});
});
window.request = request;
window.reconnect = () => connection.socket.close();
window.command = (index,data) => connection.send({type:'input', terminalId:window.sessions[index].terminalId, data});
window.term = index => {
  const tab = window.sessions[index].tab.id;
  return opened.findLast(t => t.element?.isConnected && t.element.closest('#pane-' + tab));
};
function App() {
  const [sessions,setSessions] = useState([]), [mounted,setMounted] = useState(true);
  window.mountWorkspace = setMounted;
  window.setSessions = next => { window.sessions = next; setSessions(next); };
  const act = async message => {
    const response = await request(message);
    if (response.type === 'agency.sessions.snapshot') window.setSessions(response.sessions);
    return response;
  };
  return mounted && <AgencyWorkspaceView workspace={${JSON.stringify(workspace)}} profiles={[]} sessions={sessions} webTabs={[]}
    connection={connection} request={act} sendImmediate={connection.sendImmediate.bind(connection)} online={true}
    onDone={()=>{}} onSaveLayout={async()=>{}}/>;
}
createRoot(document.getElementById('root')).render(<App/>);
connection.connect();
window.ready = async () => {
  const sessions = [];
  for (let i=0; i<2; i++) sessions.push((await request({type:'agency.session.create',workspaceId:'${workspace.id}',kind:'terminal',cols:100,rows:30,launchId:crypto.randomUUID()})).session);
  window.setSessions(sessions);
};
`;
    const outdir = path.join(repo, 'packages/web/dist');
    const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: path.join(repo, 'packages/web') },
      bundle: true, write: false, format: 'esm', jsx: 'automatic', outdir, entryNames: 'rendering-fixture', logLevel: 'silent' });
    await mkdir(outdir, { recursive: true });
    for (const file of bundle.outputFiles) await writeFile(file.path, file.contents);
    originalIndex = await readFile(path.join(outdir, 'index.html'));
    await writeFile(path.join(outdir, 'index.html'), '<!doctype html><html><link rel="stylesheet" href="/rendering-fixture.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script type="module" src="/rendering-fixture.js"></script></html>');
    const url = address;
    desktop = await electron.launch({ executablePath: electronExecutable, chromiumSandbox: true,
      args: [here, '--ozone-platform=x11'], env: { ...env, MAW_DESKTOP_URL: url, MAW_DESKTOP_DATA_DIR: path.join(root, 'desktop') } });
    const page = await desktop.firstWindow();
    page.on('pageerror', error => result.errors.push(error.message));
    await page.waitForFunction(() => window.connection?.getStatus() === 'open');
    await page.evaluate(() => window.ready());
    await page.waitForFunction(() => window.term(0) && window.term(1));
    await page.getByRole('tab').first().click();
    await delay(200);
    const command = (i, data) => page.evaluate(({i,data}) => window.command(i,data), {i,data});
    const read = i => page.evaluate(async index => {
      const t = window.term(index); await new Promise(r => t.write('', r));
      const b = t.buffer.active, v = t.element.querySelector('.xterm-viewport');
      const rect = v.getBoundingClientRect(), pane = t.element.closest('.agency-xterm-host').getBoundingClientRect();
      return { type: b.type, cols: t.cols, rows: t.rows, baseY: b.baseY, viewportY: b.viewportY,
        length: b.length, text: Array.from({length:b.length},(_,y)=>b.getLine(y)?.translateToString(true)||'').join('\n'),
        viewport: { width:v.offsetWidth-v.clientWidth, scrollHeight:v.scrollHeight, height:v.clientHeight, scrollTop:v.scrollTop,
          clipped:rect.right>pane.right+1, overflow:getComputedStyle(v).overflowY,
          thumb:getComputedStyle(v,'::-webkit-scrollbar-thumb').backgroundColor } };
    }, i);
    const waitText = (i, marker) => until(async () => (await read(i)).text.includes(marker), marker);

    // Scrollback and scrollbar usability in normal screen, including focus elsewhere.
    const activeScrollbackLimit = 42000;
    const printedLines = 25000;
    await command(0, `printf '\\033[2J\\033[H'; seq 1 ${printedLines}; printf 'HISTORY_READY\\n'\r`);
    await waitText(0, 'HISTORY_READY');
    await delay(150);
    let normal = await read(0);
    assert.equal(normal.type, 'normal');
    const minExpectedNormalLength = Math.min(activeScrollbackLimit + normal.rows, printedLines + 2);
    assert.ok(
      normal.length >= minExpectedNormalLength && normal.length <= activeScrollbackLimit + normal.rows,
      `Expected retained normal buffer length in [${minExpectedNormalLength}, ${activeScrollbackLimit + normal.rows}], got ${normal.length}`,
    );
    assert.ok(normal.text.startsWith('1\n') || normal.text.includes('\n1\n'), 'First printed line must remain in 42k scrollback');
    assert.ok(normal.text.includes(`\n${printedLines}\n`), 'Last printed line must remain in scrollback');
    assert.ok(normal.viewport.scrollHeight > normal.viewport.height);
    assert.ok(normal.viewport.width >= 8 && !normal.viewport.clipped);
    await page.evaluate(() => window.term(0).blur());
    const viewport = page.locator('.maw-session-holder:not([hidden]) .xterm-viewport');
    const wheelBox = await viewport.boundingBox();
    await page.mouse.move(wheelBox.x + wheelBox.width / 2, wheelBox.y + wheelBox.height / 2);
    await page.mouse.wheel(0, -600);
    await until(async () => (await read(0)).viewportY < normal.baseY, 'unfocused wheel scroll');
    const afterWheel = await read(0);
    // Clicking the native scrollbar track must move through retained output.
    const box = await viewport.boundingBox();
    await page.mouse.click(box.x + box.width - 5, box.y + 20);
    result.scenarios.scrollbarDiagnostics = { normal:{...normal,text:normal.text.slice(-200)}, afterWheel:{...afterWheel,text:afterWheel.text.slice(-200)}, afterClick: {...await read(0),text:''}, box };
    await page.screenshot({path: path.join(evidence, baseline?'before-scrollbar.png':'after-scrollbar.png')});
    if (!baseline) await until(async () => (await read(0)).viewportY < afterWheel.viewportY, 'scrollbar track navigation');
    result.scenarios.scrollbarTrackNavigated = (await read(0)).viewportY < afterWheel.viewportY;
    result.scenarios.scrollbar = (await read(0)).viewport;
    result.scenarios.dropStrip = await page.evaluate(({x,y}) => {
      const hit = () => !!document.elementFromPoint(x,y)?.closest('.maw-pane-drop-edge');
      const idleIntercepts = hit();
      document.body.classList.add('maw-pane-dragging');
      const dragIntercepts = hit();
      document.body.classList.remove('maw-pane-dragging');
      return {idleIntercepts,dragIntercepts};
    }, {x:box.x+box.width-5,y:box.y+20});
    assert.equal(result.scenarios.dropStrip.idleIntercepts, baseline);
    assert.equal(result.scenarios.dropStrip.dragIntercepts, true);
    const normalReplayCount = await page.evaluate(()=>window.messages.filter(m=>m.type==='terminal.replay').length);
    await page.evaluate(()=>window.reconnect());
    await until(async()=>await page.evaluate(n=>window.messages.filter(m=>m.type==='terminal.replay').length>n,normalReplayCount),'normal-screen reconnect');
    const normalReconnected = await read(0);
    result.scenarios.normalReconnect = {length:normalReconnected.length, rows:normalReconnected.rows, viewport:normalReconnected.viewport};
    if (!baseline) assert.equal(normalReconnected.length, normal.length);

    await page.screenshot({ path: path.join(evidence, baseline ? 'before-scrollbar.png' : 'after-scrollbar.png') });

    // Both PTYs run independently. Emit >256KiB while preserving a stationary
    // title on the alternate screen. A raw suffix cannot reconstruct that title.
    const script = path.join(root, 'tui.mjs');
    await writeFile(script, `process.stdin.setRawMode(true);process.stdin.resume();
const out=s=>process.stdout.write(s);
out('\\x1b[?1049h\\x1b[2J\\x1b[HRETAINED_TUI_HEADER');
for(let i=0;i<16000;i++)out('\\x1b[3;1H\\x1b[38;2;120;40;230mFRAME '+i+' 🚀界');
out('\\x1b[0m\\x1b[5;1HTUI_READY');
process.on('SIGWINCH',()=>out('\\x1b[6;1HSIZE '+process.stdout.columns+'x'+process.stdout.rows+'     '));
process.stdin.on('data',d=>{if(d.includes(113)){out('\\x1b[?1049l');process.exit(0)}});`);
    await command(1, "printf 'BACKGROUND_ISOLATED\\n'\r");
    await command(0, `node '${script}'\r`);
    await waitText(0, 'TUI_READY');
    assert.equal((await read(0)).type, 'alternate');
    assert.equal((await read(0)).baseY, 0);
    await page.mouse.move(wheelBox.x+wheelBox.width/2,wheelBox.y+wheelBox.height/2);
    await page.mouse.wheel(0,-300);
    await delay(100);
    result.scenarios.alternateScroll = {baseY:(await read(0)).baseY,scrollTop:(await read(0)).viewport.scrollTop};
    assert.deepEqual(result.scenarios.alternateScroll,{baseY:0,scrollTop:0});
    assert.equal((await read(0)).text.includes('BACKGROUND_ISOLATED'), false);
    await waitText(1, 'BACKGROUND_ISOLATED');
    const replayCount = await page.evaluate(() => window.messages.filter(m=>m.type==='terminal.replay').length);
    await page.evaluate(() => window.reconnect());
    await until(async () => await page.evaluate(n=>window.messages.filter(m=>m.type==='terminal.replay').length>n,replayCount), 'delta reconnect');
    await waitText(0, 'TUI_READY');
    const deltaHeader = (await read(0)).text.includes('RETAINED_TUI_HEADER');
    // Switching workspaces destroys/recreates xterm, forcing checkpoint recovery.
    await page.evaluate(() => window.mountWorkspace(false)); await delay(100);
    await page.evaluate(() => window.mountWorkspace(true));
    await page.waitForFunction(() => window.term(0) && window.term(1));
    await page.getByRole('tab').first().click();
    await waitText(0, 'TUI_READY');
    const recovered = await read(0);
    result.scenarios.recovery = { deltaHeader, headerAfterRemount: recovered.text.includes('RETAINED_TUI_HEADER'), type: recovered.type,
      rawFragments: /(?:^|\n)(?:\d+;){2,}\d+m/.test(recovered.text), tail: recovered.text.slice(-400) };
    await page.screenshot({ path: path.join(evidence, baseline ? 'before-recovery.png' : 'after-recovery.png') });
    if (baseline) assert.equal(result.scenarios.recovery.headerAfterRemount, false, 'baseline must reproduce lost TUI state');
    else assert.equal(result.scenarios.recovery.headerAfterRemount, true);
    // Rapid physical window resizing must settle to matching PTY dimensions.
    for (const [width,height] of [[980,680],[1100,760],[840,620],[1180,800]]) {
      await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[width,height]);
      await delay(80);
    }
    await delay(200);
    const sized = await read(0);
    await waitText(0, `SIZE ${sized.cols}x${sized.rows}`);
    result.scenarios.resize = { cols:sized.cols, rows:sized.rows, ptyMatches:true };
    await command(0, 'q');
    await until(async () => (await read(0)).type === 'normal', 'alternate-screen exit');
    await command(0, "printf 'NORMAL_RESTORED\\n'\r");
    await waitText(0, 'NORMAL_RESTORED');
    if (!baseline) await until(async () => (await read(0)).viewport.scrollHeight > (await read(0)).viewport.height, 'normal scrollbar after TUI exit');

    await command(0, "printf 'CAPS_TERM=%s CAPS_COLORTERM=%s\\n' \"$TERM\" \"${COLORTERM:-unset}\"\r");
    await waitText(0,'CAPS_TERM=xterm-256color');
    result.scenarios.capabilities = (await read(0)).text.match(/CAPS_TERM=xterm-256color CAPS_COLORTERM=[^\n]+/)?.[0];

    // Disposable Codex onboarding TUI, without copied credentials or model calls.
    // Repeat resize/focus/tab changes throughout a configurable real-time soak.
    const codexSeconds = Number(process.env.MAW_CODEX_SOAK_SECONDS || 60);
    const codexPath = process.env.MAW_CODEX_EXECUTABLE || execFileSync('which', ['codex'], { encoding:'utf8' }).trim();
    await command(0, `'${codexPath}'\r`);
    await until(async () => {
      const startup = await read(0);
      result.scenarios.codexStartup = startup.text.slice(-2500);
      return /Welcome to Codex|Sign in|OpenAI|Codex/.test(startup.text);
    }, 'disposable Codex startup');
    const started = Date.now(); let cycles = 0;
    while (Date.now() - started < codexSeconds * 1000) {
      await desktop.evaluate(({BrowserWindow},i)=>BrowserWindow.getAllWindows()[0].setContentSize(i%2?1180:1080,i%2?800:720),cycles);
      await page.getByRole('tab').last().click();
      await page.getByRole('tab').first().click();
      await delay(250); cycles++;
    }
    const codex = await read(0);
    result.scenarios.codex = { seconds: +(Date.now()-started)/1000, cycles, type:codex.type, cols:codex.cols, rows:codex.rows,
      tail:codex.text.slice(-1800), authenticated:false, modelCalls:0 };
    await page.screenshot({ path:path.join(evidence,baseline?'before-codex.png':'after-codex.png') });
    await command(0, '\x03\x03');
    if (!baseline) assert.deepEqual(result.errors, []);
    await writeFile(path.join(evidence, baseline ? 'before-runtime.json' : 'after-runtime.json'), JSON.stringify(result,null,2)+'\n');
  } catch (error) {
    await writeFile(path.join(evidence, baseline ? 'before-runtime.json' : 'after-runtime.json'), JSON.stringify({...result,failure:String(error)},null,2)+'\n');
    throw error;
  } finally {
    if (desktop) await desktop.close();
    if (originalIndex) await writeFile(path.join(repo, 'packages/web/dist/index.html'), originalIndex);
    child.kill('SIGTERM');
    await until(()=>child.exitCode!==null || child.signalCode!==null,'backend shutdown',10000).catch(()=>child.kill('SIGKILL'));
    await writeFile(path.join(evidence,baseline?'before-backend.log':'after-backend.log'),serverLog.replace(/token=[\w-]+/g,'token=REDACTED'));
    await rm(root,{recursive:true,force:true});
  }
});

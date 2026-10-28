/** Real isolated MAW/PTY/UI acceptance; optional disposable Neko config JSON.
 * pnpm --filter @agent-workbench/server exec tsx scripts/check-maw-integration.mjs
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
const out = process.env.MAW_INTEGRATION_EVIDENCE ?? path.join(root, 'evidence');
const home = path.join(root, 'home');
const config = path.join(root, 'config', 'agent-workbench');
await Promise.all([mkdir(home, { recursive: true }), mkdir(config, { recursive: true }), mkdir(out, { recursive: true })]);
const now = new Date().toISOString();
const project = { id: randomUUID(), name: 'Integration', status: 'active', createdAt: now, updatedAt: now, archivedAt: null };
const workspaces = ['Alpha', 'Beta'].map(name => ({ id: randomUUID(), projectId: project.id, name, cwd: root,
  status: 'active', createdAt: now, updatedAt: now, doneAt: null, archivedAt: null }));
await writeFile(path.join(config, 'agency-state.json'), JSON.stringify({ version: 1, projects: [project], workspaces }));
await writeFile(path.join(home, '.bashrc'), '# disposable integration fixture\n');
const neko = process.env.MAW_INTEGRATION_NEKO_ENV ? JSON.parse(await readFile(process.env.MAW_INTEGRATION_NEKO_ENV, 'utf8')) : {};
const env = { ...process.env, ...neko, HOME: home, USERPROFILE: home, SHELL: '/bin/bash',
  XDG_CONFIG_HOME: path.dirname(config), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_STATE_HOME: path.join(root, 'state'), CODEX_HOME: path.join(home, '.codex'), APPDATA: path.join(root, 'appdata'),
  PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), PI_CODING_AGENT_SESSION_DIR: path.join(home, '.pi', 'sessions'),
  AGENT_WORKBENCH_NO_OPEN: '1', AGENT_WORKBENCH_NO_RESTORE: '1' };
if (!process.env.MAW_INTEGRATION_NEKO_ENV) {
  for (const name of ['CONTROLLER_AUTH_TOKEN', 'NEKO_CONTROLLER_TOKEN', 'NEKO_PASSWORD', 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD']) delete env[name];
}
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
  command(shellA, "sleep 1; printf 'MAW_BACKGROUND_COMMAND_OK\\n'");
  await eventually(async () => (await notifications()).activityStates.some(record => record.tabId === shellA.tab.id && record.state === 'working'), 'working shell');
  await selectNative(shellB);
  await eventually(async () => (await notifications()).notifications.some(item => item.tabId === shellA.tab.id && item.state === 'finished'), 'background shell notification');
  let state = await notifications();
  let completion = state.notifications.find(item => item.tabId === shellA.tab.id && item.state === 'finished');
  assert.equal(state.activityStates.find(record => record.tabId === shellA.tab.id).state, 'finished');
  assert.equal(completion.projectId, project.id); assert.equal(completion.sessionId, shellA.id);
  await request({ type: 'agency.notification.markRead', notificationId: completion.id });
  assert.equal((await notifications()).activityStates.find(record => record.tabId === shellA.tab.id).state, 'finished');
  check('real Bash background completion, ownership, durable inbox and independent read state');
  await selectNative(shellA);
  assert.equal((await notifications()).activityStates.find(record => record.tabId === shellA.tab.id).state, 'finished', 'selection alone is not inspection');

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
  await page.locator('.maw-inbox-item').filter({ hasText: /finished/i }).first().click();
  await eventually(async () => (await notifications()).activityStates.find(record => record.tabId === shellA.tab.id)?.state === 'idle', 'inspection acknowledges after terminal render');
  assert.equal(await page.locator('[role=tab][aria-selected=true]').getAttribute('id'), 'tab-' + shellA.tab.id);
  check('real notification inbox click-through selects workspace/tab and acknowledges displayed terminal');

  await selectNative(shellB);
  command(shellA, 'false');
  await eventually(async () => (await notifications()).notifications.some(item => item.tabId === shellA.tab.id && item.state === 'failed'), 'failed shell notification');
  await page.locator('.maw-toast-item').first().waitFor();
  const beforeDismiss = (await notifications()).notifications.length;
  await page.locator('.maw-toast-dismiss').first().click();
  assert.equal((await notifications()).notifications.length, beforeDismiss);
  check('real failed shell command, top-right toast and dismissal retains inbox');

  const trafficStart=traffic.length;
  for(let i=0;i<40;i++){const began=performance.now();await selectNative(i%2?shellA:shellB);measurements.switchMs.push(performance.now()-began);}
  measurements.selectionEvents=traffic.slice(trafficStart).length;
  measurements.serverSmaps=await readFile('/proc/'+child.pid+'/smaps_rollup','utf8').then(text=>text.split('\n').filter(line=>/^(Rss|Pss):/.test(line))).catch(()=>[]);
  let webA, webB, webC;
  if (process.env.MAW_INTEGRATION_NEKO_ENV) {
    const createA = { type: 'agency.webTab.create', workspaceId: alpha.id, title: 'ChatGPT A', url: 'https://chatgpt.com/', launchId: randomUUID() };
    const repeated = await Promise.all([request(createA), request(createA)]);
    assert.equal(repeated[0].tab.id, repeated[1].tab.id);
    webA = repeated[0].tab;
    webB = (await request({ type: 'agency.webTab.create', workspaceId: alpha.id, title: 'ChatGPT B', url: 'https://chatgpt.com/', launchId: randomUUID() })).tab;
    webC = (await request({ type: 'agency.webTab.create', workspaceId: beta.id, title: 'ChatGPT C', url: 'https://chatgpt.com/', launchId: randomUUID() })).tab;
    await selectWeb(webA);
    await page.reload();
    // This fixture's persisted navigation preference is Beta; select Alpha explicitly.
    await page.evaluate(id => localStorage.setItem('agency-ui.selected-workspace.v1', id), alpha.id);
    await page.reload();
    await page.locator('.maw-neko-frame').waitFor({ timeout: 30_000 });
    const frame = page.frameLocator('.maw-neko-frame');
    await frame.locator('video').waitFor({ timeout: 30_000 });
    await eventually(() => frame.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0 &&
      video.srcObject?.getVideoTracks().some(track => track.readyState === 'live')), 'genuine Neko WebRTC media', 45_000);
    assert.equal(await page.locator('iframe').count(), 1);
    assert.match(await page.locator('iframe').getAttribute('src'), /^\/api\/agency\/browser\/viewer\//);
    assert.ok((await notifications()).activityStates.filter(record => [webA.id, webB.id, webC.id].includes(record.tabId)).every(record => record.state === 'unknown'));
    check('genuine authenticated Neko Chromium stream displayed in single MAW surface');
    await delay(1500);
    const overlay = frame.getByTestId('player-overlay');
    if (await overlay.count()) await overlay.click();
    const control = frame.getByTestId('control-request');
    if (!/release/i.test(await control.getAttribute('aria-label') ?? '')) await control.click();
    await eventually(async () => /release/i.test(await control.getAttribute('aria-label') ?? ''), 'ordinary Neko keyboard/mouse control');
    const input = frame.getByTestId('player').locator('textarea').first();
    await input.click({ force: true });
    await delay(300);
    const marker = 'maw-keyboard-' + randomUUID();
    const typedUrl = 'https://chatgpt.com/?maw-test=' + marker;
    await page.keyboard.press('Control+l');
    await delay(300);
    await page.keyboard.type(typedUrl, { delay: 20 });
    await delay(200);
    await page.keyboard.press('Enter');
    await page.screenshot({ path: path.join(out, 'neko-keyboard-after.png'), fullPage: true });
    await eventually(async () => {
      const response = await fetch(neko.NEKO_CONTROLLER_URL + '/tabs', { headers: { Authorization: 'Bearer ' + neko.CONTROLLER_AUTH_TOKEN } });
      return (await response.json()).tabs.some(tab => tab.id === webA.targetRef && tab.url.includes(marker));
    }, 'keyboard input through WebRTC reaches intended Chromium target');
    await eventually(async () => {
      const response=await fetch(neko.NEKO_CONTROLLER_URL+'/tabs',{headers:{Authorization:'Bearer '+neko.CONTROLLER_AUTH_TOKEN}});
      const live=(await response.json()).tabs.find(tab=>tab.id===webA.targetRef);
      return live?.url?.startsWith('https://chatgpt.com/') && (await webSnapshot()).tabs.find(tab=>tab.id===webA.id)?.url===live.url;
    }, 'live URL persistence including guest authentication redirects', 20_000);
    check('real Neko keyboard input controls Chromium and live navigation is persisted');

    if (process.env.MAW_TRY_CHATGPT_GUEST === '1') {
      await delay(1500);
      const videoBox = await frame.locator('video').boundingBox();
      assert.ok(videoBox);
      await page.mouse.click(videoBox.x + videoBox.width * 0.60, videoBox.y + videoBox.height * 0.57);
      await page.keyboard.type('For a browser background continuity test, write a numbered list from 1 to 200, with one short sentence explaining a different basic arithmetic fact on each line. Continue through all 200 without asking follow-up questions.', { delay: 8 });
      await page.keyboard.press('Enter');
      await delay(700);
      await page.screenshot({ path: path.join(out, 'chatgpt-before-switch.png'), fullPage: true });
      await selectWeb(webB);
      await selectNative(shellA);
      await page.locator('.agency-workspace-nav-button').filter({ hasText: 'Beta' }).click();
      await selectWeb(webC);
      await selectNative(shellB);
      await delay(12_000);
      await page.locator('.agency-workspace-nav-button').filter({ hasText: 'Alpha' }).click();
      await selectWeb(webA);
      await page.locator('.maw-neko-frame').waitFor();
      await eventually(() => page.frameLocator('.maw-neko-frame').locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0), 'guest return live stream', 30_000);
      await delay(1500);
      await page.screenshot({ path: path.join(out, 'chatgpt-after-background.png'), fullPage: true });
      results.push({ label: 'guest ChatGPT response attempted only through streamed UI', status: 'REQUIRES_VISUAL_REVIEW', targetRefPreserved: (await webSnapshot()).tabs.find(tab => tab.id === webA.id)?.targetRef === webA.targetRef });
    }
    for (const [width, height] of [[390, 844], [768, 1024], [1280, 720], [1366, 768], [1920, 1080], [2560, 1440]]) {
      await page.setViewportSize({ width, height });
      if (width === 390 && await page.getByRole('button',{name:'Collapse sidebar',exact:true}).count()) await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
      await page.getByRole('tab',{name:'ChatGPT A'}).press('F2');
      await page.getByLabel('Tab title',{exact:true}).fill('Research '+width);
      await page.screenshot({path:path.join(out,`rename-${width}x${height}.png`),fullPage:true});
      await page.getByLabel('Tab title',{exact:true}).press('Enter');
      await page.getByRole('tab',{name:'Research '+width}).waitFor();
      await request({type:'agency.webTab.rename',workspaceId:alpha.id,tabId:webA.id,title:'ChatGPT A'});
      await page.getByRole('tab',{name:'ChatGPT A'}).waitFor();
      await page.locator('.maw-bell-button').click(); await page.locator('.maw-notification-inbox').waitFor();
      await page.screenshot({path:path.join(out,`inbox-${width}x${height}.png`),fullPage:true});
      await page.keyboard.press('Escape');
      await page.screenshot({ path: path.join(out, `neko-${width}x${height}.png`), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow at ${width}`);
      if (width === 390) {
        if (await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).count()) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
        await page.getByRole('button', { name: 'Add tab' }).click();
        await page.getByRole('menuitem', { name: /ChatGPT/ }).waitFor();
        await page.screenshot({ path: path.join(out, 'neko-narrow-controls.png'), fullPage: true });
        await page.getByRole('button', { name: 'Add tab' }).click();
        await page.getByRole('tab', { name: /ChatGPT B/ }).click();
        await page.getByRole('tab', { name: /ChatGPT A/ }).click();
        check('narrow layout sidebar collapse, add menu and browser tab controls accessible');
      }
    }
    await selectWeb(webB); await selectNative(shellA); await selectWeb(webC); await selectWeb(webA);
    const targets = (await webSnapshot()).tabs;
    for (const tab of [webA, webB, webC]) assert.equal(targets.find(item => item.id === tab.id).targetRef, tab.targetRef);
    assert.equal((await snapshot()).sessions.find(session => session.id === shellA.id).terminalId, shellA.terminalId);
    await selectNative(shellA);
    await eventually(async () => await page.locator('.maw-neko-frame').count() === 0, 'browser surface hides for terminal');
    check('switch A/B/native/across workspaces retains all real targets and PTY identity');
    await selectWeb(webA);
    await request({ type: 'agency.webTab.close', workspaceId: alpha.id, tabId: webB.id });
    assert.ok((await webSnapshot()).tabs.some(tab => tab.id === webA.id && tab.targetRef === webA.targetRef));
    assert.ok(!(await webSnapshot()).tabs.some(tab => tab.id === webB.id));
    check('closing a browser tab preserves sibling browser target');
  } else {
    await assert.rejects(request({ type: 'agency.webTab.create', workspaceId: alpha.id, title: 'Offline ChatGPT', url: 'https://chatgpt.com/', launchId: randomUUID() }), /Browser|browser|engine|configured|unavailable/);
    const saved = (await webSnapshot()).tabs;
    assert.equal(saved.length, 1); assert.equal(saved[0].runtimeState, 'error');
    check('unconfigured browser persists logical tab and fails explicitly');
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: path.join(out, 'integrated-workspace.png'), fullPage: true });
  await request({type:'agency.tab.rename',workspaceId:alpha.id,tabId:shellA.tab.id,name:'Audit shell'});
  assert.equal((await snapshot()).sessions.find(s=>s.id===shellA.id).terminalId,shellA.terminalId);
  await page.reload();
  await page.getByRole('tab',{name:'Audit shell'}).waitFor();
  const notificationsBeforeRestart = (await notifications()).notifications;
  const targetBeforeRestart = webA?.targetRef;
  await page.close();
  await stop(); await start();
  state = await notifications();
  assert.equal((await snapshot()).sessions.find(s=>s.tab?.id===shellA.tab.id && s.tab.current).tab.name,'Audit shell');
  check('stable native tab rename survives page refresh and MAW restart');
  assert.deepEqual(state.notifications.map(item => [item.id, item.read]).sort(), notificationsBeforeRestart.map(item => [item.id, item.read]).sort());
  if (webA) {
    const restored = (await selectWeb(webA)).tab;
    assert.equal(restored.targetRef, targetBeforeRestart);
    assert.equal(restored.runtimeState, 'ready');
  }
  check(webA ? 'MAW restart retains notification IDs/read state and verified live browser target' : 'MAW restart retains notification IDs and independent read state');
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

/** Disposable integrated regressions for SEC-001/002 and FUNC-001. No providers. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(serverDir, '../..');
const root = await mkdtemp(path.join(tmpdir(), 'agency-remediation-'));
const home = path.join(root, 'home'), config = path.join(root, 'xdg', 'workbench');
const accountA = path.join(root, 'account-a'), accountB = path.join(root, 'account-b');
const cwd = path.join(home, 'workspace');
await Promise.all([home, config, accountA, accountB, cwd].map((p) => mkdir(p, { recursive: true })));
await writeFile(path.join(home, '.zshrc'), '# disposable\n');
// An existing installation's profile store: synthetic accounts per provider.
await writeFile(path.join(config, 'agency-profiles.json'), JSON.stringify({ schemaVersion: 1, profiles: [['codex-a', 'codex', 'Codex A'], ['codex-b', 'codex', 'Codex B'], ['codex-d', 'codex', 'Codex D']]
  .map(([id, provider, label]) => ({ id, provider, label, executable: '', args: [], environmentOverrides: {}, disabled: false })) }), { mode: 0o600 });
const files = {};
for (const [profileId, nativeHome] of [['codex-a', accountA], ['codex-b', accountB], ['codex-d', accountB]]) {
  files[profileId] = path.join(root, profileId);
  await writeFile(files[profileId], `#!/bin/sh\nexport CODEX_HOME='${nativeHome}'\nprintf '%s' "$CODEX_HOME" > '${root}/${profileId}.home'\nprintf '%s\\n' 'NATIVE_FIXTURE_READY'\nwhile IFS= read -r line; do printf '%s\\n' 'NATIVE_FIXTURE_INPUT_RECEIVED'; done\n`, { mode: 0o700 });
}
await writeFile(path.join(config, 'agency-native-identities.json'), JSON.stringify({ version: 1,
  identities: [['codex-a', accountA], ['codex-b', accountB]].map(([profileId, nativeHome]) => ({
    profileId, provider: 'codex', executable: files[profileId], args: ['literal words'], environmentOverrides: {}, home: nativeHome,
  })),
}));
const probe = createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
const fixedPort = probe.address().port;
await new Promise((r) => probe.close(r));
await writeFile(path.join(config, 'settings.json'), JSON.stringify({ version: 1, remote: { enabled: true, port: fixedPort } }));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(root, 'appdata'),
  XDG_CONFIG_HOME: path.dirname(config), XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), CODEX_HOME: accountA,
  PI_CODING_AGENT_DIR: path.join(root, 'pi'), PI_CODING_AGENT_SESSION_DIR: path.join(root, 'pi-sessions'),
  WORKBENCH_NO_OPEN: '1', WORKBENCH_NO_RESTORE: '1' };
let server, browser;
const sockets = [];
let groups = 0;
const evidence = (label, data = {}) => { groups++; console.log('PASS', label, JSON.stringify(data)); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, timeout = 15000) {
  const started = performance.now();
  while (!(await predicate())) {
    if (performance.now() - started > timeout) throw new Error('Timed out: ' + predicate.toString());
    await delay(30);
  }
}
class Client {
  messages = [];
  constructor(socket) {
    this.socket = socket;
    socket.on('message', (raw) => this.messages.push(JSON.parse(raw)));
  }
  async wait(predicate) {
    let found;
    await until(() => (found = this.messages.find(predicate)) !== undefined);
    this.messages.splice(this.messages.indexOf(found), 1);
    return found;
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  async request(message) {
    const requestId = randomUUID();
    this.send({ ...message, requestId });
    return this.wait((m) => m.requestId === requestId);
  }
}
try {
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--prod'], {
    cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let log = '';
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server readiness timed out')), 30000);
    const onData = (chunk) => {
      log += chunk;
      const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/);
      if (match) { clearTimeout(timer); resolve({ port: Number(match[1]), token: match[2], url: match[0] }); }
    };
    server.stdout.on('data', onData); server.stderr.on('data', onData);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
  });
  const origin = `http://127.0.0.1:${ready.port}`;
  async function connect(cookie) {
    const socket = new WebSocket(`ws://127.0.0.1:${ready.port}/ws${cookie ? '' : '?token=' + ready.token}`,
      { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
    sockets.push(socket);
    const client = new Client(socket);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return client;
  }
  const host = await connect();
  assert.equal((await host.wait((m) => m.type === 'hello')).remoteClient, false);
  for (const profileId of Object.keys(files)) {
    const result = await host.request({ type: 'agency.profile.configure', profileId, executable: files[profileId], args: ['literal words'] });
    assert.equal(result.type, 'agency.profile.configured');
    assert.equal(result.profile.capabilities.canResumeNativeSession, profileId !== 'codex-d');
  }
  const project = (await host.request({ type: 'agency.project.create', name: 'Isolation fixture' })).project;
  async function picker(client, message) {
    client.send(message);
    return (await client.wait((m) => m.type === 'picker.listing' && (!message.pickerId || m.listing.pickerId === message.pickerId))).listing;
  }
  async function workspace(name) {
    const listing = await picker(host, { type: 'picker.open' });
    await picker(host, { type: 'picker.enter', pickerId: listing.pickerId, name: 'workspace' });
    const result = await host.request({ type: 'agency.workspace.create', projectId: project.id, name, pickerId: listing.pickerId });
    host.send({ type: 'picker.close', pickerId: listing.pickerId });
    assert.equal(result.type, 'agency.workspace.created');
    assert.equal(result.workspace.cwd, cwd);
    return result.workspace;
  }
  const workspaces = {}, sessions = {};
  for (const profileId of Object.keys(files)) {
    workspaces[profileId] = await workspace(profileId);
    const result = await host.request({ type: 'agency.session.create', workspaceId: workspaces[profileId].id,
      kind: 'agent', profileId, cols: 80, rows: 24 });
    assert.equal(result.type, 'agency.session.created');
    assert.equal(result.session.lifecycle, 'running');
    sessions[profileId] = result.session;
    await until(async () => (await readFile(path.join(root, profileId + '.home'), 'utf8').catch(() => '')) ===
      (profileId === 'codex-a' ? accountA : accountB));
  }
  assert.equal(sessions.codex-d.historyAvailability, 'unavailable');
  evidence('three actual wrappers preserve their effective homes and native PTYs');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(ready.url);
  await page.locator('.agency-workspace-nav-button').filter({ hasText: 'codex-b' }).click();
  const at = Date.now();
  const idA = randomUUID(), idB = randomUUID();
  async function rollout(nativeHome, id, marker) {
    const d = new Date(at), pad = (n) => String(n).padStart(2, '0');
    const folder = path.join(nativeHome, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    await mkdir(folder, { recursive: true });
    const name = `rollout-${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${id}.jsonl`;
    await writeFile(path.join(folder, name), [
      { type: 'session_meta', payload: { id, timestamp: new Date(at).toISOString(), cwd, source: 'cli' } },
      { type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'user_message', message: marker, images: [], local_images: [], text_elements: [] } },
    ].map(JSON.stringify).join('\n') + '\n');
  }
  const discoveryStarted = performance.now();
  await Promise.all([rollout(accountA, idA, 'ACCOUNT_A_SYNTHETIC_ONLY'), rollout(accountB, idB, 'ACCOUNT_B_SYNTHETIC_ONLY')]);
  await until(async () => {
    const rows = (await host.request({ type: 'agency.sessions.list' })).sessions;
    return rows.find((s) => s.id === sessions.codex-a.id)?.nativeSessionId === idA &&
      rows.find((s) => s.id === sessions.codex-b.id)?.nativeSessionId === idB;
  });
  const discoveryMs = performance.now() - discoveryStarted;
  await page.locator('.agency-workspace-nav-button').filter({ hasText: 'codex-b' }).click();
  await page.locator('.agency-xterm-host').waitFor();
  await page.locator('.agency-workspace-nav-button').filter({ hasText: 'codex-a' }).click();
  await page.locator('.agency-xterm-host').waitFor();
  await page.locator('.agency-workspace-nav-button').filter({ hasText: 'codex-d' }).click();
  await page.locator('.agency-xterm-host').waitFor();
  const rows = (await host.request({ type: 'agency.sessions.list' })).sessions;
  assert.equal(rows.find((s) => s.id === sessions.codex-d.id).nativeSessionId, null);
  assert.equal(rows.find((s) => s.id === sessions.codex-a.id).nativeSessionId, idA);
  assert.equal(rows.find((s) => s.id === sessions.codex-b.id).nativeSessionId, idB);
  host.send({ type: 'terminal.attach', cols: 80, rows: 24, terminalId: sessions.codex-d.terminalId });
  await host.wait((m) => m.type === 'terminal.replay' && m.terminalId === sessions.codex-d.terminalId);
  host.send({ type: 'input', terminalId: sessions.codex-d.terminalId, data: 'safe synthetic input\n' });
  await host.wait((m) => m.type === 'terminal.output' && m.terminalId === sessions.codex-d.terminalId &&
    m.data.includes('NATIVE_FIXTURE_INPUT_RECEIVED'));
  evidence('integrated dual-home discovery/browser isolation with identical cwd and timestamp', { discoveryMs: +discoveryMs.toFixed(2), a: true, b: true, opaque: true });

  // Correct-home native resume is positive; wrong-home/opaque IDs are refused before spawn.
  host.send({ type: 'terminal.close', terminalId: sessions.codex-b.terminalId });
  await until(async () => (await host.request({ type: 'agency.sessions.list' })).sessions.find((s) => s.id === sessions.codex-b.id).lifecycle === 'exited');
  const resume = await host.request({ type: 'agency.session.create', workspaceId: workspaces.codex-b.id,
    kind: 'agent', profileId: 'codex-b', cols: 80, rows: 24, resumeNativeSessionId: idB });
  assert.equal(resume.type, 'agency.session.created'); assert.equal(resume.session.nativeSessionId, idB);
  const wrong = await workspace('Wrong home resume');
  for (const [profileId, id] of [['codex-b', idA], ['codex-d', idB]]) {
    const result = await host.request({ type: 'agency.session.create', workspaceId: wrong.id, kind: 'agent',
      profileId, cols: 80, rows: 24, resumeNativeSessionId: id });
    assert.equal(result.type, 'agency.error');
  }
  evidence('verified B resume works; A ID and opaque resume refuse');

  const profileFile = path.join(config, 'agency-profiles.json');
  const before = await readFile(profileFile, 'utf8');
  host.send({ type: 'remote.pairing.start' });
  const pairing = (await host.wait((m) => m.type === 'remote.pairing.code')).pairing;
  const paired = await fetch(`${origin}/?pair=${pairing.code}`, { redirect: 'manual' });
  assert.equal(paired.status, 303);
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const device = await connect(cookie);
  assert.equal((await device.wait((m) => m.type === 'hello')).remoteClient, true);
  const refused = await device.request({ type: 'agency.profile.configure', profileId: 'codex-b', executable: files.codex-d,
    args: ['REMOTE_CHANGED'], disabled: true, environmentOverrides: { LANG: 'C' } });
  assert.equal(refused.type, 'error'); assert.equal(refused.code, 'remote-refused');
  assert.equal(await readFile(profileFile, 'utf8'), before);
  device.send({ type: 'settings.update', consoleShell: 'auto' });
  assert.equal((await device.wait((m) => m.type === 'error')).code, 'remote-refused');
  assert.equal((await device.request({ type: 'agency.projects.list' })).type, 'agency.projects.snapshot');
  device.send({ type: 'terminal.attach', cols: 80, rows: 24, terminalId: sessions.codex-a.terminalId });
  await device.wait((m) => m.type === 'terminal.replay' && m.terminalId === sessions.codex-a.terminalId);
  const hostChange = await host.request({ type: 'agency.profile.configure', profileId: 'codex-d', args: ['HOST_ALLOWED'] });
  assert.equal(hostChange.type, 'agency.profile.configured');
  assert.deepEqual(hostChange.profile.args, ['HOST_ALLOWED']);
  const remoteContext = await browser.newContext({ storageState: await context.storageState() });
  await remoteContext.clearCookies();
  const [cookieName, ...cookieValue] = cookie.split('=');
  await remoteContext.addCookies([{ name: cookieName, value: cookieValue.join('='), url: origin }]);
  const remotePage = await remoteContext.newPage();
  await remotePage.goto(origin);
  await remotePage.locator('.agency-workspace-nav-button').filter({ hasText: 'Wrong home resume' }).click();
  assert.equal(await remotePage.getByRole('button', { name: 'Configure profile', exact: true }).count(), 0);
  evidence('paired device explicitly refused without persistent mutation; host configure and remote reads/reattach retained');

  // Compile the real shared component into a test page to exercise two dialogs on ONE real connection.
  const compiled = await build({ stdin: { contents: `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {FolderPicker} from '${repo}/packages/web/src/shared/ui/FolderPicker.tsx';
    import {AgentConnection} from '${repo}/packages/web/src/connection/connection.ts';
    const connection = new AgentConnection(); window.fixtureConnection = connection;
    window.fixtureMessages = []; connection.onMessage(m => window.fixtureMessages.push(m)); connection.connect();
    function App() { const [one,S1]=useState(false),[two,S2]=useState(false);
      return <><button onClick={()=>S1(true)}>Open one</button><button onClick={()=>S2(true)}>Open two</button>
      {one && <FolderPicker connection={connection} title="Picker one" confirmLabel="Choose" confirmTitle={p=>p} onChoose={()=>{}} onClose={()=>S1(false)} />}
      {two && <FolderPicker connection={connection} title="Picker two" confirmLabel="Choose" confirmTitle={p=>p} onChoose={()=>{}} onClose={()=>S2(false)} />}</>; }
    createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: path.join(repo, 'packages/web'), loader: 'tsx' },
    bundle: true, write: false, format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  // Chrome treats route-fulfilled HTML as a public response; permit its loopback fixture socket.
  await context.grantPermissions(['local-network-access'], { origin });
  const pickerPage = await context.newPage();
  pickerPage.on('pageerror', error => console.error('Picker fixture:', error.message));
  pickerPage.on('console', msg => { if (msg.type() === 'error') console.error('Picker console:', msg.text()); });
  await pickerPage.route('**/picker-fixture.js', (route) => route.fulfill({ contentType: 'application/javascript', body: compiled.outputFiles[0].text }));
  await pickerPage.route('**/picker-fixture.html*', (route) => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module" src="/picker-fixture.js"></script>' }));
  await pickerPage.addInitScript(() => {
    window.pickerDelay = 500;
    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    Object.defineProperty(WebSocket.prototype, 'onmessage', { ...descriptor, set(handler) {
      descriptor.set.call(this, function(event) {
        const message = JSON.parse(event.data);
        if (message.type === 'picker.listing' && window.pickerDelay) setTimeout(() => handler.call(this, event), window.pickerDelay);
        else handler.call(this, event);
      });
    } });
  });
  await pickerPage.goto(`${origin}/picker-fixture.html?token=${ready.token}`);
  await pickerPage.waitForFunction(() => window.fixtureConnection?.getStatus() === 'open').catch(async error => {
    console.error('Picker diagnostics', await pickerPage.evaluate(() => ({ fixture: !!window.fixtureConnection,
      status: window.fixtureConnection?.getStatus(), text: document.body.innerText.slice(0, 200), messages: window.fixtureMessages?.map(m=>m.type) })));
    throw error;
  });
  const cancellations = [];
  for (let i = 0; i < 12; i++) {
    const started = performance.now();
    await pickerPage.getByRole('button', { name: 'Open one', exact: true }).click();
    await pickerPage.getByRole('dialog', { name: 'Picker one' }).getByTitle('Close', { exact: true }).click();
    cancellations.push(performance.now() - started);
  }
  await delay(650);
  await pickerPage.getByRole('button', { name: 'Open one', exact: true }).click();
  await pickerPage.getByRole('dialog', { name: 'Picker one' }).locator('.picker-path').waitFor();
  await pickerPage.getByRole('button', { name: 'Open two', exact: true }).click();
  await pickerPage.getByRole('dialog', { name: 'Picker two' }).locator('.picker-path').waitFor();
  const one = pickerPage.getByRole('dialog', { name: 'Picker one' });
  const two = pickerPage.getByRole('dialog', { name: 'Picker two' });
  await one.getByRole('button', { name: 'workspace', exact: true }).click();
  await until(async () => (await one.locator('.picker-path').innerText()) === cwd);
  assert.equal(await two.locator('.picker-path').innerText(), home);
  await one.getByTitle('Close', { exact: true }).click();
  // Force actual connection loss; the mounted second picker must reopen on the fresh socket.
  await pickerPage.evaluate(() => window.fixtureConnection.socket.close());
  await pickerPage.waitForFunction(() => window.fixtureMessages.filter((m) => m.type === 'hello').length >= 2);
  await two.locator('.picker-path').waitFor();
  assert.equal(await two.locator('.picker-path').innerText(), home);
  await two.getByTitle('Close', { exact: true }).click();
  evidence('12 delayed rapid cancellations, simultaneous dialogs and reconnect', {
    cancellations: 12, delayMs: 500, medianCancelMs: +cancellations.sort((a,b)=>a-b)[6].toFixed(2),
  });
  // Exhaust real allocations on this socket to induce a genuine first-load error.
  await pickerPage.evaluate(() => {
    window.pickerDelay = 0; window.exhaustIds = Array.from({ length: 8 }, () => crypto.randomUUID());
    for (const pickerId of window.exhaustIds) window.fixtureConnection.sendImmediate({ type: 'picker.open', pickerId });
  });
  await pickerPage.waitForFunction(() => window.exhaustIds.every(id => window.fixtureMessages.some(m => m.type === 'picker.listing' && m.listing.pickerId === id)));
  await pickerPage.getByRole('button', { name: 'Open one', exact: true }).click();
  await one.getByRole('alert').waitFor();
  assert.equal(await one.locator('.picker-path').count(), 0);
  assert.doesNotMatch(await one.innerText(), /Reading the disk/);
  await one.getByTitle('Close', { exact: true }).click();
  await pickerPage.evaluate(() => { for (const pickerId of window.exhaustIds) window.fixtureConnection.sendImmediate({ type: 'picker.close', pickerId }); });
  await pickerPage.getByRole('button', { name: 'Open one', exact: true }).click();
  await one.locator('.picker-path').waitFor();
  assert.equal(await one.getByRole('alert').count(), 0);
  const foreignId = await pickerPage.evaluate(() => window.fixtureMessages.filter(m => m.type === 'picker.listing').at(-1).listing.pickerId);
  host.send({ type: 'picker.enter', pickerId: foreignId, name: '..' });
  assert.equal((await host.wait((m) => m.type === 'error' && m.requestId === foreignId)).code, 'picker-failed');
  assert.equal(await one.locator('.picker-path').innerText(), home);
  evidence('first-load server failure visible, recovered after close; socket isolation retained');
  assert.deepEqual(errors, []);
  console.log(`Remediation integration: ${groups}/${groups} groups passed; no real accounts, credentials or inference.`);
} finally {
  for (const socket of sockets) socket.terminate();
  await browser?.close();
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
    await Promise.race([new Promise((r) => server.once('exit', r)), delay(4000)]);
    try { process.kill(-server.pid, 'SIGKILL'); } catch {}
  }
  await rm(root, { recursive: true, force: true });
}

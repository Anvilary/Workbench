/** Real release/update/systemd/Chromium acceptance, entirely disposable.
 * Run from the repository: pnpm --filter @agent-workbench/server exec tsx scripts/check-startup-restoration.mjs
 * Uses the production Neko controller with a disposable Chromium profile and
 * locally fulfilled ChatGPT fixture pages. No provider, login, cookies or live Neko.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { AgencyNotificationStore } from '../src/agency/agency-notification-store.ts';
import { SplitAgencySessionStore } from '../src/agency/agency-session-store.ts';
import { defaultDefinitions } from '../src/agents/profiles/definition.ts';

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
assert.ok(process.env.XDG_RUNTIME_DIR, 'requires a user systemd manager');
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'maw-startup-restoration-')));
const source = path.join(root, 'development-worktree');
const stateDir = path.join(root, '.local/share/maw');
const home = path.join(root, 'home');
const configHome = path.join(home, '.config');
const config = path.join(configHome, 'agent-workbench');
const envFile = path.join(configHome, 'maw/environment');
const suffix = randomBytes(5).toString('hex');
const unit = `maw-test-restoration-${suffix}.service`;
const runtimeName = `maw-test-restoration-${suffix}`;
const runtimeDir = path.join(process.env.XDG_RUNTIME_DIR, runtimeName);
const unitFile = path.join(process.env.XDG_RUNTIME_DIR, 'systemd/user', unit);
const scripts = path.join(repo, 'scripts/maw');
const env = { ...process.env, MAW_STATE_DIR: stateDir, MAW_SOURCE_DIR: source, MAW_UNIT: unit,
  MAW_RUNTIME_DIR: runtimeDir, MAW_RUNTIME_NAME: runtimeName, MAW_ENV_FILE: envFile,
  MAW_NODE_BIN: process.execPath, MAW_READY_TIMEOUT: '20', MAW_CGROUP_FILE: path.join(root, 'no-cgroup'),
  MAW_LIB_DIR: path.join(root, 'lib'), MAW_BIN_DIR: path.join(root, 'bin') };
const now = new Date().toISOString();
const projects = ['Second project', 'First project'].map(name => ({ id: randomUUID(), name, status: 'active', createdAt: now, updatedAt: now, archivedAt: null }));
const workspace = { id: randomUUID(), projectId: projects[0].id, name: 'Persistent workspace', cwd: root,
  status: 'active', createdAt: now, updatedAt: now, doneAt: null, archivedAt: null };
const workspaces = [workspace, { ...workspace, id: randomUUID(), name: 'Done workspace', status: 'done', doneAt: now },
  { ...workspace, id: randomUUID(), name: 'Archived workspace', status: 'archived', archivedAt: now }];
const nativeId = randomUUID();
const native = { id: randomUUID(), workspaceId: workspace.id, kind: 'agent', profileId: 'codex00', nativeSessionId: nativeId,
  nativeIdentity: null, selectedModel: null, selectedEffort: null, terminalId: null, lifecycle: 'running', activity: 'idle',
  createdAt: now, updatedAt: now, startedAt: now, stoppedAt: null, exitCode: null,
  tab: { id: randomUUID(), name: 'Unverified native conversation', order: 0, selected: false, current: true, closedAt: null } };
const history = { ...native, id: randomUUID(), nativeSessionId: randomUUID(), lifecycle: 'exited', stoppedAt: now,
  tab: { ...native.tab, id: randomUUID(), name: 'Saved native history', closedAt: now } };
const A = 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555';
const B = 'https://chatgpt.com/g/g-fixture/c/66666666-7777-4888-8999-000000000000';
const nativeHistoryFile = path.join(home, '.codex/sessions/2026/10/29', `rollout-2026-10-29T00-00-00-${nativeId}.jsonl`);
let context, controller, socket;
let ready;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (file, args, extra = {}) => exec(file, args, { env, maxBuffer: 32 * 1024 * 1024, timeout: 600_000, ...extra });
const maw = (...args) => run(path.join(scripts, 'maw'), args);
const ctl = (...args) => run('systemctl', ['--user', ...args, unit]);
const check = label => console.log('PASS ' + label);
async function until(work, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await work();
    if (result) return result;
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
async function connect() {
  socket?.terminate();
  ready = JSON.parse(await readFile(path.join(runtimeDir, 'maw-ready.json'), 'utf8'));
  const url = new URL(ready.url);
  socket = new WebSocket(`ws://${url.host}/ws${url.search}`, { headers: { Origin: url.origin } });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await request({ type: 'agency.notifications.list' });
}
function request(message) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('Request timeout: ' + message.type)); }, 25_000);
    const listener = raw => {
      const answer = JSON.parse(raw);
      if (answer.requestId !== requestId) return;
      clearTimeout(timer); socket.off('message', listener);
      if (answer.type === 'agency.error' || answer.type === 'error') reject(new Error(answer.message ?? answer.code));
      else resolve(answer);
    };
    socket.on('message', listener); socket.send(JSON.stringify({ ...message, requestId }));
  });
}
const tabs = async () => (await request({ type: 'agency.webTabs.list' })).tabs;
const select = tab => request({ type: 'agency.webTab.select', workspaceId: workspace.id, tabId: tab.id });
const savedTabs = async () => JSON.parse(await readFile(path.join(config, 'agency-web-tabs.json'), 'utf8')).tabs;
const controllerToken = randomBytes(32).toString('hex');
let controllerPort;
async function startController(cdpPort) {
  controller = spawn('/usr/bin/python3', [path.join(repo, 'infra/neko/controller/tab_controller.py')], {
    env: { PATH: '/usr/bin:/bin', HOME: home, CONTROLLER_HOST: '127.0.0.1', CONTROLLER_PORT: String(controllerPort),
      CDP_HOST: '127.0.0.1', CDP_PORT: String(cdpPort), CONTROLLER_AUTH_TOKEN: controllerToken,
      CONTROLLER_REGISTRY_PATH: path.join(root, 'controller/ownership.json'), PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'ignore',
  });
  await until(async () => {
    if (controller.exitCode !== null) throw new Error('Disposable controller exited');
    try { return (await fetch(`http://127.0.0.1:${controllerPort}/tabs`, { headers: { Authorization: `Bearer ${controllerToken}` } })).ok; }
    catch { return false; }
  }, 'controller startup');
}
async function stopController() {
  if (!controller || controller.exitCode !== null) return;
  const ended = new Promise(resolve => controller.once('exit', resolve)); controller.kill('SIGTERM'); await ended;
}
async function pageFor(ref) {
  return until(async () => {
    for (const page of context.pages()) {
      const cdp = await context.newCDPSession(page);
      try { if ((await cdp.send('Target.getTargetInfo')).targetInfo.targetId === ref) return page; }
      finally { await cdp.detach(); }
    }
  }, 'owned Chromium page');
}
async function assertDurable(expectedShell, expectedWeb) {
  assert.deepEqual((await request({ type: 'agency.projects.list' })).projects, projects);
  assert.deepEqual((await request({ type: 'agency.workspaces.list' })).workspaces, workspaces);
  assert.equal(await readFile(path.join(config, 'agency-profiles.json'), 'utf8'), profileContents);
  const sessions = (await request({ type: 'agency.sessions.list' })).sessions;
  const recoveredNative = sessions.find(s => s.tab?.id === native.tab.id && s.tab.current);
  assert.equal(recoveredNative.nativeSessionId, nativeId);
  assert.equal(recoveredNative.profileId, native.profileId);
  assert.equal(recoveredNative.recovery.status, 'manual');
  assert.match(recoveredNative.recovery.message, /unverified/);
  const shell = sessions.find(s => s.tab?.id === expectedShell.tab.id && s.tab.current);
  assert.equal(shell.tab.name, 'Durable shell'); assert.equal(shell.tab.order, 1);
  assert.equal(shell.tab.selected, false); assert.equal(shell.lifecycle, 'running');
  assert.notEqual(shell.terminalId, expectedShell.terminalId, 'replacement PTY, same logical tab');
  const web = await tabs();
  assert.deepEqual(web.map(t => [t.id, t.title, t.url, t.order, t.selected]), expectedWeb);
  const notifications = (await request({ type: 'agency.notifications.list' })).notifications;
  assert.deepEqual(notifications.find(n => n.id === readNotification.id), readNotification);
  assert.deepEqual(notifications.find(n => n.id === doneNotification.id), doneNotification);
  const histories = await new SplitAgencySessionStore(path.join(config, 'agency-sessions.json')).load();
  assert.deepEqual(histories.find(s => s.id === history.id), history);
  assert.equal(await readFile(nativeHistoryFile, 'utf8'), nativeHistory);
  return shell;
}
let profileContents, nativeHistory, readNotification, doneNotification;
try {
  await mkdir(config, { recursive: true }); await mkdir(path.dirname(envFile), { recursive: true });
  await mkdir(path.dirname(unitFile), { recursive: true });
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({ version: 1, agents: { disabled: ['codex', 'claude-code', 'antigravity', 'opencode', 'pi'] } }));
  await writeFile(path.join(config, 'agency-state.json'), JSON.stringify({ version: 1, projects, workspaces }));
  const definitions = defaultDefinitions().map(p => ({ ...p, executable: path.join(root, 'never-launched', p.id) }));
  profileContents = JSON.stringify({ schemaVersion: 1, profiles: definitions });
  await writeFile(path.join(config, 'agency-profiles.json'), profileContents);
  await new SplitAgencySessionStore(path.join(config, 'agency-sessions.json')).save([native, history]);
  nativeHistory = JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: root } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic saved native history' }] } }) + '\n';
  await mkdir(path.dirname(nativeHistoryFile), { recursive: true });
  await writeFile(nativeHistoryFile, nativeHistory);
  const notifications = new AgencyNotificationStore(path.join(config, 'agency-notifications.json'));
  await notifications.initialize();
  const item = await notifications.create({ workspaceId: workspace.id, tabId: native.tab.id, title: 'Read fixture', body: 'synthetic', state: 'finished' });
  readNotification = await notifications.markRead(item.id);
  const done = await notifications.create({ workspaceId: workspace.id, tabId: native.tab.id, title: 'Done fixture', body: 'synthetic', state: 'finished' });
  doneNotification = await notifications.acknowledge(done.id);

  const portServer = createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  controllerPort = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  context = await chromium.launchPersistentContext(path.join(root, 'chromium-profile'), { channel: 'chrome', headless: true,
    args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname !== 'chatgpt.com') return route.abort();
    return route.fulfill({ contentType: 'text/html', body: `<title>Local conversation fixture</title><button onclick="history.pushState({},'', '${new URL(A).pathname}')">Conversation A</button><button onclick="history.pushState({},'', '${new URL(B).pathname}')">Conversation B</button>` });
  });
  const cdpPort = (await readFile(path.join(root, 'chromium-profile/DevToolsActivePort'), 'utf8')).split('\n')[0];
  await startController(cdpPort);
  const serviceEnv = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'), CODEX_HOME: path.join(home, '.codex'),
    PATH: '/usr/bin:/bin', SHELL: '/bin/bash', AGENT_WORKBENCH_NO_RESTORE: '1',
    NEKO_CONTROLLER_URL: `http://127.0.0.1:${controllerPort}`, NEKO_CONTROLLER_TOKEN: controllerToken };
  await writeFile(envFile, Object.entries(serviceEnv).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  // A separate clone lets us advance a release and remove the development source
  // without changing the user's branch, worktree registrations or app stores.
  await run('git', ['clone', '--quiet', '--no-hardlinks', repo, source]);
  await run('/bin/sh', [path.join(scripts, 'maw-update.sh'), '--initial', '--source', source, '--ref', 'HEAD', '--allow-unapproved-ref']);
  assert.ok(await readFile(path.join(stateDir, 'current/packages/web/dist/index.html')));
  await assert.rejects(readFile(path.join(stateDir, 'healthy')), /ENOENT/);
  const rendered = await run('/bin/sh', [path.join(scripts, 'maw-render-unit.sh')]);
  await writeFile(unitFile, rendered.stdout);
  await maw('start'); await connect();
  assert.equal((await fetch(ready.url)).status, 200);
  assert.equal((await fetch(new URL('/', ready.url))).status, 401);
  assert.equal((await fetch(ready.url, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal(await realpath(path.join(stateDir, 'healthy')), await realpath(path.join(stateDir, 'current')));
  const opener = path.join(root, 'open-browser-fixture');
  const openUrlFile = path.join(root, 'opened-url');
  await writeFile(opener, '#!/bin/sh\nprintf "%s" "$1" > "$MAW_OPEN_TEST_URL"\n', { mode: 0o700 });
  await run(path.join(scripts, 'maw'), ['open', opener], { env: { ...env, MAW_OPEN_TEST_URL: openUrlFile } });
  assert.equal(await readFile(openUrlFile, 'utf8'), ready.url, 'maw open transparently supplies internal authentication');
  const originalPid = ready.pid;
  await maw('start'); assert.match((await maw('status')).stdout, /Healthy/);
  assert.equal(Number((await run('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'])).stdout), originalPid);
  const firstRelease = await realpath(path.join(stateDir, 'current'));
  check('real first release under .local, private readiness, initial healthy transition, idempotent start');

  const shell = (await request({ type: 'agency.session.create', workspaceId: workspace.id, kind: 'terminal', cols: 100, rows: 30 })).session;
  await request({ type: 'agency.tab.rename', workspaceId: workspace.id, tabId: shell.tab.id, name: 'Durable shell' });
  const a = (await request({ type: 'agency.webTab.create', workspaceId: workspace.id, title: 'Conversation A', url: 'https://chatgpt.com/' })).tab;
  const b = (await request({ type: 'agency.webTab.create', workspaceId: workspace.id, title: 'Conversation B', url: 'https://chatgpt.com/' })).tab;
  const pageA = await pageFor(a.targetRef); const pageB = await pageFor(b.targetRef);
  // CDP-created targets can start their first request before Playwright attaches.
  // Load the locally fulfilled fixture after attachment before exercising its UI.
  await Promise.all([pageA.goto('https://chatgpt.com/'), pageB.goto('https://chatgpt.com/')]);
  await pageA.getByRole('button', { name: 'Conversation A', exact: true }).click();
  await pageB.getByRole('button', { name: 'Conversation B', exact: true }).click();
  await select(a);
  await request({ type: 'agency.tabs.order', workspaceId: workspace.id, tabIds: [b.id, shell.tab.id, a.id, native.tab.id] });
  // No socket-driven URL refresh: the periodic production poll must commit B.
  await until(async () => (await savedTabs()).some(t => t.id === b.id && t.url === B), 'background URL polling');
  const expectedWeb = [[b.id, b.title, B, 0, false], [a.id, a.title, A, 2, true]];
  assert.deepEqual((await tabs()).map(t => [t.id, t.title, t.url, t.order, t.selected]), expectedWeb);
  check('real Chromium selected/background navigation commits full conversation URLs');

  socket.terminate();
  await run('git', ['-C', source, '-c', 'user.name=MAW Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Disposable next release']);
  await maw('update', '--restart', '--ref', 'HEAD', '--allow-unapproved-ref');
  await connect();
  const shellAfterUpdate = await assertDurable(shell, expectedWeb);
  assert.notEqual(ready.pid, originalPid);
  assert.notEqual(await realpath(path.join(stateDir, 'current')), firstRelease);
  assert.equal(await realpath(path.join(stateDir, 'previous')), firstRelease);
  await select(a); await select(b); await select(a);
  assert.equal((await tabs()).find(t => t.id === a.id).targetRef, a.targetRef);
  assert.equal((await tabs()).find(t => t.id === b.id).targetRef, b.targetRef);
  assert.equal((await pageFor(a.targetRef)).url(), A);
  assert.equal((await pageFor(b.targetRef)).url(), B);
  assert.equal(context.pages().filter(p => p.url().startsWith('https://chatgpt.com/')).length, 2);
  check('real update preserves projects, workspaces, profiles, native IDs/manual recovery, tab metadata, notification read/Done, histories and owned browser targets');

  // Controller outage: preserve committed URLs, report recoverable failure, then
  // reconnect to the same durable receipts without opening duplicate targets.
  await stopController();
  await assert.rejects(select(a), /browser|engine|Neko/i);
  assert.equal((await tabs()).find(t => t.id === a.id).runtimeState, 'error');
  assert.deepEqual((await savedTabs()).map(t => t.url), [A, B]);
  socket.terminate(); await maw('restart'); await connect();
  assert.deepEqual((await tabs()).map(t => t.url), [B, A]);
  await startController(cdpPort);
  await select(a); assert.equal((await tabs()).find(t => t.id === a.id).targetRef, a.targetRef);
  assert.equal(context.pages().filter(p => p.url().startsWith('https://chatgpt.com/')).length, 2);
  check('Neko controller outage/restart preserves URLs and reconnects without duplicate targets');

  // Recreate a lost target from its last committed conversation address.
  await pageB.close(); await select(b);
  const recreated = (await tabs()).find(t => t.id === b.id);
  assert.notEqual(recreated.targetRef, b.targetRef);
  assert.equal((await pageFor(recreated.targetRef)).url(), B);
  await select(a);
  check('lost target is recreated at the last committed exact conversation URL');

  // Final URL capture must see navigation after the last regular poll. Its
  // completion is verified on disk before the next process acquires the store.
  const finalUrl = 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await pageA.evaluate(url => history.pushState({}, '', url), finalUrl);
  socket.terminate(); await maw('stop');
  assert.equal((await savedTabs()).find(t => t.id === a.id).url, finalUrl);
  await rm(source, { recursive: true, force: true });
  await maw('start'); await connect(); await select(a);
  assert.equal((await tabs()).find(t => t.id === a.id).url, finalUrl);
  assert.equal((await pageFor(a.targetRef)).url(), finalUrl);
  assert.equal(await realpath(path.join(stateDir, 'current')), await realpath(path.join(stateDir, 'healthy')));
  assert.ok((await request({ type: 'agency.sessions.list' })).sessions.some(s => s.tab?.id === shellAfterUpdate.tab.id && s.tab.current));
  check('shutdown final URL capture and startup survive removal of development source');

  // Roll back only the disposable release pointers; app stores stay in HOME.
  socket.terminate(); await maw('rollback'); await connect();
  assert.equal(await realpath(path.join(stateDir, 'current')), firstRelease);
  assert.equal((await tabs()).find(t => t.id === a.id).url, finalUrl);
  assert.equal(await readFile(path.join(config, 'agency-profiles.json'), 'utf8'), profileContents);
  check('verified executable rollback preserves persistent app stores');
} finally {
  socket?.terminate();
  await ctl('stop').catch(() => undefined); await ctl('reset-failed').catch(() => undefined);
  await rm(unitFile, { force: true });
  await stopController(); await context?.close();
  await rm(root, { recursive: true, force: true });
}

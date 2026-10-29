import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgencyRuntimeSession, AgencyWorkspace, RuntimeSessionId, TerminalId, WorkspaceId } from '@agent-workbench/shared';
import type { AgentAdapter } from '../agents/adapter.js';
import { AgentRegistry } from '../agents/registry.js';
import { CodexTurnWatcher, type CodexNativeTurn } from '../agents/codex/turn-watcher.js';
import { TerminalRegistry } from '../terminal-registry.js';
import { WorkspaceStore, type WorkspaceState } from '../workspace-store.js';
import { AgencySessionRuntime } from './agency-session-runtime.js';
import { AgencySessionStore } from './agency-session-store.js';
import { AgencyNotificationStore } from './agency-notification-store.js';
import { ShellIntegrationParser, ShellSequences } from './shell-integration.js';
import { TabActivityManager } from './tab-activity-manager.js';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 15));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 7000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for fixture'); await tick(); }
}
class MemorySessions extends AgencySessionStore {
  rows: AgencyRuntimeSession[] = [];
  override async load() { return this.rows; }
  override async save(rows: readonly AgencyRuntimeSession[]) { this.rows = [...rows]; }
}
class MemoryTerminals extends WorkspaceStore { override save(_state: WorkspaceState) {} }

test('OSC parser requires a command and preserves failures; chunks and large output cannot invent success', () => {
  const parser = new ShellIntegrationParser();
  parser.feed(ShellSequences.commandExit(0) + ShellSequences.promptStart);
  assert.equal(parser.getState(), 'idle');
  parser.feed(ShellSequences.commandStart + ShellSequences.commandExit(7) + ShellSequences.promptStart);
  assert.equal(parser.getState(), 'failed');
  parser.feed(ShellSequences.commandStart + '\x1b]133;D;\x07' + ShellSequences.promptStart);
  assert.equal(parser.getState(), 'unknown');
  parser.feed(ShellSequences.commandStart + 'output'.repeat(20000) + '\x1b]133;D;');
  assert.equal(parser.getState(), 'working');
  parser.feed('0\x1b'); parser.feed('\\');
  assert.equal(parser.getState(), 'finished');
  parser.acknowledge();
  parser.feed(ShellSequences.commandExit(0));
  assert.equal(parser.getState(), 'idle');
});

test('manager requires completion evidence, retains finished through exit/replay, and preserves acknowledged turns', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-activity-evidence-'));
  try {
    const store = new AgencyNotificationStore(path.join(root, 'notifications.json'));
    await store.initialize();
    const manager = new TabActivityManager({ notificationStore: store, storageDir: root });
    await manager.initialize();
    const base = { workspaceId: randomUUID() as WorkspaceId, tabId: randomUUID(), sessionId: randomUUID() as RuntimeSessionId, provider: 'claude-code', lifecycle: 'running' };
    await manager.handleCliActivity({ ...base, nextActivity: 'working' });
    await manager.handleCliActivity({ ...base, previousActivity: 'working', nextActivity: 'idle' });
    assert.equal(manager.getTabState(base.workspaceId, base.tabId), 'idle');
    assert.equal(store.list().length, 0);
    const native = { ...base, provider: 'codex', taskId: 'native:turn-a', completionEvidence: 'native-turn' as const };
    await manager.handleCliActivity({ ...native, nextActivity: 'working' });
    await manager.handleCliActivity({ ...native, nextActivity: 'finished' });
    await manager.handleCliActivity({ ...base, nextActivity: 'offline', lifecycle: 'exited', exitCode: 0 });
    assert.equal(manager.getTabState(base.workspaceId, base.tabId), 'finished');
    await manager.handleCliActivity({ ...native, nextActivity: 'working' });
    assert.equal(manager.getTabState(base.workspaceId, base.tabId), 'finished');
    await manager.acknowledgeTab(base.workspaceId, base.tabId);
    await manager.handleCliActivity({ ...native, nextActivity: 'finished' });
    assert.equal(manager.getTabState(base.workspaceId, base.tabId), 'idle');
    assert.equal(store.list().length, 1);
    const restarted = new TabActivityManager({ notificationStore: store, storageDir: root });
    await restarted.initialize();
    await restarted.handleCliActivity({ ...native, nextActivity: 'finished' });
    assert.equal(restarted.getTabState(base.workspaceId, base.tabId), 'idle');
    await restarted.handleCliActivity({ ...native, taskId: 'native:turn-b', nextActivity: 'working' });
    await restarted.handleCliActivity({ ...native, taskId: 'native:turn-b', nextActivity: 'finished' });
    assert.equal(store.list().length, 2);
    await restarted.acknowledgeTab(base.workspaceId, base.tabId);
    await restarted.handleCliActivity({ ...native, nextActivity: 'finished' });
    assert.equal(restarted.getTabState(base.workspaceId, base.tabId), 'idle', 'old turns cannot overwrite a newer acknowledged result');
    const closed = randomUUID();
    await restarted.closeTab(base.workspaceId, closed);
    await restarted.handleCliActivity({ ...native, tabId: closed, nextActivity: 'finished' });
    assert.equal(store.list().length, 2);
    const registered = await restarted.ensureTab({ ...base, source: 'cli' });
    assert.equal(registered.state, 'idle');
    await restarted.closeTab(base.workspaceId, base.tabId);
    assert.equal((await restarted.ensureTab({ ...base, source: 'cli' })).closed, true);
    assert.equal((await restarted.ensureTab({ ...base, sessionId: randomUUID() as RuntimeSessionId, source: 'cli' })).state, 'unknown');
    manager.dispose(); restarted.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed notification writes roll back mutations and deduplication so retries remain possible', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-notification-retry-'));
  const file = path.join(root, 'notifications.json');
  try {
    const store = new AgencyNotificationStore(file); await store.initialize();
    const input = { workspaceId: randomUUID() as WorkspaceId, tabId: randomUUID(), title: 'fixture', body: 'done', state: 'finished' as const, deduplicationKey: 'fixture-turn' };
    await mkdir(file);
    await assert.rejects(store.create(input));
    assert.equal(store.list().length, 0);
    await rm(file, { recursive: true });
    const notification = await store.create(input); assert.ok(notification);
    await rm(file); await mkdir(file);
    await assert.rejects(store.markAllRead());
    assert.equal(store.get(notification.id)?.read, false);
    await assert.rejects(store.markRead(notification.id));
    assert.equal(store.get(notification.id)?.read, false);
    await rm(file, { recursive: true });
    await store.markAllRead();
    assert.equal(store.get(notification.id)?.read, true);
    assert.equal(await store.create(input), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shell command identity advances after restart and acknowledges without losing durable acknowledgement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-shell-restart-'));
  try {
    const store = new AgencyNotificationStore(path.join(root, 'notifications.json'));
    await store.initialize();
    const ws = randomUUID() as WorkspaceId; const tab = randomUUID();
    for (let count = 1; count <= 2; count++) {
      const manager = new TabActivityManager({ notificationStore: store, storageDir: root });
      await manager.initialize();
      const parser = manager.getOrCreateShellParser(ws, tab);
      parser.feed(ShellSequences.commandStart + ShellSequences.commandExit(0));
      await manager.flush(); await store.flush();
      assert.equal(store.list().length, count);
      assert.equal(manager.getRecord(ws, tab)?.turnSequence, count);
      await manager.acknowledgeTab(ws, tab);
      assert.ok(manager.getRecord(ws, tab)?.acknowledgedAt);
      manager.dispose();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex native watcher scopes home/session/cwd, ignores history and output, and distinguishes complete/error/abort', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-codex-turns-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'maw-codex-foreign-'));
  const nativeId = randomUUID(); const at = Date.now(); const turns: CodexNativeTurn[] = [];
  const sessionDir = path.join(root, 'sessions', '2026', '10', '28');
  const file = path.join(sessionDir, `rollout-2026-10-28T00-00-00-${nativeId}.jsonl`);
  const line = (type: string, payload: object, time = at + 10) => JSON.stringify({ type, payload, timestamp: new Date(time).toISOString() }) + '\n';
  const event = (type: string, id: string, extra = {}, time = at + 10) => line('event_msg', { type, turn_id: id, ...extra }, time);
  const watcher = new CodexTurnWatcher({ home: root, cwd: root, sessionId: nativeId, launchedAt: at, onTurn: turn => turns.push(turn) });
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(file, line('session_meta', { id: nativeId, cwd: root }) + event('task_started', 'old', {}, at - 1000) + event('task_complete', 'old', {}, at - 900));
    await watcher.poll(); assert.equal(turns.length, 0);
    await appendFile(file, event('agent_message', 'fake') + event('task_complete', 'orphan'));
    await watcher.poll(); assert.equal(turns.length, 0);
    const start = event('task_started', 'a');
    await appendFile(file, start.slice(0, -4)); await watcher.poll(); assert.equal(turns.length, 0);
    await appendFile(file, start.slice(-4) + event('task_complete', 'a') + event('task_complete', 'a') + event('task_started', 'b') + event('task_complete', 'b', { error: { message: 'failure' } }) + event('turn_started', 'c') + event('turn_aborted', 'c'));
    await watcher.poll();
    assert.deepEqual(turns.map(turn => turn.phase), ['working', 'finished', 'working', 'failed', 'working', 'unknown']);
    assert.equal(turns[1]!.taskId, `${nativeId}:a`);
    await watcher.poll(); assert.equal(turns.length, 6);
    await writeFile(file, line('session_meta', { id: nativeId, cwd: '/unrelated' }) + event('task_started', 'mismatched') + event('task_complete', 'mismatched'));
    await watcher.poll(); assert.equal(turns.length, 6);
    // A similarly named rollout in another home cannot be opened via symlink.
    await rm(file);
    const foreign = path.join(outside, 'foreign.jsonl');
    await writeFile(foreign, line('session_meta', { id: nativeId, cwd: root }) + event('task_started', 'foreign') + event('task_complete', 'foreign'));
    await symlink(foreign, file);
    await watcher.poll(); assert.equal(turns.length, 6);
  } finally { watcher.dispose(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

for (const shell of ['bash', 'zsh']) test(`real ${shell} PTY through Agency runtime sources config and emits verified success/failure`, { skip: process.platform !== 'linux', timeout: 20000 }, async t => {
  try { await access('/bin/' + shell); } catch { t.skip('Shell unavailable'); return; }
  const root = await mkdtemp(path.join(tmpdir(), 'maw-runtime-' + shell + '-'));
  const home = path.join(root, 'home'); const app = path.join(root, 'app');
  await mkdir(home); await mkdir(app);
  const configDir = shell === 'zsh' ? path.join(home, 'custom-zdotdir') : home;
  if (shell === 'zsh') {
    await mkdir(configDir);
    await writeFile(path.join(home, '.zshenv'), 'ZDOTDIR="$HOME/custom-zdotdir"\n');
  }
  const configPath = path.join(configDir, shell === 'bash' ? '.bashrc' : '.zshrc');
  const config = 'export MAW_FIXTURE_CONFIG=preserved\n' + (shell === 'bash' ? 'PROMPT_COMMAND=(\'printf "user_prompt_hook\\n"\')\n' : 'precmd() { print -r -- user_prompt_hook; }\n');
  await writeFile(configPath, config);
  const adapter = { id: 'codex', environment: () => ({ env: { HOME: home, XDG_CONFIG_HOME: app, PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }, notice: null }) } as unknown as AgentAdapter;
  const agents = new AgentRegistry([adapter]);
  const registry = new TerminalRegistry(agents, { file: '/bin/' + shell, args: [], name: shell }, new MemoryTerminals(), () => null, async () => null, () => path.join(root, 'integration'));
  const rows = new MemorySessions(); const now = new Date().toISOString();
  const ws: AgencyWorkspace = { id: randomUUID() as WorkspaceId, projectId: randomUUID() as AgencyWorkspace['projectId'], cwd: root, name: 'fixture', status: 'active', createdAt: now, updatedAt: now, doneAt: null };
  const runtime = new AgencySessionRuntime({ registry, workspaces: { protectedDirectories: () => [], withSessionReservation: async (id, action) => action(id === ws.id ? ws : null) }, profiles: { resolveLaunch: async () => { throw new Error('No real CLI launch allowed'); } }, store: rows });
  const notifications = new AgencyNotificationStore(path.join(root, 'notifications.json'));
  const manager = new TabActivityManager({ notificationStore: notifications, storageDir: root });
  let terminal: TerminalId | null = null; let output = '';
  try {
    await notifications.initialize(); await manager.initialize(); await runtime.initialize();
    const session = await runtime.create({ kind: 'terminal', workspaceId: ws.id, cols: 100, rows: 30 });
    terminal = session.terminalId!;
    const parser = manager.getOrCreateShellParser(ws.id, session.tab!.id);
    const attached = registry.attach(terminal, (_id, chunk) => { output += chunk; parser.feed(chunk); });
    output += attached?.replay ?? ''; parser.feed(attached?.replay ?? '');
    await until(() => parser.hasIntegration());
    assert.equal(notifications.list().length, 0, 'startup prompt is not a completion');
    assert.equal(registry.write(terminal, 'printf "config:%s\\n" "$MAW_FIXTURE_CONFIG"\r'), true);
    await until(() => parser.getState() === 'finished');
    assert.match(output, /config:preserved/);
    assert.match(output, /user_prompt_hook/);
    await manager.flush(); await notifications.flush();
    assert.equal(notifications.list().length, 1);
    await manager.acknowledgeTab(ws.id, session.tab!.id);
    registry.write(terminal, '(exit 23)\r');
    await until(() => parser.getState() === 'failed');
    await tick(); assert.equal(parser.getState(), 'failed', 'prompt must not erase failure');
    await manager.flush(); await notifications.flush();
    assert.equal(notifications.list().length, 2);
    const selected = runtime.list(ws.id).find(row => row.tab?.selected)!;
    await runtime.clearWorkspaceSelection(ws.id);
    assert.equal(runtime.list(ws.id).some(row => row.tab?.selected), false);
    assert.equal(registry.get(terminal)?.alive, true);
    assert.equal(rows.rows.find(row => row.id === selected.id)?.tab?.selected, false);
    assert.equal(await readFile(configPath, 'utf8'), config);
    registry.write(terminal, 'exit\r');
    await until(() => runtime.get(session.id)?.lifecycle === 'exited');
  } finally {
    if (terminal) registry.close(terminal);
    runtime.dispose(); manager.dispose();
    await manager.flush(); await notifications.flush();
    await rm(root, { recursive: true, force: true });
  }
});


test('Codex evidence loss becomes unknown once, without inventing a completion', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'maw-codex-loss-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const id = randomUUID(), at=Date.now(), turns:CodexNativeTurn[]=[];
  const folder=path.join(root,'sessions','2026','10','28'); await mkdir(folder,{recursive:true});
  const file=path.join(folder,`rollout-2026-10-28T00-00-00-${id}.jsonl`);
  const lines=[{type:'session_meta',payload:{id,cwd:root}},{type:'event_msg',timestamp:new Date(at+1).toISOString(),payload:{type:'task_started',turn_id:'active'}}];
  await writeFile(file,lines.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const watcher=new CodexTurnWatcher({home:root,cwd:root,sessionId:id,launchedAt:at,onTurn:turn=>turns.push(turn)});t.after(()=>watcher.dispose());
  await watcher.poll();assert.deepEqual(turns.map(t=>t.phase),['working']);
  await rename(file,path.join(root,'backup.jsonl')); // retain fixture evidence before loss
  await watcher.poll();await watcher.poll();
  assert.deepEqual(turns.map(t=>t.phase),['working','unknown']);
});

test('Codex delayed evidence recovery and successive turns never duplicate or infer completion', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-codex-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = randomUUID(), at = Date.now(), turns: CodexNativeTurn[] = [];
  const folder = path.join(root, 'sessions', '2026', '10', '28'); await mkdir(folder, { recursive: true });
  const file = path.join(folder, `rollout-2026-10-28T00-00-00-${id}.jsonl`);
  const saved = path.join(root, 'saved.jsonl');
  const event = (type: string, turn_id: string) => JSON.stringify({ type: 'event_msg', timestamp: new Date(at + 1).toISOString(), payload: { type, turn_id } }) + '\n';
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n' + event('task_started', 'first'));
  const watcher = new CodexTurnWatcher({ home: root, cwd: root, sessionId: id, launchedAt: at, onTurn: turn => turns.push(turn) });
  t.after(() => watcher.dispose());
  await watcher.poll(); await rename(file, saved); await watcher.poll(); await watcher.poll();
  assert.deepEqual(turns.map(turn => turn.phase), ['working', 'unknown']);
  await rename(saved, file);
  const completion = event('task_complete', 'first');
  await appendFile(file, completion.slice(0, -3)); await watcher.poll();
  assert.equal(turns.at(-1)?.phase, 'unknown', 'incomplete completion cannot finish a task');
  await appendFile(file, completion.slice(-3)); await watcher.poll();
  assert.equal(turns.at(-1)?.phase, 'finished', 'explicit delayed evidence restores completion');
  const events = Array.from({ length: 100 }, (_, n) => event('task_started', 'turn-' + n) + event('task_complete', 'turn-' + n)).join('');
  await appendFile(file, '{invalid JSON}\n' + 'x'.repeat(300 * 1024) + '\n' + events);
  await watcher.poll(); await watcher.poll();
  assert.equal(turns.filter(turn => turn.phase === 'finished').length, 101);
  await appendFile(file, events); await watcher.poll();
  assert.equal(turns.filter(turn => turn.phase === 'finished').length, 101, 'replayed turns remain deduplicated');
  watcher.dispose(); await appendFile(file, event('task_started', 'late')); await watcher.poll();
  assert.equal(turns.length, 203, 'disposed watcher cannot emit late activity');
});

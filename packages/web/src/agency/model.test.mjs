// Run with Node 22+: node --experimental-strip-types --test packages/web/src/agency/model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeByProject, acknowledgeWorkspaceDraft, canLaunchAgent, workspaceTabs,
  putWorkspaceDraft, selectableEfforts, selectableModels, transitionNotice,
  createAgencyTransport, parseProfileArgv,
} from './model.ts';

const emptyCapabilities = {
  canLaunch: true, canResumeNativeSession: false, canInterrupt: true,
  canReportActivity: false, canSelectModel: false, canSelectEffort: false,
  canRequestPermissions: false, models: [], discovery: 'unavailable',
};

test('Active and Done navigation preserves archive metadata', () => {
  const projects = [{ id: 'project-1', name: 'Project A' }, { id: 'project-2', name: 'Project B' }];
  const workspaces = [
    { id: 'active', name: 'Active lane', projectId: 'project-1', status: 'active', updatedAt: '2026-10-27' },
    { id: 'done', name: 'Done lane', projectId: 'project-1', status: 'done', updatedAt: '2026-10-26' },
    { id: 'other', name: 'Other', projectId: 'project-2', status: 'active', updatedAt: '2026-10-25' },
  ];
  const groups = activeByProject(projects, workspaces);
  assert.deepEqual(groups.map((group) => group.items.map((ws) => ws.id)), [['active'], ['other']]);
  assert.equal(workspaces.find((ws) => ws.id === 'done').status, 'done');
});


test('Explicit current tab identities retain order; closed/history rows never become selected views', () => {
  const row=(id,order,extra={})=>({id,workspaceId:'ws',kind:'agent',tab:{id,order,current:true,closedAt:null,selected:false,...extra}});
  const sessions=[row('b',2),row('a',1),row('closed',3,{closedAt:'2026-10-28'}),row('old',0,{current:false})];
  assert.deepEqual(workspaceTabs(sessions,'ws').map(s=>s.id),['a','b']);
  assert.deepEqual(workspaceTabs(sessions,'missing'),[]);
});

test('Do not invent models or reasoning effort for undetected native profiles', () => {
  const missing = { configurationStatus: 'not-installed', capabilities: emptyCapabilities };
  assert.equal(canLaunchAgent(missing), false);
  assert.deepEqual(selectableModels(emptyCapabilities), []);
  assert.deepEqual(selectableEfforts(emptyCapabilities, null), []);
  const native = {
    ...emptyCapabilities, canSelectModel: true, canSelectEffort: true,
    discovery: 'native', models: [{ id: 'discovered-model', label: 'Detected', effortOptions: ['high'], isDefault: true }],
  };
  assert.deepEqual(selectableModels(native).map((model) => model.id), ['discovered-model']);
  assert.deepEqual(selectableEfforts(native, 'discovered-model'), ['high']);
  assert.deepEqual(selectableEfforts(native, 'unsupported-model'), []);
});

test('Draft preservation is per workspace and late acknowledgement cannot erase edits', () => {
  const base = putWorkspaceDraft({}, 'workspace-a', 'first prompt');
  const two = putWorkspaceDraft(base, 'workspace-b', 'other task');
  const edited = putWorkspaceDraft(two, 'workspace-a', 'edited prompt');
  const late = acknowledgeWorkspaceDraft(edited, 'workspace-a', 'first prompt');
  assert.equal(late['workspace-a'], 'edited prompt');
  assert.equal(late['workspace-b'], 'other task');
  const delivered = acknowledgeWorkspaceDraft(late, 'workspace-a', 'edited prompt');
  assert.equal(delivered['workspace-a'], '');
  assert.equal(delivered['workspace-b'], 'other task');
});

test('Only server-confirmed state transitions cause attention/completion notices', () => {
  const initial = { kind: 'agent', activity: 'working', lifecycle: 'running' };
  assert.equal(transitionNotice(null, initial), null);
  assert.equal(transitionNotice(initial, initial), null);
  const attention = { kind: 'agent', activity: 'awaiting-permission', lifecycle: 'running' };
  assert.equal(transitionNotice(initial, attention), 'attention');
  assert.equal(transitionNotice(attention, attention), null);
  const idle = { kind: 'agent', activity: 'idle', lifecycle: 'running' };
  assert.equal(transitionNotice(initial, idle), 'completed');
  const stopped = { kind: 'agent', activity: 'offline', lifecycle: 'exited' };
  assert.equal(transitionNotice(idle, stopped), null);
  assert.equal(transitionNotice({ kind: 'terminal', activity: 'working', lifecycle: 'running' },
    { kind: 'terminal', activity: 'idle', lifecycle: 'running' }), null);
});

test('Offline mutation and explicit Stop never enter legacy replay outbox', () => {
  const outbox = [];
  const wire = [];
  let open = false;
  const connection = {
    send(message) { if (!open) outbox.push(message); return false; },
    sendImmediate(message) { if (!open) return false; wire.push(message); return true; },
    onMessage() { return () => {}; },
  };
  const adapter = createAgencyTransport(connection);
  const create = { type: 'agency.workspace.create', requestId: 'a', projectId: 'p', name: 'lane', pickerId: 'picker' };
  const done = { type: 'agency.workspace.done', requestId: 'b', workspaceId: 'lane' };
  const restore = { type: 'agency.workspace.restore', requestId: 'c', workspaceId: 'lane' };
  const configure = { type: 'agency.profile.configure', requestId: 'd', profileId: 'profile', executable: 'codex00' };
  const launch = { type: 'agency.session.create', requestId: 'e', workspaceId: 'lane', kind: 'terminal', cols: 80, rows: 24 };
  const stop = { type: 'terminal.close', terminalId: 'terminal-id' };
  for (const message of [create, done, restore, configure, launch, stop]) {
    assert.equal(adapter.sendImmediate(message), false);
  }
  assert.deepEqual(outbox, []);
  open = true;
  assert.deepEqual(wire, [], 'Reconnect must not replay rejected operations');
  assert.equal(adapter.sendImmediate(stop), true);
  assert.deepEqual(wire, [stop]);
});

test('Missing immediate transport fails closed, never falls back to queued send', () => {
  const connection = { send: () => { throw new Error('queued send should not run'); },
    onMessage: () => () => {} };
  assert.throws(() => createAgencyTransport(connection), /non-queueing/);
});

test('Profile argv JSON preserves spaces and rejects shell-like parsing', () => {
  assert.deepEqual(parseProfileArgv('["--model", "two words", "--flag=x y"]'), ['--model', 'two words', '--flag=x y']);
  assert.deepEqual(parseProfileArgv('[]'), []);
  assert.equal(parseProfileArgv('--model two words'), null);
  assert.equal(parseProfileArgv('["okay", 123]'), null);
  assert.equal(parseProfileArgv('{"args": ["test"]}'), null);
});

test('Session notices remain independent for two agents in the same workspace', () => {
  const one={kind:'agent',lifecycle:'running',activity:'working'};
  const two={kind:'agent',lifecycle:'running',activity:'idle'};
  assert.equal(transitionNotice(one,{...one,activity:'awaiting-user'}),'attention');
  assert.equal(transitionNotice(two,two),null);
});

// Run with Node 22+: node --experimental-strip-types --test packages/web/src/agency/model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeByProject, acknowledgeWorkspaceDraft, canLaunchAgent, currentSession,
  putWorkspaceDraft, selectableEfforts, selectableModels, transitionNotice, workspaceLayout,
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

test('Empty, terminal-only, agent-only and combined layouts are disjoint', () => {
  assert.equal(workspaceLayout(false, false), 'empty');
  assert.equal(workspaceLayout(false, true), 'terminal-only');
  assert.equal(workspaceLayout(true, false), 'agent-only');
  assert.equal(workspaceLayout(true, true), 'combined');
});

test('One active slot per kind is selected independently', () => {
  const sessions = [
    { id: 'shell-1', workspaceId: 'ws', kind: 'terminal', lifecycle: 'running' },
    { id: 'agent-old', workspaceId: 'ws', kind: 'agent', lifecycle: 'exited' },
    { id: 'agent-2', workspaceId: 'ws', kind: 'agent', lifecycle: 'running' },
    { id: 'other', workspaceId: 'other-ws', kind: 'agent', lifecycle: 'running' },
  ];
  assert.equal(currentSession(sessions, 'ws', 'terminal').id, 'shell-1');
  assert.equal(currentSession(sessions, 'ws', 'agent').id, 'agent-2');
  assert.equal(currentSession(sessions, 'missing', 'agent'), undefined);
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
  assert.equal(transitionNotice(idle, stopped), 'completed');
  assert.equal(transitionNotice({ kind: 'terminal', activity: 'working', lifecycle: 'running' },
    { kind: 'terminal', activity: 'idle', lifecycle: 'running' }), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  resolveEffectiveBrowserProfileId,
} from '@agent-workbench/shared';
import {
  EMPTY_AGENCY_SNAPSHOT,
  activeByProject,
  pruneProjectData,
  pruneWorkspaceData,
} from '../../../src/agency/model.ts';
import { calculateAnchoredDialogPosition } from '../../../src/shared/lib/overlay-position.ts';
import { DeleteWorkspaceDialog } from '../../../src/features/workspaces/DeleteWorkspaceDialog.tsx';
import { DeleteProjectDialog } from '../../../src/features/workspaces/DeleteProjectDialog.tsx';
import { AgencyWorkspaceCreator } from '../../../src/agency/AgencyWorkspaceCreator.tsx';
import { editorDraftStore } from '../../../src/agency/editorDraftStore.ts';

test('Track D: activeByProject preserves persisted workspace ordering instead of re-sorting by updatedAt', () => {
  const projects = [
    { id: 'p1', name: 'Project 1', status: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  ];
  const workspaces = [
    { id: 'ws-older', projectId: 'p1', name: 'First in Order', status: 'active', cwd: '/a', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'ws-newer', projectId: 'p1', name: 'Second in Order', status: 'active', cwd: '/b', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z' },
  ];

  const grouped = activeByProject(projects, workspaces);
  assert.deepEqual(
    grouped[0].items.map((w) => w.id),
    ['ws-older', 'ws-newer'],
  );
});

test('Track C: pruneWorkspaceData and pruneProjectData clean all associated sessions, tabs, layouts, and warnings', () => {
  const snapshot = {
    ...EMPTY_AGENCY_SNAPSHOT,
    projects: [
      { id: 'p1', name: 'P1', status: 'active', createdAt: '', updatedAt: '' },
      { id: 'p2', name: 'P2', status: 'active', createdAt: '', updatedAt: '' },
    ],
    workspaces: [
      { id: 'ws1', projectId: 'p1', name: 'WS1', status: 'active', cwd: '/1', createdAt: '', updatedAt: '' },
      { id: 'ws2', projectId: 'p1', name: 'WS2', status: 'done', cwd: '/2', createdAt: '', updatedAt: '' },
      { id: 'ws3', projectId: 'p2', name: 'WS3', status: 'active', cwd: '/3', createdAt: '', updatedAt: '' },
    ],
    sessions: [
      { id: 's1', workspaceId: 'ws1', kind: 'terminal', terminalId: 't1', lifecycle: 'running', activity: 'idle', exitCode: null, createdAt: '', updatedAt: '' },
      { id: 's2', workspaceId: 'ws2', kind: 'agent', profileId: 'codex', terminalId: 't2', lifecycle: 'running', activity: 'working', exitCode: null, createdAt: '', updatedAt: '' },
      { id: 's3', workspaceId: 'ws3', kind: 'terminal', terminalId: 't3', lifecycle: 'running', activity: 'idle', exitCode: null, createdAt: '', updatedAt: '' },
    ],
    webTabs: [
      { id: 'w1', workspaceId: 'ws1', kind: 'web', title: 'ChatGPT', url: 'https://chatgpt.com/', order: 0, selected: true, closedAt: null, createdAt: '', updatedAt: '' },
      { id: 'w3', workspaceId: 'ws3', kind: 'web', title: 'GitHub', url: 'https://github.com/', order: 0, selected: true, closedAt: null, createdAt: '', updatedAt: '' },
    ],
    editorTabs: [
      { id: 'e1', workspaceId: 'ws1', kind: 'editor', title: 'a.ts', filePath: 'a.ts', order: 1, selected: false, closedAt: null, createdAt: '', updatedAt: '' },
    ],
    layouts: {
      ws1: { workspaceId: 'ws1', version: 1, updatedAt: '', focusedPaneId: 'p', maximizedPaneId: null, tree: { type: 'pane', id: 'p', tabIds: [], selectedTabId: null } },
      ws2: { workspaceId: 'ws2', version: 1, updatedAt: '', focusedPaneId: 'p', maximizedPaneId: null, tree: { type: 'pane', id: 'p', tabIds: [], selectedTabId: null } },
      ws3: { workspaceId: 'ws3', version: 1, updatedAt: '', focusedPaneId: 'p', maximizedPaneId: null, tree: { type: 'pane', id: 'p', tabIds: [], selectedTabId: null } },
    },
    layoutWarnings: { ws1: 'warn1', ws3: 'warn3' },
  };

  const afterWs1 = pruneWorkspaceData(snapshot, 'ws1');
  assert.deepEqual(afterWs1.workspaces.map((w) => w.id), ['ws2', 'ws3']);
  assert.deepEqual(afterWs1.sessions.map((s) => s.id), ['s2', 's3']);
  assert.deepEqual(afterWs1.webTabs.map((w) => w.id), ['w3']);
  assert.equal(afterWs1.editorTabs.length, 0);
  assert.equal('ws1' in afterWs1.layouts, false);
  assert.equal('ws1' in (afterWs1.layoutWarnings ?? {}), false);

  const afterP1 = pruneProjectData(snapshot, 'p1');
  assert.deepEqual(afterP1.projects.map((p) => p.id), ['p2']);
  assert.deepEqual(afterP1.workspaces.map((w) => w.id), ['ws3']);
  assert.deepEqual(afterP1.sessions.map((s) => s.id), ['s3']);
  assert.deepEqual(afterP1.webTabs.map((w) => w.id), ['w3']);
  assert.deepEqual(Object.keys(afterP1.layouts), ['ws3']);
});

test('Track C: calculateAnchoredDialogPosition places confirmation dialog outside sidebar to the right of trigger', () => {
  const pos = calculateAnchoredDialogPosition({
    triggerRect: { left: 12, top: 140, right: 236, bottom: 172 },
    dialogWidth: 360,
    dialogHeight: 220,
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  assert.equal(pos.left, 246);
  assert.equal(pos.top, 132);

  // Clamps inside bottom-right viewport edges
  const clamped = calculateAnchoredDialogPosition({
    triggerRect: { left: 12, top: 720, right: 236, bottom: 752 },
    dialogWidth: 360,
    dialogHeight: 240,
    viewportWidth: 500,
    viewportHeight: 800,
  });
  assert.ok(clamped.left + 360 <= 500 - 12);
  assert.ok(clamped.top + 240 <= 800 - 12);
});

test('pane confirmation centers over its pane and stays within the viewport', () => {
  const dimensions = {
    alignment: 'center',
    dialogWidth: 360,
    dialogHeight: 220,
    viewportWidth: 1280,
    viewportHeight: 800,
  };
  assert.deepEqual(calculateAnchoredDialogPosition({
    ...dimensions,
    triggerRect: { left: 800, top: 280, right: 1200, bottom: 680 },
  }), { left: 820, top: 370 });
  assert.deepEqual(calculateAnchoredDialogPosition({
    ...dimensions,
    triggerRect: { left: 1200, top: 750, right: 1280, bottom: 800 },
  }), { left: 908, top: 568 });
});

test('Track C: DeleteWorkspaceDialog and DeleteProjectDialog summarize active sessions, editor drafts, and cascade workspaces', () => {
  editorDraftStore.setDraft('ed-dirty', {
    mode: 'edit',
    scrollTop: 0,
    edit: { opened: 'const a = 1;', text: 'const a = 2;', baseHash: 'h1', saving: false, conflict: null, failure: null, pending: null },
  });

  const ws = { id: 'ws1', projectId: 'p1', name: 'Feature Lane', status: 'active', cwd: '/repo', createdAt: '', updatedAt: '' };
  const wsHtml = renderToStaticMarkup(
    React.createElement(DeleteWorkspaceDialog, {
      workspace: ws,
      sessions: [
        { id: 's1', workspaceId: 'ws1', kind: 'agent', profileId: 'codex', terminalId: 't1', lifecycle: 'running', activity: 'working', exitCode: null, createdAt: '', updatedAt: '' },
      ],
      webTabs: [
        { id: 'w1', workspaceId: 'ws1', kind: 'web', title: 'ChatGPT', url: 'https://chatgpt.com/', order: 0, selected: true, closedAt: null, createdAt: '', updatedAt: '' },
      ],
      editorTabs: [
        { id: 'ed-dirty', workspaceId: 'ws1', kind: 'editor', title: 'main.ts', filePath: 'main.ts', order: 1, selected: false, closedAt: null, createdAt: '', updatedAt: '' },
      ],
      anchorRect: { left: 10, top: 80, right: 230, bottom: 110 },
      onConfirm: () => {},
      onClose: () => {},
    }),
  );

  assert.ok(wsHtml.includes('1 open editor tab (1 unsaved)'));
  assert.ok(wsHtml.includes('agency-anchored-dialog'));

  const projHtml = renderToStaticMarkup(
    React.createElement(DeleteProjectDialog, {
      project: { id: 'p1', name: 'Core Platform', status: 'active', createdAt: '', updatedAt: '' },
      workspaces: [
        ws,
        { id: 'ws2', projectId: 'p1', name: 'Done Lane', status: 'done', cwd: '/repo2', createdAt: '', updatedAt: '' },
      ],
      sessions: [
        { id: 's1', workspaceId: 'ws1', kind: 'agent', profileId: 'codex', terminalId: 't1', lifecycle: 'running', activity: 'working', exitCode: null, createdAt: '', updatedAt: '' },
      ],
      webTabs: [],
      editorTabs: [
        { id: 'ed-dirty', workspaceId: 'ws1', kind: 'editor', title: 'main.ts', filePath: 'main.ts', order: 1, selected: false, closedAt: null, createdAt: '', updatedAt: '' },
      ],
      anchorRect: { left: 10, top: 50, right: 230, bottom: 80 },
      onConfirm: () => {},
      onClose: () => {},
    }),
  );

  assert.ok(projHtml.includes('2 workspaces (1 active, 1 done)'));
  assert.ok(projHtml.includes('Source directories on disk will not be deleted.'));
  assert.ok(projHtml.includes('1 open editor tab (1 unsaved)'));
  editorDraftStore.clearDraft('ed-dirty');
});

test('C-04: archived projects are excluded from activeByProject and AgencyWorkspaceCreator', () => {
  const projects = [
    { id: 'p-active', name: 'Active Project', status: 'active', createdAt: '', updatedAt: '' },
    { id: 'p-archived', name: 'Archived Project', status: 'archived', createdAt: '', updatedAt: '' },
  ];
  const workspaces = [
    { id: 'ws-a', projectId: 'p-active', name: 'WS A', status: 'active', cwd: '/a', createdAt: '', updatedAt: '' },
    { id: 'ws-b', projectId: 'p-archived', name: 'WS B', status: 'active', cwd: '/b', createdAt: '', updatedAt: '' },
  ];

  const grouped = activeByProject(projects, workspaces);
  assert.deepEqual(grouped.map((g) => g.project.id), ['p-active']);

  const creatorHtml = renderToStaticMarkup(
    React.createElement(AgencyWorkspaceCreator, {
      projects,
      initialProject: 'p-archived',
      connection: {},
      onCreate: async () => {},
      onClose: () => {},
    }),
  );
  assert.ok(creatorHtml.includes('Active Project'));
  assert.ok(!creatorHtml.includes('Archived Project'));
});

test('C-19: resolveEffectiveBrowserProfileId falls back when assigned profileId is stale or deleted', () => {
  const knownProfiles = [
    { id: 'main' },
    { id: 'prof-valid' },
  ];

  // Stale workspace profile falls back to valid project profile
  assert.equal(
    resolveEffectiveBrowserProfileId(
      { browserProfileId: 'prof-deleted' },
      { browserProfileId: 'prof-valid' },
      knownProfiles,
    ),
    'prof-valid',
  );

  // Stale workspace and project profiles fall back to main
  assert.equal(
    resolveEffectiveBrowserProfileId(
      { browserProfileId: 'prof-deleted' },
      { browserProfileId: 'prof-also-deleted' },
      knownProfiles,
    ),
    DEFAULT_BROWSER_PROFILE_ID,
  );

  // Known custom profile is preserved
  assert.equal(
    resolveEffectiveBrowserProfileId(
      { browserProfileId: 'prof-valid' },
      { browserProfileId: null },
      knownProfiles,
    ),
    'prof-valid',
  );
});

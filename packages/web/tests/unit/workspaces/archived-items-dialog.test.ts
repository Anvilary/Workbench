import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { AgencyProject, AgencyWorkspace, ProjectId, WorkspaceId } from '@anvilary/workbench-shared';
import { ArchivedItemsDialog } from '../../../src/features/workspaces/ArchivedItemsDialog.js';

globalThis.React = React;

const now = new Date('2026-11-20T10:00:00Z').toISOString();

const mockProjects: AgencyProject[] = [
  { id: 'p1' as ProjectId, name: 'Alpha Project', status: 'archived', createdAt: now, updatedAt: now, archivedAt: now },
  { id: 'p2' as ProjectId, name: 'Beta Project', status: 'active', createdAt: now, updatedAt: now, archivedAt: null },
  { id: 'p3' as ProjectId, name: 'Gamma Tools', status: 'archived', createdAt: now, updatedAt: now, archivedAt: now },
];

const mockWorkspaces: AgencyWorkspace[] = [
  { id: 'w1' as WorkspaceId, projectId: 'p1' as ProjectId, name: 'Alpha Main', status: 'archived', cwd: '/tmp/w1', createdAt: now, updatedAt: now, archivedAt: now, doneAt: null },
  { id: 'w2' as WorkspaceId, projectId: 'p2' as ProjectId, name: 'Beta Dev', status: 'active', cwd: '/tmp/w2', createdAt: now, updatedAt: now, archivedAt: null, doneAt: null },
  { id: 'w3' as WorkspaceId, projectId: 'p2' as ProjectId, name: 'Beta Archive', status: 'archived', cwd: '/tmp/w3', createdAt: now, updatedAt: now, archivedAt: now, doneAt: null },
];

test('ArchivedItemsDialog: renders dialog with archived projects and tabs', () => {
  const html = renderToString(
    React.createElement(ArchivedItemsDialog, {
      projects: mockProjects,
      workspaces: mockWorkspaces,
      onUnarchiveProject: () => {},
      onRestoreWorkspace: () => {},
      onClose: () => {},
    })
  );

  // Dialog container and title
  assert.ok(html.includes('Archived Items'), 'Renders Archived Items title');
  assert.ok(html.includes('wb-archived-dialog'), 'Uses wb-archived-dialog class');

  // Tabs with counts: 2 archived projects (p1, p3), 2 archived workspaces (w1, w3)
  assert.ok(html.includes('Projects (2)'), 'Renders Projects tab with count 2');
  assert.ok(html.includes('Workspaces (2)'), 'Renders Workspaces tab with count 2');

  // Default tab is Projects: p1 and p3 should be present, active p2 should not
  assert.ok(html.includes('Alpha Project'), 'Shows archived Alpha Project');
  assert.ok(html.includes('Gamma Tools'), 'Shows archived Gamma Tools');
  assert.ok(!html.includes('Beta Project'), 'Active Beta Project is not shown');

  // Restore button is rendered
  assert.ok(html.includes('Restore'), 'Renders Restore button');
  assert.ok(html.includes('Search archived items...'), 'Renders search input');
});

test('ArchivedItemsDialog: displays empty state when no items are archived', () => {
  const emptyProjects: AgencyProject[] = [
    { id: 'p2' as ProjectId, name: 'Beta Project', status: 'active', createdAt: now, updatedAt: now, archivedAt: null },
  ];
  const emptyWorkspaces: AgencyWorkspace[] = [
    { id: 'w2' as WorkspaceId, projectId: 'p2' as ProjectId, name: 'Beta Dev', status: 'active', cwd: '/tmp/w2', createdAt: now, updatedAt: now, archivedAt: null, doneAt: null },
  ];

  const html = renderToString(
    React.createElement(ArchivedItemsDialog, {
      projects: emptyProjects,
      workspaces: emptyWorkspaces,
      onUnarchiveProject: () => {},
      onRestoreWorkspace: () => {},
      onClose: () => {},
    })
  );

  assert.ok(html.includes('Projects (0)'), 'Projects count is 0');
  assert.ok(html.includes('Workspaces (0)'), 'Workspaces count is 0');
  assert.ok(html.includes('No archived projects'), 'Shows No archived projects empty state');
});

test('ArchivedItemsDialog: offline state disables restore buttons', () => {
  const html = renderToString(
    React.createElement(ArchivedItemsDialog, {
      projects: mockProjects,
      workspaces: mockWorkspaces,
      onUnarchiveProject: () => {},
      onRestoreWorkspace: () => {},
      onClose: () => {},
      online: false,
    })
  );

  assert.ok(html.includes('disabled=""'), 'Restore buttons are disabled when offline');
});

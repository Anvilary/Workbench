import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  parseAgencyClientMessage,
  parseAgencyServerMessage,
  partitionForBrowserProfile,
  resolveEffectiveBrowserProfileId,
} from '@anvilary/workbench-shared';
import { BrowserProfileStore } from '../../../src/features/browser/browser-profile-store.js';
import { handleAgencyDomainRequest, type AgencyDomainContext } from '../../../src/features/workspaces/workspace-request-handler.js';
import { AgencyWorkspaceStore } from '../../../src/features/workspaces/workspace-store.js';
import { DirectoryPickers } from '../../../src/features/files/directory-picker.js';

test('browser profile partition mapping preserves legacy Main partitions cleanly', () => {
  assert.equal(partitionForBrowserProfile('main', 'chatgpt'), 'persist:workbench-chatgpt');
  assert.equal(partitionForBrowserProfile(undefined, 'github'), 'persist:workbench-github');
  assert.equal(partitionForBrowserProfile(null, 'perplexity'), 'persist:workbench-perplexity');
  assert.equal(partitionForBrowserProfile('main', 'other'), 'persist:workbench-browser');
  assert.equal(partitionForBrowserProfile('bp_work1', 'chatgpt'), 'persist:workbench-profile-bp_work1-chatgpt');
  assert.equal(partitionForBrowserProfile('bp_work1', 'other'), 'persist:workbench-profile-bp_work1-browser');
});

test('browser profile resolution order: workspace -> project -> Main', () => {
  assert.equal(resolveEffectiveBrowserProfileId(null, null), DEFAULT_BROWSER_PROFILE_ID);
  assert.equal(resolveEffectiveBrowserProfileId({}, { browserProfileId: 'bp_proj' }), 'bp_proj');
  assert.equal(resolveEffectiveBrowserProfileId({ browserProfileId: 'bp_ws' }, { browserProfileId: 'bp_proj' }), 'bp_ws');
  assert.equal(resolveEffectiveBrowserProfileId({ browserProfileId: null }, { browserProfileId: 'bp_proj' }), 'bp_proj');
});

test('BrowserProfileStore CRUD, backup recovery, Main protection, and store reference clearing', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bp-store-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const profileStore = new BrowserProfileStore(path.join(dir, 'profiles.json'));
  await profileStore.load();
  const initial = profileStore.listProfiles();
  assert.equal(initial.length, 1);
  assert.equal(initial[0]?.id, 'main');
  assert.equal(initial[0]?.name, 'Main');

  const work = await profileStore.createProfile('Work Account', 'main');
  assert.match(work.id, /^bp_[a-f0-9]+$/);
  await assert.rejects(() => profileStore.createProfile('work account'));

  const renamed = await profileStore.renameProfile(work.id, 'Work Research');
  assert.equal(renamed.name, 'Work Research');
  await assert.rejects(() => profileStore.deleteProfile('main'));

  const wsDir = path.join(dir, 'ws');
  await mkdir(wsDir);
  const wsStore = new AgencyWorkspaceStore(path.join(dir, 'agency-state.json'));
  await wsStore.load();
  const proj = await wsStore.createProject('Proj');
  const ws = await wsStore.createWorkspace(proj.id, 'WS', wsDir);

  await wsStore.updateProject(proj.id, { browserProfileId: work.id });
  await wsStore.updateWorkspaceFields(ws.id, { browserProfileId: work.id });
  assert.equal(wsStore.listProjects()[0]?.browserProfileId, work.id);
  assert.equal(wsStore.listWorkspaces()[0]?.browserProfileId, work.id);

  await profileStore.deleteProfile(work.id);
  const cleared = await wsStore.clearBrowserProfile(work.id);
  assert.equal(cleared.projects.length, 1);
  assert.equal(cleared.workspaces.length, 1);
  assert.equal(wsStore.listProjects()[0]?.browserProfileId, undefined);
  assert.equal(wsStore.listWorkspaces()[0]?.browserProfileId, undefined);
});

test('domain cascade delete cleans child workspaces before removing project without touching disk dirs', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cascade-proj-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const wsDir = path.join(dir, 'repo');
  await mkdir(wsDir);

  const store = new AgencyWorkspaceStore(path.join(dir, 'state.json'));
  await store.load();
  const proj = await store.createProject('Alpha');
  const ws1 = await store.createWorkspace(proj.id, 'Active WS', wsDir);
  const ws2 = await store.createWorkspace(proj.id, 'Done WS', wsDir);
  await store.markDone(ws2.id);

  const shutdowns: string[] = [];
  const broadcasts: string[] = [];
  const ctx: AgencyDomainContext = {
    store,
    pickers: new DirectoryPickers([]),
    withSessionReservationLock: async (_id, fn) => fn(),
    runWorkspaceExclusive: async (_id, fn) => fn(),
    hasBlockingSessions: async () => false,
    shutdownWorkspace: async (id) => { shutdowns.push(id); },
    publish: (msg) => { broadcasts.push(`${msg.type}:${msg.change}`); },
  };

  const blocked = await handleAgencyDomainRequest({ type: 'agency.project.delete', requestId: 'r1', projectId: proj.id }, ctx);
  assert.equal(blocked?.type, 'agency.error');

  const ok = await handleAgencyDomainRequest({ type: 'agency.project.delete', requestId: 'r2', projectId: proj.id, cascade: true }, ctx);
  assert.equal(ok?.type, 'agency.project.deleted');
  assert.deepEqual(shutdowns.sort(), [ws1.id, ws2.id].sort());
  assert.equal(store.listWorkspaces().length, 0);
  assert.equal(store.listProjects().length, 0);
  assert.ok(broadcasts.includes('agency.project.changed:deleted'));
});

test('agency protocol parses reordered/archived broadcasts and browserProfile messages', () => {
  const pMsg = parseAgencyServerMessage({
    type: 'agency.project.changed',
    change: 'reordered',
    projectId: '',
    projects: [],
  });
  assert.equal(pMsg?.type, 'agency.project.changed');

  const wMsg = parseAgencyServerMessage({
    type: 'agency.workspace.changed',
    change: 'reordered',
    workspaceId: '',
    workspaces: [],
  });
  assert.equal(wMsg?.type, 'agency.workspace.changed');

  const bpReq = parseAgencyClientMessage({
    type: 'agency.browserProfile.create',
    requestId: 'req-1',
    name: 'Personal',
    sourceProfileId: 'main',
    clearSites: ['chatgpt'],
  });
  assert.deepEqual(bpReq, {
    type: 'agency.browserProfile.create',
    requestId: 'req-1',
    name: 'Personal',
    sourceProfileId: 'main',
    clearSites: ['chatgpt'],
  });
});

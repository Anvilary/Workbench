import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DirectoryPickers } from '../directory-picker.js';
import { handleAgencyDomainRequest, parseAgencyDomainRequest } from './domain-handler.js';
import { AgencyWorkspaceStore, parseAgencySnapshot } from './store.js';

async function fixture(t: import('node:test').TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'agency-test-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const store = new AgencyWorkspaceStore(path.join(dir, 'state.json'));
  await store.load();
  return { dir, store };
}

/** Drive the real server picker from a filesystem root, not from a fake cwd. */
async function pick(pickers: DirectoryPickers, wanted: string): Promise<string> {
  const canonical = await realpath(wanted);
  const listing = await pickers.open();
  const root = path.parse(canonical).root;
  const rootIndex = listing.roots.indexOf(root);
  assert.notEqual(rootIndex, -1, 'filesystem root should be selectable');
  await pickers.root(listing.pickerId, rootIndex);
  const segments = path.relative(root, canonical).split(path.sep).filter(Boolean);
  for (const segment of segments) await pickers.enter(listing.pickerId, segment);
  return listing.pickerId;
}

test('projects and workspaces: CRUD, independent directories, zero sessions, durable Done/Restore', async (t) => {
  const { dir, store } = await fixture(t);
  const cwd1 = path.join(dir, 'checkout-a');
  const cwd2 = path.join(dir, 'checkout-b');
  await Promise.all([mkdir(cwd1), mkdir(cwd2)]);
  await writeFile(path.join(cwd1, 'unchanged.txt'), 'original');
  const project = await store.createProject('Application');
  const second = await store.createProject('Other');
  const a = await store.createWorkspace(project.id, 'Task A', await realpath(cwd1));
  const b = await store.createWorkspace(project.id, 'Task B', await realpath(cwd2));
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, project.id);
  assert.equal(a.cwd, await realpath(cwd1));
  assert.equal(b.cwd, await realpath(cwd2));
  assert.equal(a.status, 'active');
  assert.equal(a.doneAt, null);
  assert.match(a.createdAt, /Z$/);
  assert.equal(store.listWorkspaces(second.id).length, 0);
  assert.equal(store.listWorkspaces(project.id).length, 2);

  const renamed = await store.renameProject(project.id, 'Renamed');
  assert.equal(renamed.id, project.id);
  assert.equal((await store.renameWorkspace(a.id, 'Research')).cwd, await realpath(cwd1));
  await assert.rejects(store.deleteProject(project.id), { code: 'conflict' });

  const done = await store.markDone(a.id);
  assert.equal(done.status, 'done');
  assert.ok(done.doneAt);
  assert.equal(store.listWorkspaces(project.id).length, 2, 'Done remains in historical queries');
  assert.equal(store.listWorkspaces(project.id).filter((w) => w.status === 'active').length, 1);
  assert.equal(await readFile(path.join(cwd1, 'unchanged.txt'), 'utf8'), 'original');

  const reopened = new AgencyWorkspaceStore(path.join(dir, 'state.json'));
  await reopened.load();
  assert.deepEqual(reopened.listProjects().find((p) => p.id === project.id), renamed);
  assert.equal(reopened.getWorkspace(a.id)?.status, 'done');
  assert.equal(reopened.getWorkspace(b.id)?.cwd, await realpath(cwd2));
  assert.equal((await reopened.restore(a.id)).doneAt, null);
  assert.equal((await reopened.restore(a.id)).status, 'active');

  await reopened.deleteWorkspace(a.id, async () => false);
  await reopened.deleteWorkspace(b.id, async () => false);
  await reopened.deleteProject(project.id);
  assert.equal(reopened.listProjects().length, 1);
  assert.equal(await readFile(path.join(cwd1, 'unchanged.txt'), 'utf8'), 'original');
});

test('concurrent metadata writes are serialized and never reuse IDs', async (t) => {
  const { dir, store } = await fixture(t);
  const cwd = path.join(dir, 'existing');
  await mkdir(cwd);
  const projects = await Promise.all(Array.from({ length: 24 }, (_, i) => store.createProject('P ' + i)));
  assert.equal(new Set(projects.map((p) => p.id)).size, projects.length);
  const canonicalCwd = await realpath(cwd);
  const workspaces = await Promise.all(Array.from({ length: 24 }, (_, i) =>
    store.createWorkspace(projects[0]!.id, 'W ' + i, canonicalCwd)));
  assert.equal(new Set(workspaces.map((w) => w.id)).size, workspaces.length);
  const raw = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as unknown;
  assert.equal(parseAgencySnapshot(raw).workspaces.length, 24);
  const restarted = new AgencyWorkspaceStore(path.join(dir, 'state.json'));
  await restarted.load();
  assert.equal(restarted.listProjects().length, 24);
  assert.equal(restarted.listWorkspaces().length, 24);
});

test('workspace deletions refuse live, unresolved and unverified sessions', async (t) => {
  const { dir, store } = await fixture(t);
  const cwd = path.join(dir, 'repo');
  await mkdir(cwd);
  const project = await store.createProject('P');
  const workspace = await store.createWorkspace(project.id, 'W', await realpath(cwd));
  await assert.rejects(store.deleteWorkspace(workspace.id, () => true), { code: 'conflict' });
  await assert.rejects(store.deleteWorkspace(workspace.id, () => { throw new Error('registry offline'); }), {
    code: 'session-unavailable',
  });
  assert.equal(store.listWorkspaces().length, 1);
  await store.deleteWorkspace(workspace.id, () => false);
  await assert.rejects(store.deleteWorkspace(workspace.id, () => false), { code: 'not-found' });
});

test('Done and Restore never terminate processes or remove files', async (t) => {
  const { dir, store } = await fixture(t);
  const cwd = path.join(dir, 'repo');
  await mkdir(cwd);
  const file = path.join(cwd, 'source.txt');
  await writeFile(file, 'keep');
  const project = await store.createProject('P');
  const workspace = await store.createWorkspace(project.id, 'W', cwd);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { child.kill(); });
  assert.ok(child.pid);
  await store.markDone(workspace.id);
  assert.equal(child.exitCode, null);
  await store.restore(workspace.id);
  assert.equal(child.exitCode, null);
  assert.equal(await readFile(file, 'utf8'), 'keep');
});

test('picker-bound requests reject arbitrary cwd and invalid or cross-socket IDs', async (t) => {
  const { dir, store } = await fixture(t);
  const cwd = path.join(dir, 'checkout');
  await mkdir(cwd);
  const project = await store.createProject('P');
  const a = new DirectoryPickers([]);
  const b = new DirectoryPickers([]);
  const pickerId = await pick(a, cwd);
  const request = {
    type: 'agency.workspace.create', requestId: 'req-1', projectId: project.id, name: 'Task', pickerId,
  };
  assert.throws(() => parseAgencyDomainRequest({ ...request, cwd: homedir() }), { code: 'invalid-request' });
  const crossSocket = await handleAgencyDomainRequest(request, { store, pickers: b });
  assert.equal(crossSocket?.type, 'agency.error');
  assert.equal(store.listWorkspaces().length, 0);
  const invalidId = await handleAgencyDomainRequest({ ...request, pickerId: 'not-a-uuid' }, { store, pickers: a });
  assert.equal(invalidId?.type, 'agency.error');
  const changed: string[] = [];
  const result = await handleAgencyDomainRequest(request, {
    store, pickers: a, publish: (message) => changed.push(message.type),
  });
  assert.equal(result?.type, 'agency.workspace.created');
  assert.deepEqual(changed, ['agency.workspace.changed']);
  a.close(pickerId);
  const closed = await handleAgencyDomainRequest(request, { store, pickers: a });
  assert.equal(closed?.type, 'agency.error');
  assert.equal(store.listWorkspaces().length, 1);
  const denied = await handleAgencyDomainRequest({
    type: 'agency.workspace.delete', requestId: 'req-2', workspaceId: store.listWorkspaces()[0]!.id,
  }, { store, pickers: a });
  assert.deepEqual(denied?.type, 'agency.error');
  assert.equal(store.listWorkspaces().length, 1);
});

test('picker refuses changed symlinks pointing into protected CLI directories', async (t) => {
  if (process.platform === 'win32') { t.skip('Windows symlink privileges vary'); return; }
  const { dir, store } = await fixture(t);
  const publicDir = path.join(dir, 'public');
  const protectedDir = path.join(dir, 'secret-cli-home');
  const swap = path.join(publicDir, 'swap');
  await mkdir(publicDir);
  await mkdir(protectedDir);
  await mkdir(swap);
  const project = await store.createProject('P');
  const pickers = new DirectoryPickers([protectedDir]);
  const pickerId = await pick(pickers, publicDir);
  await rename(swap, swap + '-old');
  await symlink(protectedDir, swap, 'dir');
  await assert.rejects(pickers.enter(pickerId, 'swap'));
  const reply = await handleAgencyDomainRequest({
    type: 'agency.workspace.create', requestId: 'r', projectId: project.id, name: 'W', pickerId,
  }, { store, pickers });
  // The selection remains at publicDir, not the swapped symlink.
  assert.equal(reply?.type, 'agency.workspace.created');
  assert.equal(store.listWorkspaces()[0]?.cwd, await realpath(publicDir));
  assert.equal(store.listWorkspaces().length, 1);
  await assert.rejects(store.createWorkspace(project.id, 'bad', path.join(dir, 'missing')), { code: 'invalid-directory' });
  await assert.rejects(store.createWorkspace(project.id, 'bad', swap), { code: 'invalid-directory' });
});

test('missing state is empty; corrupt state recovers from backup, else fails closed', async (t) => {
  const { dir, store } = await fixture(t);
  assert.equal(store.listProjects().length, 0);
  await store.createProject('Preserved');
  const statePath = path.join(dir, 'state.json');
  await writeFile(statePath, 'broken-json');
  const recovered = new AgencyWorkspaceStore(statePath);
  await recovered.load();
  assert.equal(recovered.listProjects()[0]?.name, 'Preserved');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).version, 1);
  assert.ok((await readdir(dir)).some((file) => file.startsWith('state.json.corrupt-')));
  await writeFile(statePath, '{bad');
  await writeFile(statePath + '.bak', '{bad');
  const failed = new AgencyWorkspaceStore(statePath);
  await assert.rejects(failed.load(), { code: 'internal-error' });
  assert.equal(await readFile(statePath, 'utf8'), '{bad');
  await assert.rejects(failed.createProject('Never overwrite'), { code: 'internal-error' });
});

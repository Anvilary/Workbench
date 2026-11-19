import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DirectoryPickers } from '../../../src/directory-picker.js';
import { checkVaultTarget } from '../../../src/vault/move.js';
import { handleAgencyDomainRequest, parseAgencyDomainRequest, type AgencyDomainContext } from '../../../src/agency/domain-handler.js';
import { AgencyWorkspaceStore, parseAgencySnapshot } from '../../../src/agency/store.js';

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
  const workspace = await store.createWorkspace(project.id, 'W', await realpath(cwd));
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

test('existing picker consumers retain their lexical path; Agency gets canonical realpath', async (t) => {
  const { dir } = await fixture(t);
  const protectedDir = path.join(dir, 'cli-home');
  const child = path.join(protectedDir, 'nested');
  await mkdir(child, { recursive: true });
  // A permissive picker is intentional: VaultService provides its own
  // protection list and reads currentPath(), not selectedDirectory().
  const picker = new DirectoryPickers([]);
  const id = await pick(picker, protectedDir);
  const before = picker.currentPath(id);
  assert.ok(before);
  const next = await picker.enter(id, 'nested');
  assert.equal(picker.currentPath(id), path.join(before, 'nested'));
  assert.equal(next.path, path.join(before, 'nested'));
  assert.equal(await picker.selectedDirectory(id), await realpath(child));
  assert.equal(checkVaultTarget(path.join(dir, 'vault'), picker.currentPath(id)!, {
    protectedDirs: [before], platform: process.platform,
  }).kind, 'refused', 'Vault must still refuse a protected CLI home');
  const other = new DirectoryPickers([protectedDir]);
  const idOther = await pick(other, dir);
  await assert.rejects(other.enter(idOther, 'cli-home'), 'Agency picker must block protected CLI homes');
  await other.create(idOther, 'new-project');
  assert.equal(other.currentPath(idOther), path.join(await realpath(dir), 'new-project'));
  assert.equal(await other.selectedDirectory(idOther), await realpath(path.join(dir, 'new-project')));
});

test('directory alias is preserved for picker clients but canonicalized for Agency', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows alias behavior is covered by check-vault section 13d on the Windows runner');
    return;
  }
  const { dir } = await fixture(t);
  const realHome = path.join(dir, 'actual-home');
  const alias = path.join(dir, 'home-alias');
  await mkdir(path.join(realHome, 'project'), { recursive: true });
  await symlink(realHome, alias, 'dir');
  const oldHome = process.env['HOME'];
  process.env['HOME'] = alias;
  t.after(() => {
    if (oldHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = oldHome;
  });
  const picker = new DirectoryPickers([]);
  const listing = await picker.open();
  assert.equal(listing.path, alias);
  const entered = await picker.enter(listing.pickerId, 'project');
  assert.equal(entered.path, path.join(alias, 'project'));
  assert.equal(picker.currentPath(listing.pickerId), path.join(alias, 'project'));
  assert.equal(await picker.selectedDirectory(listing.pickerId), await realpath(path.join(realHome, 'project')));
});

test('workspace delete is fail-closed without the shared session reservation lock', async (t) => {
  const { dir, store } = await fixture(t);
  await mkdir(path.join(dir, 'repo'));
  const project = await store.createProject('P');
  const workspace = await store.createWorkspace(project.id, 'W', await realpath(path.join(dir, 'repo')));
  const request = { type: 'agency.workspace.delete', requestId: 'delete-1', workspaceId: workspace.id };
  const pickers = new DirectoryPickers([]);
  const unguarded = await handleAgencyDomainRequest(request, {
    store, pickers, hasBlockingSessions: () => false,
  });
  assert.equal(unguarded?.type, 'agency.error');
  if (unguarded?.type === 'agency.error') assert.equal(unguarded.code, 'session-unavailable');
  assert.ok(store.getWorkspace(workspace.id));
  // Simulate the same per-workspace serialized gate used by Lane C.
  let release: (() => void) | undefined;
  const gate = async (_id: typeof workspace.id, action: () => Promise<void>) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await action();
  };
  let reserved = true;
  const pending = handleAgencyDomainRequest(request, {
    store, pickers, hasBlockingSessions: () => reserved, withSessionReservationLock: gate,
  });
  await Promise.resolve();
  assert.ok(store.getWorkspace(workspace.id));
  assert.ok(release);
  release!();
  const refused = await pending;
  assert.equal(refused?.type, 'agency.error');
  assert.ok(store.getWorkspace(workspace.id));
  reserved = false;
  const success = await handleAgencyDomainRequest(request, {
    store, pickers, hasBlockingSessions: () => reserved,
    withSessionReservationLock: async (_id, action) => action(),
  });
  assert.equal(success?.type, 'agency.workspace.deleted');
  assert.equal(store.getWorkspace(workspace.id), null);
});

test('workspace and project archive: distinct state, broadcasts, unarchive/restore and backwards compatibility', async (t) => {
  const { dir, store } = await fixture(t);
  const pickers = new DirectoryPickers([]);

  const broadcasts: unknown[] = [];
  const ctx = {
    store,
    pickers,
    publish: (msg: unknown) => broadcasts.push(msg),
  };

  // 1. Create project and workspace
  const pRes = await handleAgencyDomainRequest({
    type: 'agency.project.create',
    requestId: 'p-req',
    name: 'Archivable Project',
  }, ctx);
  assert.equal(pRes?.type, 'agency.project.created');
  const project = (pRes as { project: { id: string } }).project;

  const cwd = path.join(dir, 'archive-ws');
  await mkdir(cwd);
  const pickerId = await pick(pickers, cwd);

  const wsRes = await handleAgencyDomainRequest({
    type: 'agency.workspace.create',
    requestId: 'ws-req',
    projectId: project.id,
    name: 'Archivable Workspace',
    pickerId,
  }, ctx);
  assert.equal(wsRes?.type, 'agency.workspace.created');
  const workspace = (wsRes as { workspace: { id: string; status: string } }).workspace;
  assert.equal(workspace.status, 'active');

  // 2. Archive workspace
  const wsArchRes = await handleAgencyDomainRequest({
    type: 'agency.workspace.archive',
    requestId: 'ws-arch-req',
    workspaceId: workspace.id,
  }, ctx);
  assert.equal(wsArchRes?.type, 'agency.workspace.archived');
  const archivedWs = (wsArchRes as { workspace: { status: string; archivedAt: string | null } }).workspace;
  assert.equal(archivedWs.status, 'archived');
  assert.ok(archivedWs.archivedAt);

  // 3. Restore workspace
  const wsRestRes = await handleAgencyDomainRequest({
    type: 'agency.workspace.restore',
    requestId: 'ws-rest-req',
    workspaceId: workspace.id,
  }, ctx);
  assert.equal(wsRestRes?.type, 'agency.workspace.restored');
  const restoredWs = (wsRestRes as { workspace: { status: string; archivedAt: string | null } }).workspace;
  assert.equal(restoredWs.status, 'active');
  assert.equal(restoredWs.archivedAt, null);

  // 4. Archive project
  const pArchRes = await handleAgencyDomainRequest({
    type: 'agency.project.archive',
    requestId: 'p-arch-req',
    projectId: project.id,
  }, ctx);
  assert.equal(pArchRes?.type, 'agency.project.archived');
  const archivedProj = (pArchRes as { project: { status: string; archivedAt: string | null } }).project;
  assert.equal(archivedProj.status, 'archived');
  assert.ok(archivedProj.archivedAt);

  // 5. Unarchive project
  const pUnarchRes = await handleAgencyDomainRequest({
    type: 'agency.project.unarchive',
    requestId: 'p-unarch-req',
    projectId: project.id,
  }, ctx);
  assert.equal(pUnarchRes?.type, 'agency.project.unarchived');
  const unarchivedProj = (pUnarchRes as { project: { status: string; archivedAt: string | null } }).project;
  assert.equal(unarchivedProj.status, 'active');
  assert.equal(unarchivedProj.archivedAt, null);

  // 6. Verify broadcasts emitted
  const types = broadcasts.map((b: any) => `${b.type}:${b.change}`);
  assert.ok(types.includes('agency.workspace.changed:archived'));
  assert.ok(types.includes('agency.workspace.changed:restored'));
  assert.ok(types.includes('agency.project.changed:archived'));
  assert.ok(types.includes('agency.project.changed:unarchived'));
});

test('project and workspace ordering: persistent, serialized and cross-project isolated', async (t) => {
  const { dir, store } = await fixture(t);
  const targetDir1 = await realpath(await mkdtemp(path.join(dir, 'workspace-1-')));
  const targetDir2 = await realpath(await mkdtemp(path.join(dir, 'workspace-2-')));
  const targetDir3 = await realpath(await mkdtemp(path.join(dir, 'workspace-3-')));

  const p1 = await store.createProject('Project 1');
  const p2 = await store.createProject('Project 2');
  const p3 = await store.createProject('Project 3');

  const w1 = await store.createWorkspace(p1.id, 'Workspace 1', targetDir1);
  const w2 = await store.createWorkspace(p1.id, 'Workspace 2', targetDir2);
  const w3 = await store.createWorkspace(p1.id, 'Workspace 3', targetDir3);

  // 1. Reorder projects
  const orderedProjects = await store.orderProjects([p3.id, p1.id, p2.id]);
  assert.deepEqual(orderedProjects.map((p) => p.id), [p3.id, p1.id, p2.id]);
  assert.deepEqual(store.listProjects().map((p) => p.id), [p3.id, p1.id, p2.id]);

  // Verify persistence across reload
  const reloadedStore = new AgencyWorkspaceStore(path.join(dir, 'state.json'));
  await reloadedStore.load();
  assert.deepEqual(reloadedStore.listProjects().map((p) => p.id), [p3.id, p1.id, p2.id]);

  // 2. Reorder workspaces within parent project
  const orderedWorkspaces = await store.orderWorkspaces(p1.id, [w3.id, w1.id, w2.id]);
  assert.deepEqual(orderedWorkspaces.map((w) => w.id), [w3.id, w1.id, w2.id]);
  assert.deepEqual(store.listWorkspaces(p1.id).map((w) => w.id), [w3.id, w1.id, w2.id]);

  // Verify persistence across reload
  const reloadedStore2 = new AgencyWorkspaceStore(path.join(dir, 'state.json'));
  await reloadedStore2.load();
  assert.deepEqual(reloadedStore2.listWorkspaces(p1.id).map((w) => w.id), [w3.id, w1.id, w2.id]);

  // 3. Domain handler requests & broadcasts
  const broadcasts: any[] = [];
  const pickers = new DirectoryPickers([]);
  const ctx: AgencyDomainContext = {
    store,
    pickers,
    publish: (msg: any) => broadcasts.push(msg),
  };

  const projectOrderRes = await handleAgencyDomainRequest({
    type: 'agency.projects.order',
    requestId: 'p-order-req',
    projectIds: [p2.id, p3.id, p1.id],
  }, ctx);
  assert.equal(projectOrderRes?.type, 'agency.projects.snapshot');
  assert.deepEqual((projectOrderRes as any).projects.map((p: any) => p.id), [p2.id, p3.id, p1.id]);
  assert.ok(broadcasts.some((b) => b.type === 'agency.project.changed' && b.change === 'reordered'));

  const workspaceOrderRes = await handleAgencyDomainRequest({
    type: 'agency.workspaces.order',
    requestId: 'w-order-req',
    projectId: p1.id,
    workspaceIds: [w2.id, w3.id, w1.id],
  }, ctx);
  assert.equal(workspaceOrderRes?.type, 'agency.workspaces.snapshot');
  assert.ok(broadcasts.some((b) => b.type === 'agency.workspace.changed' && b.change === 'reordered'));

  // 4. Reject cross-project workspace reorder
  const p2Workspace = await store.createWorkspace(p2.id, 'P2 Workspace', targetDir1);
  await assert.rejects(
    () => store.orderWorkspaces(p1.id, [p2Workspace.id, w1.id]),
    (err: any) => err.code === 'conflict',
  );

  // 5. Reject duplicate IDs
  await assert.rejects(
    () => store.orderProjects([p1.id, p1.id]),
    (err: any) => err.code === 'invalid-request',
  );
  await assert.rejects(
    () => store.orderWorkspaces(p1.id, [w1.id, w1.id]),
    (err: any) => err.code === 'invalid-request',
  );
});

test('P2 A-09: AgencyWorkspaceStore.transact keeps previous committed state in .bak and control check-data prefers primary over stale .bak', async (t) => {
  const { dir, store } = await fixture(t);
  const statePath = path.join(dir, 'state.json');

  // 1st commit seeds both primary and .bak with Project A
  const p1 = await store.createProject('Project A');
  await store.updateProject(p1.id, { browserProfileId: 'bp_custom1234' as any });
  // 2nd commit (clearing browserProfileId) rotates previous state into .bak and writes cleared state to primary
  await store.updateProject(p1.id, { browserProfileId: null });

  const primary = JSON.parse(await readFile(statePath, 'utf8'));
  const backup = JSON.parse(await readFile(statePath + '.bak', 'utf8'));
  assert.equal(primary.projects[0].browserProfileId, undefined);
  assert.equal(backup.projects[0].browserProfileId, 'bp_custom1234', '.bak must hold the previous committed state');

  // Verify scripts/maw/control.mjs check-data allows downgrade once primary has cleared assignments
  // even when previous-state .bak still had browserProfileId, and falls back to .bak if primary is missing/corrupt.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const controlScript = path.resolve(process.cwd(), '../../scripts/maw/control.mjs');
  const targetDir = path.join(dir, 'target-old');
  const configHome = path.join(dir, 'xdg-config');
  const configAppDir = path.join(configHome, 'agent-workbench');
  await mkdir(targetDir, { recursive: true });
  await mkdir(configAppDir, { recursive: true });
  await writeFile(path.join(targetDir, 'package.json'), JSON.stringify({ mawCompatibility: { browserTabStore: 2 } }));
  await writeFile(path.join(configAppDir, 'agency-state.json'), await readFile(statePath, 'utf8'));
  await writeFile(path.join(configAppDir, 'agency-state.json.bak'), await readFile(statePath + '.bak', 'utf8'));

  // Primary is valid and cleared -> check-data MUST succeed despite stale .bak!
  await execFileAsync(process.execPath, [controlScript, 'check-data', targetDir], {
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  });

  // Corrupt primary -> check-data MUST fall back to .bak and reject due to browserProfileId!
  await writeFile(path.join(configAppDir, 'agency-state.json'), '{corrupt');
  await assert.rejects(
    execFileAsync(process.execPath, [controlScript, 'check-data', targetDir], {
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
    }),
    (err: any) => /does not preserve browser profile assignments/.test(err.stderr ?? ''),
  );
});

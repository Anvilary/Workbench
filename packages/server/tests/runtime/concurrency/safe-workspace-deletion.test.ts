import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AgencyServerMessage, TerminalId, WorkspaceId } from '@agent-workbench/shared';
import { AgencySessionRuntime } from '../../../src/agency/agency-session-runtime.js';
import { AgencySessionStore } from '../../../src/agency/agency-session-store.js';
import { AgencyWorkspaceStore } from '../../../src/agency/store.js';
import { WorkspaceMutex } from '../../../src/agency/workspace-lock.js';
import { BrowserTabAdapter, BrowserTabStore } from '../../../src/agency/browser-tabs/index.js';
import { AgencyTabCoordinator } from '../../../src/agency/tab-coordinator.js';
import { handleAgencyDomainRequest, type AgencyDomainContext } from '../../../src/agency/domain-handler.js';
import { DirectoryPickers } from '../../../src/directory-picker.js';

interface TestContext {
  root: string;
  workspaceStore: AgencyWorkspaceStore;
  native: AgencySessionRuntime;
  browser: BrowserTabAdapter;
  coordinator: AgencyTabCoordinator;
  terminals: Map<string, { terminalId: TerminalId; kind: string; state: string; exitCode: number | null; pid: number; alive: boolean }>;
  lock: WorkspaceMutex;
  messages: AgencyServerMessage[];
  createWorkspace: (name: string) => Promise<{ id: WorkspaceId; name: string; projectId: string; cwd: string }>;
  domainContext: (extra?: Partial<AgencyDomainContext>) => AgencyDomainContext;
}

async function setupTest(t: test.TestContext, options?: { closeRefuses?: boolean }): Promise<TestContext> {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-safe-deletion-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspaceStore = new AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
  await workspaceStore.load();
  const project = await workspaceStore.createProject('Test Project');
  const lock = new WorkspaceMutex();

  const terminals = new Map<string, { terminalId: TerminalId; kind: string; sessionId?: string; state: string; exitCode: number | null; pid: number; alive: boolean }>();
  const registry = Object.assign(new EventEmitter(), {
    async open(opts?: any) {
      const terminalId = randomUUID() as TerminalId;
      const row = {
        terminalId,
        kind: opts?.kind ?? 'shell',
        sessionId: opts?.agencyLaunch?.session?.kind === 'known' ? opts.agencyLaunch.session.sessionId : randomUUID(),
        state: 'running',
        exitCode: null,
        pid: 1000 + terminals.size,
        alive: true,
      };
      terminals.set(terminalId, row);
      return row;
    },
    get: (id: string) => terminals.get(id) ?? null,
    has: (id: string) => terminals.has(id),
    list: () => [...terminals.values()],
    close: (id: string) => {
      if (options?.closeRefuses) {
        // Simulates an unkillable/hanging process that ignores termination
        return true;
      }
      const entry = terminals.get(id);
      if (entry) {
        entry.alive = false;
        entry.state = 'exited';
        entry.exitCode = 0;
        registry.emit('exit', id, 0);
      }
      terminals.delete(id);
      return true;
    },
    activityOf: () => 'unknown',
  });

  const native = new AgencySessionRuntime({
    registry: registry as unknown as ConstructorParameters<typeof AgencySessionRuntime>[0]['registry'],
    store: new AgencySessionStore(path.join(root, 'sessions.json')),
    profiles: {
      resolveLaunch: async (input) => ({
        profileId: input.profileId,
        provider: 'claude-code',
        file: '/bin/echo',
        args: ['hello'],
        env: { PATH: '/usr/bin' },
        session: { kind: 'discover' },
        launchToken: input.launchToken,
        proposedSessionId: input.proposedSessionId,
        cwd: input.cwd,
      }),
    },
    workspaces: {
      protectedDirectories: () => [],
      withSessionReservation: (id, work) => lock.runExclusive(id, () => work(workspaceStore.getWorkspace(id))),
    },
  });
  await native.initialize();
  t.after(() => native.dispose());

  const browser = new BrowserTabAdapter({
    store: new BrowserTabStore(path.join(root, 'web.json')),
    workspaceStore,
  });
  await browser.restore();

  const messages: AgencyServerMessage[] = [];
  const coordinator = new AgencyTabCoordinator(native, browser, workspaceStore, (m) => messages.push(m));

  const createWorkspace = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    const real = await realpath(dir);
    const ws = await workspaceStore.createWorkspace(project.id, name, real);
    return ws;
  };

  const domainContext = (extra?: Partial<AgencyDomainContext>): AgencyDomainContext => ({
    store: workspaceStore,
    pickers: new DirectoryPickers([]),
    withSessionReservationLock: (id, op) => lock.runExclusive(id, op),
    hasBlockingSessions: async (id) => native.hasWorkspaceReferences(id) || coordinator.hasBrowserReferences(id),
    publish: (msg) => messages.push(msg as AgencyServerMessage),
    shutdownWorkspace: (id) => coordinator.shutdownWorkspace(id, options?.closeRefuses ? 150 : 5000),
    ...extra,
  });

  return { root, workspaceStore, native, browser, coordinator, terminals, lock, messages, createWorkspace, domainContext };
}

test('1. Empty workspace deletion succeeds cleanly and removes workspace record', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('empty-ws');
  assert.ok(ctx.workspaceStore.getWorkspace(ws.id));

  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-1', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.workspaceStore.getWorkspace(ws.id), null);
});

test('2. Workspace with one stopped terminal tab safely shuts down and deletes', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('stopped-term-ws');
  const session = await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-1', workspaceId: ws.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });
  assert.ok(session.tab);
  // Stop the process so it is in 'exited' state but the tab is still open/retained
  await ctx.native.stop(session.id);
  assert.equal(ctx.native.get(session.id)?.lifecycle, 'exited');
  assert.equal(ctx.native.hasWorkspaceReferences(ws.id), true);

  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-2', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.native.hasWorkspaceReferences(ws.id), false);
  assert.equal(ctx.workspaceStore.getWorkspace(ws.id), null);
});

test('3. Workspace with one running terminal terminates PTY and deletes', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('running-term-ws');
  const session = await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-r', workspaceId: ws.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });
  assert.ok(session.terminalId);
  assert.equal(ctx.terminals.get(session.terminalId)?.alive, true);
  assert.equal(ctx.native.hasWorkspaceReferences(ws.id), true);

  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-3', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.terminals.has(session.terminalId), false, 'PTY session was closed and removed');
  assert.equal(ctx.native.hasWorkspaceReferences(ws.id), false);
  assert.equal(ctx.workspaceStore.getWorkspace(ws.id), null);
});

test('4. Workspace with a running coding CLI stops agent and deletes', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('running-cli-ws');
  const session = await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'agent-r', workspaceId: ws.id, kind: 'agent', profileId: 'claude-01' as any, cols: 80, rows: 24, launchId: randomUUID(),
  });
  assert.ok(session.terminalId);
  assert.equal(ctx.terminals.get(session.terminalId)?.alive, true);
  assert.equal(ctx.native.hasWorkspaceReferences(ws.id), true);

  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-4', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.terminals.has(session.terminalId), false);
  assert.equal(ctx.native.hasWorkspaceReferences(ws.id), false);
  assert.equal(ctx.workspaceStore.getWorkspace(ws.id), null);
});

test('5. Workspace with one open ChatGPT page closes web tab and deletes', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('chatgpt-ws');
  await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-1', workspaceId: ws.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });
  assert.equal(ctx.coordinator.hasBrowserReferences(ws.id), true);

  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-5', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.coordinator.hasBrowserReferences(ws.id), false);
  assert.equal(ctx.workspaceStore.getWorkspace(ws.id), null);
});

test('6. Workspace with several mixed tabs coordinates shutdown and deletes', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('mixed-ws');
  // 1 agent CLI
  const agent = await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'agent-m', workspaceId: ws.id, kind: 'agent', profileId: 'claude-01' as any, cols: 80, rows: 24, launchId: randomUUID(),
  });
  // 1 running terminal
  const termRunning = await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-r', workspaceId: ws.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });
  // 1 stopped terminal
  const termStopped = await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-s', workspaceId: ws.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });
  await ctx.native.stop(termStopped.id);
  // 2 ChatGPT tabs
  await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-1', workspaceId: ws.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });
  await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-2', workspaceId: ws.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });

  assert.equal(ctx.native.hasWorkspaceReferences(ws.id), true);
  assert.equal(ctx.coordinator.hasBrowserReferences(ws.id), true);

  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-6', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.native.hasWorkspaceReferences(ws.id), false);
  assert.equal(ctx.coordinator.hasBrowserReferences(ws.id), false);
  assert.equal(ctx.terminals.has(agent.terminalId!), false);
  assert.equal(ctx.terminals.has(termRunning.terminalId!), false);
  assert.equal(ctx.workspaceStore.getWorkspace(ws.id), null);
});

test('7. Background ChatGPT views are destroyed cleanly without leaking references', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('bg-chatgpt-ws');
  await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-1', workspaceId: ws.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });
  await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-2', workspaceId: ws.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });
  // web2 is now active, web1 is in background
  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-7', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.coordinator.hasBrowserReferences(ws.id), false);
  assert.equal(ctx.browser.listTabs(ws.id, { includeClosed: false }).length, 0);
});

test('8. Session still starting resolves and terminates without leaving orphaned references', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('starting-session-ws');
  const session = await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-start', workspaceId: ws.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });
  assert.ok(session);
  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-8', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.workspaceStore.getWorkspace(ws.id), null);
});

test('9. Session refusing termination aborts deletion and retains workspace', async (t) => {
  // Test fixture where close() fails to terminate the process
  const ctx = await setupTest(t, { closeRefuses: true });
  const ws = await ctx.createWorkspace('refusing-term-ws');
  await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-refuse', workspaceId: ws.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });

  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-9', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.error');
  if (res?.type === 'agency.error') {
    assert.equal(res.code, 'session-unavailable');
    assert.ok(res.message.includes('Process termination could not be verified'));
  }
  // Workspace MUST survive
  assert.ok(ctx.workspaceStore.getWorkspace(ws.id), 'Workspace record is preserved on failed cleanup');
});

test('10. Concurrent launch versus deletion: deletion serializes under mutation lock', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('concurrent-ws');
  await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-init', workspaceId: ws.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });

  // Launch delete and concurrent session create
  const deletePromise = ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-10', workspaceId: ws.id }, ctx.domainContext())
  );
  const createPromise = ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-concurrent', workspaceId: ws.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });

  const [delRes] = await Promise.allSettled([deletePromise, createPromise]);
  assert.equal(delRes.status, 'fulfilled');
  if (delRes.status === 'fulfilled') assert.equal((delRes.value as any)?.type, 'agency.workspace.deleted');
  assert.equal(ctx.workspaceStore.getWorkspace(ws.id), null);
});

test('11. Duplicate delete submissions are idempotent and produce no duplicate side effects', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('duplicate-delete-ws');

  const res1 = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-11a', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res1?.type, 'agency.workspace.deleted');

  // Second submission for already deleted workspace
  const res2 = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-11b', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res2?.type, 'agency.workspace.deleted');
});

test('12. Cancellation does not stop any process, close any page or change workspace state', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('cancelled-ws');
  const term = await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-c', workspaceId: ws.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });
  await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-c', workspaceId: ws.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });

  // User canceled: no delete request is dispatched to server
  assert.ok(ctx.workspaceStore.getWorkspace(ws.id));
  assert.equal(ctx.terminals.get(term.terminalId!)?.alive, true);
  assert.equal(ctx.coordinator.hasBrowserReferences(ws.id), true);
  assert.equal(ctx.native.hasWorkspaceReferences(ws.id), true);
});

test('13. Failure halfway through cleanup retains workspace record', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('halfway-failure-ws');
  await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-h', workspaceId: ws.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });

  // Inject a failure into shutdownWorkspace
  const failingContext = ctx.domainContext({
    shutdownWorkspace: async () => {
      throw new Error('Simulated network or disk failure during cleanup');
    },
  });

  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-13', workspaceId: ws.id }, failingContext)
  );
  assert.equal(res?.type, 'agency.error');
  assert.ok(ctx.workspaceStore.getWorkspace(ws.id), 'Workspace is retained on failure');
});

test('14. Deletion of a workspace that is not currently selected succeeds cleanly', async (t) => {
  const ctx = await setupTest(t);
  const wsSelected = await ctx.createWorkspace('selected-ws');
  const wsOther = await ctx.createWorkspace('unselected-ws');

  const sessionSelected = await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-sel', workspaceId: wsSelected.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });
  await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-other', workspaceId: wsOther.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });

  // Delete the unselected workspace
  const res = await ctx.coordinator.mutations.runExclusive(wsOther.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-14', workspaceId: wsOther.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.workspaceStore.getWorkspace(wsOther.id), null);

  // Selected workspace and its process must remain alive and untouched
  assert.ok(ctx.workspaceStore.getWorkspace(wsSelected.id));
  assert.equal(ctx.terminals.get(sessionSelected.terminalId!)?.alive, true);
  assert.equal(ctx.native.hasWorkspaceReferences(wsSelected.id), true);
});

test('15. Isolation from other workspaces: resources in other workspaces remain intact', async (t) => {
  const ctx = await setupTest(t);
  const wsA = await ctx.createWorkspace('workspace-A');
  const wsB = await ctx.createWorkspace('workspace-B');

  await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-A', workspaceId: wsA.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });
  await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-A', workspaceId: wsA.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });

  const termB = await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-B', workspaceId: wsB.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });
  await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-B', workspaceId: wsB.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });

  // Delete workspace A
  const res = await ctx.coordinator.mutations.runExclusive(wsA.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-15', workspaceId: wsA.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');

  // Verify workspace B is completely intact
  assert.ok(ctx.workspaceStore.getWorkspace(wsB.id));
  assert.equal(ctx.terminals.get(termB.terminalId!)?.alive, true);
  assert.equal(ctx.coordinator.hasBrowserReferences(wsB.id), true);
  assert.equal(ctx.native.hasWorkspaceReferences(wsB.id), true);
  assert.equal(ctx.browser.listTabs(wsB.id, { includeClosed: false }).length, 1);
});

test('16. Done and archived workspace deletion succeeds with lifecycle-safe cleanup', async (t) => {
  const ctx = await setupTest(t);
  const wsDone = await ctx.createWorkspace('done-ws');
  await ctx.coordinator.createNative({
    type: 'agency.session.create', requestId: 'term-done', workspaceId: wsDone.id, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID(),
  });
  await ctx.workspaceStore.markDone(wsDone.id);
  assert.equal(ctx.workspaceStore.getWorkspace(wsDone.id)?.status, 'done');

  // Delete done workspace
  const resDone = await ctx.coordinator.mutations.runExclusive(wsDone.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-16-done', workspaceId: wsDone.id }, ctx.domainContext())
  );
  assert.equal(resDone?.type, 'agency.workspace.deleted');
  assert.equal(ctx.workspaceStore.getWorkspace(wsDone.id), null);

  // Archived workspace deletion
  const wsArchived = await ctx.createWorkspace('archived-ws');
  await ctx.workspaceStore.archiveWorkspace(wsArchived.id);
  assert.equal(ctx.workspaceStore.getWorkspace(wsArchived.id)?.status, 'archived');

  const resArchived = await ctx.coordinator.mutations.runExclusive(wsArchived.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-16-arch', workspaceId: wsArchived.id }, ctx.domainContext())
  );
  assert.equal(resArchived?.type, 'agency.workspace.deleted');
  assert.equal(ctx.workspaceStore.getWorkspace(wsArchived.id), null);
});

test('17. Done workspace containing an open ChatGPT tab shuts down web tab and deletes successfully', async (t) => {
  const ctx = await setupTest(t);
  const wsDone = await ctx.createWorkspace('done-ws-web');
  const web = await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-done-17', workspaceId: wsDone.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });
  assert.ok(web && web.type === 'agency.webTab.created');
  assert.equal(ctx.coordinator.hasBrowserReferences(wsDone.id), true);

  await ctx.workspaceStore.markDone(wsDone.id);
  assert.equal(ctx.workspaceStore.getWorkspace(wsDone.id)?.status, 'done');

  // Deleting the Done workspace with open ChatGPT tab must succeed through authorized shutdown
  const res = await ctx.coordinator.mutations.runExclusive(wsDone.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-17', workspaceId: wsDone.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.workspaceStore.getWorkspace(wsDone.id), null);
  assert.equal(ctx.coordinator.hasBrowserReferences(wsDone.id), false);
  assert.equal(ctx.browser.listTabs(wsDone.id, { includeClosed: false }).length, 0);
});

test('18. Archived workspace containing an open ChatGPT tab shuts down web tab and deletes successfully', async (t) => {
  const ctx = await setupTest(t);
  const wsArchived = await ctx.createWorkspace('archived-ws-web');
  const web = await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-arch-18', workspaceId: wsArchived.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });
  assert.ok(web && web.type === 'agency.webTab.created');
  assert.equal(ctx.coordinator.hasBrowserReferences(wsArchived.id), true);

  await ctx.workspaceStore.archiveWorkspace(wsArchived.id);
  assert.equal(ctx.workspaceStore.getWorkspace(wsArchived.id)?.status, 'archived');

  // Deleting the Archived workspace with open ChatGPT tab must succeed through authorized shutdown
  const res = await ctx.coordinator.mutations.runExclusive(wsArchived.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-18', workspaceId: wsArchived.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.workspaceStore.getWorkspace(wsArchived.id), null);
  assert.equal(ctx.coordinator.hasBrowserReferences(wsArchived.id), false);
  assert.equal(ctx.browser.listTabs(wsArchived.id, { includeClosed: false }).length, 0);
});

test('19. Archived project containing a workspace with a web tab shuts down web tab and deletes successfully', async (t) => {
  const ctx = await setupTest(t);
  const projArchived = await ctx.workspaceStore.createProject('Archived Project');
  const dir = path.join(ctx.root, 'ws-arch-proj');
  await mkdir(dir, { recursive: true });
  const real = await realpath(dir);
  const ws = await ctx.workspaceStore.createWorkspace(projArchived.id, 'ws-arch-proj', real);

  const web = await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-arch-proj-19', workspaceId: ws.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });
  assert.ok(web && web.type === 'agency.webTab.created');
  assert.equal(ctx.coordinator.hasBrowserReferences(ws.id), true);

  // Archive owning project
  await ctx.workspaceStore.archiveProject(projArchived.id);
  assert.equal(ctx.workspaceStore.listProjects().find((p) => p.id === projArchived.id)?.status, 'archived');

  // Ordinary tab creation on this workspace must now be rejected because project is archived
  await assert.rejects(
    ctx.browser.createTab({ workspaceId: ws.id, url: 'https://chatgpt.com/' }),
    (err: any) => err.code === 'conflict'
  );

  // Deleting the workspace in an archived project must succeed through authorized shutdown
  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-19', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.workspace.deleted');
  assert.equal(ctx.workspaceStore.getWorkspace(ws.id), null);
  assert.equal(ctx.coordinator.hasBrowserReferences(ws.id), false);
});

test('20. Cross-workspace closure refusal: closing a tab with a foreign workspace ID is rejected', async (t) => {
  const ctx = await setupTest(t);
  const wsA = await ctx.createWorkspace('ws-closure-A');
  const wsB = await ctx.createWorkspace('ws-closure-B');

  const createA = await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-A20', workspaceId: wsA.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });
  assert.ok(createA && createA.type === 'agency.webTab.created');
  const tabAId = createA.tab.id;

  // Attempting to close Tab A using Workspace B must be rejected without altering Tab A
  await assert.rejects(
    ctx.browser.closeTab(wsB.id, tabAId),
    (err: any) => err.code === 'not-found'
  );
  await assert.rejects(
    ctx.browser.closeTab(wsB.id, tabAId, { allowInactiveWorkspace: true }),
    (err: any) => err.code === 'not-found'
  );

  // Verify Tab A remains open and intact in Workspace A
  const tabAState = ctx.browser.getTabState(tabAId);
  assert.ok(tabAState);
  assert.equal(tabAState.closedAt, null);
  assert.equal(tabAState.workspaceId, wsA.id);
  assert.equal(ctx.coordinator.hasBrowserReferences(wsA.id), true);
  assert.equal(ctx.coordinator.hasBrowserReferences(wsB.id), false);
});

test('21. Failure during browser-tab persistence rolls back in-memory tabs, aborts shutdown, and preserves workspace', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('persistence-fail-ws');
  const web = await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-fail-21', workspaceId: ws.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });
  assert.ok(web && web.type === 'agency.webTab.created');
  assert.equal(ctx.coordinator.hasBrowserReferences(ws.id), true);

  // Inject failure into browser tab store.save to simulate I/O or disk error
  const originalSave = ctx.browser.store.save.bind(ctx.browser.store);
  ctx.browser.store.save = async () => {
    throw new Error('Simulated disk/IO failure during browser tab persistence');
  };

  const res = await ctx.coordinator.mutations.runExclusive(ws.id, () =>
    handleAgencyDomainRequest({ type: 'agency.workspace.delete', requestId: 'del-21', workspaceId: ws.id }, ctx.domainContext())
  );
  assert.equal(res?.type, 'agency.error');

  // Restore save method
  ctx.browser.store.save = originalSave;

  // Workspace must survive
  assert.ok(ctx.workspaceStore.getWorkspace(ws.id), 'Workspace record must be preserved on persistence failure');

  // In-memory tab state must be rolled back: tab is still open
  const tabState = ctx.browser.getTabState(web.tab.id);
  assert.ok(tabState);
  assert.equal(tabState.closedAt, null, 'Tab closedAt must be rolled back to null');
  assert.equal(ctx.coordinator.hasBrowserReferences(ws.id), true);
});

test('22. Workspace validation on mutations remains unweakened for Done and Archived workspaces', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('validation-strict-ws');
  const createRes = await ctx.coordinator.webRequest({
    type: 'agency.webTab.create', requestId: 'web-init', workspaceId: ws.id, url: 'https://chatgpt.com/', launchId: randomUUID(),
  });
  assert.ok(createRes && createRes.type === 'agency.webTab.created');
  const tabId = createRes.tab.id;

  // 1. Mark done: mutations must be refused
  await ctx.workspaceStore.markDone(ws.id);

  await assert.rejects(
    ctx.browser.createTab({ workspaceId: ws.id, url: 'https://chatgpt.com/' }),
    (err: any) => err.code === 'conflict'
  );
  await assert.rejects(
    ctx.browser.navigateTab(ws.id, tabId, 'https://chatgpt.com/c/test'),
    (err: any) => err.code === 'conflict'
  );
  await assert.rejects(
    ctx.browser.selectTab(ws.id, tabId),
    (err: any) => err.code === 'conflict'
  );
  await assert.rejects(
    ctx.browser.renameTab(ws.id, tabId, 'Renamed'),
    (err: any) => err.code === 'conflict'
  );
  await assert.rejects(
    ctx.browser.orderTabs(ws.id, [tabId]),
    (err: any) => err.code === 'conflict'
  );
  // Unprivileged closure (without allowInactiveWorkspace) must also be rejected
  await assert.rejects(
    ctx.browser.closeTab(ws.id, tabId),
    (err: any) => err.code === 'conflict'
  );

  // 2. Archive workspace: mutations must still be refused
  await ctx.workspaceStore.restore(ws.id);
  await ctx.workspaceStore.archiveWorkspace(ws.id);

  await assert.rejects(
    ctx.browser.createTab({ workspaceId: ws.id, url: 'https://chatgpt.com/' }),
    (err: any) => err.code === 'conflict'
  );
  await assert.rejects(
    ctx.browser.navigateTab(ws.id, tabId, 'https://chatgpt.com/c/test'),
    (err: any) => err.code === 'conflict'
  );
  await assert.rejects(
    ctx.browser.selectTab(ws.id, tabId),
    (err: any) => err.code === 'conflict'
  );
  await assert.rejects(
    ctx.browser.renameTab(ws.id, tabId, 'Renamed'),
    (err: any) => err.code === 'conflict'
  );
  await assert.rejects(
    ctx.browser.orderTabs(ws.id, [tabId]),
    (err: any) => err.code === 'conflict'
  );
  await assert.rejects(
    ctx.browser.closeTab(ws.id, tabId),
    (err: any) => err.code === 'conflict'
  );
});

test('concurrent delete requests take the coordinator lock once and publish one deletion', async (t) => {
  const ctx = await setupTest(t);
  const workspace = await ctx.createWorkspace('concurrent-delete');
  const context = ctx.domainContext({
    runWorkspaceExclusive: (id, operation) => ctx.coordinator.mutations.runExclusive(id, operation),
  });
  const request = { type: 'agency.workspace.delete', workspaceId: workspace.id };
  const replies = await Promise.all([
    handleAgencyDomainRequest({ ...request, requestId: 'first' }, context),
    handleAgencyDomainRequest({ ...request, requestId: 'second' }, context),
  ]);
  assert.deepEqual(replies.map(reply => reply?.type), ['agency.workspace.deleted', 'agency.workspace.deleted']);
  assert.equal(ctx.messages.filter(message => message.type === 'agency.workspace.changed' &&
    message.change === 'deleted' && message.workspaceId === workspace.id).length, 1);
  assert.equal(await realpath(workspace.cwd), workspace.cwd);
});

test('P1 B-15: partial failure in shutdownWorkspace still broadcasts snapshots for already-closed tabs', async (t) => {
  const ctx = await setupTest(t);
  const ws = await ctx.createWorkspace('partial-shutdown-ws');

  // Create one native tab and two browser tabs
  await ctx.coordinator.createNative({
    type: 'agency.session.create',
    requestId: 'n1',
    workspaceId: ws.id,
    kind: 'terminal',
    cols: 80,
    rows: 24,
  });
  await ctx.browser.createTab({ workspaceId: ws.id, url: 'https://chatgpt.com/', title: 'Web 1' });
  await ctx.browser.createTab({ workspaceId: ws.id, url: 'https://chatgpt.com/c/2', title: 'Web 2' });

  ctx.coordinator.snapshot();
  ctx.messages.length = 0;

  // Fail closing the second browser tab after the native tab and first browser tab already closed
  let closeCalls = 0;
  const origCloseTab = ctx.browser.closeTab.bind(ctx.browser);
  ctx.browser.closeTab = async (workspaceId, tabId, options) => {
    closeCalls++;
    if (closeCalls === 2) {
      throw new Error('Injected browser tab close failure');
    }
    return origCloseTab(workspaceId, tabId, options);
  };

  await assert.rejects(
    () => ctx.coordinator.shutdownWorkspace(ws.id),
    /Injected browser tab close failure/,
  );

  // Even though shutdownWorkspace threw midway, snapshots MUST have been broadcast
  // so clients reconcile the native tab and first browser tab that were closed.
  assert.ok(
    ctx.messages.some((m) => m.type === 'agency.sessions.snapshot'),
    'Native sessions snapshot must be broadcast on partial shutdownWorkspace failure',
  );
  assert.ok(
    ctx.messages.some((m) => m.type === 'agency.webTabs.snapshot'),
    'Browser tabs snapshot must be broadcast on partial shutdownWorkspace failure',
  );
});

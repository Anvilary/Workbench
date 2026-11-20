/**
 * Checkpoint 5 — cross-workspace isolation under concurrent load (real runtime, real tab coordinator, real
 * logical browser adapter). Activity in workspace A must never select or close
 * B's tabs, close B's browser targets, close a sibling PTY, or let a forged (workspace, tab) pair through.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AgencyServerMessage, TerminalId, WorkspaceId } from '@agent-workbench/shared';
import { AgencySessionRuntime } from '../../../src/features/sessions/session-runtime.js';
import { SplitAgencySessionStore } from '../../../src/features/sessions/session-store.js';
import { AgencyWorkspaceStore } from '../../../src/features/workspaces/workspace-store.js';
import { WorkspaceMutex } from '../../../src/features/workspaces/workspace-lock.js';
import { BrowserTabAdapter } from '../../../src/features/browser/browser-tab-adapter.js';
import { BrowserTabStore } from '../../../src/features/browser/browser-tab-store.js';
import { AgencyTabCoordinator } from '../../../src/features/workspaces/tab-coordinator.js';

test('concurrent operations in one workspace never touch another workspace, its browser targets or sibling PTYs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'maw-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceStore = new AgencyWorkspaceStore(path.join(root, 'workspaces.json'));
  await workspaceStore.load();
  const project = await workspaceStore.createProject('Isolation');
  const dirA = path.join(root, 'a'), dirB = path.join(root, 'b');
  await (await import('node:fs/promises')).mkdir(dirA); await (await import('node:fs/promises')).mkdir(dirB);
  const A = await workspaceStore.createWorkspace(project.id, 'A', dirA);
  const B = await workspaceStore.createWorkspace(project.id, 'B', dirB);
  const lock = new WorkspaceMutex();
  const terminals = new Map<string, { terminalId: TerminalId; kind: string; state: string; exitCode: null; pid: number; alive: boolean }>();
  const closed: string[] = [];
  const registry = Object.assign(new EventEmitter(), {
    async open() {
      const terminalId = randomUUID() as TerminalId;
      const row = { terminalId, kind: 'shell', state: 'running', exitCode: null, pid: 123, alive: true };
      terminals.set(terminalId, row); return row;
    },
    get: (id: string) => terminals.get(id) ?? null,
    has: (id: string) => terminals.has(id), list: () => [...terminals.values()],
    close: (id: string) => { closed.push(id); const row = terminals.get(id); if (row) { row.alive = false; queueMicrotask(() => registry.emit('exit', id, 0)); } },
    activityOf: () => 'unknown',
  });
  const native = new AgencySessionRuntime({ registry: registry as unknown as ConstructorParameters<typeof AgencySessionRuntime>[0]['registry'],
    store: new SplitAgencySessionStore(path.join(root, 'sessions.json')),
    profiles: { resolveLaunch: async () => { throw new Error('No CLI launch requested'); } },
    workspaces: { protectedDirectories: () => [], withSessionReservation: (id, work) => lock.runExclusive(id, () => work(workspaceStore.getWorkspace(id))) },
  });
  await native.initialize(); t.after(() => native.dispose());

  const browser = new BrowserTabAdapter({ store: new BrowserTabStore(path.join(root, 'web.json')), workspaceStore });
  await browser.restore();
  const messages: AgencyServerMessage[] = [];
  const coordinator = new AgencyTabCoordinator(native, browser, workspaceStore, message => messages.push(message));

  const shell = (ws: WorkspaceId, i: number) => coordinator.createNative({ type: 'agency.session.create', requestId: 's' + i, workspaceId: ws, kind: 'terminal', cols: 80, rows: 24, launchId: randomUUID() });
  const web = (ws: WorkspaceId, i: number) => coordinator.webRequest({ type: 'agency.webTab.create', requestId: 'w' + i, workspaceId: ws, url: 'https://chatgpt.com/', launchId: randomUUID() });
  const shellsA = [await shell(A.id, 1), await shell(A.id, 2), await shell(A.id, 3)];
  const shellsB = [await shell(B.id, 4), await shell(B.id, 5)];
  await web(A.id, 6); await web(A.id, 7); await web(B.id, 8); await web(B.id, 9);
  const webA = browser.listTabs(A.id), webB = browser.listTabs(B.id);
  // B's state before the storm: select a specific B shell.
  await coordinator.nativeAction({ type: 'agency.tab.action', requestId: 'b-sel', workspaceId: B.id, tabId: shellsB[1]!.tab!.id, action: 'select' });
  const targetsB = webB.map(tab => tab.id);
  const ptysB = shellsB.map(s => native.get(s.id)!.terminalId);
  const beforeB = JSON.stringify({ sessions: native.liveList(B.id).map(s => [s.id, s.tab?.selected, s.tab?.order, s.tab?.name, s.lifecycle]), web: browser.listTabs(B.id).map(w => [w.id, w.selected, w.order, w.title, w.closedAt]) });

  const ops: Array<() => Promise<unknown>> = [];
  for (let round = 0; round < 40; round++) {
    const s = shellsA[round % 3]!, w = webA[round % 2]!;
    ops.push(() => coordinator.nativeAction({ type: 'agency.tab.action', requestId: 'a' + round, workspaceId: A.id, tabId: s.tab!.id, action: 'select' }));
    ops.push(() => coordinator.webRequest({ type: 'agency.webTab.select', requestId: 'aw' + round, workspaceId: A.id, tabId: w.id }));
    ops.push(() => coordinator.nativeAction({ type: 'agency.tab.rename', requestId: 'ar' + round, workspaceId: A.id, tabId: s.tab!.id, name: 'A-' + round }));
    // Forgeries: A's workspace with B's tab ids, and B's workspace with A's tab ids.
    ops.push(() => coordinator.nativeAction({ type: 'agency.tab.action', requestId: 'x' + round, workspaceId: A.id, tabId: shellsB[round % 2]!.tab!.id, action: round % 2 ? 'close' : 'select' }).catch(() => 'rejected'));
    ops.push(() => coordinator.webRequest({ type: round % 2 ? 'agency.webTab.close' : 'agency.webTab.select', requestId: 'xw' + round, workspaceId: A.id, tabId: webB[round % 2]!.id }).catch(() => 'rejected'));
    ops.push(() => coordinator.nativeAction({ type: 'agency.tabs.order', requestId: 'xo' + round, workspaceId: A.id, tabIds: [...shellsB.map(x => x.tab!.id), ...webB.map(x => x.id)] }).catch(() => 'rejected'));
  }
  // A also closes its own tabs during the storm.
  ops.push(() => coordinator.nativeAction({ type: 'agency.tab.action', requestId: 'a-close', workspaceId: A.id, tabId: shellsA[2]!.tab!.id, action: 'close' }));
  ops.push(() => coordinator.webRequest({ type: 'agency.webTab.close', requestId: 'aw-close', workspaceId: A.id, tabId: webA[1]!.id }));
  for (let i = ops.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ops[i], ops[j]] = [ops[j]!, ops[i]!]; }
  const results = await Promise.all(ops.map(op => op().catch(error => ({ error: String(error) }))));

  const afterB = JSON.stringify({ sessions: native.liveList(B.id).map(s => [s.id, s.tab?.selected, s.tab?.order, s.tab?.name, s.lifecycle]), web: browser.listTabs(B.id).map(w => [w.id, w.selected, w.order, w.title, w.closedAt]) });
  assert.equal(afterB, beforeB, 'workspace B state is byte-identical after 240 concurrent operations in A');
  assert.equal(targetsB.every(Boolean), true);
  assert.equal(browser.listTabs(B.id).filter(tab => !tab.closedAt).length, 2);
  for (const pty of ptysB) assert.ok(!closed.includes(pty!), 'no sibling PTY of B was closed');
  assert.ok(closed.includes(native.get(shellsA[2]!.id)!.terminalId!) || native.get(shellsA[2]!.id)!.tab!.closedAt, 'A closed its own tab');
  assert.ok(!closed.some(id => [shellsA[0], shellsA[1]].some(s => native.get(s!.id)!.terminalId === id)), 'A siblings not closed');
  // Exactly one selected tab per workspace across both domains.
  for (const ws of [A.id, B.id]) {
    const selected = native.liveList(ws).filter(s => s.tab?.selected && !s.tab.closedAt).length + browser.listTabs(ws).filter(w => w.selected && !w.closedAt).length;
    assert.equal(selected, 1, 'one selection in ' + ws);
  }
  const forged = results.filter(r => r === 'rejected' || (typeof r === 'object' && r !== null && ('error' in r || (r as { type?: string }).type === 'agency.error'))).length;
  assert.ok(forged >= 80, `forged cross-workspace operations rejected (${forged})`);
});

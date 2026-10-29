// P-1 before/after: per tab-action snapshot size and per-change save latency as closed history grows.
// BEFORE = single AgencySessionStore + full list in every snapshot (audit baseline behaviour).
// AFTER  = SplitAgencySessionStore + liveList() snapshots; "after (close)" is a change that moves a row
//          into history (history file rewritten), the rare case.
// Run: (cd packages/server && npx tsx ../../docs/maw/claude-review/evidence/bench-session-history-split.ts)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgencySessionStore, SplitAgencySessionStore, isLiveSession } from '../../../../packages/server/src/agency/agency-session-store.js';
function session(i: number, open: boolean, ws: string): any {
  const now = new Date(Date.now() - i * 1000).toISOString();
  return { id: randomUUID(), workspaceId: ws, tab: { id: randomUUID(), name: i % 3 ? null : 'Renamed tab ' + i, order: i, selected: false, closedAt: open ? null : now, current: true },
    launchId: randomUUID(), terminalId: open ? 't-' + i : null, lifecycle: open ? 'running' : 'exited', activity: open ? 'unknown' : 'offline',
    createdAt: now, updatedAt: now, startedAt: now, stoppedAt: open ? null : now, exitCode: open ? null : 0,
    kind: 'agent', profileId: 'codex-0', nativeSessionId: randomUUID(), nativeIdentity: { provider: 'codex', home: '/home/user/.codex', bindingId: 'a'.repeat(64) },
    selectedModel: null, selectedEffort: null, launchDefinition: { executable: '/home/user/.local/bin/codex-0', args: ['--no-alt-screen'], contextRef: 'a'.repeat(64) },
    historyAvailability: 'available', recovery: { status: 'resumed', message: null } };
}
const p = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))]!.toFixed(2);
const dir = await mkdtemp(path.join(tmpdir(), 'maw-bench-split-'));
const ws = randomUUID();
console.log('closed,before_snapshot_B,after_snapshot_B,before_save_p50_ms,before_save_p95_ms,after_save_p50_ms,after_save_p95_ms,after_close_save_p50_ms');
for (const closed of [0, 100, 500, 2000]) {
  const open = Array.from({ length: 12 }, (_, i) => session(i, true, ws));
  const hist = Array.from({ length: closed }, (_, i) => session(i + 12, false, ws));
  const all = [...open, ...hist];
  const snap = (rows: unknown[]) => Buffer.byteLength(JSON.stringify({ type: 'agency.sessions.snapshot', requestId: '', sessions: rows }));
  const single = new AgencySessionStore(path.join(dir, `single-${closed}.json`));
  const split = new SplitAgencySessionStore(path.join(dir, `split-${closed}.json`));
  await split.save(all);   // first save writes both files
  const before: number[] = [], after: number[] = [], closeSave: number[] = [];
  for (let r = 0; r < 40; r++) {
    // A live-only change (select / rename / activity): a new object for one open row.
    open[0] = { ...open[0], updatedAt: new Date().toISOString() };
    const rows = [...open, ...hist];
    let t = performance.now(); await single.save(rows); before.push(performance.now() - t);
    t = performance.now(); await split.save(rows); after.push(performance.now() - t);
  }
  for (let r = 0; r < 10; r++) {
    hist.unshift(session(99999 + r, false, ws));
    const t = performance.now(); await split.save([...open, ...hist]); closeSave.push(performance.now() - t);
    hist.shift();
  }
  console.log([closed, snap(all), snap(all.filter(isLiveSession)), p(before, .5), p(before, .95), p(after, .5), p(after, .95), p(closeSave, .5)].join(','));
}
await rm(dir, { recursive: true, force: true });

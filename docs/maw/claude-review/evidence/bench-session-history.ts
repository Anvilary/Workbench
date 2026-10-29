// Microbenchmark: agency-sessions snapshot size, JSON.stringify and AgencySessionStore.save()
// cost as closed-tab history grows. Synthetic rows shaped like AgencyRuntimeSession; temp dir only.
// Run from repo root: (cd packages/server && npx tsx ../../docs/maw/claude-review/evidence/bench-session-history.ts)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgencySessionStore } from '../../../../packages/server/src/agency/agency-session-store.js';
function session(i: number, open: boolean, ws: string): any {
  const now = new Date().toISOString();
  return { id: randomUUID(), workspaceId: ws, tab: { id: randomUUID(), name: i % 3 ? null : 'Renamed tab ' + i, order: i, selected: false, closedAt: open ? null : now, current: open },
    launchId: randomUUID(), terminalId: open ? 't-' + i : null, lifecycle: open ? 'running' : 'exited', activity: open ? 'unknown' : 'offline',
    createdAt: now, updatedAt: now, startedAt: now, stoppedAt: open ? null : now, exitCode: open ? null : 0,
    kind: 'agent', profileId: 'codex-0', nativeSessionId: randomUUID(), nativeIdentity: { provider: 'codex', home: '/home/user/.codex', bindingId: 'a'.repeat(64) },
    selectedModel: null, selectedEffort: null, launchDefinition: { executable: '/home/user/.local/bin/codex-0', args: ['--no-alt-screen'], contextRef: 'a'.repeat(64) },
    historyAvailability: 'available', recovery: { status: 'resumed', message: null } };
}
const dir = await mkdtemp(path.join(tmpdir(), 'maw-bench-'));
const ws = randomUUID();
console.log('closed_history,open,snapshot_bytes,stringify_ms_p50,save_ms_p50,save_ms_p95');
for (const closed of [0, 100, 500, 2000]) {
  const rows = [...Array.from({ length: 12 }, (_, i) => session(i, true, ws)), ...Array.from({ length: closed }, (_, i) => session(i + 12, false, ws))];
  const store = new AgencySessionStore(path.join(dir, 'agency-sessions-' + closed + '.json'));
  const str: number[] = []; const sv: number[] = [];
  for (let r = 0; r < 40; r++) { const t = performance.now(); JSON.stringify(rows); str.push(performance.now() - t); }
  for (let r = 0; r < 40; r++) { const t = performance.now(); await store.save(rows); sv.push(performance.now() - t); }
  const p = (a: number[], q: number) => a.sort((x, y) => x - y)[Math.floor(q * (a.length - 1))].toFixed(2);
  console.log([closed, 12, Buffer.byteLength(JSON.stringify({ type: 'agency.sessions.snapshot', requestId: '', sessions: rows })), p(str, 0.5), p(sv, 0.5), p(sv, 0.95)].join(','));
}
await rm(dir, { recursive: true, force: true });

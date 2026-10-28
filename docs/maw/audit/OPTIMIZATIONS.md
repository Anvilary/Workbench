# Optimizations

## O01 — native selection persistence/event amplification

15 logical shell tabs, real private JSON files on /tmp, fake PTYs, no network.
Node 24.22.0 Linux. 300 repeated selections followed by 300 alternating selections.
Command: `pnpm --filter @agent-workbench/server exec tsx ../../scripts/audit/selection-benchmark.mts`.
Before: e8c559a. Raw samples summary in evidence/selection-{before,after}.json.

| Workload | Before | After | Observed change |
| --- | --- | --- | --- |
| Same-tab snapshot writes | 300 | 0 | 100% eliminated |
| Same-tab changed events | 4500 | 0 | 100% eliminated |
| Same-tab p50 / p95 ms | .181 / .445 | .0028 / .0067 | 98.4% / 98.5% lower |
| Alternating changed events | 4500 | 600 | 86.7% fewer |
| Alternating event bytes | 2,635,500 | 350,700 | 86.7% fewer |
| Alternating writes | 300 | 300 | Unchanged |
| Alternating p50 / p95 ms | .193 / .326 | .180 / .337 | No convincing latency improvement |

Small change: compute changed tab metadata, skip duplicate selections and publish
only changed sessions. Preserve atomic persistence for real switches. Failed
writes restore tab selection while retaining concurrent PTY lifecycle changes.
Only current/open attempts can be selected. Coordinator snapshots still exist;
these counts describe runtime changed events, not total WebSocket traffic.
42 focused runtime/coordinator tests PASS, including new no-op, two changed tabs,
write-failure rollback, native identity, sibling PTY and mixed web selection checks.
RSS varied by ~1 MB; no memory reduction claim. Shared host/cache/short runs mean
latencies are illustrative; deterministic event/write reductions are the benefit.

Recommendations not implemented: differential coordinator snapshots, browser
viewer connection reuse, debounced persistence only after crash semantics analysis,
bundle splitting, bounded completed-turn receipts with durable deduplication.
No architecture replacement or unmeasured optimization performed.

# Reproducible performance measurements

Starting SHA cde654f6a0302a43c10dfc696b264ec8c3aefd05. Native optimization
baseline at e8c559a, after at b0ab846. No baseline startup/Neko comparison was
captured before checkpoint 0; do not present final measurements as original-main
performance. Real application/resource reference measurements below are final
behavior, not before/after claims.

## Native selection before/after

See OPTIMIZATIONS.md and evidence/selection-*.json. Real atomic JSON persistence,
fake PTYs, 15 tabs, 300 operations per workload. Same-tab writes 300→0;
alternating events 4500→600. Real-switch p95 did not improve. Counts do not include
coordinator snapshots. These measurements do not predict remote/browser latency.

## Actual application reference

Isolated temporary HOME/XDG; production bundle; Node 24.22.0; disposable Chrome
and real local Neko; shared Linux host, OS caches warm. `check-maw-integration.mjs`
with generated config. Raw data: evidence/integration.json.

- Initial process startup to authenticated WS notification response: 470.0 ms.
- Restart of same fixture: 465.3 ms. One sample each, not distributions.
- Frontend navigation to mounted .agency-app: 191.2 ms. Includes navigation;
  not React commit time or fully rendered terminal/video readiness.
- 40 native select requests between already-selected tabs in separate workspaces:
  WS roundtrip p50 0.230, p95 0.341, p99 0.351 ms.
  **This is server request latency, not visible workspace-switch latency**.
  120 received messages (3 per operation, including snapshots/responses).
- Server RSS 117.3 MiB, PSS 65.9 MiB from /proc/smaps_rollup before browser UI.

## Real Neko browser resources

Fresh audit-only pinned Neko image, 1280×720 desktop, no viewer connection,
unauthenticated https://chatgpt.com/ pages; no prompts/conversation access. Actual
controller target counts exactly 1/5/10/15. `scripts/audit/neko-resources.py`
reads /proc as neko user, groups by process comm, samples CPU ticks across ~3.3s.
Loading interval immediately after target creation; settled interval follows it.
Settled is a sampling label, not proof of page/network idle. CPU is percent of
one core, can exceed 100%. No machine isolation/cache reset. Raw evidence includes
sample duration/process counts. PSS is shared-page apportioned, RSS sums shared
pages repeatedly. Container overhead group has one unreadable process; Chromium
and Neko samples have none. Initial root-user attempt could not read browser PSS
and was discarded, never interpreted as zero memory.

| Tabs | Chromium PSS MiB | Chromium summed RSS MiB | Chromium CPU loading / settled | Neko PSS / RSS MiB |
| --- | --- | --- | --- | --- |
| 1 | 320.1 | 1101.4 | 45.5% / 1.5% | 22.0 / 41.1 |
| 5 | 580.0 | 1863.1 | 132.3% / 2.5% | 22.0 / 41.1 |
| 10 | 891.5 | 2801.2 | 206.3% / 2.1% | 22.0 / 41.1 |
| 15 | 1202.6 | 3738.2 | 205.8% / 2.1% | 22.0 / 41.1 |

Neko without viewer uses ~0% sampled CPU; this excludes WebRTC encoding cost.
Other container processes use ~76 MiB measured PSS (partial: one unreadable PID).
Browser active workload here is page loading, not AI generation. These are
reference costs, no claimed Neko optimization. Script requires a uniquely labelled
audit container and refuses a non-fresh tab inventory; no production defaults.

## UNVERIFIED / not measured

OS-cache-cold startup; visible workspace/tab activation distributions; frontend
process PSS/CPU; React commit counts; terminal-output frame latency; long-uptime
listener/timer growth; authenticated generation CPU; power-loss durability.
No inference from short runs or idle network. Use future bounded isolated soak
with explicit process ownership and real interaction timing before release claims.

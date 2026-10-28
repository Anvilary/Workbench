# Optimization decisions

| Candidate | Impact/evidence | Cost/risk | Outcome |
| --- | --- | --- | --- |
| O2-01 suppress unchanged coordinator domains | Repeated select: 3 global/direct messages per call; 100 real WS calls measured | Two cached serializations; extra JSON comparison on changed state, no disk/schema/session changes | Kept: 66.7% fewer messages, 50.1% fewer bytes on repeated select; no paint-speed claim |
| Drop native snapshots entirely / change protocol | Could remove more traffic on real switches | Requires careful partial-failure/reconnect validation across observers | Deferred |
| Debounce persistence / discard dedup receipts | Could reduce disk work/history cost | Failure durability and duplicate notifications could regress | Deferred |
| Dynamically resize shared Chromium for mobile | Would enlarge remote page text | Changes global desktop for every viewer and active page | Deferred pending fitting/input design |
| Bundle split / React memoization | Bundle warning exists; no measured critical-path attribution | Changes unmeasured paths | Deferred |

O2-01 keeps every native request response, connection/reopen snapshot and changed
domain broadcast. Coordinator comparison still runs in finally after mutations,
including failures. Tests cover unchanged/failed no-op selection, native-only
rename, mixed-domain selection and activation failure that must publish error
state. Broad server tests, real reconnect soak and real Neko restart acceptance
pass. No PTY lifecycle, native identity, persistence format or browser ownership
policy changes. Comparison strings are bounded by current retained application
metadata; this is not a new unbounded event log.

Before/after commands, distributions and limitations are in BENCHMARKS.md.
Visible switch p95 50.2→50.6 ms, no improvement. Alternating WS p95 .847→1.475 ms
in the shared-host runs; changed-state JSON comparison has cost, and overlapping
setup work prevents clean attribution. Keep for the deterministic duplicate
traffic reduction; do not describe it as a measured UI responsiveness gain.
If later controlled trials show meaningful real-switch regression, revert only
this optimization; persistence recovery fixes remain independent commits.

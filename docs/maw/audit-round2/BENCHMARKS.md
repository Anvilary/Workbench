# Round 2 measurements

Raw before/after: [before](evidence/soak-before.json), [after](evidence/soak-after.json).
Node 24.22.0, production UI, real disposable Bash PTYs, 15 initial tabs across
four workspaces/two projects, shared Linux host. Two runs, 120-second workload
each plus setup/UI/cleanup. Before coordinator uses starting implementation;
after uses domain comparison. Persistence fixes were also present during later
phases but do not alter healthy selection writes. Builds/typecheck/other host
work overlap some setup; neither run is a controlled CPU/cache experiment.

Each inexpensive interaction has 100 samples. Percentiles use sorted sample
indices floor(n*q), no interpolation. Browser event timing starts inside the
real page, clicks the actual UI control, observes selected aria state and waits
two requestAnimationFrame callbacks. This includes WS delivery and React update
for tab selection, but only establishes a **paint opportunity**, not display
hardware scanout or WebRTC frame latency. There is no Playwright click transport
in these sample durations. Other viewport checks use real Playwright input.

| Metric (ms unless specified) | Before p50 / p95 / p99 | After p50 / p95 / p99 |
| --- | --- | --- |
| Repeated select WS response | .219 / .381 / .769 | .251 / .362 / .714 |
| Alternating select WS response | .490 / .847 / 2.123 | .657 / 1.475 / 4.601 |
| Tab input → selected state + two rAF | 50.0 / 50.2 / 50.7 | 50.0 / 50.6 / 50.8 |
| Inbox toggle → two rAF | 33.3 / 33.5 / 34.0 | 33.3 / 33.4 / 33.6 |
| Repeated select messages / bytes, 100 operations | 300 / 1,929,300 | 100 / 963,500 |
| Alternating select messages / bytes, 100 operations | 498 / 2,073,741 | 397 / 2,058,242 |

No meaningful visible-latency improvement is established. Alternating WS tail
latency is worse in this shared-host run; do not present reduced traffic as
faster real switching. Comparison adds JSON work on changed snapshots, and
other setup processes overlap; repeated isolated trials are needed to attribute
the sub-ms difference. Duplicate traffic falls deterministically by 66.7%
(messages) / 50.1% (bytes); alternating byte reduction is only 0.75%.
Global native snapshots and direct request replies remain intentionally intact.

Full-page reload and heap sampling affect workload resource use. No forced GC
in latency/resource runs. Server FD before 32→47 warm→50 churn→32 cleaned;
after 24→39→42→24. Both have 15 PTY children during workload, zero after close.
Before PSS 81.9→90.8→78.5 cleaned / 69.6 restarted MiB; after
66.2→73.9→63.6 cleaned / 68.9 restarted MiB. Do not claim reduced memory
from different process warm-up and host accounting. RSS and CPU ticks are in raw
JSON; CPU tick deltas divided by elapsed monotonic sample time / host CLK_TCK
estimate CPU use, not instantaneous utilization. No sustained unrecovered server
resource trend is established in these two short runs.

Both runs complete 34 reconnects plus repeated frontend reloads, 680 workload
selections and 34 temporary PTY create/close cycles, then close all 15 initial
PTYs. Each retains 49 historical session rows by design. DOM stays 384–419 nodes.
After-run CDP listener counts are 381, 362, 368, 867, 861 across successive
samples. Counts include garbage awaiting collection across reloads; diagnostic
GC results are recorded separately when available. Server listener/timer counts,
React commit counts/durations, and actual terminal input-to-output paint
throughput were not instrumented. Known fixture WS client count and active PTYs
are recorded in after samples; no kernel-level socket inventory was captured.

Final-window long-task observer recorded no tasks >=50 ms and layout shift 0
in both runs. The observer resets on each navigation: these values cover only
the final document, not the entire run or all 100 measured interactions.
No claim of zero long tasks throughout the application is made.

Chromium/Neko PSS/FD/process/CPU at 1/5/10/15/30 targets and post-close:
[evidence](evidence/neko-resources.json), interpretation in RELIABILITY.md.
No comparison with Round 1's different browser/profile warm-up is valid.

Traces (private local artifacts, contain disposable fixture auth URLs):
`/tmp/maw-round2-before/interaction-trace.zip`,
`/tmp/maw-round2-after/interaction-trace.zip`.
Screenshots are committed under screenshots/. No production auth or user
conversation was used. Raw sample arrays/std deviation, independent repeated
trials, React durations, frontend PSS and WebRTC update distributions remain
unmeasured. A new fixture run can be extended via MAW_ROUND2_SECONDS (up to 3600).

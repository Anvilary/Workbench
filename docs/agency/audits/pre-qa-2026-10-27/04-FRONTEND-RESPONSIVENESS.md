FINAL — BOUNDED AUDIT COMPLETE

Final decision: bounded audit complete; final continuation sections below and 08/09 supersede historical checkpoint limitations. No performance refactoring before QA; Group A/B corrections remain required.

# Frontend Responsiveness

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`
Audit branch: `audit/agency-ui-pre-qa-20261027`
Date: 2026-10-28 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.
Limitations: synthetic/local bounded review; real-provider checks require manual QA. Earlier checkpoint sections are historical; final continuation conclusions supersede their incomplete-state statements.
Last completed step: integrated account isolation, critical boundary review, sustained PTYs, long transcript and browser reconnection; final backlog and handoff.


## Browser fixture run (partial)

Executed `capture-agency-screenshots.mjs` with disposable homes and a synthetic no-inference CLI, actual headless Chrome 155, production build and temporary screenshot directory. All eight distinct screenshot hashes and associated state assertions passed; zero page errors and zero console errors were printed. Script asserts keyboard focus stays in profile dialog for eight Tab presses, Escape restores focus, draft remains across two switches, Done/Restore succeeds, and terminal panes are visible. It checks a populated combined workspace plus dialog at all four widths, manually collapsing the sidebar at 390px. Viewport/document widths were equal: 390/390, 768/768, 1024/1024, 1440/1440; dialog bounds and terminal minimum sizes passed. These are not exhaustive clipping, accessibility, focus, real provider, large-list, transcript, throughput, reconnection or load tests. Script logs console errors but does not assert the array empty (`capture-agency-screenshots.mjs:387-393`); this run happened to log zero.

Repeated warm interaction measurements are in 05. Active terminals emitted no sustained output; low-load success does not establish responsiveness under load. No browser traces or leak counts collected.

A 20-switch disposable shell-output test at ~64 kB/s reported p50/p95/max 56.97/66.26/68.75 ms including Playwright overhead. It ran for only 1.17 seconds and is not a long-run stress or leak test; methodology in 05. Source review: `TerminalView.tsx:462-480` removes message/reopen listeners, resize observer, DOM handlers and xterm subscriptions and sends detach on unmount. Runtime listener counts and offline navigation behavior remain to be tested.

## Ten projects / fifty workspaces fixture

Expanded the real-server fixture to 10 projects and 50 workspace records, 4 live synthetic agent/shell sessions, and reran the screenshot script on headless Chrome. All eight state assertions and distinct hashes passed; the same combined layout and profile dialog checks passed at 390/768/1024/1440 with the mobile sidebar collapsed. Console/page error counts were reported as zero. Twenty-switch and interaction distributions in 05. The existing selected test workspaces were under the initial project; this does not exhaustively navigate all 50 records, or cover 5/20 as a distinct fixture, long transcripts, high-frequency activity, keyboard/accessibility, live provider sessions, or long-running output.

The first fixture attempt did not close picker instances and hung at the server's limit of eight per socket. The disposable harness was corrected to send `picker.close` after each workspace. The UI's existing FolderPicker sends close on unmount (`FolderPicker.tsx:81-85`); this harness mistake is not itself an application defect. Rapid close before initial listing might leak a picker because the client has no ID at cleanup; this is an unverified timing hypothesis, requiring controlled reproduction.

The previously noted rapid picker-close hypothesis is confirmed as FUNC-001 in a real browser with controlled 500 ms response delay; see 02 and 07. Eight abandoned pickers lead to an initial failure that stays visually loading. Actual incidence without injected delay is unmeasured.

## Continuation 02 — sustained eight-PTY workload (2026-10-28)

Real production server / Chrome 155, same hardware and pinned source; ten projects / **56** workspaces (50 plus six load fixtures), eight concurrent shell PTYs plus two idle agent fixtures. Eight Python generators each emit 260-character lines with 10 ms sleep for a maximum 60 seconds. An independent attached socket counts all eight streams. During 60 browser switches, alternate Combined Workspace and Agent Only; focus composer, type `abc`, assert its value ends with abc, then wait 400 ms. Send Ctrl+C to generators, perform 20 detach/attach cycles and await actual terminal.replay. Tear down owned processes and temp directories. Observed 5,980,506 output bytes across 29,238 ms (~204.5 kB/s overall). This is a bounded ~29-second trial, not a soak or throughput ceiling.

| Measurement | p50 ms | p95 ms | max ms | n |
|---|---:|---:|---:|---:|
| Loaded navigation, visible workspace + aria-current | 59.12 | 68.79 | 71.91 | 60 |
| Composer type abc + value check | 9.92 | 14.53 | 20.18 | 60 |
| Socket terminal replay delivery | 1.72 | 3.59 | 4.73 | 20 |

Nearest-rank p95; median averages central pair; wall clock includes Playwright/WS polling overhead. Replay delivery does not measure completion of xterm painting. Resources sampled before load and every fifth switch (13 observations): server launcher process-group summed RSS 360428..367440 KiB (first/last), fd count 84 initially, 83 then 81 stable; three launcher/server group processes (PTY children in other process groups are excluded). Summed RSS is not PSS or server heap. Browser CDP metrics after forced GC, before/after: JS heap 4,998,296 / 7,844,004 bytes; DOM nodes 902 / 989; event listeners 373 / 553. ScriptDuration delta 1.801 s; TaskDuration delta 6.525 s. These are cumulative main-thread execution costs including parsing/dispatch/rendering, not isolated parser costs. Listener growth requires attribution/longer investigation; do not call this proof of a production leak or a material bottleneck. No fd growth observed; no latency degradation established. Do not refactor performance before QA on this evidence.

Runnable ephemeral fixture `/tmp/agency-audit-sustained.mjs`, derived from 05 scale harness: add six picker-created shell workspaces, attach all eight shell IDs on one observer socket, send the Python command from the short-output fixture with sleep(0.01)/6000 iterations, run the 60 switch/type/sleep cycles above, sample /proc as earlier, and use CDP Performance.getMetrics plus HeapProfiler.collectGarbage. Original workload design and metrics remain preserved above.

## Continuation 04 — long transcript and browser costs

Disposable real server/wrapper/browser, 1,000 timestamped synthetic user events of ~1,000 chars each, in a valid UUIDv7 rollout whose embedded creation day matches its directory. Initial append-to-visible tail: 334.35 ms (n=1, p50=p95=max for that single observation; not a tail estimate). After switching away, re-subscription intentionally uses ConversationHub INITIAL_EVENT_LIMIT=300; wait for `.agency-turn` index 299 before declaring Agent Only ready. Three blocks of 20 alternating switches between Agent Only and Combined: p50 179.87, nearest-rank p95 278.71, max 292.90 ms, n=60. This measures restored transcript readiness, unlike earlier visible-container-only switching numbers; do not infer a causal slowdown ratio from different endpoints. Final rendered count 300; full older history browsing is not benchmarked. No multi-second stall or lost stored transcript established.

CDP metrics after 1.2s settle and forced GC, baseline/after each 20-switch block, identical final workspace and 300 rows: Nodes 3012/3015/3015/3015; JSHeapUsedSize bytes 5944468/6447888/6514384/6571824; JSEventListeners 185/245/305/365. Last cumulative ScriptDuration 2.441541s and TaskDuration 9.105725s after enabling CDP; scripting + layout/paint etc cannot be separated into React cost from these totals. Listener increase repeats, but retained targets/root cause and long-term slope/impact are unverified. Record as an investigation opportunity, not a confirmed memory-leak finding. Fixture `/tmp/agency-audit-long-ready.mjs`: reuse account-browser recipe, derive UUIDv7 first 48 bits from current epoch milliseconds, generate 1000 user events, wait for at least300 visible events on each return; three20-switch blocks, collect CDP Performance metrics after HeapProfiler GC. Earlier temporary attempt used a fixed old UUIDv7 in today's directory and could not reload; this was a **fixture error**, not a product finding. Its 57/68ms container-only timings and timeout are excluded from long-transcript conclusions.

Separate browser microbenchmark (Chrome155 fresh blank page): serialize `{type:'conversation.reset',events:[1000 synthetic user events, each 1000-char text]}` once, warm JSON.parse once, then20 JSON.parse calls inside page.evaluate, assert1000 events each time, measure performance.now. 1,086,930-byte payload: p50 1.10ms, nearest-rank p95 1.40ms, max1.90ms, n20. `/tmp/agency-audit-browser-parse.mjs`. Excludes network, dispatch and rendering; no claim this exact payload is sent as an initial snapshot (initial tail is300). This bounds a representative parse workload and does not identify a parser bottleneck.

**Decision:** no performance refactoring before QA. Retain existing implementation pending native/manual QA; separately profile listener retention if a longer run or user-visible degradation establishes material impact. Current finite trials do not establish soak stability, machine-cold startup, peak provider workloads, or zero leaks.

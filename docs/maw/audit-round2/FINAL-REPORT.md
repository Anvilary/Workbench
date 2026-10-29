# MAW Round 2 — verified subset and release assessment

Started 2026-10-28; delivered 2026-10-29. Branch `audit/maw-deep-soak`.
Starting SHA `e2dc81217490199e16683ce08653860171d912ad`.
Audited implementation/evidence SHA `510fe0873fec312916f5107ef5e6014a285075dc`;
subsequent delivery changes are documentation/evidence only. Exact delivery HEAD
is available on the PR head and in the final handoff; no self-referential commit
hash is embedded in its own contents.
Draft PR: https://github.com/alteixeira20/My-Amazing-Workspace/pull/14.
No merge or deployment. Production processes, sessions, data and services untouched.

**Release verdict: CONDITIONAL.** Core bounded regressions and isolated acceptance
pass; this is not a complete production release approval. No confirmed unresolved
P0/P1 finding. Outstanding evidence and mobile/shared-desktop limitations prevent
PASS. The two P2 recovery defects and P3 traffic defect found here are corrected.

## Checkpoint completion

| Checkpoint | Executed | Incomplete / limitation |
| --- | --- | --- |
| 0 recovery/baseline | COMPLETE: expected clean HEAD, prior documents, 173/19/19 baseline, typecheck/build, committed plan | None for baseline |
| 1 sustained reliability | BOUNDED: two 120-second workloads, 34 churn/reconnect cycles each, PTY/FD/PSS/CPU/DOM; 1/5/10/15/30 actual browser targets; 30-reload GC diagnostic | Days-long uptime, active WebRTC encoding soak, server listener/timer counts |
| 2 perceived performance | PARTIAL: 100 samples each WS repeat/alternate, UI tab switch, inbox; trace and percentiles | Full scenario matrix, actual viewport scanout, WebRTC update latency, React commits/durations, terminal throughput |
| 3 concurrency/faults | PARTIAL: repeated recovery corruption, future schema, mixed selection/errors; existing targeted fault regressions and real restarts | Every listed fault ordering, true disk full/power interruption at all write stages |
| 4 responsive UI | PARTIAL: actual interactions/media six sizes, active shell resizing/input, keyboard rename/sidebar/inbox; screenshots | Mobile stream readability unchanged; zoom, touch, all focus paths and pointer stress |
| 5 security/isolation | PARTIAL: auth/controller/ownership regression and actual foreign owner/restart rejection | Packet-level egress isolation, full new adversarial matrix, independent visual privacy unavailable by architecture |
| 6 optimizations | COMPLETE for O2-01: measured, compatibility tested, before/after documented | No demonstrated paint-speed improvement; other candidates deliberately deferred |
| 7 provider completion | PARTIAL: Codex lifecycle fixtures strengthened; official hook contracts researched | Authentic Codex/Antigravity turns, Stop-hook installation/attribution and authenticated ChatGPT completion UNVERIFIED |
| 8 regression/release | LOCAL applicable gates PASS, draft pushed and CI inspected | Remote runners blocked before startup; cross-platform/package/Android acceptance not run locally |

## Confirmed defects and corrections

| ID | Severity | Reproduction / correction |
| --- | --- | --- |
| R2-01 | P2 | Valid backup recovery → next save poisons backup with old corrupt primary → second corruption unrecoverable. Both notification/activity regressions failed before, pass after validated quarantine. |
| R2-02 | P2 | Browser primary version 999 + v1 backup silently downgraded. Now refuse fallback, preserve both files, remain unloaded. |
| R2-03 | P3 | Duplicate tab selections broadcast both global snapshots. Compare each domain; preserve changed/error state, direct replies and new-connection catch-up. |

[FINDINGS.md](FINDINGS.md) contains root causes and executable tests. New recovery
matrix also verifies both-corrupt refusal without overwriting evidence and
missing-primary/valid-backup recovery. No persistence schema changed. No durable
receipt retention was reduced or writes debounced.

## Measured results

- 100 repeated selects: **300→100 WS messages**, **1,929,300→963,500 bytes**.
  Alternating selection: 498→397 messages, 2,073,741→2,058,242 bytes.
- Visible selected-state + two-rAF p50/p95/p99: 50.0/50.2/50.7 →
  50.0/50.6/50.8 ms. **No visible latency improvement**. WS alternating p95
  .847→1.475 ms in shared-host runs; extra comparison and overlapping setup
  need controlled follow-up. Keep the deterministic duplicate-traffic reduction,
  do not call this a demonstrated faster switch.
- Before/after FD returns to respective baselines (32 / 24); 15 PTY children
  return to zero. Before PSS 81.9 baseline / 90.8 warm / 78.5 cleanup MiB;
  after 66.2 / 73.9 / 63.6. Different baselines do not prove memory optimization.
- Actual Chromium settled PSS at 1/5/10/15/30 targets:
  456.8/715.7/1024.8/1328.4/2167.4 MiB; post-close 368.2 MiB.
  CPU ~1.6–2.5% of one core up to 15 tabs; 30-tab sample still loading at 54.8%,
  loading peak 376.2%. No viewer encoding included; Neko PSS ~33 MiB.
- A 30-reload diagnostic showed 7,014 listeners / 83 documents before GC,
  362 / one document after. This supports uncollected old documents, not a
  confirmed persistent subscription leak. Interaction benchmarks never force GC.

Raw distributions, CPU calculations and limits: [BENCHMARKS.md](BENCHMARKS.md),
[evidence](evidence/soak-after.json). Rationale and rejected/deferred candidates:
[OPTIMIZATIONS.md](OPTIMIZATIONS.md). The workloads are minutes, not days.

## UI and providers

Six-size screenshots and interaction coverage: [RESPONSIVE.md](RESPONSIVE.md).
Live Neko media, desktop keyboard input, browser/native/workspace switching,
rename, inbox inspection, sibling close and MAW/controller/Chromium restart
acceptance passed. At 390px remote text remains severely downscaled. A local
panning/fitting strategy needs coordinate/touch tests; changing shared desktop
resolution would affect every viewer. No untested fitting change shipped.

[Provider capability matrix and security model](RELIABILITY.md): shell lifecycle
PASS with real disposable Bash/Zsh; Codex fixture lifecycle/repeated turns/loss
and delayed recovery PASS; authentic Codex behavior UNVERIFIED. Antigravity Stop
contract documented but authentic lifecycle attribution UNVERIFIED. ChatGPT
completion UNVERIFIED, remains Unknown; no private API, cookie/token retrieval,
transcript scraping or completion claim based on network inactivity.

A single Neko stream does not provide independent visual privacy across viewers
or workspaces. Controller ownership is mutation isolation. Browser navigation
policy is not verified network egress isolation. Atomic rename is not proof of
fsync/power-loss durability. Closed history and durable dedup receipts grow by
design; retention requires a separate durability design.

## Regression / CI / cleanup

- Server/auth/host/native/profile/browser/activity: **179 PASS**, zero skips.
- Frontend model/notifications/real Chromium UI fixture: **19 PASS**, zero skips.
- Python controller/ownership: **19 PASS**.
- Native identity/session E2E **25 PASS**; remediation **6/6 groups PASS**.
- New Codex activity integration **9 PASS**; recovery corruption matrix **4 PASS**
  (included in server total).
- Real Neko UI **11 acceptance groups**, all six media sizes PASS; managed real
  browser controller/Chromium restart **7 assertions PASS**.
- `pnpm check`, all-package typecheck and production build PASS. Internal guide
  check explicitly SKIP because not in checkout. Existing large bundle warning.
- GitHub main baseline run 40786993666 and draft run
  [40790978936](https://github.com/alteixeira20/My-Amazing-Workspace/actions/runs/40790978936)
  failed before runners started: billing/payment or spending-limit annotation,
  zero job steps, downstream install smoke SKIPPED. **Not code-check passes.**
  Windows/macOS package smoke and Android were not substituted with local checks.

Fixture container `maw-neko-integration-audit-fm1n7jvb` was removed only after
verifying its ID, audit label, loopback ports, read-only mounts and no volumes.
No volumes, images, production services or unrelated containers removed.
All harness-owned MAW/Chromium/PTY processes exited; artifact directories remain.
The traces contain disposable MAW auth URLs and are left in private local /tmp,
not published. Committed numeric evidence/screenshots contain no user sessions.

## Exact continuation

1. `git switch audit/maw-deep-soak`; `git status --short --branch`; read
   CHECKPOINTS.md, FINDINGS.md and the latest PR head. Use this worktree only.
2. For a longer isolated soak:
   `MAW_ROUND2_SECONDS=1800 MAW_ROUND2_OUT=/tmp/maw-round2-long node scripts/audit/round2-soak.mjs`.
   Inspect progress.json while running; harness closes only its own processes.
   Follow up on real-switch WS tails with independent repeated controlled trials;
   revert O2-01 separately if meaningful real-switch regression is confirmed.
3. Create a fresh Neko via `python3 scripts/audit/start-neko-fixture.py`; save its
   printed config privately. Never reuse the now-removed fixture. Run resource
   harness and integration commands in RELIABILITY.md with this generated config.
   Extend to sustained **active viewer** reconnect/media/input and failure soak;
   sample encoder CPU/PSS, frame progress and input paint separately.
4. Complete performance scenario matrix and mobile fitting prototype with actual
   pointer/keyboard/touch transforms; add no extra Chromium instances. Instrument
   React commits and terminal-output paint, not just server response timings.
5. Native provider validation requires a separately authenticated **disposable**
   profile or a future explicit session with safe authorization. Do not reuse
   production profiles. Test Antigravity session/execution attribution and
   fullyIdle/termination semantics before claiming completion. ChatGPT remains
   Unknown without an authorized reliable signal.
6. Finish packet-level local/metadata egress probes using local endpoints only,
   storage ENOSPC/write interruption matrix and cross-platform/package gates.
7. Re-run applicable commands in CHECKPOINTS.md, commit evidence, push the same
   draft branch and inspect real CI startup. Account billing changes belong to
   the user, not this audit. No automatic merge/deploy.

# MAW audit remediation — final report

Branch `fix/maw-claude-audit-remediation` (from audit `4fc3e02`, baseline main `3109fc9`).
Final commit and PR: see §1. Original audit: [FINAL-REPORT.md](FINAL-REPORT.md) (unchanged).
Per-finding detail: [REMEDIATION-MATRIX.md](REMEDIATION-MATRIX.md). Durable log: [REMEDIATION-CHECKPOINTS.md](REMEDIATION-CHECKPOINTS.md).

Evidence classes used below: **REAL** = real systemd user manager / real server / real PTY / real Chromium /
real Neko container; **MOCKED** = stubbed systemctl/pnpm or fake connection; **INSPECTION** = code reading only.

## 1. Final commit, PR, CI

- Final commit: the HEAD of `fix/maw-claude-audit-remediation` (this report is committed last; last code commit `36ae0f2`).
- Draft PR: **NOT CREATED — BLOCKED.** `gh` is not authenticated in this environment and no token is available.
  The branch is pushed. Create it with (from the worktree): `gh pr create --draft --base main --head fix/maw-claude-audit-remediation --title "MAW independent audit remediation" --body-file docs/maw/claude-review/PR-BODY.md`,
  or via https://github.com/user/My-Amazing-Workspace/pull/new/fix/maw-claude-audit-remediation
- CI: **UNVERIFIED / not started** — `ci.yml` runs on push to main/develop and on pull_request; no PR exists yet,
  and run status cannot be queried without `gh` auth. Round 2 recorded GitHub billing blocking runners before
  startup; if that recurs it is an infrastructure BLOCK, not a pass.

## 2. Dispositions — all 19 audit findings (+3 found during remediation)

| ID | Sev | Disposition | Fix commit | Proof (strongest evidence) |
|---|---|---|---|---|
| U-1 | P1 | Fixed | `ff3171d`, `9c4ab15` | REAL systemd: crash-looping candidate hits start-limit (journal "Start request repeated too quickly"), detected, healthy release restored and verified by release ID (19.1–19.9 s); broken rollback target → CRITICAL exit 3. MOCKED UPD 8/9/9b/9c/9d/9e |
| U-2 | P1 | Fixed | `ff3171d` | MOCKED UPD 16 (stage A, stage B, reboot boots H, failed B recovers H not A), 16b (helper SIGKILLed after switch + reboot into unverified B → next restart recovers H), 17; REAL systemd promotes healthy/previous only after verification |
| U-3 | P2 | Fixed | `ff3171d` | MOCKED UPD 31 (install builds isolated first release; legacy `current` preserved as `legacy-current`); REAL: release built by `maw-update.sh --initial` boots under the production template |
| U-4 | P2 | Fixed | `ff3171d` | MOCKED UPD 1, 16: staging changes only `staged`; reboot/crash keeps booting the running release |
| U-5 | P2 | Fixed | `ff3171d` | MOCKED UPD 21 (TERM/INT/HUP), 22 (SIGKILL orphan removed next run; decoys untouched), 23 (parent exit) |
| U-6 | P2 | Fixed | `ff3171d` | MOCKED UPD 21: abort < 1 s during a 20 s step, exit 130, pointers unchanged, lock free |
| U-7 | P2 | Fixed | `ff3171d` | MOCKED UPD 3, 19: plain update stages `origin/main` even on a pushed feature branch; other refs need `--allow-unapproved-ref` (+ typed confirmation on a TTY), recorded `channel: unapproved` |
| U-8 | P2 | Fixed | `ff3171d` | Log events asserted in UPD 1/8/9b/17/21/22; `maw status` shows pointers + last event |
| P-1 | P2 | Fixed | `cbae913` | `session-history.test.ts` 6/6; bench: 2,000 closed → snapshot 2,140,229 → 12,327 B, live-change save p50 12.40 → 0.45 ms |
| U-9 | P3 | Fixed | `ff3171d` | MOCKED UPD 24: 20/20 races, exactly one updater proceeds (flock) |
| U-10 | P3 | Fixed | `ff3171d` | `maw-host.test.ts` U-10; UPD 18; REAL systemd probes by release ID |
| U-11 | P3 | Fixed | `ff3171d` | UPD 25 (no stale lock after `--restart`) |
| U-12 | P3 | Fixed | `ff3171d` | UPD 26 (GC keeps pointers + 1 spare, never touches non-release entries) |
| U-13a | P3 | Fixed | `ff3171d`, `36ae0f2` | UPD 30/31; REAL systemd runs the rendered template |
| U-13b | P3 | Fixed | `ff3171d` | UPD 27/28/29 (env passed to delegated helper, fixed collectable unit, exact cgroup match, duplicate refused) |
| C-1 | P3 | Fixed | `33e3745` | `profiles.test.ts` C-1 (configure/inspect/launch refuse an identical launch plan; distinct args / symlinked wrapper / other provider allowed) |
| C-2 | P3 | Fixed | `ddf89ab` | REAL Chromium `browser-tabs.test.mjs`: Configure profile + Start again (close, then relaunch same profile) |
| F-1 | P3 | Fixed | `33e3745` | `model.test.mjs` F-1, `multi-session-protocol.test.ts` F-1 |
| F-2 | P3 | Fixed | `33e3745` | `model.test.mjs` F-2 |
| N-1 (new) | P3 | Fixed | `7a25ad3` | Pre-existing flake at baseline `3109fc9`: 4/6 combined UI runs failed (stale rAF focus restore cancels a new rename); 0/8 after |
| N-2 (new) | P3 | Fixed pre-merge | `1a1be94` | Opt-C's lazy import of UMD `@xterm/addon-webgl` had no named export under esbuild; REAL Chromium WebGL2 (SwiftShader) test now requires the WebGL canvas |
| N-3 (new) | P2 | Fixed | `655b86a` | REAL server + bash PTYs: stalled client during 15M-line flood → RSS +320 MB growing ~18 MB/s before, +112 MB plateau after; reading client keystroke echo ~2.4–2.5 s → p50 8.6–16.6 ms |

No finding was closed as invalid, accepted or deferred. Severities unchanged (U-13 split into a/b to reconcile
the audit's 18 table rows with its 19-count headline).

## 3. P1 reproduction and verified fixes

**U-1** (rollback aborted under `set -e`). Original: `systemctl --user restart` of the healthy release is
refused after a crash-looping candidate hits `StartLimitBurst=3/120s`, and `set -e` exits before rollback.
Fix: explicit state machine in `maw-restart-helper.sh`; every `systemctl` failure and a unit entering `failed`
feed the rollback path; `reset-failed` precedes each restart; success requires the authenticated readiness
probe to report the target's **release ID**; outcomes exit 0 (healthy) / 2 (update failed, recovered) /
3 (CRITICAL); a single rollback attempt, never a loop; every transition logged.
Real proof (`MAW_REAL_SYSTEMD=1 npx tsx --test src/maw-systemd-acceptance.test.ts`): disposable
`maw-test-<hex>.service` rendered from the production template; journal contains "Start request repeated too
quickly" and "candidate crashed on start"; helper exits 2; `current = healthy = H`; `control.mjs status`
with `MAW_EXPECT_RELEASE_ID=H` → `Healthy; PID …; release H`. Rollback-target failure → exit 3 + CRITICAL.

**U-2** (rollback target could be a never-run release). Fix: `staged` / `current` / `healthy` / `previous`
(see [UPDATE-ROLLBACK.md](../UPDATE-ROLLBACK.md)). Only verified activation writes `healthy`/`previous`; staging
writes only `staged`. Migration adopts a running release as healthy only when the live service proves it
serves exactly that release (release ID, or `/proc/<pid>/cwd` for older servers).

## 4. P2/P3 changes

Updater/launcher (`scripts/maw/*`): approved channel; isolated first release; flock locks; interruptible build
steps and ownership-checked orphan recovery; outcome log; release GC; release identity in readiness;
`$HOME`-derived paths and rendered unit; exact cgroup match; delegated helper env; `maw rollback`; `maw start`
verifies; `maw status` shows release state. Application: identical-account profile refusal (C-1); failed-tab
recovery actions (C-2); scoped snapshots (F-1); pure activity reducer (F-2); live/history split (P-1);
output backpressure (N-3); focus-restore race (N-1).

## 5. Update / restart / rollback acceptance matrix

| Scenario | Evidence | Result |
|---|---|---|
| Stage without restart keeps service on running release (crash/reboot included) | MOCKED UPD 1, 16 | PASS |
| Two staged updates, failed activation → actual healthy release | MOCKED UPD 16 | PASS |
| Helper killed after pointer switch, reboot into unverified release, next restart | MOCKED UPD 16b | PASS (rollback) |
| Candidate crash loop → start-limit → rollback → verified | REAL systemd | PASS (exit 2) |
| `systemctl restart` itself fails (start-limit / ExecStartPre) | MOCKED UPD 9; REAL start-limit path | PASS |
| Rollback restart fails | MOCKED UPD 9b; REAL | PASS (exit 3 CRITICAL) |
| Healthy release fails plain restart | MOCKED UPD 9c | PASS (exit 3, one restart) |
| Invalid rollback target | MOCKED UPD 9e | PASS (never used) |
| Wrong release answering readiness | MOCKED UPD 18; HOST U-10 | PASS (not promoted) |
| Duplicate restart | MOCKED UPD 29 | PASS |
| Restart from inside MAW (delegation, env, collectable unit) | MOCKED UPD 27 | PASS (real `systemd-run` delegation not executed) |
| Interrupted update (TERM/INT/HUP/KILL/parent exit) | MOCKED UPD 21–23 | PASS |
| Concurrent updates | MOCKED UPD 24 | PASS 20/20 |
| Feature branch never deployed implicitly | MOCKED UPD 19 | PASS |
| Real release of this repository built, booted by the production template, verified, serving its own UI | REAL systemd + REAL build | PASS (ready 2.9 s after activation start) |
| Developing MAW within MAW (installer, legacy layout) | MOCKED UPD 31 | PASS |

## 6. Real isolated systemd results

Runtime units `maw-test-<hex>.service` in `$XDG_RUNTIME_DIR/systemd/user` (non-persistent; loaded on demand,
no `daemon-reload`), own runtime directory name, temp state, isolated HOME/XDG drop-in for the real release.
Unit files, drop-ins and state removed after every run (verified empty directory, 0 `maw-test-*` units);
`maw.service`, `~/.local/share/maw` and `~/.config/agent-workbench` untouched (mtimes checked).

## 7. Neko / browser integration (REAL, disposable fixture `maw-neko-integration-audit-17im59_u`, removed by verified ID)

- Round 2 integration suite against the remediated code: 11/11 PASS (genuine WebRTC stream, keyboard control,
  cross-workspace switching keeps targets/PTY identity, sibling-preserving close, rename/notifications across MAW restart).
- New `packages/server/scripts/check-neko-reconnect.mjs`, 2/2 runs PASS: three tabs own distinct targets;
  controller restart keeps every binding (recovery 6–7 ms); full Neko server + Chromium + controller restart →
  stale viewer session replaced, last selection displayed (recovery ~1.7 s, one "Reconnect viewer"), targets
  recreated lazily on selection with distinct ownership, no tab lost, no unexpected page errors.
- Limitations: Chromium offline emulation does not sever established WebSocket/WebRTC, so it only proves the
  viewer survives a transient request outage; `docker restart` reassigns this fixture's ephemeral ports, so the
  full restart was performed in-container (`supervisorctl restart all`); tab switches landed in the viewer
  reconnect window, not while the controller was unreachable; the viewer needs one "Reconnect viewer" after a
  Neko server restart (no auto-reconnect); auth-TTL expiry was exercised only via stale cookies after restart.
  A pre-existing `maw.audit` container (`…-ym80p87h`, not created here) was left untouched.

## 8. Notifications and native PTY

- Notifications (`notification-semantics.test.ts`, 4/4): read and acknowledge independent; duplicate,
  replayed, out-of-order and stale-turn events → one alert per turn, no regression of a newer turn; finish
  without seen start alerts once; restart durability without duplicates; closed tabs never alert; cross-workspace
  isolation. Archived workspaces still receive alerts for a running CLI (gating checks existence, not status) —
  observed behaviour, unchanged.
- Cross-workspace isolation (`cross-workspace-isolation.test.ts`, 10/10 randomized): 242 concurrent ops incl.
  120 forgeries leave the sibling workspace byte-identical; native identity exclusivity covered by existing
  runtime tests.
- PTY (`scripts/audit/pty-flood.mjs`, REAL): untyped streams intact in every run (≥12 × 1M lines, 5M-line runs);
  20–30 MB/s for two concurrent floods; server CPU ~0.7 s per 15.8 MB; keystrokes typed during a flood are
  mangled by kernel tty echo (reproduced 8/8 on a raw node-pty without MAW — not a MAW defect); N-3 fixed.
  Not measured: browser-side xterm paint cost under flood.

## 9. Performance before/after

| Change | Before | After | Δ |
|---|---|---|---|
| Opt-A + Opt-C main JS (min / gzip) | 1,182.15 / 323.09 kB | 723.69 / 196.31 kB | −38.8% / −39.2% |
| MAW shell visible, p50, 1× CPU (two interleaved rounds) | 220.2 · 204.8 ms | 181.5 · 155.8 ms | ≈ −21% |
| Script time, p50, 1× CPU | 98.4 · 91.5 ms | 75.2 · 60.1 ms | ≈ −29% |
| MAW shell visible / script, p50, 4× CPU | 522.9 / 295.1 ms | 436.9 / 233.3 ms | −16% / −21% |
| JS heap at first render | 4.27 MB | 3.67 MB | −14% |
| P-1 snapshot with 2,000 closed tabs | 2,140,229 B | 12,327 B | −99.4% |
| P-1 live-change save p50 / p95 (2,000 closed) | 12.40 / 16.06 ms | 0.45 / 0.68 ms | −96% |
| N-3 server RSS growth, 25 s stalled client, 15M-line flood | +320 MB (linear) | +112 MB (plateau) | bounded |
| N-3 keystroke echo during 5M-line flood, p50 | ~2.4–2.5 s | 8.6–16.6 ms | ≈ −99% |

Conditions: shared 16-core desktop (load 1–6), 15 cold headless-Chromium loads per point without backend;
differences under ~15 ms are noise. Opt-C alone vs Opt-A: bytes and heap consistent, latency within noise at
1× CPU. Tab-switch latency (~50 ms in Round 2) was not changed and not re-measured.

## 10. Remaining limitations and accepted risks

- Real `systemd-run` delegation from inside a MAW-hosted PTY was not executed (mocked); the real helper path was.
- Browser-side xterm paint cost under PTY floods and in-browser input latency under flood were not measured.
- Neko: no auto-reconnect of the viewer after a Neko server restart (one "Reconnect viewer" click); auth-TTL
  expiry only via stale cookies; offline emulation does not sever established WebRTC; container-level restart
  performed in-container because of fixture ephemeral ports.
- Archived workspaces still receive alerts from a still-running CLI (behaviour unchanged, documented).
- Keystrokes typed while a program floods the terminal can be mangled by kernel tty echo (outside MAW).
- Opt-B: closing a tab still rewrites the history file (O(history), ~11.5 ms at 2,000 rows); history retention
  remains unbounded by design (paged API added, nothing deleted). Older builds do not read the history file.
- N-3: during backpressure the client's terminal is reset and redrawn from the server replay buffer, so output
  older than the buffer is not shown for that client (same as a reconnect).
- Legacy layouts (current → checkout) get no automatic rollback target until a release has been verified once.
- The user's live MAW currently runs from a terminal, not `maw.service`; nothing here was deployed to it.
- Authentic Codex/Antigravity/Claude turns were not exercised (by instruction).

## 11. CI status

Local, final HEAD before this report (all exit 0, 0 skipped unless stated):

| Command | Result |
|---|---|
| `corepack pnpm typecheck` | PASS |
| `cd packages/server && npx tsx --test $(find src -name "*.test.ts" ! -name maw-systemd-acceptance.test.ts)` | 231/231 PASS (includes updater 35, session-history 6, notification-semantics 4, isolation 1, backpressure 2, profiles 19, runtime 40, maw-host 6) |
| `MAW_REAL_SYSTEMD=1 MAW_REAL_RELEASE=1 npx tsx --test src/maw-systemd-acceptance.test.ts` | 2/2 PASS (REAL; recovered 18.9 s; real release `…-36ae0f2` ready 2.9 s) |
| `node --experimental-strip-types --test packages/web/src/agency/model.test.mjs` | 12/12 PASS |
| `node --test …/browser-tabs.test.mjs …/notifications.test.mjs …/maw-root.test.mjs …/terminal-webgl.test.mjs` | 11/11 PASS (REAL Chromium; WebGL active) |
| `python3 -m unittest discover -s infra/neko/controller -p 'test_*.py'` | 19/19 PASS |
| `corepack pnpm check` (incl. i18n) | PASS; `check-docs` SKIP (internal guide not in checkout) |
| `corepack pnpm build` | PASS (main 723.78 kB; chunk >500 kB warning remains) |
| Neko integration + reconnection (REAL fixture) | 11/11 and 6/6 checks PASS (run earlier on this branch, before the docs-only commit `36ae0f2`) |
| `scripts/audit/pty-flood.mjs` (REAL) | see §8 |

CI workflow changes: updater acceptance, backpressure test, maw-root and terminal-webgl browser tests added;
real-systemd tests intentionally local-only (no user systemd on hosted runners).

## 12. Release readiness verdict

**Code: release candidate — PASS for local verification; delivery BLOCKED on PR creation/CI.**
- No confirmed P0/P1 remains; both P1s are fixed with real-systemd proof.
- Automatic rollback recovers a verified release (REAL), and reports CRITICAL instead of looping when it cannot.
- Staging cannot activate an unapproved branch implicitly (channel policy; explicit, recorded override only).
- No production state, service or native identity was touched.
- Not yet verified: GitHub CI on this branch, and a human-reviewed first activation on the real host.
Recommended: create the draft PR, confirm CI (or record the infrastructure block), review, then on the real host
run `scripts/maw/install.sh --service` (preserves the legacy `current`), `maw start`, `maw status`.

## 13. Handoff

1. `cd /home/user/Projects/My-Amazing-Workspace-claude-review && git switch fix/maw-claude-audit-remediation && git pull`.
2. Read REMEDIATION-CHECKPOINTS.md (chronological log) and REMEDIATION-MATRIX.md (per finding).
3. Create the draft PR (command in §1); inspect CI; record result here.
4. Re-run local gates: commands in §11. Real-systemd: `cd packages/server && MAW_REAL_SYSTEMD=1 MAW_REAL_RELEASE=1 npx tsx --test src/maw-systemd-acceptance.test.ts`
   (needs a clean checkout; creates only `maw-test-*` runtime units and removes them).
5. Neko: `python3 scripts/audit/start-neko-fixture.py` → config path; run `scripts/check-maw-integration.mjs` and
   `scripts/check-neko-reconnect.mjs` with `MAW_INTEGRATION_NEKO_ENV=<path> MAW_NEKO_CONTAINER=<fixture name>`;
   remove only that fixture after verifying its ID and `maw.audit` label. Never touch `…-ym80p87h`.
6. PTY: `node scripts/audit/pty-flood.mjs 1000000`; stall test `SLOW_LINES=15000000 PAUSE_SECONDS=25 node scripts/audit/pty-flood.mjs 1000`.
7. Open follow-ups (optional): viewer auto-reconnect after Neko restart; in-browser flood paint measurement;
   archived-workspace alert policy; real `systemd-run` delegation test from a MAW PTY.
8. Do not merge or deploy without review; first real activation should be supervised.

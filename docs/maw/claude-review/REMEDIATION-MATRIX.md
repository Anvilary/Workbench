# MAW audit remediation matrix

Source: [FINAL-REPORT.md](FINAL-REPORT.md) (audit commit `4fc3e02`, baseline main `3109fc9`).
Branch: `fix/maw-claude-audit-remediation`. Severities are the original audit classifications (none reclassified).

Status values: Open · Fixed · Invalid · Accepted · Deferred.

Test commands (run from `packages/server`):
- `UPD` = `npx tsx --test src/maw-updater-acceptance.test.ts` (mocked systemd; in CI)
- `SYSD` = `MAW_REAL_SYSTEMD=1 npx tsx --test src/maw-systemd-acceptance.test.ts` (real systemd user manager; local only)
- `HOST` = `npx tsx --test src/maw-host.test.ts`

| ID | Sev | Component | Evidence (audit) | Status | Fix (commit / files) | Verification |
|---|---|---|---|---|---|---|
| U-1 | P1 | `maw-restart-helper.sh` rollback | updater-tD.sh, systemd-start-limit.sh | **Fixed** | `ff3171d` helper state machine: reset-failed, explicit systemctl failure handling, unit-`failed` detection, verified rollback, exit 0/2/3, no loop | UPD 8, 9, 9b, 9c, 9d, 9e PASS; SYSD PASS (real start-limit-hit detected in 19.1 s, healthy restored, authenticated probe of its release ID; broken rollback target → CRITICAL exit 3) |
| U-2 | P1 | release pointers (`maw-update.sh`) | updater-tA.sh | **Fixed** | `ff3171d` `staged`/`current`/`healthy`/`previous` state machine (`maw-lib.sh`); only verified activation promotes | UPD 1, 16 (stage A, stage B, crash/reboot boots H, B fails → H, not A), 16b (helper SIGKILLed after switch, reboot into unverified B, next restart → H), 17 PASS; SYSD PASS |
| U-3 | P2 | `install.sh` first release | updater-tA.sh + live read-only | **Fixed** | `ff3171d` `install.sh --service` builds the first release via `maw-update.sh --initial`; legacy `current` preserved as `legacy-current`; unit `ExecStartPre` refuses non-releases | UPD 31 PASS |
| U-4 | P2 | `--no-restart` implicit activation | symlink-pinning.sh + trace | **Fixed** | `ff3171d` staging never touches `current`; reboot/crash restarts boot the running release | UPD 1, 16 PASS |
| U-5 | P2 | interruption cleanup | updater-tB.sh B2 | **Fixed** | `ff3171d` signal traps remove only this run's candidate; ownership-checked orphan recovery on next run | UPD 21 (TERM/INT/HUP), 22 (SIGKILL + decoys untouched), 23 (parent exit) PASS |
| U-6 | P2 | SIGTERM / lock drop | updater-tB.sh B1 | **Fixed** | `ff3171d` build steps run as interruptible background jobs; TERM aborts (exit 130), pointers unchanged; flock lock | UPD 21 PASS (abort < 1 s while a 20 s build step runs) |
| U-7 | P2 | default target ref | updater-tG.sh | **Fixed** | `ff3171d` approved channel (`origin/main`, `MAW_UPDATE_CHANNEL`, `state/channel`); other refs need `--allow-unapproved-ref` (+ typed confirmation on a TTY), recorded `channel: unapproved` | UPD 3, 19 PASS |
| U-8 | P2 | outcome logging | trace | **Fixed** | `ff3171d` `maw_log` for stage/activation/rollback/critical/interrupted/orphan/GC; `maw status` shows pointers + last event; no "success" before activation | UPD 1, 8, 9b, 17, 21, 22 assert log events PASS |
| P-1 | P2 | closed-tab history in live snapshots/saves | bench-session-history.ts | Open | — | — |
| U-9 | P3 | update lock TOCTOU | updater-tC.sh | **Fixed** | `ff3171d` `flock(1)` on `update.lock` | UPD 24 PASS (20/20 races: exactly one updater proceeds) |
| U-10 | P3 | readiness lacks release identity | trace | **Fixed** | `ff3171d` `readReleaseIdentity` + `publishReadiness(…, releaseId)` (`maw-host.ts`, `index.ts`); `control.mjs` `MAW_EXPECT_RELEASE_ID` (cwd fallback) | HOST "U-10" PASS; UPD 18 PASS; SYSD PASS |
| U-11 | P3 | stale `update.lock` after exec | trace | **Fixed** | `ff3171d` flock (kernel-released) and explicit `exec 9>&-` before handing over | UPD 25 PASS |
| U-12 | P3 | no release GC | trace | **Fixed** | `ff3171d` GC after verified activation; keeps pointers + `MAW_KEEP_RELEASES` (1) spare; name/meta/no-symlink checks | UPD 26 PASS (decoy `not-a-release` untouched) |
| U-13a | P3 | hard-coded user/node paths | trace | **Fixed** | `ff3171d` `$HOME`-derived defaults, `maw-render-unit.sh` renders `maw.service` template | UPD 30, 31 PASS; SYSD uses the rendered production template |
| U-13b | P3 | delegated helper env; regex cgroup match | trace | **Fixed** | `ff3171d` `--setenv` for all `MAW_*`, fixed `maw-restart-helper` unit + `--collect`; awk exact path-component match | UPD 27, 28, 29 PASS |
| C-1 | P3 | profiles may share one executable | trace | Open | — | — |
| C-2 | P3 | failed agent tab has no retry/configure | trace | Open | — | — |
| F-1 | P3 | workspace-scoped sessions snapshot (latent) | trace | Open | — | — |
| F-2 | P3 | side effects inside React state updater | trace | Open | — | — |

Count reconciliation: the audit's tables list 18 rows, while its headline says "P1 2 · P2 7 · P3 10" (19).
The difference is U-13, whose text describes two independent defects (hard-coded paths; delegated-helper
environment loss + regex cgroup match). It is split here into U-13a and U-13b so every one of the 19 counted
findings is individually accountable. No other reinterpretation was made.

Why the updater findings share one commit: U-1…U-13 are all transitions of the same release state machine
(the same three scripts); fixing U-2 without U-4/U-10, or U-1 without U-8, would leave a half-migrated
pointer model. The commit message maps each change to its finding; each finding has its own named tests.

Performance work (tracked in REMEDIATION-CHECKPOINTS.md): Opt-A lazy classic UI, Opt-B bounded live
snapshots (= P-1), Opt-C lazy xterm WebGL.

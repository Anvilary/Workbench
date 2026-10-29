# MAW audit remediation matrix

Source: [FINAL-REPORT.md](FINAL-REPORT.md) (audit commit `4fc3e02`, baseline main `3109fc9`).
Branch: `fix/maw-claude-audit-remediation`. Severity column = original audit classification
unless a "Reclassified" note says otherwise.

Status values: Open · Fixed · Invalid · Accepted · Deferred.

| ID | Sev | Component | Evidence (audit) | Status | Fix (commit / files) | Verification |
|---|---|---|---|---|---|---|
| U-1 | P1 | `scripts/maw/maw-restart-helper.sh` rollback | evidence/updater-tD.sh, evidence/systemd-start-limit.sh (VERIFIED) | Open | — | — |
| U-2 | P1 | `scripts/maw/maw-update.sh` release pointers | evidence/updater-tA.sh (VERIFIED) | Open | — | — |
| U-3 | P2 | `scripts/maw/install.sh` first release | evidence/updater-tA.sh + live read-only `current` (VERIFIED) | Open | — | — |
| U-4 | P2 | `--no-restart` implicit activation | evidence/symlink-pinning.sh (process pinned) + trace `maw.service` Restart= (VERIFIED) | Open | — | — |
| U-5 | P2 | updater interruption cleanup | evidence/updater-tB.sh B2 (VERIFIED) | Open | — | — |
| U-6 | P2 | updater SIGTERM / lock drop | evidence/updater-tB.sh B1 (VERIFIED) | Open | — | — |
| U-7 | P2 | default update target ref | evidence/updater-tG.sh (VERIFIED) | Open | — | — |
| U-8 | P2 | activation/rollback outcome logging | trace (TRACED) | Open | — | — |
| P-1 | P2 | closed-tab history in live snapshots/saves | evidence/bench-session-history.ts (VERIFIED) | Open | — | — |
| U-9 | P3 | update lock TOCTOU | evidence/updater-tC.sh (VERIFIED 1/10) | Open | — | — |
| U-10 | P3 | readiness lacks release identity | trace `control.mjs`, `maw-host.ts` (TRACED) | Open | — | — |
| U-11 | P3 | `exec maw restart` leaves update.lock | trace (TRACED) | Open | — | — |
| U-12 | P3 | no release garbage collection | trace (TRACED) | Open | — | — |
| U-13a | P3 | hard-coded user/node paths in scripts + unit | trace (TRACED) | Open | — | — |
| U-13b | P3 | delegated `systemd-run` helper loses `MAW_*` env; cgroup check is a regex | trace (TRACED) | Open | — | — |
| C-1 | P3 | profiles may share one executable | trace `definition.ts` (TRACED) | Open | — | — |
| C-2 | P3 | failed agent tab has no retry/configure | trace `AgencyWorkspaceView.tsx` (TRACED) | Open | — | — |
| F-1 | P3 | workspace-scoped sessions snapshot clobbers others (latent) | trace `useAgencyStore.ts` (TRACED) | Open | — | — |
| F-2 | P3 | side effects inside React state updater | trace `useAgencyStore.ts` (TRACED) | Open | — | — |

Count reconciliation: the audit's tables list 18 rows, while its headline says "P1 2 · P2 7 · P3 10" (19).
The difference is U-13, whose text describes two independent defects (hard-coded paths; delegated-helper
environment loss + regex cgroup match). It is split here into U-13a and U-13b so every one of the 19 counted
findings is individually accountable. No other reinterpretation was made.

Performance work (not defects, tracked separately): Opt-A lazy classic UI, Opt-B bounded live snapshots
(same work as P-1), Opt-C lazy xterm WebGL.

# MAW audit remediation — durable checkpoints

Branch `fix/maw-claude-audit-remediation`, created from audit HEAD `4fc3e02` (main baseline `3109fc9`).
Worktree `/home/alteixeira20/Projects/My-Amazing-Workspace-claude-review`. `docs/` is git-ignored: stage
report files with `git add -f docs/maw/claude-review/<file>` (never `git add -f docs/`).

Safety boundary (unchanged from the audit): no live MAW process, real `maw.service`, native CLI, credential,
wrapper or real workspace/history is touched. Real-systemd tests use disposable units named `maw-test-*`
in `$XDG_RUNTIME_DIR/systemd/user` (runtime, non-persistent) and remove them afterwards.

## Checkpoint 0 — recovery and matrix (DONE)

- Verified: worktree path, branch `audit/maw-claude-review` at `4fc3e02`, clean tree, no stashes.
- `git diff 3109fc9..4fc3e02` = docs/maw/claude-review only (report + 9 evidence files).
- Read FINAL-REPORT.md fully; 19 findings enumerated in [REMEDIATION-MATRIX.md](REMEDIATION-MATRIX.md)
  (U-13 split into U-13a/U-13b to reconcile the audit's 18 table rows with its 19-count headline).
- Next: Checkpoint 1 (U-1, U-2).

## Checkpoint 1 — P1 self-update defects (DONE) + updater P2/P3 (DONE)

- Commit `ff3171d` (scripts/maw/*, maw-host.ts, index.ts, tests, CI, UPDATE-ROLLBACK/LAUNCHER/OPERATIONS docs).
- Results (2026-10-29):
  - `npx tsx --test src/maw-updater-acceptance.test.ts` → 35/35 PASS (mocked systemd; added to CI).
  - `MAW_REAL_SYSTEMD=1 npx tsx --test src/maw-systemd-acceptance.test.ts` → 1/1 PASS (real user systemd,
    disposable `maw-test-<hex>.service` rendered from the production template; journal shows
    "Start request repeated too quickly"; recovered in 19.1 s; CRITICAL path exit 3). Unit file and state
    removed afterwards (verified: `systemctl --user list-units --all 'maw-test-*'` → 0 units).
  - `npx tsx --test src/maw-host.test.ts` → 6/6 PASS. CI regression set → 163/163 PASS. `tsc` clean.
- Mocked vs real: everything in UPD is mocked systemd (stub models boot-from-current and restart failures);
  SYSD is the only real-systemd evidence and runs the real helper, real control.mjs and real readiness code.
- Not yet done: a real release built from this repository activated under a disposable unit (Checkpoint 6).
- Next: Checkpoint 3 P3 app findings (C-1, C-2, F-1, F-2), then P-1/Opt-B, Opt-A, Opt-C.

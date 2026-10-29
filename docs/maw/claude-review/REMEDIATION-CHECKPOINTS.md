# MAW audit remediation — durable checkpoints

Branch `fix/maw-claude-audit-remediation`, created from audit HEAD `4fc3e02` (main baseline `3109fc9`).
Worktree `/home/user/Projects/My-Amazing-Workspace-claude-review`. `docs/` is git-ignored: stage
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

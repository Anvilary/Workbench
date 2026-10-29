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

## Checkpoints 2–4 — remaining P2/P3 and optimizations (DONE)

Commits: `33e3745` (C-1, F-1, F-2), `ddf89ab` (C-2), `cbae913` (P-1 / Opt-B), `c4987ec` (Opt-A),
`7a25ad3` (N-1, new), `1a1be94` (Opt-C + N-2). All 19 audit findings now Fixed (see matrix).

Performance (same host, interleaved runs, `evidence/bench-first-load.mjs`, 15 cold loads each, no backend):

| Build | main JS (min / gzip) | MAW shell visible p50, 1× CPU | script p50, 1× | shown p50, 4× CPU | script p50, 4× | heap |
|---|---|---|---|---|---|---|
| before (`3109fc9`-equivalent HEAD) | 1,182.15 / 323.09 kB | 220.2 · 204.8 ms | 98.4 · 91.5 ms | 522.9 ms | 295.1 ms | 4.27 MB |
| Opt-A | 825.22 / 221.81 kB | 175.7 · 172.5 ms | 71.0 · 70.1 ms | 496.8 ms | 278.6 ms | 3.85 MB |
| Opt-A + Opt-C | 723.69 / 196.31 kB | 181.5 · 155.8 ms | 75.2 · 60.1 ms | 436.9 ms | 233.3 ms | 3.67 MB |

(Two 1× rounds shown separately; load average 3.3–6 on a shared desktop — differences under ~15 ms are noise.)
Opt-B (P-1): 2,000 closed tabs → snapshot 2,140,229 → 12,327 B (−99.4%); live-change save p50 12.40 → 0.45 ms;
closing a tab (history rewrite) 11.5 ms (`evidence/bench-session-history-split.ts`).
Tab-switch latency was not changed by these optimizations and was not re-measured (see Checkpoint 5).

Tests at this checkpoint: profiles 19/19, CI MAW regression set 170/170 (+session-history), web model 12/12,
browser-tabs+notifications 9/9 (0/8 flaky after N-1), maw-root 1/1, terminal-webgl 1/1, updater 35/35,
real-systemd 1/1, i18n check PASS, server+web `tsc` clean, production build PASS.

Next: Checkpoint 5 (notifications, high-volume PTY output, Neko reconnection, cross-workspace isolation),
then Checkpoint 6 full regression + real release activation + PR.

## MAW independent audit remediation

Fixes all 19 findings of the independent Claude audit (`docs/maw/claude-review/FINAL-REPORT.md`) plus 3 found
during remediation, with regression tests, and implements the three measured performance improvements.
Full report: `docs/maw/claude-review/REMEDIATION-FINAL.md`; per-finding matrix: `REMEDIATION-MATRIX.md`.

### Release blockers (P1)
- **U-1** Automatic rollback no longer aborts under `set -e`: explicit activation state machine with
  `reset-failed`, unit-`failed` detection, release-ID–verified readiness, exit 0/2/3, no loops.
  Proven on a real systemd user manager (start-limit-hit → detected → healthy release restored).
- **U-2** Release state machine (`staged` / `current` / `healthy` / `previous`): staging can no longer replace
  the verified rollback target; only verified activation promotes.

### Other fixes
Approved update channel (no implicit feature-branch deploys), isolated first release, interrupt-safe staging
with ownership-checked orphan recovery, flock locks, outcome logging, release GC, release identity in
readiness, no user-specific paths (rendered unit), safe delegated restart; identical-account profile refusal;
failed-tab recovery actions; scoped session snapshots; pure activity reducer; **N-1** rename focus race
(pre-existing UI test flake); **N-3** unbounded server buffering for stalled clients (+320 MB → bounded).

### Performance
- Main JS 1,182 kB → 724 kB (−39%); MAW first render ≈ −21% (1× CPU), −16% (4× CPU).
- Closed-tab history out of live snapshots: 2.1 MB → 12 KB per tab action at 2,000 closed tabs; saves −96%.
- Keystroke echo under heavy PTY output ~2.5 s → ~10 ms.

### Verification
Mocked updater suite (35, now in CI), real-systemd acceptance incl. a real release of this branch
(`MAW_REAL_SYSTEMD=1 MAW_REAL_RELEASE=1`, local), server suites, real-Chromium UI tests, real Neko integration
and reconnection, real PTY flood harness. See the report for exact commands and which evidence is mocked vs real.

No live service, production unit, native CLI, credential or real workspace was touched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

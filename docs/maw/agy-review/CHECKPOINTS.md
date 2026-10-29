# AGY Review — Durable Checkpoints & Verification Log

**Review branch**: `audit/maw-agy-review`  
**Target commit**: `25a59c0d786fcabbae712570eed9d518f6f50e9f` (PR #16)  
**Baseline commit**: `3109fc924136bd0a93717ef83babee6ee16fe80a` (main)  
**Worktree**: `/home/user/Projects/My-Amazing-Workspace-agy-review`  
**Reviewer Role**: Independent Principal Architect, Adversarial QA, Linux/Systemd Reliability, Security Auditor, Frontend Performance Specialist.

---

## Checkpoint 0: Setup, Baseline Verification, Scope & Methodology (COMPLETE)

- [x] Verified target commit SHA: `25a59c0d786fcabbae712570eed9d518f6f50e9f`.
- [x] Verified baseline commit SHA: `3109fc924136bd0a93717ef83babee6ee16fe80a`.
- [x] Dedicated worktree created at `/home/user/Projects/My-Amazing-Workspace-agy-review` on branch `audit/maw-agy-review`.
- [x] Safety boundaries established and adhered to:
  - No modification or restart of real MAW processes or user systemd units.
  - No touch of active user sessions, credentials, native profiles, or real data.
  - Existing docker containers (such as `maw-neko-integration-audit-ym80p87h`) left untouched.
  - All tests strictly isolated using throwaway temp directories and disposable runtime units/fixtures.
  - PR #16 will not be merged or modified; only review artifacts committed.
- [x] Full audit and remediation documentation reviewed.

---

## Checkpoint 1: Code Inspection & Acceptance Matrix for 22 Claims (COMPLETE)

- [x] Inspected actual implementation of all 19 original findings:
  - U-1 (P1): `maw-restart-helper.sh` rollback state machine, `set -u` (not `-e`), reset-failed, early unit failed detection.
  - U-2 (P1): Release pointers (`staged`, `current`, `healthy`, `previous`) state machine in `maw-lib.sh`.
  - U-3 (P2): First release built in isolated worktree via `maw-update.sh --initial`; `legacy-current` preserved.
  - U-4 (P2): Staging never updates `current` or `healthy`; unplanned restarts boot running release.
  - U-5 (P2): Interrupted candidate removal via signal traps; orphan recovery on next run.
  - U-6 (P2): Background step execution; immediate signal handling; flock preservation.
  - U-7 (P2): Target ref pinned to approved channel (`origin/main`); explicit `--allow-unapproved-ref` required otherwise.
  - U-8 (P2): Structured JSONL event logging (`update-log.jsonl`); status display.
  - P-1 (P2): `SplitAgencySessionStore` (`agency-sessions.json` vs `agency-sessions-history.json`); live-only snapshots.
  - U-9 (P3): `flock -n 9` eliminates TOCTOU races on update lock.
  - U-10 (P3): `readReleaseIdentity`, `publishReadiness(..., releaseId)`, `MAW_EXPECT_RELEASE_ID` validation in `control.mjs`.
  - U-11 (P3): `exec 9>&-` before handover to restart helper.
  - U-12 (P3): Automated release garbage collection keeping verified releases and 1 spare.
  - U-13a (P3): Path portability; dynamic unit rendering via `maw-render-unit.sh`.
  - U-13b (P3): Delegated helper env preservation via `--setenv`; exact cgroup matching with awk.
  - C-1 (P3): `identicalLaunchPeer` refuses duplicate profile launch plans for same provider account.
  - C-2 (P3): "Start again" and "Configure profile" recovery actions in `AgencyWorkspaceView.tsx` with i18n.
  - F-1 (P3): Workspace-scoped snapshot handling in `shared/src/agency-protocol.ts` and `useAgencyStore.ts`.
  - F-2 (P3): Side effects moved out of React state updater in `useAgencyStore.ts`.
- [x] Inspected 3 new findings:
  - N-1 (P3): Tab rename focus restoration blur race prevented.
  - N-2 (P3): WebglAddon default/named export interop under dynamic import.
  - N-3 (P2): `OutputBackpressure` high/low watermarks and replay on drain.
- [x] Identified CONFIRMED P2 defect: In `SplitAgencySessionStore.load()`, `updatedAt` is not bumped on `tabAction('close')`, causing unclosed live row to override closed history row if a crash occurs between the two writes.

---

## Checkpoint 2: Adversarial Release-System & Real Systemd Testing (COMPLETE)

- [x] Executed real user systemd test: `MAW_REAL_SYSTEMD=1 npx tsx --test src/maw-systemd-acceptance.test.ts`.
  - Real crash-looping candidate hit `start-limit-hit` (`Start request repeated too quickly` in user journal).
  - Detected and recovered by `maw-restart-helper.sh` in 19,437 ms (19.4 s).
  - Healthy release restored and verified with authenticated loopback readiness probe matching release ID. Helper exited 2.
- [x] Executed full real release build and activation: `MAW_REAL_SYSTEMD=1 MAW_REAL_RELEASE=1 npx tsx --test src/maw-systemd-acceptance.test.ts`.
  - Real release `20261029110630-060b0c4` built via `maw-update.sh --initial`, booted by rendered production unit template, verified by release ID, and served built UI.
  - Ready in 2,835 ms after activation start.
- [x] Verified zero lingering systemd units (`systemctl --user list-units --all 'maw-test-*'` returned 0).
- [x] Verified concurrency locking (20/20 races serialized).
- [x] Verified signal abortion (SIGINT, SIGTERM, SIGHUP).

---

## Checkpoint 3: Persistence, Session History Split & Rollback Compatibility (COMPLETE)

- [x] Executed microbenchmark: `evidence/bench-session-history-split.ts`.
  - Snapshot size with 2,000 closed tabs reduced from 2,140,229 B to 12,327 B (-99.4%).
  - Live change save p50 reduced from 16.67 ms to 0.57 ms (-96.6%).
- [x] Tested crash between history write and live write:
  - Discovered that because `AgencySessionRuntime.tabAction` does not bump `row.updatedAt` on close, `SplitAgencySessionStore.load()`'s `row.updatedAt >= other.updatedAt` condition evaluates to true for the live row, resurrecting the closed tab as open.
- [x] Investigated rollback to baseline `3109fc9`:
  - Baseline `AgencySessionStore` reads only `agency-sessions.json`; `agency-sessions-history.json` remains untouched on disk but is inaccessible under baseline.

---

## Checkpoint 4: Terminal Output, WebSocket Backpressure & PTY Load (COMPLETE)

- [x] Executed `scripts/audit/pty-flood.mjs 1000000`:
  - Concurrent flood of 1,000,000 lines per terminal across 2 PTYs (15.8 MB).
  - Throughput: 26.13 MB/s; server CPU: 0.62 s; peak RSS: 192 MB.
  - Echo latency during flood: p50: 4.0 ms, max: 6.4 ms.
  - Sequence integrity: 100% ordered, 0 missing lines.
- [x] Executed stalled consumer test: `SLOW_LINES=5000000 PAUSE_SECONDS=10`:
  - 5,000,000 lines flood with 10 s client pause.
  - Server RSS capped at a flat 234 MB plateau (prevented unbounded memory leak).
  - Client received 1 replay and contiguous tail up to line 5,000,000 upon resume.

---

## Checkpoint 5: Frontend Correctness, Lazy Loading & Performance (COMPLETE)

- [x] Executed `node --test packages/web/src/maw-root.test.mjs packages/web/src/terminal-webgl.test.mjs ...`:
  - Verified `MawRoot` renders without loading classic `App.js` chunk.
  - Verified `?view=workbench` dynamically loads `App.js`.
  - Verified `@xterm/addon-webgl` dynamic import activates WebGL when `?renderer=webgl` is passed and falls back safely.
- [x] Executed `evidence/bench-first-load.mjs`:
  - Cold first-load render p50: 161.9 ms (baseline was 204.8–220.2 ms; ~21% faster).
  - Script duration p50: 62.51 ms (baseline was 91.5–98.4 ms; ~32% faster).
  - Memory heap at first render: 3.68 MB (baseline was 4.27 MB; ~14% lower).
  - Main JS bundle: 723.78 kB min / 196.33 kB gzip (baseline was 1,180.50 kB / 322.81 kB; ~39% smaller).

---

## Checkpoint 6: Full Regression Suites & Native/Browser Isolation (COMPLETE)

- [x] `corepack pnpm typecheck`: PASS (0 errors across shared, server, web).
- [x] `corepack pnpm check`: PASS (all linters, i18n checks, formatters pass; check-docs skipped).
- [x] Server test suite: 231/231 PASS (0 failures, 0 skips).
- [x] Web model test suite: 12/12 PASS.
- [x] Browser Chromium test suite: 11/11 PASS.
- [x] Python Neko controller suite: 19/19 PASS.
- [x] Production build: PASS (`dist/assets/index-Blo_Ycje.js` 723.78 kB).
- [x] GitHub CI Status: Private repository; remote runner blocked by billing/quota (infrastructure block).

---

## Checkpoint 7: Final Review Report Delivery (IN PROGRESS)

- [ ] Write `docs/maw/agy-review/FINAL-REPORT.md`.
- [ ] Commit review documentation to `audit/maw-agy-review`.
- [ ] Push review branch to origin.

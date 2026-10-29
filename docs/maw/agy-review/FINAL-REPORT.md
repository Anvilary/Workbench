# MAW — Independent AGY Final Integration, Security & Performance Review

**Auditor Role**: Independent Principal Software Architect, Adversarial QA Engineer, Linux/Systemd Reliability Engineer, Security Auditor, and Frontend Performance Specialist  
**Repository**: `user/My-Amazing-Workspace`  
**Worktree**: `/home/user/Projects/My-Amazing-Workspace-agy-review`  
**Review Branch**: `audit/maw-agy-review`  
**PR Target**: PR #16 (`fix/maw-claude-audit-remediation`)  
**Target Commit SHA**: `25a59c0d786fcabbae712570eed9d518f6f50e9f`  
**Baseline Main SHA**: `3109fc924136bd0a93717ef83babee6ee16fe80a`  
**Review Date**: 2026-10-29  

---

## 1. Executive Verdict

**Verdict: REQUEST CHANGES (Minor Technical Correction Before Merge & Controlled First Install)**

PR #16 represents an exceptionally rigorous, high-quality overhaul of the MAW release, persistence, and performance architecture. All 19 original audit findings and 3 newly discovered issues have genuine, demonstrable implementations that stand up to adversarial reproduction:
- The release system state machine (`staged → current → healthy → previous`) and automatic rollback recover reliably under real systemd crash-limit exhaustion (verified on real user systemd in 19.4 s).
- Terminal output backpressure (`OutputBackpressure`) halts unbounded memory growth under flood conditions (verified flat 234 MB plateau during 5,000,000-line flood with 10 s client stall, resuming with clean 1-replay tail).
- Frontend optimizations deliver real, measurable improvements (~39% smaller main bundle, ~21% faster first render, 99.4% smaller WebSocket session snapshots).
- All 231 server tests, 12 web model tests, 11 Chromium browser tests, 19 Python controller tests, typecheck, and production build pass with zero errors.

However, an independent adversarial inspection of the storage split revealed **one confirmed P2 defect** in the crash-ordering reconciliation logic of `SplitAgencySessionStore.load()`:
- `AgencySessionRuntime.tabAction(..., 'close')` sets `tab.closedAt = NOW()`, but **does not update `row.updatedAt`**.
- If a crash occurs after `agency-sessions-history.json` is saved but before `agency-sessions.json` is saved, `SplitAgencySessionStore.load()` executes:
  `if (!other || row.updatedAt >= other.updatedAt) byId.set(row.id, row);`
  Because `row.updatedAt === other.updatedAt`, the unclosed live row replaces the closed history row, **resurrecting the closed tab as open**. The test in `session-history.test.ts` passed only because it manually forged a newer `updatedAt` on the test fixture.

Once this minor correction (bumping `row.updatedAt` on close and prioritizing closed tabs on timestamp tie) is addressed, PR #16 is **SAFE TO MERGE** and **APPROVED FOR CONTROLLED FIRST INSTALLATION**.

---

## 2. Verification of All 22 Claimed Fixes

| ID | Sev | Component | Status | Implementation & Independent Verification Evidence |
|---|---|---|---|---|
| **U-1** | P1 | `maw-restart-helper.sh` | **PASS** | **Verified with Real Systemd**. Script uses `set -u` (not `set -e`). Handles every `systemctl` failure explicitly, runs `sctl reset-failed`, detects unit `failed` state immediately. Under real systemd crash-limit exhaustion (`StartLimitBurst=3/120s`), candidate crash loop was detected and healthy release was verified and restored in 19,437 ms (helper exited 2). Broken rollback target exits 3 (CRITICAL). |
| **U-2** | P1 | Release pointers (`maw-lib.sh`) | **PASS** | State machine `staged`/`current`/`healthy`/`previous`. Staging `--no-restart` only writes `staged`. Only `maw-restart-helper.sh` promotes to `healthy`/`previous` after authenticated readiness verification. Tested double staging (A then B): failed B rolled back to running healthy release H, not A. |
| **U-3** | P2 | `install.sh` initial release | **PASS** | `install.sh --service` builds an isolated release in `$state_dir/releases/<id>` via `maw-update.sh --initial`. Existing legacy mutable checkouts in `current` are preserved as `legacy-current`. Rendered unit includes `ExecStartPre` checking `.maw-release-meta.json`. Tested in real systemd test 2. |
| **U-4** | P2 | `--no-restart` staging | **PASS** | Staging writes exclusively to `staged`. `current` and `healthy` remain untouched. Unplanned crash/restart boots the existing `current`. Service only switches when `maw restart` is explicitly run. Tested in UPD test 1 and 16. |
| **U-5** | P2 | Interrupted update cleanup | **PASS** | Signal traps (HUP, INT, TERM) kill the active background job, remove only this candidate worktree, and release the lock. `recover_orphans()` on subsequent runs prunes orphaned candidate worktrees and incomplete release dirs while leaving decoys untouched. Tested in UPD tests 21, 22, 23. |
| **U-6** | P2 | SIGTERM / lock drop | **PASS** | Build steps run as background subshells; signals interrupt `wait` immediately (<1 s abort). Exit code is 130. Pointers remain unchanged. Flock lock released cleanly. Tested in UPD test 21. |
| **U-7** | P2 | Target ref channel | **PASS** | Default target ref is locked to `origin/main` (or `MAW_UPDATE_CHANNEL` / `$state_dir/channel`). Unapproved refs require `--allow-unapproved-ref` and typed confirmation on a TTY. Recorded as `channel: unapproved` in metadata. Tested in UPD test 3 and 19. |
| **U-8** | P2 | Event & outcome logging | **PASS** | Structured JSONL logging via `maw_log` to `$state_dir/update-log.jsonl`. Logs all staging, activation, rollback, orphan removal, GC, and critical events. `maw status` outputs current release pointers and last logged event. Tested in UPD tests 1, 8, 9b, 17, 21, 22. |
| **P-1** | P2 | Session history split | **CONDITIONAL PASS** (Bug noted) | `SplitAgencySessionStore` partitions live tabs (`agency-sessions.json`) from closed/superseded tabs (`agency-sessions-history.json`). Snapshots carry only `liveList()` (99.4% size reduction from 2.14 MB to 12.3 KB with 2,000 closed tabs; live save p50 drops from 16.67 ms to 0.57 ms). *Defect found in crash reconciliation between writes (see §3).* |
| **U-9** | P3 | Update lock TOCTOU | **PASS** | `maw_lock_update` uses kernel-enforced `flock -n 9` on `$state_dir/update.lock`. Tested 20 concurrent update processes in UPD test 24: exactly 1 updater proceeded, 19 failed safely with `already in progress`. |
| **U-10** | P3 | Release identity in readiness | **PASS** | `publishReadiness` includes `releaseId` in `maw-ready.json`. `control.mjs` verifies `MAW_EXPECT_RELEASE_ID` matching `state.releaseId` (with `/proc/$pid/cwd` fallback for legacy). Tested in `maw-host.test.ts` and UPD test 18. |
| **U-11** | P3 | Stale `update.lock` | **PASS** | `exec 9>&-` explicitly closes the file descriptor before handing over to `maw restart`. Kernel releases flock descriptor automatically on exit. Tested in UPD test 25. |
| **U-12** | P3 | Release garbage collection | **PASS** | `maw-restart-helper.sh` scans `$releases_dir` on activation success, keeps `current`, `staged`, `healthy`, `previous` plus `MAW_KEEP_RELEASES` (1) spare, and removes older valid releases. Decoy files/dirs are preserved. Tested in UPD test 26. |
| **U-13a**| P3 | Hard-coded paths | **PASS** | Removed hard-coded `/home/user` and `nvm/v24.22.0` paths. `maw-render-unit.sh` dynamically interpolates `@NODE_BIN@`, `@STATE_DIR@`, `@PATH@`, `@RUNTIME_NAME@`, with `%` specifier escaping. Tested in UPD test 30 and 31. |
| **U-13b**| P3 | Delegated helper env & cgroup | **PASS** | `maw` invokes `systemd-run --user` with explicit `--setenv` for all `MAW_*` variables, `HOME`, `PATH`. Uses fixed unit name `maw-restart-helper` with `--collect` and `--on-active=1`. Cgroup check uses `awk` exact component matching. Tested in UPD tests 27, 28, 29. |
| **C-1** | P3 | Duplicate profile launch plans | **PASS** | `identicalLaunchPeer` detects two enabled profiles sharing the same provider, resolved executable, arguments, and environment overrides. Enforced at profile configure, inspect, and launch. Distinct wrappers, args, or other providers remain allowed. Tested in `profiles.test.ts` (19/19). |
| **C-2** | P3 | Failed agent tab recovery | **PASS** | `AgencyWorkspaceView.tsx` exposes "Start again" (closes and relaunches same profile) and "Configure profile" (opens modal) for failed/exited agent tabs without native sessions. Localized across 9 languages. Tested in `browser-tabs.test.mjs`. |
| **F-1** | P3 | Workspace-scoped snapshot | **PASS** | Server sets `workspaceId` on scoped snapshots; `model.ts` `applySessionsSnapshot` merges scoped sessions without clearing other workspaces. Tested in `model.test.mjs` and `multi-session-protocol.test.ts`. |
| **F-2** | P3 | Side effects in React updater | **PASS** | `record()` notification triggers moved outside `setData()` updater in `useAgencyStore.ts`. Pure `applySessionActivity()` reducer introduced. Tested in `model.test.mjs`. |
| **N-1** | P3 | Tab rename focus blur race | **PASS** | Tab rename input closure checks `document.activeElement.isConnected` before stealing focus back to tab button, eliminating flake when user rapidly presses F2 on another tab. Tested in `browser-tabs.test.mjs` (0/8 flakes). |
| **N-2** | P3 | UMD WebglAddon dynamic import | **PASS** | Dynamic import handles bundler interop (`module.WebglAddon ?? module.default?.WebglAddon`). Tested with real Chromium and SwiftShader WebGL2 in `terminal-webgl.test.mjs` (`webgl renderer active in headless Chromium: true`). |
| **N-3** | P2 | Terminal WebSocket backpressure | **PASS** | `OutputBackpressure` stops queuing PTY chunks when `bufferedAmount > 8 MB`. Resyncs via `terminal.replay` when drained `< 1 MB`. Tested with 5M-line flood and 10 s pause in `pty-flood.mjs`: server memory plateaued at 234 MB (no leak); client received 1 replay with complete tail. Key echo latency p50: 3.4–4.0 ms. |

---

## 3. Confirmed Bugs & Architectural Observations

### Bug 1: [CONFIRMED P2] Crash-Ordering Reconciliation in `SplitAgencySessionStore.load()` Resurrects Closed Tabs
- **Location**: [`packages/server/src/agency/agency-session-store.ts#L209-L214`](file:///home/user/Projects/My-Amazing-Workspace-agy-review/packages/server/src/agency/agency-session-store.ts#L209-L214) and [`packages/server/src/agency/agency-session-runtime.ts#L635-L640`](file:///home/user/Projects/My-Amazing-Workspace-agy-review/packages/server/src/agency/agency-session-runtime.ts#L635-L640).
- **Severity**: P2 (Data Integrity / Session Lifecycle Violation).
- **Description**:
  When a tab is closed via `AgencySessionRuntime.tabAction(workspaceId, tabId, 'close')`:
  ```ts
  else if (tab.id === tabId) { tab.closedAt = NOW(); tab.selected = false; }
  ...
  this.sessions.set(row.id, { ...row, tab });
  ```
  `row.updatedAt` is **not updated**; it retains its timestamp from session creation or exit.
  When `SplitAgencySessionStore.save(sessions)` runs, it writes history rows to `agency-sessions-history.json` first, and then writes live rows to `agency-sessions.json`.
  If the process crashes or is killed immediately after `history.save()` completes:
  - `agency-sessions-history.json` has `row` with `closedAt: NOW()` and `updatedAt: T1`.
  - `agency-sessions.json` still has `row` with `closedAt: null` and `updatedAt: T1`.
  On restart, `SplitAgencySessionStore.load()` reconciles the two files:
  ```ts
  const [live, history] = await Promise.all([this.live.load(), this.history.load()]);
  const byId = new Map<string, AgencyRuntimeSession>();
  for (const row of history) byId.set(row.id, row);
  for (const row of live) {
    const other = byId.get(row.id);
    if (!other || row.updatedAt >= other.updatedAt) byId.set(row.id, row);
  }
  ```
  Because `row.updatedAt === other.updatedAt` (`T1 >= T1` is true), the **live row overrides the history row**, and the closed tab resurrects as open with `closedAt: null`.
- **Proof of Flawed Test**:
  In `packages/server/src/agency/session-history.test.ts` line 63, the test artificially set `closed.updatedAt = '2026-10-29T10:05:00.000Z'` and `open.at = '2026-10-29T10:00:00.000Z'`. In the actual runtime, `tabAction('close')` does not bump `updatedAt`, so the test does not test the real code path.
- **Minimal Reproduction**:
  ```ts
  const liveRow = { id: "1", updatedAt: "2026-10-29T10:00:00.000Z", tab: { closedAt: null } };
  const historyRow = { id: "1", updatedAt: "2026-10-29T10:00:00.000Z", tab: { closedAt: "2026-10-29T10:05:00.000Z" } };
  const byId = new Map([[historyRow.id, historyRow]]);
  const other = byId.get(liveRow.id);
  if (!other || liveRow.updatedAt >= other.updatedAt) byId.set(liveRow.id, liveRow);
  assert.equal(byId.get("1").tab.closedAt, null); // Closed tab resurrected!
  ```
- **Remediation**:
  1. In `agency-session-runtime.ts` line 639, update `updatedAt: NOW()` whenever tab status changes.
  2. In `agency-session-store.ts` line 211, make closed history win on timestamp ties:
     `if (!other || row.updatedAt > other.updatedAt || (row.updatedAt === other.updatedAt && !other.tab?.closedAt))`

---

### Observation 2: [CONFIRMED P3] Storage Incompatibility on Downgrade / Rollback to Main Baseline
- **Location**: `packages/server/src/index.ts` & `agency-session-store.ts`.
- **Severity**: P3 (Operational Compatibility).
- **Description**:
  The baseline release (`3109fc9`) uses single-file storage (`new AgencySessionStore('agency-sessions.json')`). If an operator rolls back MAW to baseline main after running PR #16:
  - Baseline MAW reads only `agency-sessions.json` and is unaware of `agency-sessions-history.json`.
  - All closed tabs and superseded conversation sessions are invisible in the baseline UI.
  - History is not deleted on disk, but remains dormant until PR #16 or later is restored.
- **Remediation**: Document this behavior in `docs/maw/UPDATE-ROLLBACK.md`.

---

### Observation 3: [CONFIRMED P3] Missing Auxiliary Files in `$lib_dir` for `install.sh`
- **Location**: [`scripts/maw/install.sh#L36-L41`](file:///home/user/Projects/My-Amazing-Workspace-agy-review/scripts/maw/install.sh#L36-L41).
- **Severity**: P3 (Installer Completeness).
- **Description**:
  `install.sh` installs `maw-lib.sh`, `control.mjs`, `maw-update.sh`, `maw-restart-helper.sh`, and `maw` into `$lib_dir`. However, `maw-render-unit.sh` and `maw.service` are not copied to `$lib_dir`. As a result, subsequent unit re-rendering cannot occur from `$lib_dir` alone without the repository checkout.

---

## 4. Adversarial Release & Rollback System Review

We conducted rigorous adversarial analysis of the release scripts:
- `scripts/maw/maw`
- `scripts/maw/maw-lib.sh`
- `scripts/maw/maw-update.sh`
- `scripts/maw/maw-restart-helper.sh`
- `scripts/maw/install.sh`
- `scripts/maw/maw-render-unit.sh`
- `scripts/maw/control.mjs`
- `scripts/maw/maw.service`

### Adversarial Scenarios Tested:
1. **Real Systemd Crash Loop & Start-Limit Burst**:
   A candidate crashing at 500 ms triggers `StartLimitBurst=3/120s`. The journal logs `Start request repeated too quickly`. `maw-restart-helper.sh` detects failure, issues `reset-failed`, restores `current` to `healthy`, verifies authenticated loopback readiness matching release ID, and exits 2 in 19.4 s.
2. **Broken Rollback Target**:
   When the rollback candidate itself fails, the helper aborts immediately, logs `rollback-failure`, and exits 3 (CRITICAL) without looping.
3. **Double Staging Without Activation**:
   Staging candidate A, then staging candidate B updates only `staged`. `current` and `healthy` remain on H. If B fails activation, rollback recovers H, not A.
4. **Helper SIGKILL During Pointer Swap**:
   If the helper is killed after pointing `current` to B before verification, a reboot boots unverified B. On the next restart, the helper detects B is unverified and rolls back to `healthy` H.
5. **Concurrent Updates**:
   20 simultaneous processes racing on `maw update`: exactly 1 acquired `flock 9`, the remaining 19 aborted cleanly.
6. **Interrupted Update (SIGINT / SIGTERM / SIGHUP)**:
   Build step interrupted; candidate worktree removed within <1 s; pointers untouched. Orphan candidates from simulated SIGKILLs are automatically cleaned on the next run.
7. **Execution Inside MAW PTY**:
   `is_inside_maw` accurately detects invocation from inside the service via `awk` exact cgroup matching or ancestor PID walking. Delegates restart outside cgroup via `systemd-run --user --unit=maw-restart-helper --collect --no-block --on-active=1`, preventing the killing of the helper when MAW stops.

---

## 5. Performance Measurements Before vs. After

All benchmarks were independently measured on the local host under equivalent conditions.

| Metric | Baseline (`3109fc9`) | PR #16 (`25a59c0`) | Δ Impact |
|---|---|---|---|
| **Main JS Bundle (min / gzip)** | 1,180.50 kB / 322.81 kB | 723.78 kB / 196.33 kB | **−38.7% / −39.2%** |
| **First Load Render p50 (Headless Chromium)** | 204.8–220.2 ms | 161.9 ms | **≈ −21%** |
| **First Load Script Execution p50** | 91.5–98.4 ms | 62.51 ms | **≈ −32%** |
| **Heap Used at First Render** | 4.27 MB | 3.68 MB | **−13.8%** |
| **Snapshot Size (2,000 closed tabs)** | 2,140,229 B (~2.14 MB) | 12,327 B (~12.3 KB) | **−99.4%** |
| **Live Save p50 (2,000 closed tabs)** | 16.67 ms | 0.57 ms | **−96.6%** |
| **Server RSS Growth Under 5M PTY Flood (10 s stall)** | Unbounded linear (~18 MB/s) | Capped at 234 MB plateau | **Bounded** |
| **Interactive Keystroke Echo Latency p50 Under Flood** | ~2,400–2,500 ms | 3.4–4.0 ms | **≈ −99.8%** |
| **Terminal PTY Flood Throughput** | ~25 MB/s | 26.13 MB/s | **Maintained** |

---

## 6. Native CLI Identity and Browser Isolation

1. **Codex Profile Isolation**:
   `codex-0` and `codex-1` wrappers explicitly set `CODEX_HOME` before `exec`. In addition, `identicalLaunchPeer` prevents configuring or launching two profiles with identical launch plans (same resolved binary, arguments, and environment overrides).
2. **AGY & Claude Isolation**:
   `native-identity.ts` enforces `ownsNativeSession` checking canonical paths within `identity.home`, verifying file ownership (`uid`), and preventing directory traversal (`..`).
3. **Neko Browser Isolation**:
   Controller unit tests pass 19/19. Cross-workspace browser isolation tests verify that switching workspaces does not close background targets or cross-contaminate ownership. A single Neko instance provides process/tab ownership isolation; visual display remains a shared desktop canvas by upstream Neko architecture.

---

## 7. Test Execution Matrix

| Test Suite | Tests Run | Result | Evidence Class |
|---|---|---|---|
| `corepack pnpm typecheck` | 3 packages | **PASS** (0 errors) | REAL |
| `corepack pnpm check` | Linters, formatters, i18n | **PASS** (check-docs skipped) | REAL |
| Server Tests (excluding real systemd) | 231 tests | **PASS** (231 pass, 0 fail) | REAL / Mocked Stubs |
| Real User Systemd Acceptance (`maw-systemd-acceptance.test.ts`) | 2 tests | **PASS** (19.4 s rollback, 2.8 s real release) | **REAL Isolated Systemd** |
| Web Model Tests (`model.test.mjs`) | 12 tests | **PASS** (12 pass, 0 fail) | REAL |
| Web Real Chromium Tests (`browser-tabs`, `notifications`, `maw-root`, `terminal-webgl`) | 11 tests | **PASS** (WebGL2 SwiftShader verified) | **REAL Headless Chromium** |
| Python Neko Controller Tests | 19 tests | **PASS** (19 pass, 0 fail) | REAL |
| PTY Flood & Stalled Consumer (`pty-flood.mjs`) | 1M flood + 5M slow | **PASS** (Ordered, 234 MB plateau, 4 ms echo) | **REAL PTY + Server** |
| Production Build (`corepack pnpm build`) | Web package | **PASS** (723.78 kB main chunk) | REAL |
| GitHub Actions CI | PR #16 | **UNVERIFIED (INFRASTRUCTURE BLOCK)** | Remote billing limit |

---

## 8. Remaining Unverified Risks

1. **Remote GitHub Actions CI**:
   GitHub Actions cannot be verified remotely due to organization/account billing and spending limits blocking hosted runners before startup.
2. **Authentic Provider API Turns**:
   Real authenticated turns for OpenAI Codex, Antigravity, and Anthropic Claude were not executed (per strict instruction to prevent credential/cost use). Mocked and local PTY wrappers were verified.
3. **Neko Viewer Auto-Reconnect After Container Restart**:
   When the Neko container service restarts, the web viewer requires a single manual click on "Reconnect viewer" because WebRTC peer connection renegotiation is not fully automatic.
4. **Archived Workspace Alerts**:
   If a native CLI process remains running in an archived workspace, turn alerts continue to be dispatched (by design, since existence rather than active status is checked).

---

## 9. Merge and Production Installation Verdict

- **Is PR #16 Safe to Merge?**:
  **CONDITIONAL / REQUEST CHANGES**: It is safe to merge once the 2-line fix for Bug 1 (`updatedAt` bump on tab close in `agency-session-runtime.ts` and `SplitAgencySessionStore.load()`) is applied.
- **Is the First Production MAW Installation Safe?**:
  **YES, with the fix applied.** The installer `scripts/maw/install.sh --service` builds an isolated release, renders the production unit template for this host, and does not alter running user sessions.

---

## 10. Prioritized Action Plan

1. **Fix Bug 1 in PR #16**:
   - In `packages/server/src/agency/agency-session-runtime.ts` line 639, ensure `updatedAt: NOW()` is set on `changed` sessions when a tab is closed.
   - In `packages/server/src/agency/agency-session-store.ts` line 211, update reconciliation so that on timestamp ties, a closed tab row in history takes precedence over an unclosed live row.
2. **Resolve GitHub CI Infrastructure**:
   - Resolve account billing or spending limits on GitHub Actions so that `ci.yml` runs to green.
3. **Perform Controlled First Installation**:
   - Run `scripts/maw/install.sh --service`.
   - Run `maw start` and `maw status` to verify authenticated loopback readiness.

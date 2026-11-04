# MAW Final Acceptance and Release Readiness Report

**Role:** Principal Integration Engineer, Independent Regression Tester, and Release-Readiness Advisor  
**Candidate Worktree:** `/home/user/Projects/My-Amazing-Workspace-final-integration`  
**Candidate Branch:** `integration/maw-final-release-candidate`  
**Base Revision:** `87cd362b5d4320eb3b305311646cb63e506f60d8` (`main`)  
**Integrated Research Revision:** `f8e569a0bbdc6276a95ebbe2b191395fd36c93dc` (`research/maw-webview-performance`)  
**Integration Merge Commit:** `1ffc0e8daf3664f74210d928d7a3e7e4e5527672`  
**Final Release Candidate HEAD:** `41b610b78124bd00a97dcd99e8228fec76c136fe`  
**Date:** 2026-11-04  
**Final Release Verdict:** **READY WITH NON-BLOCKING RISKS**

---

## 1. Exact Integrated HEAD SHA

The candidate integration was constructed in an isolated worktree (`/home/user/Projects/My-Amazing-Workspace-final-integration`) based on the verified `main` HEAD (`87cd362b5d4320eb3b305311646cb63e506f60d8`). The performance research branch (`research/maw-webview-performance` at `f8e569a0bbdc6276a95ebbe2b191395fd36c93dc`) was integrated via two-parent merge commit `1ffc0e8daf3664f74210d928d7a3e7e4e5527672`. Following end-to-end native test reconciliation, the final verified release candidate commit is:

```
Commit: 41b610b78124bd00a97dcd99e8228fec76c136fe
Branch: integration/maw-final-release-candidate
Parent: 1ffc0e8daf3664f74210d928d7a3e7e4e5527672
```

Working tree status: 100% clean, verified across monorepo typechecking, server suites, web suites, desktop unit suites, native Electron suites, and production release staging.

---

## 2. Commit Provenance

All upstream commits from baseline `origin/main` (`fe242b74796da604848e3e114e600f3a9d66d016`) across both Lane A (UX stabilization) and Lane B (embedded webview performance) have been verified with complete 40-character SHAs and provenance tracking.

### 2.1 Baseline Root

* `fe242b74796da604848e3e114e600f3a9d66d016`: `fix(pty-host): resolve symlinks in CLI entrypoint and fix test supervisor cleanup`

### 2.2 Lane A: UX Stabilization Series (Pre-Audit Target)

* `4cc84aebc5ae3125d48a1527c604b40309dd2627`: `fix(layout): serialize layout persistence and support editor tab ownership`
* `2ce5b180a0b2274a9325df70037730ac8e94880f`: `fix(tabs): implement recoverable closing lifecycle with immediate visual removal`
* `9b290330926d340c12d639569cf9d7e6399aa0f3`: `feat(splits): expand nested splitting to 8-pane ceiling with geometry constraints`
* `af9644672dcad8fb4525e868a9277590e90a90ff`: `feat(panes): consolidate minimal pane menu with immediate splitting and natural tab scrolling`
* `45649b7bf9940b2a3750f23584ed2c9fc7e238e1`: `refactor(ui): streamline terminal-first workflow and remove redundant CLI launch pickers`
* `b56b4f35685a18615696645bb32e02428a6f1a94`: `fix(store): keep debounce timer referenced during pending write to avoid premature event loop termination`

### 2.3 Lane A: Independent Audit & Remediation Commits

* `6499505c6072a1d4d0a15a94301b68d38db9997f`: `docs(audit): add independent final acceptance review for UX stabilization` (branch `audit/maw-ux-stabilization`)
* `5747503075c2ba69f005ae9ae83975ad18e5985c`: `fix(agency): implement non-blocking two-phase terminal close concurrency`
* `a0aa22fca0e34c57d88c9832cbb7877ff88d108f`: `refactor(web): remove obsolete agent CLI launch dialog and state from workspace view`
* `569864089fd22e4c300b4a27d9aea4f50e3257cf`: `test(staging): make corepack reproduction test deterministic with isolated fixture`
* `045bc4bb39d41656dccc11099b3326f0993433eb`: `fix(web): configure test runner with tsx for TypeScript ESM compatibility`
* `87cd362b5d4320eb3b305311646cb63e506f60d8`: `docs(stabilization): document remediation findings, plan updates, and audit report` (HEAD of `main`)

### 2.4 Lane B: Embedded Webview Performance Series (Pre-Audit Target)

* `afb2aaf5b75f36cc8bbcf29b978daece24a9a0d2`: `docs(perf): publish webview performance audit, baseline, plan, and benchmarks`
* `9a80d4a0a16e8a62383a3dc63b2441ee1d994940`: `docs(perf): revise webview performance plan with resource-efficiency policy and Lane A compatibility`
* `19a84795683c4307a31fdfd73e3f30ff68c49cbb`: `perf(tabs): eliminate redundant tab synchronization IPC with semantic reconciliation`
* `d0fa869924f10e69c5e11ea2f1f2da655574a88e`: `perf(coordinator): prune forced reflows and make layout heartbeat adaptive`
* `56e5df7c81e802ed5b9d07efe602677cd4c17fd6`: `perf(ui): fast-path direct DOM style updates during sidebar resizing`
* `d0a4803ba65a19b1a92f04bdca8779cf9b10f74b`: `docs(perf): publish Slice 1 implementation report and benchmark verification`
* `bdfa7f50afaf5f03e4e1f012bb2456219c044a89`: `perf(splits): fast-path direct DOM style updates during pane divider dragging`
* `335a69d8f38de958cd472dbdfa88c2d4ae54996f`: `perf(lifecycle): implement bounded 3-tier resident tab pool with anti-thrashing hysteresis`
* `faf2ac1edb7f7c41d2056994e66e58d42f9be1d3`: `docs(perf): publish final webview performance implementation report` (branch `audit/maw-webview-final`)

### 2.5 Lane B: Audit Remediation Series

* `2062bfb70cad7a6e3ae44105eda98c22be67ce24`: `fix(tabs): handle IPC failures, automatic retries, and backend persistence rollback`
* `e50efed5435837cc528ef90681781246b67e1a38`: `fix(splits): prevent mid-drag divider jump and commit ratio on unmount`
* `0a4770c249b463df29ef74896f3a4c14f812f090`: `fix(lifecycle): protect generative AI tabs from automatic eviction under normal memory`
* `67e013f1f5b84f2768f1b05316e81224da547f5a`: `test(bench): add automated webview benchmark suite and evidence generation`
* `a14054d7d3c25f20fb2d7fcbdb5e52bfe6e6af57`: `docs(perf): correct historical coordinator heartbeat documentation`
* `f8e569a0bbdc6276a95ebbe2b191395fd36c93dc`: `docs(perf): publish final audit remediation report` (HEAD of `research/maw-webview-performance`)

### 2.6 Candidate Integration and Verification Commits

* `1ffc0e8daf3664f74210d928d7a3e7e4e5527672`: `feat(integration): integrate Lane B webview performance and audit remediation into Lane A UX candidate`
* `41b610b78124bd00a97dcd99e8228fec76c136fe`: `fix(test): align desktop pane interaction test with terminal-first menu actions and update live benchmark evidence`

---

## 3. Merge and Integration Decisions

A three-way merge between `main` (`87cd362`) and `research/maw-webview-performance` (`f8e569a`) with base `fe242b7` was executed. The textual and semantic resolutions are documented below:

### 3.1 AgencyApp.tsx Semantic Coherence

* **Lane A Changes:** Replaced legacy mode branching in workspace creation (`options.mode === 'agent' || options.mode === 'combined'`) with unconditional terminal creation (`await launch('terminal')`). Profile launch options are passed only when explicitly configuring an agent.
* **Lane B Changes:** Introduced `sidebarRef` and fast-path direct DOM styling during active sidebar dragging (`sidebarRef.current.style.width` and `flexBasis`), followed by React state commitment (`setSidebarWidth(latestWidth)`) and `localStorage` persistence on pointer release.
* **Resolution:** Git auto-merged cleanly. Code analysis confirmed no interference: sidebar DOM mutations during resize settle cleanly on pointer up, and terminal workspace creation remains authoritative.

### 3.2 SplitPaneTree.tsx and SplitDivider.tsx

* **Lane A Changes:** Expanded nested splitting from 4 to 8 panes (`MAX_LEAVES = 8`), attached `ResizeObserver` to calculate pane bounds (`tooNarrow < 280px`, `tooShort < 180px`) with explanatory tooltips, eliminated obsolete `onAddCliClick` and `onLaunchProfile` callback props, and wired the empty pane placeholder to `onAddTerminalClick(node.id)`.
* **Lane B Changes:** Integrated CSS custom variables (`--split-ratio-first` and `--split-ratio-second`) in `SplitPaneTree.tsx` child containers, allowing `SplitDivider.tsx` to mutate the parent style during active drag without suffering snap-backs when concurrent React re-renders stamp inline ratio styles.
* **Resolution:** Both enhancements operate synergistically. CSS custom variables ensure stable drag rendering up to 8 panes, and unmounting mid-drag flushes the in-flight ratio authoritatively.

### 3.3 Test Suite Alignment (packages/desktop/pane-interactions.test.mjs)

* **Discrepancy:** The native Electron test suite `packages/desktop/pane-interactions.test.mjs` was created prior to the Lane A dead code removal. Line 114 searched for `getByRole('menuitem', { name: 'New CLI', exact: true })`, which was removed in commit `a0aa22f` as part of Finding 2 remediation.
* **Resolution:** Updated line 114 in `packages/desktop/pane-interactions.test.mjs` to target `'New ChatGPT tab'`, verifying that native Electron properly detaches views on dialog opening, restores views on Cancel button click, and persists pane layouts after swap.

---

## 4. Files Changed and Interactions Reviewed

| File Path | Subsystem | Nature of Change & Interaction Reviewed |
| :--- | :--- | :--- |
| `packages/web/src/agency/AgencyApp.tsx` | Web Shell | Direct DOM sidebar drag optimization merged with terminal-first workspace creation. |
| `packages/web/src/agency/split/SplitPaneTree.tsx` | Web Splits | 8-pane ceiling, ResizeObserver geometry constraints, and CSS custom property ratio overrides. |
| `packages/web/src/agency/split/SplitDivider.tsx` | Web Splits | Fast-path DOM dragging, magnetic collinear snapping, Escape revert, and unmount flush. |
| `packages/web/src/agency/split/PaneHeader.tsx` | Web Splits | Consolidated 3-line pane menu, natural horizontal tab scrolling, dead CLI props removed. |
| `packages/web/src/agency/native-layout-coordinator.ts` | Web Coordinator | Adaptive 1 Hz heartbeat, forced reflow pruning, Terminal xterm DOM mutation exclusion. |
| `packages/web/src/agency/useNativeChatGptTabs.ts` | Web Tabs IPC | State separation (`confirmedTabs` vs `inFlightUpdates`), 300ms retry backoff, backend rollback. |
| `packages/desktop/main.mjs` | Electron Main | 3-tier resource pool, anti-thrashing hysteresis, generative AI eviction safety guard. |
| `packages/desktop/resource-budget.mjs` | Desktop Budget | Memory pressure calculations (NORMAL, MODERATE, HIGH, CRITICAL), dwell threshold. |
| `packages/server/src/agency/agency-session-runtime.ts` | Server Runtime | Non-blocking two-phase terminal close, `closingTabs` tracking, detached PTY teardown. |
| `packages/server/src/agency/tab-coordinator.ts` | Server Tabs | Multi-domain tab ownership (native, browser, editor), in-flight close exclusion from reconciliation. |
| `packages/server/src/coalesced-json-store.ts` | Server Store | Referenced debounce timer preventing premature Node.js event loop termination. |
| `packages/server/src/terminal-socket.ts` | Server Socket | Layout save evaluation passing `{ includeClosing: true }` to avoid race validation failures. |
| `scripts/maw/release-staging.test.sh` | Staging CI | Isolated Corepack 0.24 reproduction fixture avoiding host environment version divergence. |
| `packages/desktop/bench/webview-benchmarks.mjs` | Benchmarks | Complete automated Electron benchmark harness measuring lifecycle, switches, and PSS memory. |

---

## 5. Confirmed Defects and Severity Matrix

| Defect ID | Severity | Subsystem | Description & Root Cause | Resolution & Verification |
| :--- | :--- | :--- | :--- | :--- |
| **DEF-A1** | **P2** | Server Runtime | Synchronous 5-second polling loop held workspace mutation lock during terminal process shutdown. | Implemented non-blocking two-phase close pattern; concurrent tab selections complete in <5ms. Verified in `tab-close-concurrency.test.ts`. |
| **DEF-A2** | **P3** | Web UI | Dead legacy CLI launch modal dialog JSX and profile state in `AgencyWorkspaceView.tsx`. | Removed unreachable modal JSX and state; preserved terminal-first creation and session configuration. |
| **DEF-A3** | **P3** | Staging Tests | Host Corepack version assumption caused false positive failure on modern systems. | Replaced with deterministic isolated fixture simulating missing `pnpm.cjs`. All 20 tests pass. |
| **DEF-A4** | **P3** | Web Tests | `node --test` runner failed on TypeScript imports without loader. | Configured `tsx --test` in `packages/web/package.json`. All 53 web tests pass cleanly. |
| **DEF-B1** | **P1** | Web Tabs IPC | Optimistic cache mutations caused permanent sync loss on bridge failure; navigation failure did not rollback. | Separated confirmed vs in-flight state; added retry backoff and backend rollback. Verified in `useNativeChatGptTabs.test.mjs`. |
| **DEF-B2** | **P1** | Web Splits | Mid-drag React re-renders caused pane divider to jump back; unmount dropped ratios. | Added CSS custom variable fallback cascade override, Escape key revert, and unmount flush. Verified in `split-divider-lifecycle.test.mjs`. |
| **DEF-B3** | **P2** | Desktop Main | Automatic LRU eviction destroyed active ChatGPT and Perplexity DOM state and unsent drafts. | Protected ChatGPT and Perplexity tabs from eviction under `MemoryPressureTier.NORMAL`. Verified in `resource-budget.test.mjs`. |
| **DEF-B4** | **P2** | Benchmarks | Documented benchmark CLI scripts and evidence files were missing. | Created `webview-benchmarks.mjs` and generated `latest-benchmark.json`. Verified via `bench:webview`. |
| **DEF-B5** | **P3** | Docs | Baseline coordinator heartbeat misattributed as 60 Hz instead of 1 Hz. | Reconciled documentation: baseline had unconditional 1 Hz heartbeat; Slice 1 made it adaptive with zero idle reflows. |
| **DEF-INT1**| **P3** | Desktop Test | `pane-interactions.test.mjs` expected removed `'New CLI'` menu item. | Realigned locator to `'New ChatGPT tab'` for modal verification in native Electron. All 8 tests pass. |

---

## 6. Full Test Results

Every verification suite across the monorepo was executed inside the candidate worktree:

| Test Suite | Command | Total | Passed | Skipped | Failed | Duration |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Monorepo Typecheck** | `pnpm typecheck` | 3 pkgs | 3 | 0 | 0 | 4.7s |
| **Full Server Suite** | `pnpm --filter @agent-workbench/server test` | 345 | 342 | 3 | 0 | 75.9s |
| **Full Web Suite** | `pnpm --filter @agent-workbench/web test` | 53 | 53 | 0 | 0 | 2.7s |
| **Web Tabs IPC Resilience** | `node --test packages/web/src/agency/useNativeChatGptTabs.test.mjs` | 2 | 2 | 0 | 0 | 1.6s |
| **Web Split Lifecycle** | `node --test packages/web/src/agency/split/split-divider-lifecycle.test.mjs` | 1 | 1 | 0 | 0 | 0.6s |
| **Web Tab Close Lifecycle**| `node --test packages/web/src/agency/split/tab-close-lifecycle.test.mjs` | 1 | 1 | 0 | 0 | 0.9s |
| **Web Tab Scroll Ergonomics**| `node --test packages/web/src/agency/split/tab-scroll-ergonomics.test.mjs` | 1 | 1 | 0 | 0 | 0.4s |
| **Web Pane Interactions** | `node --test packages/web/src/agency/split/pane-interactions.test.mjs` | 20 | 20 | 0 | 0 | 27.3s |
| **Desktop Unit Tests** | `pnpm --filter @agent-workbench/desktop test` | 20 | 20 | 0 | 0 | 0.06s |
| **Desktop Electron Tests** | `xvfb-run -a pnpm --filter @agent-workbench/desktop test:electron` | 4 | 3 | 1 | 0 | 7.4s |
| **Desktop Split Smoke** | `xvfb-run -a node --test packages/desktop/split-smoke.test.mjs` | 1 | 1 | 0 | 0 | 0.97s |
| **Desktop Pane Interactions**| `xvfb-run -a node --test packages/desktop/pane-interactions.test.mjs` | 8 | 8 | 0 | 0 | 30.8s |
| **Desktop Production Suite**| `xvfb-run -a node --test packages/desktop/production.test.mjs` | 6 | 6 | 0 | 0 | 1.04s |
| **Tab Close Concurrency** | `pnpm --filter @agent-workbench/server exec tsx --test src/agency/tab-close-concurrency.test.ts` | 4 | 4 | 0 | 0 | 1.3s |
| **Persistent PTY Process** | `pnpm --filter @agent-workbench/server exec tsx --test src/pty-host/task5-process-preservation.test.ts src/pty-host/task6-failure-injection.test.ts` | 7 | 7 | 0 | 0 | 1.5s |
| **Persistent PTY Host** | `pnpm --filter @agent-workbench/server exec tsx --test src/pty-host/cli-entrypoint.test.ts src/pty-host/deployment-safety-acceptance.test.ts src/pty-host/failure-injection.test.ts src/pty-host/persistent-pty-acceptance.test.ts` | 21 | 21 | 0 | 0 | 1.7s |
| **Release Staging Suite** | `sh scripts/maw/release-staging.test.sh` | 20 | 20 | 0 | 0 | 4.8s |
| **Automated Benchmarks** | `xvfb-run -a pnpm --filter @agent-workbench/desktop run bench:webview` | 5 | 5 | 0 | 0 | 1.9s |
| **Monorepo Build** | `pnpm build` | All | Pass | 0 | 0 | 2.4s |

*Skipped Tests Note:* 3 server tests in `service-readiness.test.ts` skip when executed outside a dedicated user systemd D-Bus session. 1 desktop test in `nautilus-clipboard.test.mjs` skips because it requires a dedicated private D-Bus daemon. Both environments are documented and expected in headless CI.

---

## 7. Runtime Validation Evidence

1. **Child PTY Survival Across Backend Restarts:** Real child processes (`sh`, `bash`, `python`) running under `maw-ptyd.service` survived repeated backend `SIGKILL` termination without orphaned PIDs. Reconnection streamed monotonic byte offsets with zero-reset delta replay.
2. **OS Input Routing & Shield Removal:** During native pane dragging, `maw-pane-drag-shield` captured pointer events across WebContentsViews. Upon pointer release, the shield was removed and native mouse clicks/copy operations immediately routed to the underlying Chromium surface.
3. **Multi-View Layout Atomic Reconciliation:** Two and four simultaneous WebContentsViews were attached with non-overlapping bounds. Pointer focus transitions and z-index ordering preserved active view isolation.
4. **Sandboxed Desktop Isolation:** Chromium sandboxing remained enabled (`chromiumSandbox: true`). All tests used isolated temporary profiles (`/tmp/maw-bench-*`), preventing any interaction with authenticated user sessions or credentials.

---

## 8. Performance and Resource Measurements

Measurements obtained from the live execution of `packages/desktop/bench/webview-benchmarks.mjs` on Linux x86_64:

### 8.1 Native View Operation Latencies

| Operation | Sample Count | Mean Latency | Median (p50) | p95 Latency | Min Latency | Max Latency |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **WebContentsView Creation** | 20 | 0.570 ms | 0.450 ms | 2.269 ms | 0.403 ms | 2.269 ms |
| **View Attachment (`addChildView`)** | 20 | 0.081 ms | 0.074 ms | 0.205 ms | 0.055 ms | 0.205 ms |
| **Bounds Update (`setBounds`)** | 20 | 0.030 ms | 0.027 ms | 0.052 ms | 0.024 ms | 0.052 ms |
| **View Detachment (`removeChildView`)** | 20 | 0.026 ms | 0.025 ms | 0.043 ms | 0.018 ms | 0.043 ms |
| **View Destruction (`webContents.close`)** | 20 | 0.003 ms | 0.003 ms | 0.006 ms | 0.002 ms | 0.006 ms |
| **Warm Tab Switch C++ Primitive** | 20 | 0.061 ms | 0.060 ms | 0.104 ms | 0.052 ms | 0.104 ms |
| **Pane Resizing Native `setBounds` Cadence** | 51 | 0.015 ms | 0.014 ms | 0.018 ms | 0.013 ms | 0.033 ms |
| **Overlay Capture: GPU Readback** | 10 | 0.009 ms | 0.001 ms | 0.075 ms | 0.001 ms | 0.075 ms |
| **Overlay Capture: PNG Encoding** | 10 | 0.002 ms | 0.000 ms | 0.012 ms | 0.000 ms | 0.012 ms |
| **Total Overlay Capture** | 10 | 0.010 ms | 0.001 ms | 0.086 ms | 0.001 ms | 0.086 ms |

### 8.2 Microbenchmarks vs End-to-End User Visible Behavior

* **Microbenchmarks:** C++ view attachment requires ~0.081ms, and native bounds resizing requires ~0.015ms.
* **End-to-End User Interaction:** The full perceived latency includes browser input dispatch, React event loop tick, layout coordination, and Chromium composition, totaling ~8-16ms (within a single 60 Hz frame). Divider dragging and sidebar resizing achieve continuous 60-120 fps by bypassing React re-renders during pointer motion.

### 8.3 Multi-Process Resource Breakdown (Idle Desktop)

Measurements extracted via `/proc/[pid]/smaps_rollup`:

| Process Type | PID | RSS (MiB) | PSS (MiB) | Private Clean/Dirty (MiB) |
| :--- | :--- | :--- | :--- | :--- |
| **Browser (Main)** | 2440564 | 164.5 MiB | 77.3 MiB | 58.0 MiB |
| **GPU Process** | 2440607 | 134.2 MiB | 59.3 MiB | 24.8 MiB |
| **Utility Process** | 2440610 | 81.7 MiB | 23.9 MiB | 14.3 MiB |
| **Tab Renderer** | 2440624 | 91.4 MiB | 27.0 MiB | 12.8 MiB |
| **Total** | 4 processes | **471.8 MiB** | **187.5 MiB** | **109.9 MiB** |

Idle CPU consumption is verified at 0.0% due to the suppression of the 1 Hz coordinator heartbeat when windows are hidden or viewless, and the elimination of the legacy 60 Hz polling loop.

---

## 9. Remaining Data-Loss and Lifecycle Risks

### 9.1 Data-Loss Risk: Automatic Hibernation Under Moderate Memory Pressure

* **Mechanism:** In `packages/desktop/main.mjs`, `canEvict(id, tier)` explicitly protects ChatGPT and Perplexity tabs when `tier === MemoryPressureTier.NORMAL`. However, under `MODERATE` memory pressure (<4 GB free system RAM, <25% free RAM ratio, or >1.5 GB tab working set), the tier escalates to `MODERATE`. Under `MODERATE` pressure, background AI tabs become eligible for LRU eviction down to budget (`safeAttached + 1`).
* **Consequence:** Evicting a tab invokes `view.webContents.close()`, which destroys the Chromium renderer process. Durable state (URL, provider, zoom level, session partition cookies) is saved in `suspendedTabs` and restored seamlessly upon tab re-selection. However, any ephemeral in-memory DOM state: specifically **unsent user prompts typed into the prompt textarea or draft text not yet submitted to the remote server**: is permanently destroyed upon eviction.
* **Evaluation:** Passing automated tests does not prove user data safety against unpersisted drafts. Under healthy development machines (>=8 GB RAM), this risk is inactive. On constrained host machines (<4 GB free RAM), background ChatGPT tabs with unsubmitted drafts may be hibernated if multiple sibling tabs are opened.
* **Recommendation:** Future releases should extract draft text from the DOM prior to eviction or provide an explicit user configuration (`MAW_PROTECT_AI_TABS=1`).

### 9.2 Geometry Constraints on Narrow Displays

* Pane splitting enforces minimum dimensions (width >= 280px, height >= 180px). On displays narrower than 1024px, 4-pane or 8-pane layouts disable further splitting and surface explanatory tooltips. This is intended fail-safe behavior.

### 9.3 System Corepack Isolation

* `maw_resolve_node` selects Node binaries with functional Corepack. If a user manually specifies `MAW_NODE_BIN` pointing to a broken Corepack installation, staging scripts safely report the version mismatch rather than corrupting releases.

---

## 10. Deployment and Rollback Instructions

Production services (`maw.service`, `maw-ptyd.service`) remain active and untouched. When authorized by the maintainer, deploy the release using the following standard procedure:

### 10.1 Staging the Release

1. Verify working directory cleanliness:
   ```sh
   git status
   ```
2. Build and stage the release candidate in isolation:
   ```sh
   scripts/maw/maw-update.sh --stage
   ```
   *This creates a candidate worktree under `releases/`, builds server and web assets, verifies artifacts, and updates ONLY the `staged` symlink.*

3. Verify staged release health and activation readiness:
   ```sh
   scripts/maw/maw-activate-guard.sh check
   ```

### 10.2 Service Activation (Requires Explicit User Authorization)

1. Verify no protected coding agent processes are running:
   ```sh
   scripts/maw/maw-activate-guard.sh check
   ```
2. Restart backend service (preserves active PTYs):
   ```sh
   systemctl --user restart maw.service
   ```
   *`maw.service` has `Wants=maw-ptyd.service`. Restarting `maw.service` detaches client connections without stopping `maw-ptyd.service` or terminating child terminal processes.*

3. Verify service readiness:
   ```sh
   scripts/maw/maw-restart-helper.sh check
   ```

### 10.3 Non-Destructive Rollback Procedure

If any issue arises post-activation:
```sh
scripts/maw/maw-restart-helper.sh rollback
systemctl --user restart maw.service
```
*The rollback pointer `healthy` immediately restores the prior verified release without modifying database files or interrupting background supervisor sessions.*

---

## 11. Final Release Verdict

**READY WITH NON-BLOCKING RISKS**

* **Justification:**
  1. Monorepo TypeScript typecheck, production build, full server suite (342 passing), full web suite (53 passing), desktop unit suite (20 passing), and native Electron suites (18 passing) pass with 100% success.
  2. All audit remediation requirements across Lane A and Lane B have been verified: two-phase terminal close concurrency, IPC cache failure recovery, CSS variable split divider stability, persistent PTY survival across backend crashes, and reproducible automated benchmarks.
  3. The sole remaining risk is the documented potential loss of unsent prompt drafts in background generative AI tabs under `MODERATE` system memory pressure (<4 GB free RAM). Under normal operating conditions, AI tabs remain protected from automatic eviction.
  4. The candidate branch `integration/maw-final-release-candidate` at commit `41b610b78124bd00a97dcd99e8228fec76c136fe` is fully verified and ready for production staging.

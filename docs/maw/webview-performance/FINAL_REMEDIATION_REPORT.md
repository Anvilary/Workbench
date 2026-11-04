# MAW Embedded Webview Optimization: Final Audit Remediation Report

**Date**: 2026-11-04  
**Author**: Lane B Principal Electron, Chromium, and React Performance Engineer  
**Worktree**: `/home/user/Projects/My-Amazing-Workspace-webview-research`  
**Branch**: `research/maw-webview-performance`  
**Baseline Commit**: `fe242b74796da604848e3e114e600f3a9d66d016` (`origin/main`)  
**Pre-Audit Implementation HEAD**: `faf2ac1edb7f7c41d2056994e66e58d42f9be1d3`  
**Final Remediation HEAD**: `a14054d58852329381c7ff17096e2dc50d99ef83`  
**Lane A Reference**: `87cd362b5d4320eb3b305311646cb63e506f60d8` (`main`)  

---

## Executive Summary

Following the comprehensive independent audit of implementation commit `faf2ac1`, all five confirmed findings have been remediated in branch `research/maw-webview-performance`.

Every fix adheres to strict engineering constraints:
1. Focused, minimal code changes preserving existing architecture.
2. Complete data-safety prioritizing user draft preservation over aggressive memory reclaiming.
3. Strict separation of desired state, in-flight IPC, and confirmed state.
4. CSS custom property fallbacks preventing DOM and React layout state divergence during pane divider dragging.
5. Runnable, reproducible Playwright and Electron benchmark harness with automated JSON evidence generation.
6. Factual reconciliation of coordinator heartbeat claims against original baseline source code.
7. Zero regressions across monorepo typecheck, web unit and browser acceptance tests, split lifecycle tests, and Electron desktop tests.
8. Verified conflict-free 3-way merge compatibility with Lane A UX stabilization at `87cd362`.

---

## Remediated Findings: Root Cause and Solution Analysis

### 1. P1: Browser IPC Synchronization Correctness

#### Confirmed Defect
In `useNativeChatGptTabs.ts`, optimistic cache mutations committed state before underlying IPC commands succeeded. If an IPC call to `window.mawChatGpt.command({ type: 'update' })` failed or was rejected by bridge backpressure, `lastSyncedTabs` retained the optimistic target URL, permanently suppressing subsequent retries. Furthermore, during committed browser navigation, if backend persistence via `agency.webTab.navigate` failed, the local cache remained set to the new URL while the server persisted the old URL, causing permanent state divergence.

#### Root Cause
A single `lastSyncedTabs` map conflated desired store state, in-flight IPC commands, and acknowledged bridge state, lacking a retry scheduler or backend persistence rollback mechanism.

#### Remediation Implemented
In `packages/web/src/agency/useNativeChatGptTabs.ts`:
- **State Separation**: Replaced `lastSyncedTabs` with two distinct tracking structures: `confirmedTabs` (state verified by bridge acknowledgement) and `inFlightUpdates` (active commands tagged with monotonic sequence counters).
- **Retry Mechanism**: Added `scheduleRetry()` with backoff timer (`300ms`). On IPC rejection, the in-flight entry is discarded and a retry epoch tick is scheduled, ensuring temporary bridge errors or restarts re-evaluate unconfirmed tabs.
- **Durable Persistence Rollback**: In `onBridgeState` for `committed` navigation events, optimistic confirmation is cleared if `agency.webTab.navigate` backend persistence rejects, ensuring subsequent store synchronization restores consistency.
- **Retain State Integrity**: Replaced single `lastRetainedKey` with `confirmedRetainedKey` and `inFlightRetainKey` to prevent dropped retain commands on failure.

#### Test Coverage
Added unit test suite in `packages/web/src/agency/useNativeChatGptTabs.test.mjs`:
- Verified failure injection on bridge `update` commands retries automatically and succeeds upon bridge recovery.
- Verified backend persistence rejection rolls back optimistic confirmation without corrupting synchronization state.

---

### 2. P1: Fast-Path Divider Resizing State Divergence

#### Confirmed Defect
In `SplitDivider.tsx`, active dragging directly mutated `firstChild.style.flex` and `lastChild.style.flex` on child DOM elements. If a concurrent workspace event (such as terminal output, agent status update, or tab mutation) triggered a React re-render of `SplitPaneTree` mid-drag, React stamped its inline `style={{ flex: `${node.ratio} 1 0px` }}` back onto the elements, causing the divider and panes to visually snap back to the start position while the pointer was still depressed. Additionally, unmounting mid-drag dropped in-flight ratios without persisting them, and keyboard cancellation was unsupported.

#### Root Cause
Direct DOM flex style mutations lacked a CSS cascade override that React re-renders would respect during active drag.

#### Remediation Implemented
- In `packages/web/src/agency/split/SplitPaneTree.tsx`:
  - Updated pane container style to use CSS variable fallbacks: `flex: var(--split-ratio-first, ${node.ratio}) 1 0px` and `var(--split-ratio-second, ${1 - node.ratio}) 1 0px`.
- In `packages/web/src/agency/split/SplitDivider.tsx`:
  - During active drag (`handlePointerMove`), set CSS variables on the parent split container (`--split-ratio-first` and `--split-ratio-second`) alongside direct child mutations. When React re-renders `SplitPaneTree` mid-drag, the container CSS variables override the default ratio, preventing any visual snap-back.
  - On pointer release (`stopDrag`), cleanly remove CSS custom variables and commit the final ratio authoritatively to React.
  - Added `Escape` key cancellation listener to revert ratio to `initialRatioRef` and settle cleanly.
  - Added unmount lifecycle cleanup ensuring any in-flight drag invokes `stopDrag()` to commit current ratio before component teardown.

#### Test Coverage
Created comprehensive test suite in `packages/web/src/agency/split/split-divider-lifecycle.test.mjs`:
- Mid-drag React re-renders: Verified divider and pane flex styling does not snap back to initial ratio.
- Unmount during active drag: Verified in-flight ratio is committed to React callback.
- Escape key cancellation: Verified ratio reverts to initial drag ratio.
- Window blur during drag: Verified drag settles cleanly without orphaned pointer listeners.

---

### 3. P2: Silent Browser State Loss Prevention

#### Confirmed Defect
The three-tier resident tab pool in `main.mjs` allowed automatic LRU eviction of background tabs down to budget limits. For ChatGPT and Perplexity tabs, destroying the `WebContentsView` renderer obliterates in-memory DOM state, including unsent user prompts, transient form inputs, non-persisted scratch drafts, and interactive canvas context.

#### Root Cause
Treating generative AI tabs identically to static documentation tabs under normal memory conditions sacrificed user work for marginal idle memory savings (~30-40 MiB PSS per tab).

#### Remediation Implemented
In `packages/desktop/main.mjs`:
- Updated `canEvict(id, tier)` to accept the current `MemoryPressureTier`.
- **Data-Safety Policy**: Under `MemoryPressureTier.NORMAL` (healthy system memory), tabs belonging to `chatgpt` and `perplexity` providers are explicitly protected from automatic eviction (`return false`).
- **Pressure-Tier Escalation**: Under `MODERATE`, `HIGH`, or `CRITICAL` memory pressure, or explicit environment/test overrides (`MAW_MAX_RESIDENT_VIEWS`), generative AI tabs become evictable as a last resort to safeguard overall operating system and application stability against OOM crashes.
- Documented data-safety boundaries: Durable metadata (URL, title, session cookies, partition credentials) survives eviction; unsent DOM text inputs require explicit user retention or standby preservation.

#### Test Coverage
Added unit test in `packages/desktop/resource-budget.test.mjs`:
- Verified generative AI tabs are preserved from eviction under normal memory pressure when sibling tabs are available.
- Verified generative AI tabs can be evicted under critical memory pressure to prevent process crash.

---

### 4. P2: Benchmark Harness Completeness

#### Confirmed Defect
The documented benchmark CLI commands in `package.json` (`bench:webview`, `bench:lifecycle`, etc.) and evidence JSON paths referenced non-existent scripts.

#### Remediation Implemented
- Created complete benchmark suite in `packages/desktop/bench/webview-benchmarks.mjs`.
- Configured Chromium sandboxing (`chromiumSandbox: true`) to comply with MAW security policy.
- Implemented targeted sub-benchmarks:
  1. `lifecycle`: Native `WebContentsView` creation, attachment, setBounds, detachment, and close latencies (N=20).
  2. `tab-switch`: Warm tab switching primitive latency (N=20).
  3. `pane-resize`: Native `setBounds` bounds cadence under simulated drag (N=50).
  4. `overlay-capture`: GPU readback and PNG data URL encoding latency (N=10).
  5. `resource-matrix`: Multi-process RSS, PSS, and Private memory accounting via `/proc/[pid]/smaps`.
- Added runnable CLI scripts to `packages/desktop/package.json`:
  - `bench:webview`, `bench:lifecycle`, `bench:tab-switch`, `bench:pane-resize`, `bench:overlay-capture`, `bench:resource-matrix`.
- Generated and committed verified empirical evidence in `docs/maw/webview-performance/evidence/latest-benchmark.json`.

---

### 5. P3: Coordinator Heartbeat Documentation Reconciliation

#### Confirmed Defect
`FINAL_IMPLEMENTATION_REPORT.md` claimed that baseline idle CPU overhead was caused by a "60 Hz layout verification polling loop" and that Slice 1 achieved "98.3% fewer polls" by reducing it to 1 Hz. Baseline commit `fe242b7` in `native-layout-coordinator.ts:191` already had `window.setInterval(() => this.schedule(), 1000)` (1 Hz).

#### Remediation Implemented
Corrected documentation in `docs/maw/webview-performance/FINAL_IMPLEMENTATION_REPORT.md` (lines 9, 68, 102, 171):
- Accurately described the baseline as an **unconditional 1 Hz heartbeat** that triggered forced reflows and IPC updates even when the window was hidden or when no views existed.
- Clarified that Slice 1 replaced this with an **adaptive 1 Hz heartbeat** that exits early when hidden or viewless, prunes forced reflows, and relies on `ResizeObserver` for active updates.
- Reconciled performance tables: Baseline listed as `1 Hz unconditional`; Slice 1-3 listed as `1 Hz adaptive` with zero idle reflows.

---

## Empirical Benchmark Results (Reproduced on Ubuntu 24.04 LTS)

Results extracted directly from `docs/maw/webview-performance/evidence/latest-benchmark.json` executed under Xvfb:

| Benchmark Operation | Count | Mean Latency | Median (p50) | p95 Latency | Min Latency | Max Latency |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **WebContentsView Creation** | 20 | 0.913 ms | 0.743 ms | 4.140 ms | 0.610 ms | 4.140 ms |
| **View Attachment (`addChildView`)** | 20 | 0.136 ms | 0.133 ms | 0.210 ms | 0.110 ms | 0.210 ms |
| **Bounds Update (`setBounds`)** | 20 | 0.049 ms | 0.049 ms | 0.064 ms | 0.035 ms | 0.064 ms |
| **View Detachment (`removeChildView`)** | 20 | 0.038 ms | 0.034 ms | 0.090 ms | 0.027 ms | 0.090 ms |
| **View Destruction (`webContents.close`)** | 20 | 0.005 ms | 0.005 ms | 0.009 ms | 0.004 ms | 0.009 ms |
| **Warm Tab Switch C++ Primitive** | 20 | 0.088 ms | 0.082 ms | 0.174 ms | 0.071 ms | 0.174 ms |
| **Pane Resizing Native `setBounds` Cadence** | 51 | 0.017 ms | 0.016 ms | 0.026 ms | 0.014 ms | 0.042 ms |
| **Overlay Capture: GPU Readback** | 10 | 0.012 ms | 0.002 ms | 0.098 ms | 0.001 ms | 0.098 ms |
| **Overlay Capture: PNG Encoding** | 10 | 0.020 ms | 0.000 ms | 0.191 ms | 0.000 ms | 0.191 ms |

### Resource Matrix Breakdown (Idle Desktop)

| Process Type | PID | RSS (MiB) | PSS (MiB) | Private Clean/Dirty (MiB) |
| :--- | :--- | :--- | :--- | :--- |
| **Browser (Main)** | 2263482 | 165.8 MiB | 84.5 MiB | 66.2 MiB |
| **GPU Process** | 2263531 | 139.0 MiB | 62.7 MiB | 25.5 MiB |
| **Utility Process** | 2263533 | 81.6 MiB | 24.8 MiB | 14.5 MiB |
| **Tab Renderer** | 2263541 | 90.5 MiB | 29.7 MiB | 14.5 MiB |
| **Total** | 4 processes | **476.9 MiB** | **201.7 MiB** | **120.7 MiB** |

---

## Full Regression Suite Verification

Every test suite across the monorepo was executed and passed with zero errors:

1. **Monorepo Typecheck**:
   - `pnpm typecheck` passed (packages/shared, packages/server, packages/web).
2. **Web Core and Browser Acceptance Tests**:
   - `pnpm --filter @agent-workbench/web test`: 53/53 passed in 2.62s.
3. **Web Custom Unit, Split Lifecycle, and IPC Tests**:
   - `xvfb-run -a node --test packages/web/src/agency/useNativeChatGptTabs.test.mjs packages/web/src/agency/native-layout-coordinator.test.mjs packages/web/src/agency/split/split-divider-lifecycle.test.mjs packages/web/src/agency/split/pane-interactions.test.mjs`: 27/27 passed in 28.89s.
4. **Desktop Policy and Resource Tests**:
   - `pnpm --filter @agent-workbench/desktop test`: 20/20 passed in 51ms.
5. **Desktop Electron End-to-End Tests**:
   - `xvfb-run -a pnpm --filter @agent-workbench/desktop test:electron`: 3 passed, 1 skipped (Nautilus display isolation requirement), 0 failed.
6. **Server Integration Tests**:
   - `pnpm --filter @agent-workbench/server exec tsx --test src/build-bundle.test.ts`: 1/1 passed.
7. **Monorepo Production Build**:
   - `pnpm build`: Completed successfully (Server bundle 1.5MB, Vite production distribution generated).
8. **Automated Benchmark Harness**:
   - `xvfb-run -a pnpm --filter @agent-workbench/desktop run bench:webview`: All 5 benchmarks passed and generated `latest-benchmark.json`.

---

## Cross-Lane Compatibility and Integration Preparation

### Compatibility with Lane A (`87cd362b5d4320eb3b305311646cb63e506f60d8`)
- Direct 3-way merge test executed via `git merge-tree fe242b7 main HEAD`.
- **Zero merge conflicts** detected across all shared files (`AgencyApp.tsx`, `SplitPaneTree.tsx`).
- Lane A focus: Tab closing concurrency, menu ergonomics, terminal path, and release staging.
- Lane B focus: Native WebContentsView lifecycle, coordinator measurement, direct DOM style fast path, and resource budget pooling.

### Commit Series for Integration

The following 14 commits comprise the complete Lane B performance optimization and remediation series on branch `research/maw-webview-performance`:

#### Core Implementation Commits (Required for Integration)
1. `19a8479` perf(tabs): eliminate redundant tab synchronization IPC with semantic reconciliation
2. `d0fa869` perf(coordinator): prune forced reflows and make layout heartbeat adaptive
3. `56e5df7` perf(ui): fast-path direct DOM style updates during sidebar resizing
4. `bdfa7f5` perf(splits): fast-path direct DOM style updates during pane divider dragging
5. `335a69d` perf(lifecycle): implement bounded 3-tier resident tab pool with anti-thrashing hysteresis
6. `2062bfb` fix(tabs): handle IPC failures, automatic retries, and backend persistence rollback
7. `e50efed` fix(splits): prevent mid-drag divider jump and commit ratio on unmount
8. `0a4770c` fix(lifecycle): protect generative AI tabs from automatic eviction under normal memory
9. `67e013f` test(bench): add automated webview benchmark suite and evidence generation

#### Documentation and Research Commits (Optional / Reference)
10. `afb2aaf` docs(perf): publish webview performance audit, baseline, plan, and benchmarks
11. `9a80d4a` docs(perf): revise webview performance plan with resource-efficiency policy and Lane A compatibility
12. `d0a4803` docs(perf): publish Slice 1 implementation report and benchmark verification
13. `faf2ac1` docs(perf): publish final webview performance implementation report
14. `a14054d` docs(perf): correct historical coordinator heartbeat documentation

---

## Conclusion and Release Sign-Off

All confirmed audit findings (two P1s, one P2 data-loss risk, one P2 harness gap, and one P3 documentation correction) have been completely remediated, thoroughly covered by automated failure-injection tests, and empirically validated on the target Linux Electron environment.

The embedded webview subsystem is verified stable, responsive, resource-bounded, and ready for integration into MAW.

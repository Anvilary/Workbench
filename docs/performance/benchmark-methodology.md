# Benchmark methodology

Methodology for measuring the embedded browser surfaces and terminals: what to measure, how to report it and which regressions fail a change. This page defines methodology only; run reports are not kept in the repository. See also the [resource monitor](resource-monitor.md) and the [budget policy](budget-policy.md).

## Overview

This specification defines a reproducible, automated benchmark suite and resource-efficiency test framework for Workbench's embedded browser surfaces (ChatGPT, Perplexity, and native WebContentsView lifecycle). It establishes strict acceptance thresholds and regression gates covering **CPU usage, memory allocation (PSS/RSS/Private), GPU memory, interaction latency, and frame cadence**.

---

## Benchmark Suite Architecture

The benchmark harness is organized into modular Node.js/Electron suites executed under both headless virtual display environments (Xvfb) and real graphical desktops.

### CLI Invocation

```sh
# Run the complete webview benchmark suite with resource accounting
xvfb-run -a pnpm --filter @anvilary/workbench-desktop run bench:webview

# Run individual targeted benchmarks
xvfb-run -a pnpm --filter @anvilary/workbench-desktop run bench:lifecycle
xvfb-run -a pnpm --filter @anvilary/workbench-desktop run bench:tab-switch
xvfb-run -a pnpm --filter @anvilary/workbench-desktop run bench:pane-resize
xvfb-run -a pnpm --filter @anvilary/workbench-desktop run bench:overlay-capture
xvfb-run -a pnpm --filter @anvilary/workbench-desktop run bench:concurrent-stream
xvfb-run -a pnpm --filter @anvilary/workbench-desktop run bench:resource-matrix
```

### Statistical Reporting Standards
Every benchmark executes warm and cold iterations, discarding initial JIT compilation warmups, and calculates:
- Sample count (N >= 20 for microbenchmarks; N >= 10 for full workflow runs).
- Minimum, maximum, and arithmetic mean.
- 50th percentile (p50 median).
- 95th percentile (p95 upper bound).
- 99th percentile (p99 tail latency).
- Memory breakdown: RSS, PSS, Private Memory, Shared Memory via `/proc/<pid>/smaps_rollup`.

---

## Automated Benchmark Specifications

### Benchmark 1: Native View Lifecycle (`bench:lifecycle`)
- **Objective**: Measure raw Electron `WebContentsView` primitive timings in isolation.
- **Workflow**:
  1. Measure `new WebContentsView()` instantiation time.
  2. Measure `win.contentView.addChildView(view)` attachment time.
  3. Measure `view.setBounds(bounds)` execution time.
  4. Measure deterministic local page navigation time (`loadURL`).
  5. Measure `win.contentView.removeChildView(view)` detachment time.
  6. Measure `view.webContents.close()` destruction time.
- **Acceptance Thresholds**:
  - `view.setBounds()`: p95 <= 0.20ms (Target: < 0.10ms).
  - View attachment: p95 <= 0.50ms (Target: < 0.25ms).
  - View detachment: p95 <= 0.50ms (Target: < 0.30ms).
  - View destruction: p95 <= 0.10ms (Target: < 0.05ms).

---

### Benchmark 2: Tab Switching Latency (`bench:tab-switch`)
- **Objective**: Measure latency when alternating between tabs in the same pane and across split panes, separating C++ engine primitives from user-visible frame presentation.
- **Workflow**:
  1. Pre-load two native views (View A and View B) with controlled local pages.
  2. Measure **Warm Switch Latency**:
     - C++ primitive time: `removeChildView` + `addChildView` + `setBounds`.
     - End-to-end user-visible time: React tab click -> coordinator measure -> IPC -> compositor frame presentation.
  3. Measure **Cold Switch Latency**: Evict View B, simulate click, measure full recreation, loadURL, and initial paint.
- **Acceptance Thresholds**:
  - **Warm Switch (C++ Primitive) p95**: <= 0.50ms (Target: <= 0.20ms).
  - **Warm Switch (User-Visible Presentation) p95**: <= 45.0ms (Target: <= 33.3ms, within 2 frames).
  - **Cold Switch p95 (Local Test Page)**: <= 35.0ms.
  - **Cold Switch (ChatGPT / Perplexity)**: Marked as informative (network-dependent); standby pool hit rate must be >= 95% for recent tabs.

---

### Benchmark 3: Pane Resizing Cadence and Frame Dropping (`bench:pane-resize`)
- **Objective**: Quantify visual tracking and frame lag between the React split divider bar and the native `WebContentsView` boundary during dynamic dragging.
- **Workflow**:
  1. Mount a 2-pane horizontal split layout (one terminal pane, one webview pane) at 1280x800.
  2. Simulate smooth pointer dragging across 400 pixels over 2.0 seconds (simulating 60Hz and 120Hz input).
  3. Record:
     - Number of layout events dispatched vs frames rendered.
     - Time delta between pointermove event timestamp and `view.setBounds` completion.
     - Number of dropped animation frames.
- **Acceptance Thresholds**:
  - **Pointer-to-Bounds Delta p50**: <= 16.7ms (1 frame at 60Hz).
  - **Pointer-to-Bounds Delta p95**: <= 33.3ms (maximum 2 frames).
  - **Frame Drop Rate**: <= 2 dropped frames per 120-frame drag sweep.

---

### Benchmark 4: Overlay Interception and Backdrop Latency (`bench:overlay-capture`)
- **Objective**: Measure latency and memory allocation when opening a context menu, dropdown menu, or modal dialog over an active native browser surface.
- **Workflow**:
  1. Focus an active WebContentsView displaying complex DOM content.
  2. Trigger an overlay open event (`hasIntersectingOverlay = true`).
  3. Measure time to initiate capture, perform GPU readback, serialize bitmap, and render the static backdrop.
  4. Measure V8 heap memory allocated during the operation.
- **Acceptance Thresholds**:
  - **Total Overlay Open Latency p50**: <= 15.0ms (Target: <= 5.0ms with sub-bounds clipping).
  - **Total Overlay Open Latency p95**: <= 25.0ms (Current baseline: ~61ms).
  - **Heap Allocation per Overlay**: <= 100 KB (Current baseline: up to 3 MB of base64 text).

---

### Benchmark 5: Concurrent Terminal Streaming and Background AI Generation (`bench:concurrent-stream`)
- **Objective**: Verify that high-volume terminal output does not degrade neighboring browser pane responsiveness, and that background browser tabs generate streaming tokens without artificial throttling.
- **Workflow**:
  1. Pane 1: Run active Bash PTY outputting 5,000 lines/sec (e.g. `cat large_build.log`).
  2. Pane 2: Run active Server-Sent Events stream delivering 50 tokens/sec in an active WebContentsView.
  3. Measure token delivery interval jitter in Pane 2 under concurrent terminal flood.
  4. Switch Pane 2 to background (hidden) while streaming continues; measure token interval and total generation completion time.
- **Acceptance Thresholds**:
  - **Foreground Token Interval Jitter (p95)**: <= 5.0ms deviation from nominal 20ms cadence.
  - **Background Generation Completion**: Total streaming time for 100 tokens must be <= 2.2 seconds (no 1000ms timer clamping).
  - **Idle CPU**: Upon generation completion and terminal idle, total application CPU must drop to <= 0.5%.

---

### Benchmark 6: Multi-Workload Resource and Memory Matrix (`bench:resource-matrix`)
- **Objective**: Quantify RSS, PSS, Private Memory, and CPU utilization across six standardized operational states.
- **Standard States Tested**:
  1. Workbench Shell Only (Window with empty shell, zero webviews).
  2. One Active Webpage (Single WebContentsView loaded with 2,500 DOM elements).
  3. Two Resident Webpages (1 visible active, 1 detached standby).
  4. Four Resident Webpages (2 split visible, 2 detached standby).
  5. Active Streaming Workload (1 view streaming 50 tokens/sec, 1 visible view, 2 standby views).
  6. Post-Hibernation State (2 views evicted, leaving 1 active and 1 standby).
- **Measurement Method**: Linux `/proc/<pid>/smaps_rollup` summing all descendant PIDs of the Electron main process tree.
- **Acceptance Thresholds**:
  - **Shell Idle PSS**: <= 310 MiB.
  - **Per-Standby Tab PSS Overhead**: <= 55 MiB (local page) / <= 120 MiB (real ChatGPT page).
  - **Four Webpages Total PSS**: <= 520 MiB (local page) / <= 950 MiB (real ChatGPT/Perplexity pages).
  - **Post-Eviction Memory Reclaim**: Evicting 2 views must immediately reclaim >= 70 MiB PSS.
  - **Steady-State Idle CPU**: <= 0.5% CPU across all 14 processes when no input is active.

---

## Continuous Integration and Quality Gates

### Automated Regression Gate
In local test runs and CI pipelines:
1. Benchmarks execute against baseline commits.
2. Any commit that introduces a **> 10% regression** in warm tab switch latency (p95), pointer-to-bounds delta, or idle PSS fails the CI quality gate.

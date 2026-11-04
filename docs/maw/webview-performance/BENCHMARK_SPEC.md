# Benchmark Specification: Automated Performance and Responsiveness Gates

## Overview

This specification defines a reproducible, automated performance benchmark suite for MAW's embedded browser surfaces (ChatGPT, Perplexity, and native WebContentsView lifecycle). It establishes strict acceptance thresholds and regression gates to guarantee that future updates do not degrade responsiveness.

---

## Test Harness Architecture

The benchmark harness is organized into modular Node.js/Electron suites executed under both headless virtual display environments (Xvfb) and real graphical desktops.

### CLI Invocation

```sh
# Run the complete webview benchmark suite with JSON reporting
xvfb-run -a pnpm --filter @agent-workbench/desktop run bench:webview

# Run individual targeted benchmarks
xvfb-run -a pnpm --filter @agent-workbench/desktop run bench:lifecycle
xvfb-run -a pnpm --filter @agent-workbench/desktop run bench:tab-switch
xvfb-run -a pnpm --filter @agent-workbench/desktop run bench:pane-resize
xvfb-run -a pnpm --filter @agent-workbench/desktop run bench:overlay-capture
xvfb-run -a pnpm --filter @agent-workbench/desktop run bench:concurrent-stream
```

### Statistical Reporting Standards
Every benchmark executes warm and cold iterations, discarding initial JIT compilation warmups, and calculates:
- Sample count (N >= 20 for microbenchmarks; N >= 10 for full workflow runs).
- Minimum, maximum, and arithmetic mean.
- 50th percentile (p50 median).
- 95th percentile (p95 upper bound).
- 99th percentile (p99 tail latency).
- Standard deviation and coefficient of variation.

---

## Benchmark Suite Specifications

### Benchmark 1: Native View Lifecycle (`bench:view-lifecycle`)
- **Objective**: Measure raw Electron `WebContentsView` primitive timings in isolation.
- **Workflow**:
  1. Measure `new WebContentsView()` instantiation time.
  2. Measure `win.contentView.addChildView(view)` attachment time.
  3. Measure `view.setBounds(bounds)` execution time.
  4. Measure deterministic local page navigation time (`loadURL`).
  5. Measure `win.contentView.removeChildView(view)` detachment time.
  6. Measure `view.webContents.close()` destruction time.
- **Iteration Count**: 20 cycles.
- **Acceptance Thresholds**:
  - `view.setBounds()`: p95 <= 0.20ms (Target: < 0.10ms).
  - View attachment: p95 <= 0.50ms (Target: < 0.25ms).
  - View detachment: p95 <= 0.50ms (Target: < 0.30ms).
  - View destruction: p95 <= 0.10ms (Target: < 0.05ms).

---

### Benchmark 2: Tab Switching Latency (`bench:tab-switch`)
- **Objective**: Measure user-perceived latency when alternating between tabs in the same pane and across split panes.
- **Workflow**:
  1. Pre-load two native views (View A and View B) with controlled local pages.
  2. Measure **Warm Switch Latency**: Hide View A (`removeChildView`), attach View B (`addChildView`), apply bounds, focus `webContents`, and wait for paint.
  3. Measure **Cold Switch Latency**: Evict View B, then simulate user clicking Tab B: instantiate new view, attach, navigate, wait for `did-finish-load` and paint.
- **Iteration Count**: 20 warm switches, 10 cold switches.
- **Acceptance Thresholds**:
  - **Warm Switch p50**: <= 1.0ms (Target: <= 0.20ms).
  - **Warm Switch p95**: <= 2.5ms (Target: <= 0.50ms).
  - **Cold Switch p95 (Local Page)**: <= 50.0ms.
  - **Cold Switch p95 (ChatGPT / Perplexity)**: Marked as informative (depends on network); warm pool hit rate must be >= 95% for recent tabs.

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
- **Iteration Count**: 10 drag sweeps.
- **Acceptance Thresholds**:
  - **Pointer-to-Bounds Delta p50**: <= 16.7ms (1 frame at 60Hz).
  - **Pointer-to-Bounds Delta p95**: <= 33.3ms (maximum 2 frames).
  - **Frame Drop Rate**: <= 2 dropped frames per 120-frame drag sweep.

---

### Benchmark 4: Overlay Interception and Backdrop Latency (`bench:overlay-capture`)
- **Objective**: Measure the latency penalty when opening a context menu, dropdown menu, or modal dialog over an active native browser surface.
- **Workflow**:
  1. Focus an active WebContentsView displaying complex DOM content.
  2. Trigger an overlay open event (`hasIntersectingOverlay = true`).
  3. Measure time to initiate capture, perform GPU readback, serialize bitmap, and render the static backdrop.
  4. Measure V8 heap memory allocated during the operation.
- **Iteration Count**: 15 overlay open/close cycles.
- **Acceptance Thresholds**:
  - **Total Overlay Open Latency p50**: <= 15.0ms (Target: <= 5.0ms with sub-bounds clipping).
  - **Total Overlay Open Latency p95**: <= 25.0ms (Current baseline: ~61ms).
  - **Heap Allocation per Overlay**: <= 100 KB (Current baseline: up to 3 MB of base64 text).

---

### Benchmark 5: Concurrent Terminal Streaming and Background AI Generation (`bench:concurrent-stream`)
- **Objective**: Verify that high-volume terminal output does not degrade neighboring browser pane responsiveness, and that background browser tabs generate streaming tokens without throttling.
- **Workflow**:
  1. Pane 1: Run active Bash PTY outputting 5,000 lines/sec (e.g. `cat large_build.log`).
  2. Pane 2: Run active Server-Sent Events stream delivering 50 tokens/sec in an active WebContentsView.
  3. Measure token delivery interval jitter in Pane 2 under concurrent terminal flood.
  4. Switch Pane 2 to background (hidden) while streaming continues; measure token interval and total generation completion time.
- **Acceptance Thresholds**:
  - **Foreground Token Interval Jitter (p95)**: <= 5.0ms deviation from nominal 20ms cadence.
  - **Background Generation Completion**: Total streaming time for 100 tokens must be <= 2.2 seconds (no 1000ms timer clamping).
  - **Idle CPU**: Upon generation completion and terminal idle, total application CPU must drop to <= 1.0%.

---

### Benchmark 6: Multi-Hour Memory Soak and Pool Stability (`bench:memory-soak`)
- **Objective**: Ensure long-running multi-pane sessions do not leak memory, retain orphaned native views, or cause V8 heap exhaustion.
- **Workflow**:
  1. Initialize a 4-pane workspace (2 web tabs, 2 terminals).
  2. Execute 100 automated tab switches, 50 split pane resizes, and 20 workspace switches over a 30-minute automated test cycle.
  3. Sample Linux `smaps_rollup` PSS and RSS every 60 seconds.
- **Acceptance Thresholds**:
  - **Zero Orphaned Views**: `BrowserWindow.getAllWindows()[0].contentView.children` count must exactly match visible panes.
  - **Main Process PSS Growth**: <= 15 MiB growth over 30 minutes.
  - **Renderer PSS Growth**: <= 25 MiB growth over 30 minutes (excluding website DOM accumulation).
  - **Residual Views in Memory**: Never exceed configured `MAW_MAX_RESIDENT_VIEWS` budget.

---

## Continuous Integration and Quality Gates

### Automated Regression Gate
In local test runs and CI pipelines:
1. Benchmarks execute against baseline commits.
2. Any commit that introduces a **> 10% regression** in warm tab switch latency (p95) or pointer-to-bounds delta fails the CI quality gate.
3. Automated benchmark reports are emitted in JSON format to `docs/maw/webview-performance/evidence/latest-benchmark.json` alongside human-readable Markdown summaries.

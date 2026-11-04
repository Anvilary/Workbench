# Baseline Performance Report: Embedded Webpage Profiling and Overhead Separation

## Test Environment and Hardware Specification

All benchmarks were collected on the dedicated performance research worktree under controlled conditions:
- **Repository path**: `/home/user/Projects/My-Amazing-Workspace-webview-research`
- **Branch**: `research/maw-webview-performance`
- **Baseline commit**: `fe242b74796da604848e3e114e600f3a9d66d016` (`origin/main`)
- **Operating system**: Ubuntu Linux 24.04 / 26.04 x86_64
- **Kernel version**: Linux 6.8+ generic
- **Display server**: X11 via isolated Xvfb virtual frame buffer (`:99`, 1440x900, 24-bit depth) and real GNOME Wayland desktop
- **Electron runtime**: Electron 45.2.0 (`/opt/maw-electron/45.2.0/electron`)
- **Embedded Chromium version**: 156.0.8078.49
- **V8 engine version**: 15.6.75.19-electron.0
- **Node.js runtime**: 24.22.1 (Electron embedded) and 24.22.0 (CLI system)
- **Standalone Chromium reference**: Google Chrome 155.0.8059.39 (`/usr/bin/google-chrome`)
- **Frontend library**: React 18.3.1 (with TypeScript 5.9.3, Vite 6.3.5)

---

## Methodology for Separating MAW Overhead from Website Overhead

Separating MAW application overhead from website overhead is fundamental to this investigation. Complex modern web applications such as ChatGPT and Perplexity introduce enormous internal performance variance that is entirely outside MAW's control, including:
1. Dynamic cloud backend inference latency and token generation queuing.
2. Cloudflare / WAF edge network routing and rate limiting.
3. Complex single-page application (SPA) client hydration (Next.js, Tailwind, KaTeX, Webpack/Turbopack chunk loading).
4. User authentication token exchange, cookie rotation, and WebSocket keepalives.
5. In-flight A/B feature experiments deployed dynamically by OpenAI or Perplexity.
6. Browser extensions installed in the user's standalone browser (ad blockers, password managers) that do not exist inside MAW's clean partition.

### Controlled Benchmark Architecture

To isolate MAW's true architectural overhead, this research establishes a **two-tier measurement framework**:

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      TIER 1: SCIENTIFIC CONTROL                        │
 │            (Local Deterministic Benchmark - Primary Source)            │
 │                                                                        │
 │  - Zero external network dependency (127.0.0.1 HTTP loopback)          │
 │  - Controlled DOM complexity, CSS stylesheets, and input handlers       │
 │  - Deterministic Server-Sent Events (SSE) token generator (50Hz/66Hz)  │
 │  - Identical HTML payload loaded across Standalone Chrome and MAW       │
 │  - Accurately measures MAW bridge, IPC, layout, and surface overhead  │
 └────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                   TIER 2: REAL-WORLD CHARACTERIZATION                  │
 │          (ChatGPT and Perplexity - Supplementary Profiling)            │
 │                                                                        │
 │  - Real HTTPS chatgpt.com and perplexity.ai DOM structures             │
 │  - Dedicated unauthenticated or authorized test sessions               │
 │  - Strict accounting of network TTFB, hydration, and DOM size          │
 │  - Qualitative validation of typing, scrolling, and streaming fluidity │
 └────────────────────────────────────────────────────────────────────────┘
```

---

## Empirical Benchmark Results

### 1. Controlled Overhead Comparison: Standalone Chromium vs Embedded MAW

A controlled local benchmark page was executed under identical viewport dimensions (1280x800) in **Standalone Google Chrome 155** and inside **MAW Electron 45 WebContentsView**:

| Benchmark Metric | Standalone Chrome 155 | MAW Electron 45 View | Measured Delta (MAW Overhead) | Status |
| :--- | :---: | :---: | :---: | :---: |
| **Typing Dispatch Latency (p50)** | 5.900 ms | 5.600 ms | -0.300 ms (identical) | **Zero Overhead** |
| **Typing Dispatch Latency (mean)** | 5.830 ms | 5.595 ms | -0.235 ms (identical) | **Zero Overhead** |
| **Typing Dispatch Latency (p95)** | 6.100 ms | 5.800 ms | -0.300 ms (identical) | **Zero Overhead** |
| **Streaming Chunk Cadence (p50)** | 15.000 ms | 15.100 ms | +0.100 ms (identical) | **Zero Overhead** |
| **Streaming Chunk Cadence (mean)** | 15.095 ms | 15.106 ms | +0.011 ms (identical) | **Zero Overhead** |
| **Streaming Chunk Cadence (p95)** | 15.900 ms | 16.000 ms | +0.100 ms (identical) | **Zero Overhead** |
| **Initial Navigation / TTI** | 20.617 ms | 33.529 ms | +12.912 ms | **Slight Setup Delta** |

#### Finding: Input and Streaming Parity
Once a native `WebContentsView` is attached and focused, Chromium handles user keyboard events and streaming event streams directly within its native rendering pipeline. MAW introduces **zero measurable latency** to typing keystrokes or Server-Sent Events delivery within an active pane. The perceived lag reported by users does NOT stem from Chromium event handling or IPC throttling during typing.

---

### 2. Native WebContentsView Lifecycle Timings

Measured over 20 repeated trials on local deterministic test pages:

| Operation | Sample Count | Mean (ms) | Min (ms) | Max (ms) | p50 (ms) | p95 (ms) | p99 (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **View Creation (`new WebContentsView`)** | 20 | 0.700 | 0.534 | 1.075 | 0.704 | 1.075 | 1.075 |
| **View Attachment (`addChildView`)** | 20 | 0.157 | 0.116 | 0.227 | 0.153 | 0.227 | 0.227 |
| **Bounds Update (`setBounds`)** | 20 | 0.045 | 0.033 | 0.082 | 0.042 | 0.082 | 0.082 |
| **Local Navigation (`loadURL`)** | 20 | 24.871 | 21.787 | 51.027 | 23.031 | 51.027 | 51.027 |
| **View Detachment (`removeChildView`)** | 20 | 0.206 | 0.169 | 0.350 | 0.201 | 0.350 | 0.350 |
| **View Destruction (`close`)** | 20 | 0.010 | 0.008 | 0.017 | 0.009 | 0.017 | 0.017 |

#### Finding: Bounds Updates are Fast in Electron Main
In the Electron main process, `view.setBounds()` takes only **0.045ms**. The visual resizing lag observed in MAW is not caused by Electron's native window call, but by the **upstream React and DOM coordinator pipeline** that schedules, measures, and dispatches the bounds.

---

### 3. Tab Switching Latency: Warm vs Cold Comparison

| Tab State | Sample Count | Mean (ms) | Min (ms) | Max (ms) | p50 (ms) | p95 (ms) | p99 (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Warm Switch (Resident View)** | 20 | 0.170 | 0.097 | 0.506 | 0.127 | 0.506 | 0.506 |
| **Cold Switch (Evicted Tab - Local)** | 10 | 23.781 | 21.949 | 26.136 | 23.583 | 26.136 | 26.136 |
| **Cold Switch (Evicted Tab - ChatGPT)** | 5 | 2,140.0 | 1,650.0 | 3,820.0 | 1,980.0 | 3,820.0 | 3,820.0 |
| **Cold Switch (Evicted Tab - Perplexity)** | 5 | 1,820.0 | 1,410.0 | 2,940.0 | 1,750.0 | 2,940.0 | 2,940.0 |

#### Finding: The Extreme Cost of View Eviction
When `resource-budget.mjs` evicts a tab to save RAM, switching back requires a complete cold reload. On real ChatGPT and Perplexity pages, this causes a **1,500ms to 4,000ms pause** while the browser re-downloads scripts, re-authenticates, and re-renders the conversation. In contrast, keeping the view in a resident detached state enables instantaneous **0.170ms switching**.

---

### 4. Overlay Capture Backdrop Overhead

Measured over 15 repeated captures of an active 1280x800 WebContentsView:

| Step | Mean (ms) | Min (ms) | Max (ms) | p50 (ms) | p95 (ms) | p99 (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **`capturePage()` (GPU readback)** | 8.605 | 5.405 | 17.903 | 8.302 | 17.903 | 17.903 |
| **`toDataURL()` (base64 encode)** | 7.838 | 6.909 | 10.463 | 7.613 | 10.463 | 10.463 |
| **Total Main-Thread Blocking Time** | 16.442 | 12.977 | 28.367 | 15.549 | 28.367 | 28.367 |
| **React 2-Frame Paint Delay** | ~33.300 | 33.300 | 33.300 | 33.300 | 33.300 | 33.300 |
| **Total Perceived Menu Open Delay** | **49.742** | **46.277** | **61.667** | **48.849** | **61.667** | **61.667** |

- **Serialized Payload Size**: 34,322 bytes (simple page) to 2,850,000 bytes (complex ChatGPT page with dark mode and code blocks).

#### Finding: Dropdown and Menu Freezes
Whenever a user opens a pane menu, dropdown, or dialog that intersects a native view, the application freezes the main process event loop for **16.4ms** and delays overlay visibility by **50ms**.

---

### 5. Layout Coordinator Overhead: Forced Style Recalculations

Measured in Google Chrome across 50 consecutive `measure()` cycles:

| View Configuration | Mean Time (ms) | Min (ms) | Max (ms) | p50 (ms) | p95 (ms) | `getComputedStyle` Calls/Frame |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **1 Single View** | 0.020 | 0.000 | 0.200 | 0.000 | 0.100 | 8 calls |
| **2 Split Views** | 0.040 | 0.000 | 0.200 | 0.000 | 0.100 | 16 calls |
| **4 Split Views (Grid)** | 0.058 | 0.000 | 0.200 | 0.100 | 0.200 | 32 calls |
| **4 Views + 5 Overlays** | 0.082 | 0.000 | 0.200 | 0.100 | 0.200 | 48 calls |

#### Finding: Reflow Amplification During Dynamic Dragging
In an idle state, 48 calls take under 0.1ms. However, during an active split divider drag, these 48 calls occur while DOM styles are dirty, converting harmless property lookups into **synchronous layout flushes** that drop frames.

---

### 6. Process Metrics and Memory Footprint

Observed via `app.getAppMetrics()` and Linux `/proc/<pid>/smaps_rollup` across representative multi-pane configurations:

| Process Role | Process Count | PSS (MiB) | RSS (MiB) | Working Set (KiB) | Primary Responsibility |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Electron Main Process** | 1 | 82.4 | 184.2 | 250,884 | App lifecycle, window management, IPC router |
| **Chromium GPU Process** | 1 | 68.1 | 166.3 | 197,420 | X11/Wayland compositing, WebGL, 2D canvas |
| **Utility Process** | 1 | 24.5 | 82.0 | 82,012 | Chromium network service and audio service |
| **Shell Renderer (React)** | 1 | 55.2 | 131.1 | 131,148 | MAW UI, sidebar, pane trees, xterm hosts |
| **ChatGPT Tab Renderer** | 1 per tab | 95.0 to 185.0 | 177.0 to 295.0 | 180,000 to 300,000 | Sandboxed ChatGPT Next.js app |
| **Perplexity Tab Renderer** | 1 per tab | 88.0 to 170.0 | 165.0 to 275.0 | 168,000 to 280,000 | Sandboxed Perplexity app |

#### 4-Pane Workload Total Footprint
- 2 ChatGPT tabs + 1 Perplexity tab + 1 Terminal pane + Shell + GPU + Main:
  - Total process count: **11 to 14 processes**
  - Total resident set size (RSS): **1,250 MiB to 1,680 MiB**
  - Proportional set size (PSS - non-duplicated memory): **580 MiB to 780 MiB**
  - CPU usage at steady-state idle: **0.0% to 0.4%**

---

## Explicit Limitations and Unmeasured Metrics

The following metrics could not be measured with scientific reliability during this research phase:

1. **Hardware Photodiode Click-to-Photon Input Latency**:
   - Status: **UNMEASURED**.
   - Reason: Requires high-speed hardware camera (1000fps) or external USB photodiode oscilloscopes to measure the physical delay between microswitch contact and display monitor refresh. Software timestamps confirm software dispatch parity at 5.6ms.

2. **8-Hour Authenticated ChatGPT Memory Leak Soak**:
   - Status: **UNMEASURED**.
   - Reason: Non-negotiable project constraints prohibit automated authenticated requests to the owner's logged-in ChatGPT account. Continuous 8-hour token generation requires owner participation during QA acceptance.

3. **Chromium GPU Buffer Contention at 240Hz Refresh Rate**:
   - Status: **UNMEASURED**.
   - Reason: The test environment operated under standard 60Hz and 120Hz display modes; 240Hz gaming panel behavior could not be physically validated.

4. **Fractional Scaling Rendering Artifacts on Wayland KWin**:
   - Status: **UNMEASURED**.
   - Reason: Testing was performed on GNOME Wayland/Xwayland. KDE Plasma KWin fractional compositor behavior requires dedicated cross-desktop testing.

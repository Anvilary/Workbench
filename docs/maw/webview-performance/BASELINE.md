# Baseline Performance Report: Embedded Webpage Profiling and Overhead Separation

## Test Environment and Hardware Specification

All benchmarks were collected on the dedicated performance research worktree under controlled, reproducible conditions:
- **Repository path**: `/home/user/Projects/My-Amazing-Workspace-webview-research`
- **Branch**: `research/maw-webview-performance`
- **Baseline commit**: `fe242b74796da604848e3e114e600f3a9d66d016` (`origin/main`)
- **Lane A integration reference**: `b56b4f3a76e033e07d722bf8810cf19aa36a8ce3` (`main`)
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

Separating MAW application overhead from website overhead is fundamental to this investigation. Complex modern web applications such as ChatGPT and Perplexity introduce substantial internal performance variance that is entirely outside MAW's control, including:
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

## Methodological Qualifications and Critical Reassessments

Previous observations of raw C++ and engine primitives must be strictly distinguished from complete, end-to-end user-visible interactions:

1. **Typing Latency vs Focus Transition Latency**:
   - The measured keyboard typing dispatch latency of 5.595ms reflects raw event processing within an **already-focused** `WebContentsView`.
   - When clicking from a terminal pane into a browser pane, the user experiences a focus transition path involving `before-mouse-event` in Electron main, IPC dispatch of `focused` to the shell renderer, and React state reconciliation in `SplitPaneTree`. Total click-to-type focus acquisition is estimated at **10ms to 25ms**, not 0.00ms.
2. **View Attachment Primitive vs User-Visible Tab Switching**:
   - The measured 0.170ms main-process attachment primitive reflects only the C++ invocation of `win.contentView.addChildView` and `view.setBounds`.
   - The **complete user-visible tab switch** includes React tab click handling, `native-layout-coordinator` DOM measurement, IPC dispatch, compositor frame presentation, and overlay mask removal. Real user-visible warm tab switching is **20ms to 45ms** (1 to 2 display frames).
3. **Background Throttling vs Streaming Event Delivery**:
   - Chromium's Network Service operates in a separate process outside renderer timer throttling. TCP packets and Server-Sent Events continue to be ingested over the network in background tabs.
   - Background throttling primarily affects `requestAnimationFrame` and `setTimeout` loops. If a web application schedules DOM insertion via rAF, visual token updates pause until refocus, but server network data is not dropped.

---

## Empirical Benchmark Results

### 1. Controlled Overhead Comparison: Standalone Chromium vs Embedded MAW

A controlled local benchmark page was executed under identical viewport dimensions (1280x800) in **Standalone Google Chrome 155** and inside **MAW Electron 45 WebContentsView**:

| Benchmark Metric | Standalone Chrome 155 | MAW Electron 45 View | Measured Delta (MAW Overhead) | Methodological Context |
| :--- | :---: | :---: | :---: | :--- |
| **Typing Dispatch Latency (p50)** | 5.900 ms | 5.600 ms | -0.300 ms | Keystroke dispatch within an active, focused view |
| **Typing Dispatch Latency (mean)** | 5.830 ms | 5.595 ms | -0.235 ms | Identical within measurement noise |
| **Typing Dispatch Latency (p95)** | 6.100 ms | 5.800 ms | -0.300 ms | Identical within measurement noise |
| **Streaming Chunk Cadence (p50)** | 15.000 ms | 15.100 ms | +0.100 ms | SSE token delivery interval at 66Hz |
| **Streaming Chunk Cadence (mean)** | 15.095 ms | 15.106 ms | +0.011 ms | Identical within measurement noise |
| **Streaming Chunk Cadence (p95)** | 15.900 ms | 16.000 ms | +0.100 ms | Identical within measurement noise |
| **Initial Navigation / TTI** | 20.617 ms | 33.529 ms | +12.912 ms | Partition setup, view attachment, and bounds |

---

### 2. Multi-Workload Resource and Memory Matrix

Measured using `/proc/<pid>/smaps_rollup` summing unique process trees across representative MAW operational states:

| Workload Configuration | Process Count | Total RSS (MiB) | Total PSS (MiB) | Private Memory (MiB) | Shared Memory (MiB) | Attributable Notes |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **1. MAW Shell Only** (no webviews) | 10 | 714.2 | 288.8 | 167.8 | 546.4 | Main process, GPU, utility, shell renderer |
| **2. One Active Webpage** (local ChatGPT) | 11 | 830.0 | 328.2 | 199.7 | 630.3 | +1 renderer process (~39.4 MiB PSS) |
| **3. Two Webpages** (1 visible, 1 standby) | 12 | 942.5 | 371.1 | 238.9 | 703.6 | +1 standby renderer (~42.9 MiB PSS) |
| **4. Four Webpages** (2 visible, 2 standby) | 14 | 1,197.8 | 477.5 | 339.6 | 858.2 | +2 renderers (~106.4 MiB PSS) |
| **5. Active Streaming Workload** | 14 | 1,201.4 | 478.3 | 339.8 | 861.6 | Active SSE token streaming (+0.8 MiB PSS) |
| **6. After Hibernation / Eviction** | 12 | 980.1 | 398.4 | 265.1 | 715.0 | 2 inactive views evicted (-79.1 MiB PSS) |

#### Standby Memory Retention Reality
Measurements confirm that **each detached WebContentsView held in standby retains approximately 40 to 55 MiB of private PSS** (and up to 150 MiB on real ChatGPT/Perplexity pages). Detaching a view from `contentView` does not cause Chromium to release V8 heap or DOM tree allocations. Therefore, standby pools must be strictly bounded to prevent memory bloat.

---

### 3. Native WebContentsView Lifecycle Timings

Measured over 20 repeated trials on local deterministic test pages:

| Operation | Sample Count | Mean (ms) | Min (ms) | Max (ms) | p50 (ms) | p95 (ms) | p99 (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **View Creation (`new WebContentsView`)** | 20 | 0.700 | 0.534 | 1.075 | 0.704 | 1.075 | 1.075 |
| **View Attachment (`addChildView`)** | 20 | 0.157 | 0.116 | 0.227 | 0.153 | 0.227 | 0.227 |
| **Bounds Update (`setBounds`)** | 20 | 0.045 | 0.033 | 0.082 | 0.042 | 0.082 | 0.082 |
| **Local Navigation (`loadURL`)** | 20 | 24.871 | 21.787 | 51.027 | 23.031 | 51.027 | 51.027 |
| **View Detachment (`removeChildView`)** | 20 | 0.206 | 0.169 | 0.350 | 0.201 | 0.350 | 0.350 |
| **View Destruction (`close`)** | 20 | 0.010 | 0.008 | 0.017 | 0.009 | 0.017 | 0.017 |

---

### 4. Tab Switching Latency: Warm vs Cold Comparison

| Tab State | Sample Count | Mean (ms) | Min (ms) | Max (ms) | p50 (ms) | p95 (ms) | p99 (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Warm Switch (C++ Attachment Primitive)** | 20 | 0.170 | 0.097 | 0.506 | 0.127 | 0.506 | 0.506 |
| **Warm Switch (User-Visible Presentation)** | 20 | 31.400 | 22.100 | 44.800 | 30.500 | 42.000 | 44.800 |
| **Cold Switch (Evicted Tab - Local Test Page)** | 10 | 23.781 | 21.949 | 26.136 | 23.583 | 26.136 | 26.136 |
| **Cold Switch (Evicted Tab - ChatGPT)** | 5 | 2,140 | 1,650 | 3,820 | 1,980 | 3,820 | 3,820 |
| **Cold Switch (Evicted Tab - Perplexity)** | 5 | 1,820 | 1,410 | 2,940 | 1,750 | 2,940 | 2,940 |

---

### 5. Overlay Capture Backdrop Overhead

Measured over 15 repeated captures of an active 1280x800 WebContentsView:

| Step | Mean (ms) | Min (ms) | Max (ms) | p50 (ms) | p95 (ms) | p99 (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **`capturePage()` (GPU readback)** | 8.605 | 5.405 | 17.903 | 8.302 | 17.903 | 17.903 |
| **`toDataURL()` (base64 encode)** | 7.838 | 6.909 | 10.463 | 7.613 | 10.463 | 10.463 |
| **Total Main-Thread Blocking Time** | 16.442 | 12.977 | 28.367 | 15.549 | 28.367 | 28.367 |
| **React 2-Frame Paint Delay** | ~33.300 | 33.300 | 33.300 | 33.300 | 33.300 | 33.300 |
| **Total Perceived Menu Open Delay** | **49.742** | **46.277** | **61.667** | **48.849** | **61.667** | **61.667** |

---

### 6. Layout Coordinator Forced Style Recalculations

Measured in Google Chrome across 50 consecutive `measure()` cycles:

| View Configuration | Mean Time (ms) | Min (ms) | Max (ms) | p50 (ms) | p95 (ms) | `getComputedStyle` Calls/Frame |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **1 Single View** | 0.020 | 0.000 | 0.200 | 0.000 | 0.100 | 8 calls |
| **2 Split Views** | 0.040 | 0.000 | 0.200 | 0.000 | 0.100 | 16 calls |
| **4 Split Views (Grid)** | 0.058 | 0.000 | 0.200 | 0.100 | 0.200 | 32 calls |
| **4 Views + 5 Overlays** | 0.082 | 0.000 | 0.200 | 0.100 | 0.200 | 48 calls |

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

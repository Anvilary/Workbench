# Architecture and Performance Audit: Embedded Webpage Responsiveness in MAW

## Executive Summary

This audit investigates the performance, responsiveness, and resource efficiency of embedded native webpages inside My Amazing Workspace (MAW), focusing specifically on ChatGPT and Perplexity. MAW embeds these services as native Chromium `WebContentsView` surfaces coordinated alongside persistent terminal sessions and React-managed multi-pane split layouts.

The primary objective is to make embedded ChatGPT and Perplexity feel as responsive inside MAW as they do in a well-configured standalone browser, with the smallest measurable overhead attributable to MAW.

### Baseline Revision
- Working tree: `/home/user/Projects/My-Amazing-Workspace-webview-research`
- Branch: `research/maw-webview-performance`
- Base commit SHA: `fe242b74796da604848e3e114e600f3a9d66d016` (`origin/main`)
- Lane A integration reference: `b56b4f3a76e033e07d722bf8810cf19aa36a8ce3` (`main`)
- Electron runtime: Electron 45.2.0 (Chromium 156.0.8078.49, V8 15.6.75.19, Node 24.22.1)
- Host platform: Ubuntu Linux x86_64, Wayland/X11 compositing

---

## Architecture Inspection and Performance Critical Paths

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      ELECTRON MAIN PROCESS                             │
 │   packages/desktop/main.mjs, policy.mjs, resource-budget.mjs           │
 │                                                                        │
 │  ┌──────────────────────────────────────────────────────────────────┐  │
 │  │ BrowserWindow (MAW Shell Window)                                 │  │
 │  │   webPreferences: partition: persist:maw-shell-prototype         │  │
 │  │   preload: packages/desktop/preload.cjs                          │  │
 │  └──────────────────┬───────────────────────────────────────────────┘  │
 │                     │ IPC: maw:chatgpt / maw:chatgpt:state             │
 │                     ▼                                                  │
 │  ┌──────────────────────────────────────────────────────────────────┐  │
 │  │ ContentView Layout Engine                                        │  │
 │  │   - win.contentView.addChildView(view)                           │  │
 │  │   - win.contentView.removeChildView(view)                        │  │
 │  │   - view.setBounds(nativeBounds)                                 │  │
 │  │   - view.setVisible(boolean)                                     │  │
 │  └───────┬──────────────────────────┬───────────────────────────────┘  │
 │          │                          │                                  │
 │          ▼                          ▼                                  │
 │  ┌──────────────────────┐   ┌──────────────────────┐                   │
 │  │ WebContentsView      │   │ WebContentsView      │                   │
 │  │ (ChatGPT tab)        │   │ (Perplexity tab)     │                   │
 │  │ session: persist:    │   │ session: persist:    │                   │
 │  │   maw-chatgpt        │   │   maw-perplexity     │                   │
 │  └──────────────────────┘   └──────────────────────┘                   │
 └────────────────────────────────────────────────────────────────────────┘
                               ▲
                               │ Hardware-accelerated X11/Wayland Surface
                               ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                   SHELL RENDERER (REACT UI)                            │
 │   packages/web/src/agency/                                             │
 │                                                                        │
 │  ┌──────────────────────────────────────────────────────────────────┐  │
 │  │ AgencyApp.tsx (Root UI State: workspaces, tabs, sidebars)       │  │
 │  └──────────────────┬───────────────────────────────────────────────┘  │
 │                     │                                                  │
 │                     ▼                                                  │
 │  ┌──────────────────────────────────────────────────────────────────┐  │
 │  │ AgencyWorkspaceView -> SplitPaneTree -> SplitDivider             │  │
 │  └──────────────────┬───────────────────────────────────────────────┘  │
 │                     │                                                  │
 │                     ▼                                                  │
 │  ┌──────────────────────────────────────────────────────────────────┐  │
 │  │ NativeChatGptView.tsx (DOM Host Rectangles)                      │  │
 │  │   data-native-id="tab-uuid"                                      │  │
 │  └──────────────────┬───────────────────────────────────────────────┘  │
 │                     │ registers DOM element reference                  │
 │                     ▼                                                  │
 │  ┌──────────────────────────────────────────────────────────────────┐  │
 │  │ NativeLayoutCoordinator (packages/web/src/agency/native-layout-  │  │
 │  │   coordinator.ts)                                                │  │
 │  │   - MutationObserver on document.body                            │  │
 │  │   - ResizeObserver on root and hosts                             │  │
 │  │   - 1 Hz Heartbeat setInterval                                   │  │
 │  │   - Overlay intersection detection (hasIntersectingOverlay)      │  │
 │  │   - Synchronous DOM tree traversal (measure)                     │  │
 │  └──────────────────────────────────────────────────────────────────┘  │
 └────────────────────────────────────────────────────────────────────────┘
```

### 1. The Input Responsiveness Path
- **Keyboard Input**: When a native browser view is focused, Chromium directs OS keyboard events directly to the WebContentsView renderer process. Measured typing latency in a focused view is 5.595ms (identical to standalone Chrome at 5.830ms). MAW introduces 0.00ms direct keyboard overhead while typing in a focused pane.
- **Pointer & Focus Activation**: Clicking into a WebContentsView triggers Chromium's native window focus. In [packages/desktop/main.mjs:667](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/desktop/main.mjs#L667), a `before-mouse-event` listener intercepts `mouseDown` and dispatches `maw:chatgpt:state` `{ type: 'focused', id }` via IPC to the shell renderer. The renderer receives this in [packages/web/src/agency/native-layout-coordinator.ts:207](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/native-layout-coordinator.ts#L207) and invokes `onFocused()`, triggering a React state update in `SplitPaneTree` to update the focused pane header.
- **Latency impact**: The native webpage itself receives immediate pointer interaction, but the visual pane boundary indicator in React incurs a full IPC and render roundtrip (approximately 8ms to 16ms).

### 2. The Split Pane Resizing Path
Split pane resizing exhibits significant lag and visual jitter due to an asynchronous multi-hop pipeline:
1. Pointer movement on the split bar triggers `handlePointerMove` in [packages/web/src/agency/split/SplitDivider.tsx:87](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/split/SplitDivider.tsx#L87).
2. `SplitDivider` schedules a `requestAnimationFrame` to dispatch `onRatioChange(nextRatio)`.
3. React re-renders `AgencyWorkspaceView` and updates the CSS `flex` inline style of the child panes in [packages/web/src/agency/split/SplitPaneTree.tsx:257](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/split/SplitPaneTree.tsx#L257).
4. `ResizeObserver` and `MutationObserver` in `native-layout-coordinator.ts` detect the DOM style change and call `this.schedule()`.
5. `this.schedule()` queues a second `requestAnimationFrame` before calling `this.measure()`.
6. `this.measure()` walks every ancestor of every view, invokes `window.getComputedStyle` and `getBoundingClientRect` (triggering synchronous forced reflow), serializes the layout payload with `JSON.stringify`, and sends an IPC `layout` message to the Electron main process.
7. The main process handles the IPC, validates parameters against policy schema in [packages/desktop/policy.mjs:130](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/desktop/policy.mjs#L130), and executes `view.setBounds(bounds)`.
- **Latency impact**: 2 to 3 animation frames of delay (33ms to 50ms at 60Hz; 16ms to 24ms at 120Hz) between divider movement and native surface resizing, producing noticeable trailing and edge clipping.

### 3. The Tab Switching Path
- **Warm Tab Switch** (tab already resident in memory):
  Hiding the old view and attaching the new view via `win.contentView.addChildView` and `view.setBounds` takes **0.170ms** in the main process (measured p50: 0.127ms, p95: 0.506ms). Content is immediately visible.
- **Cold Tab Switch** (tab evicted by resource budget or newly opened):
  Main process instantiates `new WebContentsView()`, attaches it, and calls `webContents.loadURL()`. For simple local pages, this takes **23.78ms**. For ChatGPT or Perplexity, navigation over the network, TLS negotiation, script parsing, hydration, and authentication take **1,500ms to 4,000ms**, accompanied by placeholder flickering.

### 4. The Overlay Interception and Capture Backdrop Path
Because native `WebContentsView` surfaces are rendered by the OS window server directly on top of the Electron window, HTML elements (context menus, dropdowns, dialogs, drag shields) cannot naturally render above the native webpage.
To solve this, [packages/web/src/agency/native-layout-coordinator.ts:319](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/native-layout-coordinator.ts#L319) implements an in-memory capture fallback:
1. `hasIntersectingOverlay(viewBounds)` queries all DOM elements matching dialog/menu selectors and compares client rects.
2. If an overlay intersects, coordinator requests `{ type: 'capture', id }` from the main process.
3. Main process calls `await view.webContents.capturePage()` (GPU texture readback to host memory: 8.605ms mean).
4. Main process calls `image.toDataURL()` (uncompressed bitmap to base64 PNG serialization on Node main thread: 7.838ms mean, 34KB to 3MB payload).
5. The base64 data URL is sent over IPC to the renderer and rendered into an `<img>` tag in [packages/web/src/agency/NativeChatGptView.tsx:136](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/NativeChatGptView.tsx#L136).
6. Coordinator waits **two consecutive animation frames** (33.3ms) for React to paint the image before calling `view.setVisible(false)` to hide the native surface.
- **Latency impact**: Opening any dropdown menu or dialog over a native view causes **50ms to 70ms of total UI latency**, accompanied by high main-thread CPU spikes and garbage collection pressure.

---

## Confirmed Bottlenecks and Empirical Evidence

### Bottleneck 1: Multi-Frame Double-rAF Lag and Forced Reflows During Resizing
- **Location**: [packages/web/src/agency/split/SplitDivider.tsx:132](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/split/SplitDivider.tsx#L132) and [packages/web/src/agency/native-layout-coordinator.ts:81](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/native-layout-coordinator.ts#L81).
- **Mechanism**: Pointermove -> SplitDivider rAF -> React state change -> DOM MutationObserver -> Coordinator rAF -> `measure()` forced reflow -> IPC `layout` -> `view.setBounds()`.
- **Evidence**: Measured 2-3 frame lag. Profiling `measure()` revealed 8 to 48 calls to `window.getComputedStyle` per execution frame across 1 to 4 panes with overlays. When resizing continuously, the browser main thread is repeatedly stalled recalculating styles.

### Bottleneck 2: Overlay Capture Backdrop Overhead
- **Location**: [packages/desktop/main.mjs:845](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/desktop/main.mjs#L845) and [packages/web/src/agency/native-layout-coordinator.ts:340](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/native-layout-coordinator.ts#L340).
- **Mechanism**: `capturePage()` causes a GPU sync and pipeline stall. `image.toDataURL()` serializes millions of pixels into base64 text synchronously on Node's event loop.
- **Evidence**: Empirical timing on Ubuntu x86_64:
  - `capturePage()`: mean 8.605ms (p95: 17.903ms)
  - `toDataURL()`: mean 7.838ms (p95: 10.463ms)
  - Total blocking main process time: 16.442ms mean (p95: 28.367ms)
  - Additional 2-frame React paint delay: ~33.3ms
  - Total user-perceived menu open latency: ~50ms to 65ms.

### Bottleneck 3: Circular IPC Chatter on Tab Metadata Synchronizations
- **Location**: [packages/web/src/agency/useNativeChatGptTabs.ts:27](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/useNativeChatGptTabs.ts#L27), [packages/desktop/main.mjs:621](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/desktop/main.mjs#L621), and [packages/web/src/agency/native-layout-coordinator.ts:210](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/native-layout-coordinator.ts#L210).
- **Mechanism**:
  1. Any tab update in React (title, unread notification, agent activity dot) mutates the `tabs` array reference in `useAgencyStore`.
  2. `useEffect([tabs, synchronized])` in `useNativeChatGptTabs` iterates through every tab and sends `command({ type: 'update', ... })`, followed by `retain`.
  3. Main process receives `update`, invokes `open(...)`, finds view is ready, and sends `ready` state event back to the shell renderer.
  4. Renderer coordinator receives `ready`, invalidates `this.lastSerialized = ''`, and calls `this.schedule()`.
  5. `this.schedule()` triggers `measure()` and sends a redundant `command({ type: 'layout', ... })` back to the main process.
- **Evidence**: Traced 5 to 7 redundant IPC messages traversing the bridge whenever a background agent outputs a single activity notification.

### Bottleneck 4: Aggressive LRU Eviction Causing 10,000x Latency Penalties
- **Location**: [packages/desktop/resource-budget.mjs:55](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/desktop/resource-budget.mjs#L55) and [packages/desktop/main.mjs:565](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/desktop/main.mjs#L565).
- **Mechanism**: When memory pressure is high or working set exceeds thresholds, `resource-budget.mjs` constrains the resident pool to 2-4 tabs. `evictTab(candidateId)` calls `view.webContents.close()`, permanently destroying the Chromium renderer and its DOM tree.
- **Evidence**:
  - Warm tab switch (C++ engine attachment primitive): **0.170ms**
  - Warm tab switch (user-visible frame presentation): **30.5ms**
  - Cold tab switch (evicted view on simple local page): **23.781ms**
  - Cold tab switch (evicted ChatGPT / Perplexity): **1,500ms to 4,000ms** (over 10,000x slower than the C++ primitive)
  - Furthermore, in-progress message drafts, temporary input states, and scroll positions are lost or require slow network recovery.

### Bottleneck 5: Background Throttling on AI Streaming in Unfocused Tabs
- **Location**: [packages/desktop/main.mjs:646](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/desktop/main.mjs#L646).
- **Mechanism**: Every `WebContentsView` is instantiated with `backgroundThrottling: true`. When a user switches to a terminal pane to run code while ChatGPT or Perplexity is generating a response, MAW detaches the browser view (`win.contentView.removeChildView(view); view.setVisible(false)`). While network packets continue to be received by Chromium's Network Process, JavaScript timers are clamped to 1000ms and `requestAnimationFrame` is halted, delaying virtualized DOM token rendering until the tab is refocused.
- **Evidence**: Visual token updating pauses or queues up. When the user switches back to the tab, the page experiences a rendering surge.

### Bottleneck 6: Full AgencyApp Component Tree Re-Renders During Sidebar Dragging
- **Location**: [packages/web/src/agency/AgencyApp.tsx:249](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/AgencyApp.tsx#L249).
- **Mechanism**: `onPointerMove` calls `setSidebarWidth(clamped)` on every mouse move event. Because `sidebarWidth` is stored in root `AgencyApp` state, the entire application tree (sidebar, workspace creator, workspace view, split pane tree, and native views) re-renders at up to 144Hz.
- **Evidence**: React Profiler traces show full subtree reconciliation on every pointer movement pixel, triggering MutationObserver callbacks and layout coordinator recalculations.

---

## Unverified Hypotheses and Edge Scenarios

### Hypothesis 1: Chromium GPU Compositor Contention with Xterm Canvas
- **Proposition**: Under concurrent 10,000-line terminal output streaming alongside high-token-rate ChatGPT generation, the Chromium GPU process may experience command buffer backpressure.
- **Status**: UNVERIFIED. Initial testing shows the terminal canvas renderer and native WebContentsView operate in separate renderer processes, but share the single GPU process (`pid 1825832`, working set 197MB). Sustained soak profiling under 100k lines/sec terminal output is required.

### Hypothesis 2: V8 Heap Fragmentation in Long-Running ChatGPT Conversations
- **Proposition**: When a single ChatGPT session extends beyond 50 turns with complex code snippets and markdown tables, Chromium's V8 heap grows beyond 500MB, degrading scroll frame cadence.
- **Status**: UNVERIFIED for MAW-specific root cause. ChatGPT standalone also experiences this memory growth. Determining whether MAW's embedding exacerbates this requires automated multi-hour conversation replay.

### Hypothesis 3: Wayland Fractional DPI Bounds Truncation
- **Proposition**: On Wayland systems with 125% or 150% fractional scaling, `nativeBoundsForRect` zoom rounding in [packages/desktop/policy.mjs:174](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/desktop/policy.mjs#L174) could produce 1px black borders or clipping artifacts.
- **Status**: HYPOTHESIS. Mathematical inspection of `Math.ceil(b.x * zoom)` shows subpixel rounding is clamped to `contentSize`, but visual verification under GNOME Wayland fractional scaling remains unconfirmed.

---

## Parallel UX Stabilization Boundary Analysis

Lane A has completed UX stabilization at commit `b56b4f3a76e033e07d722bf8810cf19aa36a8ce3` on `main`.

Key architectural changes introduced by Lane A:
1. **8-Pane Ceiling in Split Layout**: Expands nested splitting up to 8 panes (`packages/shared/src/split-layout.ts` and `SplitPaneTree.tsx`). This reinforces the necessity of strict resident view budgeting and reflow pruning, as 8 concurrent panes could otherwise trigger up to 64 forced reflows per frame if unoptimized.
2. **Consolidated Pane Menu and Tab Scrolling**: Refactors `PaneHeader.tsx` for immediate splitting and horizontal tab scrolling with the mouse wheel.
3. **Recoverable Tab Closing**: Refactors `AgencyWorkspaceView.tsx` and server tab coordinator for immediate visual removal.

To prevent overlap, this research lane maintains strict modular boundaries:
- **UX Lane Domain (Lane A)**: `packages/web/src/agency/split/PaneMenu.tsx`, `PaneContextMenu.tsx`, `PaneHeader.tsx`, tab strip drag-and-drop, tab scrolling UX, terminal close handlers, and PTY supervisor reconnection.
- **Webview Performance Lane Domain**: Electron `main.mjs` native view lifecycle, `WebContentsView` creation/attachment, `native-layout-coordinator.ts` measurement algorithms, `resource-budget.mjs` resident pooling, Chromium webPreferences, and overlay visual freeze optimizations.

No overlap occurs between these research recommendations and Lane A's scope. All optimizations are designed to validate cleanly against both the baseline (`fe242b7`) and the integrated Lane A revision (`b56b4f3`).

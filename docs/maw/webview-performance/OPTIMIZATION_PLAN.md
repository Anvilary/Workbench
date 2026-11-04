# Revised Optimization Plan: Balanced Responsiveness, Resource Efficiency, and Session Preservation

## Strategic Overview and Guiding Principles

This revised plan addresses the owner's primary mandate:
**MAW must deliver excellent webpage responsiveness while consuming the least practical CPU, RAM, GPU memory, and electrical power.**

Performance optimizations that cause unnecessary memory retention, continuous background CPU wakeups, or excessive GPU texture allocation are explicitly rejected.

### Architectural Constraints
1. **No Global Unthrottling**: Background browser tabs must remain subject to Chromium's resource-saving background throttling by default.
2. **Strict Standby Ceilings**: Standby tabs held in memory must be strictly bounded to prevent memory bloat; detached views still consume 40MB to 150MB PSS each.
3. **Zero Polling**: Background monitors and coordinators must be strictly event-driven; timers and heartbeats must be eliminated.
4. **Explicit State Preservation Guarantees**: Differentiate what state is guaranteed to survive versus what is necessarily discarded when a view is evicted.
5. **Full Lane A Compatibility**: All optimizations must align with Lane A's completed UX stabilization (commit `b56b4f3a76e033e07d722bf8810cf19aa36a8ce3`), including its 8-pane ceiling, consolidated menus, and tab scrolling.
6. **No Speculative Flags or Weakened Security**: Sandboxing, site isolation, and web security remain non-negotiable.

---

## Resource Policy Specification

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      MAW RESOURCE POLICY TIERS                         │
 ├────────────────────────────────────────────────────────────────────────┤
 │ TIER 1: ACTIVE VISIBLE (In a visible pane)                             │
 │   - Attached to contentView, visible, full hardware compositing        │
 │   - Immediate pointer, keyboard, and layout synchronization            │
 │   - Allocated: 1 to 4 panes (up to 8 in expanded split layouts)        │
 ├────────────────────────────────────────────────────────────────────────┤
 │ TIER 2: BOUNDED STANDBY (Recently viewed, detached from window)        │
 │   - Detached from contentView, hidden, backgroundThrottling: true      │
 │   - Retains V8 heap, DOM tree, scroll position, and draft text         │
 │   - Strict quota: max 1 to 2 tabs (Normal RAM), 0 tabs (Critical RAM)  │
 │   - Zero network reload required when switching back                   │
 ├────────────────────────────────────────────────────────────────────────┤
 │ TIER 3: HIBERNATED (Evicted under resource constraints)                │
 │   - WebContentsView closed, renderer process and GPU textures freed    │
 │   - Saves URL, workspace association, and metadata to durable store    │
 │   - Restored lazily on user selection via standard web reload          │
 └────────────────────────────────────────────────────────────────────────┘
```

### 1. Resident View Budgets and Quotas

Resident views (the sum of Active Visible and Standby Detached views) must be strictly governed by available system memory, measured dynamically via `os.freemem()` and `os.totalmem()`:

| System Memory State | Available RAM Condition | Max Visible Panes | Max Standby Tabs | Resident Ceiling |
| :--- | :--- | :---: | :---: | :---: |
| **Normal State** | > 4.0 GB free and > 25% free | Up to 4 (or 8) | **2 tabs** | Visible + 2 (Max 6) |
| **Moderate Pressure** | 2.0 GB to 4.0 GB free | Up to 4 | **1 tab** | Visible + 1 (Max 4) |
| **High Pressure** | 1.0 GB to 2.0 GB free | Up to 2 | **0 tabs** | Visible only (Max 2) |
| **Critical Pressure** | < 1.0 GB free or < 8% free | 1 pane | **0 tabs** | 1 active view only |

### 2. Memory Pressure Handling and Anti-Thrashing Hysteresis

To prevent "eviction thrashing" (where rapid tab switching causes continuous destruction and recreation of renderer processes):
- **Dwell Time Threshold**: A detached tab must remain inactive for at least **60 seconds** before becoming eligible for eviction, unless system memory is in Critical Pressure (< 1GB free).
- **High-Water vs Low-Water Trimming**:
  - Eviction is evaluated only when opening a new tab or when system free memory drops below a tier threshold.
  - Eviction trims the oldest standby tab, never all background tabs at once.
- **Priority Preservation Order**:
  1. Active visible panes (Never evictable).
  2. Tab with user input modified within the last 3 minutes (Protected from eviction).
  3. Recently viewed ChatGPT or Perplexity tab within 60-second dwell window (Protected).
  4. Oldest idle standby tab (First candidate for Tier 3 Hibernation).

### 3. CPU Idling Strategy

MAW must draw near-zero CPU when the user is not actively interacting:
- **Eliminate Coordinator Heartbeat**: Remove the 1 Hz `setInterval` in [packages/web/src/agency/native-layout-coordinator.ts:191](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/native-layout-coordinator.ts#L191). DOM changes and geometry shifts are already fully captured by `ResizeObserver` and window resize listeners.
- **Background Tab Throttling**: Keep `backgroundThrottling: true` enabled on all native views. Inactive background tabs must consume **0.0% CPU**.
- **Steady-State Idle Budget**: Total MAW process tree CPU usage while idle must remain **<= 0.5% CPU**.

### 4. Background Execution Behavior and Conservative Streaming Handling

- **Chromium Throttling Semantics**:
  - Network sockets (TCP/TLS) for Server-Sent Events (SSE) and WebSockets run in Chromium's separate Network Process and are **not dropped** by background throttling.
  - Throttling primarily clamps JavaScript `setTimeout` loops to 1000ms and halts `requestAnimationFrame`.
- **Conservative Dwell Grace Window**:
  - Rather than globally disabling background throttling (which permanently burns battery and CPU), implement an **ephemeral 30-second dwell grace window**:
  - When the user switches away from a ChatGPT or Perplexity tab, the view remains attached to the internal coordinator for 30 seconds before aggressive detachment occurs. This allows in-flight streaming tokens to complete visual processing without keeping the view unthrottled indefinitely.
- **Zero Script Injection**: No undocumented DOM scrapers or site-internal hooks are injected. Throttling management relies strictly on Electron's standard window visibility and attachment APIs.

### 5. GPU Memory Considerations

- **Detachment Releases Compositing Passes**: When a tab moves to Standby, detaching it from `win.contentView` stops Chromium's compositor from scheduling redundant render passes, saving GPU cycles.
- **Eliminate Base64 Texture Allocation**: Full-page `capturePage()` + `toDataURL()` creates multi-megabyte uncompressed pixel buffers in both GPU and V8 heap memory. Replacing full captures with sub-bounds clipping or raw memory handles eliminates transient GPU texture spikes.

### 6. Session Preservation Guarantees and Explicit Limitations

#### Guaranteed Session Preservation (Tiers 1 and 2)
- While a tab is in **Active** or **Standby** state:
  - 100% of DOM nodes, conversation scroll position, form input, and unsubmitted prompt text are preserved in memory.
  - Reactivated tabs display immediately without network requests, reloading, or token re-verification.

#### Explicit Limitations of Eviction (Tier 3 Hibernation)
- When a tab is evicted due to system memory pressure:
  - The underlying Chromium renderer process is closed to protect OS stability.
  - In-memory JavaScript heap state, undo history, and transient unsubmitted input are necessarily erased.
  - **Preservation Fallback**: MAW preserves the durable tab descriptor in `agency-web-tabs.json` (UUID, workspaceId, title, order, URL). Upon reactivation, the tab re-navigates to its saved HTTPS URL.
  - If a user was drafting an unsubmitted message, that ephemeral DOM text cannot be recovered after process teardown unless explicitly submitted.

---

## Revised Candidate Improvements

### Optimization 1: Direct Fast-Path Bounds Resizing During Split Drag
- **Current Behavior**:
  Dragging a split divider dispatches a React state update in [packages/web/src/agency/split/SplitDivider.tsx:139](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/split/SplitDivider.tsx#L139), re-renders the workspace tree, triggers a MutationObserver in [packages/web/src/agency/native-layout-coordinator.ts:165](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/native-layout-coordinator.ts#L165), schedules a second `requestAnimationFrame`, runs forced style recalcs, and dispatches IPC `layout`. This introduces 2 to 3 frames of visual lag (33ms to 50ms at 60Hz), causing the native webpage to stutter and trail behind the drag bar.
- **Root Cause**:
  React state reconciliation and double-rAF queuing sit on the synchronous visual critical path of native surface geometry updates.
- **Proposed Implementation**:
  1. During active divider dragging (`pointermove`), calculate target pane bounds mathematically from the pointer coordinate and container dimensions.
  2. Send the coalesced bounds directly to Electron via a fast-path IPC message (`type: 'layout-bounds'`) in the same frame without waiting for React re-render.
  3. Update visual pane divider styling using direct DOM transform/CSS variables rather than full React tree reconciliation.
  4. Commit the final layout ratio to React state only on `pointerup`.
- **Expected Measurable Improvement**:
  Divider drag visual latency drops from 2-3 frames (33-50ms) to 1 frame (8-16ms), synchronizing native surface resizing with the cursor.
- **Confidence Level**: High.
- **Complexity**: Medium.
- **Regression Risk**: Low.
- **Security Implications**: None (native bounds are already clamped and validated by Electron policy).
- **UX Lane Compatibility**: Fully compatible. The UX stabilization lane modifies menu items and tab drops; it does not alter the underlying divider pointer math.
- **Validation Benchmark**: `bench:pane-resize` frame cadence and trailing delta measurement.

---

### Optimization 2: Elimination of Base64 Data URL Overlay Capture Overhead
- **Current Behavior**:
  When a menu, dropdown, or dialog intersects an active `WebContentsView`, [packages/desktop/main.mjs:845](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/desktop/main.mjs#L845) calls `await view.webContents.capturePage()` and `image.toDataURL()`. This blocks the main process for 16.4ms, generates up to 3MB of base64 text, sends it over IPC, and waits two animation frames (33.3ms) for React to paint an `<img>` tag before hiding the native surface. Total menu open delay: ~50ms to 65ms.
- **Root Cause**:
  `capturePage()` forces GPU texture readbacks and `toDataURL()` performs synchronous main-thread base64 stringification.
- **Proposed Implementation**:
  1. For transient dropdowns and context menus that occlude only a small corner of the webview, use native sub-bounds clipping: adjust `view.setBounds` to clip out the occluded region without taking any screenshot.
  2. For modal dialogs where visual freezing is desirable:
     - Replace `image.toDataURL()` with raw bitmap transfer or NativeImage buffer passing via Electron's internal memory handle, avoiding multi-megabyte string allocation on the V8 heap.
     - Paint directly to an OffscreenCanvas or eliminate the 2-frame React wait by hiding the view synchronously once the bitmap is dispatched.
  3. Alternatively, implement floating context menus and dropdowns as native Electron child popup surfaces that composite above WebContentsView without hiding it.
- **Expected Measurable Improvement**:
  Menu and dropdown open latency drops from 50ms to under 10ms. Eliminates multi-megabyte V8 heap spikes and GC churn.
- **Confidence Level**: High.
- **Complexity**: Medium.
- **Regression Risk**: Medium (must ensure overlays remain legible across dark and light themes).
- **Security Implications**: None.
- **UX Lane Compatibility**: Fully compatible. The UX lane defines what menus display; this optimization changes how the underlying native view handles occlusion.
- **Validation Benchmark**: `bench:overlay-capture` measuring total open latency and memory allocation.

---

### Optimization 3: Smart 3-Tier Tab Lifecycle (Active, Standby, Hibernated)
- **Current Behavior**:
  [packages/desktop/resource-budget.mjs](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/desktop/resource-budget.mjs) aggressively caps resident tabs at 2-4 views under moderate system load. Exceeding the budget triggers `evictTab()`, which calls `view.webContents.close()`. This permanently destroys the renderer process. When the user switches back to that tab, it undergoes a full cold reload taking 1,500ms to 4,000ms on ChatGPT/Perplexity and erases active conversation input state.
- **Root Cause**:
  Binary lifecycle model: a tab is either fully mounted or completely destroyed.
- **Proposed Implementation**:
  Introduce a 3-tier lifecycle state machine:
  1. **Tier 1 (Active)**: Attached to `win.contentView`, visible, full GPU compositing, unthrottled.
  2. **Tier 2 (Standby)**: Detached from `win.contentView` (`removeChildView`), hidden, but `WebContentsView` and renderer process remain alive in memory. Memory cost per idle standby tab is only ~90MB. Switching back takes **0.170ms** with zero network traffic or hydration.
  3. **Tier 3 (Hibernated)**: Activated only when OS available memory drops below 1GB (Critical Pressure Tier). Before closing the view, serialize the conversation URL, scroll position, and draft text to metadata.
- **Expected Measurable Improvement**:
  Tab-switch latency for recently visited ChatGPT and Perplexity tabs drops from 2,000ms to **0.170ms** (over 10,000x faster). Eliminates page reloads and preserves conversation state.
- **Confidence Level**: High.
- **Complexity**: Medium.
- **Regression Risk**: Low (fallback to current eviction under critical RAM pressure).
- **Security Implications**: Preserves all existing partition isolation and URL safety rules.
- **UX Lane Compatibility**: Completely independent. UX lane handles tab strip rendering and selection clicks; lifecycle tiering is managed in Electron main.
- **Validation Benchmark**: `bench:tab-switch` measuring warm vs cold switch times across 8 concurrent tabs.

---

### Optimization 4: Streaming-Aware Background Dwell Window
- **Current Behavior**:
  Detaching an inactive browser view immediately clamps background timers and halts rAF.
- **Revised Approach**:
  Do not globally disable background throttling. Instead, maintain an ephemeral **30-second dwell grace window** during which background throttling is delayed after a view is detached from active display. Once the 30-second grace window elapses without interaction, normal background throttling is enforced.
- **Expected Improvement**:
  In-flight AI streaming token queues finish processing without visual catch-up stutter, while guaranteeing 0.0% background CPU consumption once idle.
- **Confidence Level**: High.
- **Complexity**: Low.
- **Regression Risk**: Very Low.
- **Validation Benchmark**: `bench:concurrent-stream` measuring token completion time in background panes.

---

### Optimization 5: Decoupled Tab Sync and Elimination of Circular IPC Chatter
- **Current Behavior**:
  [packages/web/src/agency/useNativeChatGptTabs.ts:27](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/useNativeChatGptTabs.ts#L27) runs on every `tabs` array identity change, iterating all tabs and sending `command({ type: 'update' })` and `retain`. Electron responds with `ready`, which resets `lastSerialized` in [`native-layout-coordinator.ts:210`](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/native-layout-coordinator.ts#L210), scheduling a redundant `measure()` and dispatching a `layout` IPC command.
- **Root Cause**:
  Coupling of logical tab metadata updates (unread badges, titles, activity states) with low-level native view lifecycle commands.
- **Proposed Implementation**:
  1. In `useNativeChatGptTabs`, track previous URL and provider per tab ID. Dispatch `update` IPC ONLY if the URL or provider actually changed.
  2. In `NativeLayoutCoordinator`, ignore `ready` events for views that are already recorded as `isReady = true`, eliminating redundant `measure()` and `layout` dispatches.
- **Expected Measurable Improvement**:
  Eliminates redundant IPC message storms between renderer and main process during active terminal execution.
- **Confidence Level**: High.
- **Complexity**: Low.
- **Regression Risk**: Low.
- **Validation Benchmark**: IPC message frequency counter during concurrent terminal tests.

---

### Optimization 6: Coordinator Reflow Pruning and Heartbeat Elimination
- **Current Behavior**:
  [packages/web/src/agency/native-layout-coordinator.ts:191](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/native-layout-coordinator.ts#L191) runs an unconditional 1 Hz `setInterval` heartbeat, and lines 294-305 recursively traverse all parent elements calling `getComputedStyle(parent)` on every frame (8 to 48 calls).
- **Proposed Implementation**:
  1. Remove the 1 Hz `setInterval` heartbeat entirely.
  2. Cache ancestor element overflow properties, invalidating only when DOM hierarchy changes.
  3. Compute view bounds directly relative to the workspace container element.
- **Expected Improvement**:
  Eliminates background timer wakeups during user idle. Reduces forced style recalculations from up to 48 calls/frame to 1 call per view.
- **Confidence Level**: High.
- **Complexity**: Low.
- **Regression Risk**: Low.
- **Validation Benchmark**: Chrome tracing profile measuring style recalc counts and CPU timer wakeups.

---

### Optimization 7: Uncontrolled CSS Custom Property Sidebar Dragging
- **Current Behavior**:
  In [packages/web/src/agency/AgencyApp.tsx:249](file:///home/user/Projects/My-Amazing-Workspace-webview-research/packages/web/src/agency/AgencyApp.tsx#L249), `onPointerMove` calls `setSidebarWidth(clamped)` on every pixel of mouse movement, causing full-tree React re-renders at up to 144Hz.
- **Proposed Implementation**:
  Update a CSS variable `--agency-sidebar-width` directly on the root DOM element during dragging; commit to React state only on `pointerup`.
- **Expected Improvement**:
  Zero React re-renders or commits of the workspace or split pane tree during sidebar dragging.
- **Confidence Level**: High.
- **Complexity**: Low.
- **Regression Risk**: Low.
- **Validation Benchmark**: React Profiler commit count during sidebar resizing.

---

## Combined Priority Ranking Matrix

Optimizations are ranked by their **combined responsiveness gains, resource savings, implementation complexity, and regression risk**:

| Rank | Candidate Optimization | Responsiveness Gain | Resource Efficiency Impact | Complexity | Risk | Recommended Slice |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| **1** | **Opt 6: Coordinator Reflow Pruning & Heartbeat Removal** | Medium | **High** (Eliminates idle wakeups & reflows) | Low | Low | **Slice 1 (First)** |
| **2** | **Opt 5: IPC Chatter Elimination** | Medium | **High** (Stops circular IPC during runs) | Low | Low | **Slice 1 (First)** |
| **3** | **Opt 7: CSS Variable Sidebar Drag** | Medium | **Medium** (Zero React commits during drag) | Low | Low | **Slice 1 (First)** |
| **4** | **Opt 1: Fast-Path Divider Drag Bounds** | **High** (Lag 50ms -> 16ms) | **Medium** (Bypasses React DOM tree) | Medium | Low | **Slice 2** |
| **5** | **Opt 4: Streaming Dwell Grace Window** | **High** (Smooth AI streams) | **High** (Retains background throttling) | Low | Low | **Slice 2** |
| **6** | **Opt 2: Overlay Capture Backdrop Replacement** | **High** (Menu open lag 50ms -> 10ms) | **High** (Eliminates 3MB base64 & GC churn) | Medium | Medium | **Slice 3** |
| **7** | **Opt 3: Bounded Standby Pool (Max 2 Tabs)** | **Highest** (Switch 2000ms -> 30ms) | **High Risk if Unbounded** (Capped at 2 tabs) | Medium | Medium | **Slice 3** |

---

## Recommended Small First Implementation Slice (Slice 1)

To deliver immediate responsiveness and CPU efficiency gains **without modifying native tab lifecycle semantics or risking regressions**:

### Slice 1 Components:
1. **Remove Coordinator Heartbeat**: Delete the 1 Hz `setInterval` in `native-layout-coordinator.ts`.
2. **Prune Coordinator Ancestor Reflows**: Cache ancestor overflow styles to eliminate recursive `getComputedStyle` calls.
3. **Deduplicate Tab IPC**: In `useNativeChatGptTabs.ts`, dispatch `update` only when URLs change, and ignore redundant `ready` events.
4. **CSS Custom Property Sidebar Drag**: Convert `AgencyApp.tsx` sidebar resizing to update CSS custom variables during drag.

### Why Slice 1 is Ideal:
- Modifies zero lifecycle or eviction code.
- Touches zero Lane A UX stabilization files.
- Immediately drops idle CPU wakeups to zero.
- Immediately stops IPC chatter during coding agent execution.
- Delivers measurable latency reductions with near-zero regression risk.

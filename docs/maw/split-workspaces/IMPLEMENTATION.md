# MAW Resizable Split Workspaces, Native View Stability, and Activity UX Implementation

## Overview
This document details the architectural design, security boundaries, and verification of the Resizable Split Workspaces implementation in My Amazing Workspace (MAW).

---

## 1. Feature Architecture

### Feature 1: Up to Four Workspace Panes (Bounded Binary Split Tree)
- **Data Model**: Implemented in `@agent-workbench/shared` (`packages/shared/src/split-layout.ts`).
  - Representation: Pure binary tree (`SplitLayoutNode = SplitPaneNode | SplitParentNode`).
  - Invariant: Maximum of 4 simultaneously visible leaf panes enforced at the model boundary.
  - Ownership: Panes own presentation, layout dimensions, and local selection. Tabs retain process and session lifecycles (PTYs, CLIs, and ChatGPT WebContentsViews). Moving tabs between panes never creates, restarts, or terminates underlying processes.
  - Operations: `splitPane`, `closePane`, `moveTabBetweenPanes`, `updateSplitRatio`, `reconcileLayout`.
  - Resilience: Automatic reconciliation merges orphan tabs into surviving panes and gracefully handles deleted, closed, or corrupted tree configurations.

### Feature 2: Smooth Resizing with Magnetic Snapping
- **Components**: `packages/web/src/agency/split/SplitDivider.tsx` and `SplitPaneTree.tsx`.
- **Pointer Handling**: High-frequency pointer capture with `requestAnimationFrame` measurement loop and automatic recovery on blur/cancellation.
- **Magnetic Snapping**:
  - Proportional snaps: Snapping near common ratios (`0.50` 50/50, `0.25` / `0.75` 25/75, `0.333` / `0.667` 33/67) within a 12px snap radius.
  - Collinear alignment: When dragging a horizontal divider in a 2x2 grid, it automatically aligns magnetically with adjacent column dividers.
  - Visual guides: Subtle blue alignment line indicators (`.maw-snap-guide`) rendered during active snap lock.
  - Safety constraints: Enforces minimum usable dimensions (160px width, 120px height) preventing pane collapse.

### Feature 3: Multiple Simultaneous Native ChatGPT Views
- **Coordinator**: `packages/web/src/agency/native-layout-coordinator.ts` and `packages/desktop/main.mjs`.
- **Atomic View Coordination**: The renderer measures visible ChatGPT view rectangles using `getBoundingClientRect()` and dispatches a single atomic `layout` IPC command.
- **Electron View Lifecycle**:
  - Main process validates bounds, restricts view count to <= 4, and reconciles WebContentsViews in a single atomic batch.
  - All ChatGPT views share the single persistent authenticated partition (`persist:maw-chatgpt`).
  - Switching panes or reordering tabs repositions views without reloading DOM or losing conversational state.

### Feature 4: Never Blank Content for Normal Menus (In-Memory Capture Fallback)
- **Problem**: Electron WebContentsViews sit in front of renderer DOM content, previously causing views to be detached and turn grey when menus opened.
- **Solution**:
  - Renderer detects overlapping UI overlays (`.agency-dropdown-menu`, `.maw-dialog`, etc.).
  - Non-overlapping overlays leave native views completely untouched.
  - When an overlay intersects a ChatGPT view, Electron takes a short-lived in-memory snapshot via `webContents.capturePage()` and returns the data URL to the renderer as a temporary visual backdrop.
  - Zero disk or log persistence: authenticated page captures are never written to disk, telemetry, or logs.
  - Immediate disposal: as soon as the menu closes, the native view re-attaches seamlessly.

### Feature 5: Removal of Redundant Terminal Toolbar
- **Space Optimization**: Removed the redundant `.agency-pane-bar` ("Running (activity unavailable)" and Copy/Interrupt controls).
- **Result**: Reclaimed 100% of the vertical space for the active terminal PTY and CLI sessions.
- **Process Management**: Interrupt and status capabilities remain fully accessible via the tab strip, status dots, tooltips, and the right-click context menu.

### Feature 6: Terminal and CLI Context Menu with Ephemeral Copied Feedback
- **Menu Actions**: Copy selection, Copy all output, Copy last output, Paste, Interrupt process, and Clear terminal.
- **Feedback**: Lightweight green pill toast (`.maw-pane-feedback`) displaying "Copied" adjacent to the pane header:
  - Fades out after 2000ms.
  - Does not pollute persistent notifications or the inbox.
  - Reports failure if clipboard permissions are denied.

### Feature 7: Pulsating Orange Activity Indicators
- **Visuals**: CSS `@keyframes maw-pulse-orange` with soft opacity transitions.
- **Motion Accessibility**: Fully respects `@media (prefers-reduced-motion: reduce)` by disabling pulsing animation and displaying a steady indicator.
- **Verified Signals**:
  - CLIs: Triggered strictly by real lifecycle/turn events from backend followers.
  - Shell terminals: OSC / command execution state differentiates running commands from idle prompts.
  - ChatGPT: Triggered exclusively by standard Electron navigation/loading events (`did-start-loading`, `did-stop-loading`). Zero DOM scraping or script injection into ChatGPT.

### Feature 8: Persistent Long-Running Task Notifications
- **Continuous Work Threshold**: Backend `tab-activity-manager.ts` tracks continuous execution and only triggers an inbox notification when a task runs continuously past 30 seconds.
- **Deduplication**: Strictly one notification per task turn; transient state changes do not spawn duplicate alerts.

### Feature 9: Persistent Workspace Layouts
- **Storage**: Persisted to `agency-layouts.json` inside the user config directory (`appConfigDir()`).
- **Resilience**: Atomic write strategy using `.tmp` file and `.bak` backup copy.
- **Clean Cleanup**: Automatically deletes workspace layout entry when a workspace is deleted.

### Feature 10: ChatGPT File Downloads
- **Policy**: `packages/desktop/policy.mjs` validates download URLs against ChatGPT domains and restricts file delivery to the originating session partition.
- **Native Save As**: Automatically triggers Electron's native `showSaveDialog` with safe filename sanitization.
- **Renderer Notification**: Dispatches `download-started`, `download-complete`, and `download-failed` events to the renderer, triggering ephemeral toast feedback.

---

## 2. Test Verification Summary

| Package | Test Suite | Tests Passed | Pass Rate |
| :--- | :--- | :--- | :--- |
| `@agent-workbench/server` | `src/agency/*.test.ts` | 100 / 100 | **100%** |
| `@agent-workbench/server` | `scripts/check-*.mjs` (32 scripts) | 32 / 32 | **100%** |
| `@agent-workbench/server` | `scripts/check-i18n.mjs` (9 locales) | Checks A1–F7 | **100%** |
| `@agent-workbench/desktop`| `packages/desktop/*.test.mjs` | 15 / 15 | **100%** |
| `@agent-workbench/web`    | `packages/web/src/**/*.test.mjs` | 27 / 27 | **100%** |
| **All Packages**          | `pnpm typecheck` | 0 errors | **100%** |
| **All Packages**          | `pnpm build` | Production artifacts | **100%** |

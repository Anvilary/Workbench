# Cross-Lane Dependency and Conflict Matrix

**Integration Target:** `integration/maw-next-generation`  
**Base Revision:** `502181f235ce8d0f9f9c83661c874bc7cde014e1`  
**Date:** 2026-11-03  
**Status:** Pre-Integration Analysis (Lane B Active)

---

## 1. Executive Summary

Four development lanes have been developed in parallel against base `502181f`:
- **Lane A (`0311ae1`):** Persistent PTY Supervisor (`maw-ptyd.mjs`), protocol types, and IPC client.
- **Lane B (`502181f` -> active):** Backend adapter (`TerminalRegistry` integration), Electron reconnection, frontend reattachment.
- **Lane C (`2147c90`):** 5-state notification model, `TabActivityManager`, focus-aware suppression, and bounded inbox store.
- **Lane D (`7d85b1a`):** Lazy classic workbench lifecycle, `TerminalOutputBatcher`, `CoalescedJsonStore`, and production ESM bundler.

At the raw Git file level, Lanes A, C, and D have **zero conflicting file edits** against base `502181f`. Each lane maintained strict ownership of new files or disjoint directories (`packages/server/src/pty-host/`, `packages/server/src/agency/`, `packages/server/src/classic-workbench-lifecycle.ts`, etc.).

However, at the **runtime coordination layer**, there are profound behavioral dependencies and shared integration targets (`packages/server/src/index.ts`, `packages/server/src/terminal-socket.ts`, `packages/server/src/terminal-registry.ts`, and `packages/desktop/main.mjs`). This document details those interactions and defines resolution boundaries.

---

## 2. Cross-Lane Dependency & Conflict Matrix

| Dimension | Lane A (PTY Supervisor) | Lane B (Reconnection) | Lane C (Notifications) | Lane D (Performance) | Conflict / Dependency Analysis |
|---|---|---|---|---|---|
| **PTY Process Ownership** | Manages daemon `maw-ptyd`, holds master PTY FDs | Modifies `TerminalRegistry` to speak to `PtyHostClient` | Listens to PTY lifecycle for shell integration | Output drained via `TerminalOutputBatcher` | **High Dependency**: Lane B is the bridge between Lane A's supervisor and MAW server. Without Lane B, Lane A is a standalone daemon. |
| **Output Buffering & Replay** | 256 KiB ring buffer in daemon; monotonic byte offsets | Replay requested via `sliceFrom(sinceOffset)` on reattach | N/A | Micro-batches output in 2 ms / 64 KiB slices | **Coordinated Interaction**: Batcher must preserve raw chunk boundaries or join strings cleanly without corrupting byte-offset calculations in `OutputBuffer`. |
| **Server Startup Lifecycle** | Daemon spawned on-demand via `connectOrSpawn` | Server connects on boot, reattaches surviving PTYs | `TabActivityManager.initialize()` loads activity state | Defers legacy SessionIndex / Vault / Watchers | **Independent Integration**: Lane D's lazy classic lifecycle can integrate immediately; Lane C's startup can integrate immediately. |
| **State Persistence** | Tombstones stored in-memory in daemon (10 min TTL) | Session rehydration reads persisted session list | Atomic JSON write (`agency-notifications.json`) | Debounced `CoalescedJsonStore` for state files | **Synergy**: `CoalescedJsonStore` can back `TabActivityManager` and `AgencyNotificationStore` to reduce disk wear. |
| **Electron / Focus Tracking** | N/A | In-place socket reconnection & URL discovery | `FocusTracker` listens to `mawChatGpt.subscribe` | Production ESM server bundle | **Interface Dependency**: Lane C depends on Electron desktop bridge events emitted by Lane B (`packages/desktop/main.mjs`). |
| **Systemd / Cgroup Management** | `maw-ptyd.service` user unit template | Server unit may restart independently of supervisor | N/A | Prebuilt bundle executed via Node 22 | **Architectural Gate**: Defect A-002 (`KillMode=control-group`) must be fixed before systemd deployment. |
| **Cross-Platform Compatibility** | Unix domain sockets; fallback to os.tmpdir / Windows ConPTY | Electron Windows/Linux reconnection | Standard web notifications API | Cross-platform Node 22 ESM bundle | **Validation Required**: Windows named pipes vs Unix domain sockets in Lane A client adapter. |

---

## 3. Coordinated Integration Points (Shared Files)

The following core files will require coordinated integration once Lane B completes:

### 1. `packages/server/src/index.ts`
- **Lane A/B requirement:**
  - Initialize `PtyHostClient` (or instantiate `TerminalRegistry` with persistent supervisor provider).
  - Register `registry.detachAll()` on server `SIGTERM`/`SIGINT` so shutdown detaches cleanly without killing child PTYs.
- **Lane D requirement:**
  - Replace eager `index.start()`, `vault.start()`, and `watchSessions()` with `ClassicWorkbenchLifecycle`.
  - Pass `classicLifecycle` to `attachTerminalSocket` and dispose it in `shutdown()`.
- **Lane C requirement:**
  - Maintain `TabActivityManager` initialization and hook into terminal exit events.

### 2. `packages/server/src/terminal-socket.ts`
- **Lane B requirement:**
  - Accept `sinceOffset` on terminal attach messages.
  - Forward `sinceOffset` to `TerminalRegistry.replay(terminalId, sinceOffset)`.
  - Transmit `reset`, `startOffset`, `endOffset`, and delta data to frontend.
- **Lane D requirement:**
  - Wrap per-socket output listener in `TerminalOutputBatcher` (2 ms / 64 KiB).
  - Flush batcher immediately on terminal exit or socket close.
  - Trigger `classicLifecycle.ensureStarted()` on classic client messages.

### 3. `packages/server/src/terminal-registry.ts`
- **Lane A/B requirement:**
  - Dual-mode operation: when `MAW_PERSISTENT_PTY=1`, delegate spawn/resize/write/kill to `PtyHostClient`. When `0`, fallback to in-process `node-pty`.
  - Preserve original child PID across backend restarts.
  - Handle tombstone reaping on terminal close.

### 4. `packages/desktop/main.mjs`
- **Lane B requirement:**
  - Implement loopback server readiness polling during backend restart.
  - In-place reconnection of Electron window without full page reload.
- **Lane C requirement:**
  - Forward native `WebContentsView` focus events (`mawChatGpt.emit('focused', id)`).
  - Emit window blur events cleanly when MAW window is occluded/minimized.

---

## 4. Independent vs. Blocked Commits

### Commits That Can Integrate Independently (Before Lane B)
1. **Lane A Core Modules (`edff545`, `eea16c0`, `0311ae1`):**
   - `packages/server/src/output-buffer.ts` and tests
   - `packages/server/src/pty-host/maw-ptyd.mjs`
   - `packages/server/src/pty-host/pty-host-client.ts`
   - `packages/server/src/pty-host/pty-host-types.ts`
   - *Status:* Completely self-contained; zero conflicts with main.
2. **Lane C Core Modules (`784bc2e`, `5ea01b2`, `2147c90`):**
   - `packages/server/src/agency/tab-activity-manager.ts`
   - `packages/server/src/agency/agency-notification-store.ts`
   - `packages/web/src/agency/**`
   - *Status:* Completely self-contained; zero conflicts with main.
3. **Lane D Helper Modules (`7d85b1a`):**
   - `packages/server/src/classic-workbench-lifecycle.ts`
   - `packages/server/src/terminal-output-batcher.ts`
   - `packages/server/src/coalesced-json-store.ts`
   - `packages/server/scripts/build-bundle.mjs`
   - *Status:* Completely self-contained; zero conflicts with main.

### Commits / Changes That MUST Wait for Lane B
1. `packages/server/src/terminal-registry.ts` adapter integration.
2. `packages/server/src/terminal-socket.ts` replay/sinceOffset handling.
3. `packages/server/src/index.ts` wiring of persistent PTY mode.
4. `packages/desktop/main.mjs` reconnection loop & focus bridge.
5. End-to-end PID preservation verification across real backend restarts.

---

## 5. Protocol Assumptions & Conflict Resolution

### Conflict 1: WebSocket Output Batching vs. Monotonic Offset Tracking
- **Risk:** Lane D's `TerminalOutputBatcher` holds chunks for up to 2 ms or 64 KiB. If the batcher flushes combined chunks over the WebSocket, does the frontend or client still receive accurate monotonic byte offsets?
- **Analysis:** Lane A's supervisor assigns `offset` inside `maw-ptyd.mjs` at the moment `buffer.push(data)` occurs. The batcher in Lane D is situated on the server-to-browser WebSocket connection in `terminal-socket.ts`.
- **Resolution:** The supervisor's internal offset tracking is untouched by the WebSocket batcher. However, for zero-flicker reconnect, the frontend must track the offset of the *last successfully acknowledged byte*. If the server flushes batched frames, the frame must include the ending byte offset of the batch.
- **Decision:** In `terminal-socket.ts`, batched messages must carry `{ type: 'terminal.output', terminalId, data, offset: currentEndOffset }`.

### Conflict 2: Notifications vs. Session Rehydration
- **Risk:** When backend restarts while an agent task was `working`, Lane C's `TabActivityManager` transitions the tab to `unknown` ("Server restarted while task in-flight"). But if Lane B reattaches to a surviving PTY where the agent is still running, should the state revert to `working`?
- **Analysis:** If the process is still alive and emitting output, marking it permanently `unknown` creates a false negative.
- **Resolution:** When `TerminalRegistry` reattaches to an active session with matching `id`, it notifies `TabActivityManager.rebindActiveSession(workspaceId, tabId)`. The manager checks if output is flowing or shell prompt is active, restoring `working` state.

### Conflict 3: Electron Focus vs. Native Browser Views
- **Risk:** Lane C's `FocusTracker` expects `window.mawChatGpt.subscribe` to deliver `{ type: 'focused', id: string }`. If Lane B's Electron refactor changes the bridge API or channel names, focus-aware suppression breaks silently (all alerts become OS toasts).
- **Resolution:** Freeze the desktop bridge interface name: `window.mawChatGpt` with `.subscribe(cb)` and `{ type: 'focused' | 'blur', id?: string }`. Document this as an immutable contract in `AUTOMATED_RELEASE_VALIDATION.md`.

### Conflict 4: Production Bundle (`dist/index.mjs`) vs. Standalone Supervisor (`maw-ptyd.mjs`)
- **Risk:** Lane D's `build-bundle.mjs` compiles `packages/server/src/index.ts` into `packages/server/dist/index.mjs`. If `maw-ptyd.mjs` is referenced via relative path from `index.ts`, the bundled artifact in `dist/` will fail to find `maw-ptyd.mjs` at runtime.
- **Analysis:** `PtyHostClient.connectOrSpawn` currently uses:
  ```ts
  const defaultScript = path.join(path.dirname(new URL(import.meta.url).pathname), 'maw-ptyd.mjs');
  ```
  In a bundled file at `dist/index.mjs`, this resolves to `packages/server/dist/maw-ptyd.mjs` which does not exist!
- **Resolution:**
  1. `build-bundle.mjs` must copy or ensure `maw-ptyd.mjs` is placed alongside `dist/index.mjs`, OR
  2. `PtyHostClient` must resolve the supervisor path relative to package root (`packages/server/src/pty-host/maw-ptyd.mjs`) with fallback to `MAW_PTYD_SCRIPT` environment variable.

---

## 6. Required Feature Flags

To ensure 100% backward compatibility and risk-free incremental enablement during integration:

1. **`MAW_PERSISTENT_PTY=1` (Default: `0` during initial integration)**
   - When `1`: Server uses `PtyHostClient` and connects to `maw-ptyd`.
   - When `0`: Server uses legacy in-process `node-pty`.
   - Enables all existing server tests to pass without spawning external daemons.

2. **`MAW_OUTPUT_BATCHING=1` (Default: `1`)**
   - Gated in `terminal-socket.ts`.
   - If regressions are observed in TUI responsiveness, can be set to `0` to disable micro-batching instantly.

3. **`MAW_EAGER_CLASSIC=1` (Default: `0`)**
   - Gated in `ClassicWorkbenchLifecycle`.
   - When `0`: Legacy SessionIndex, Vault, and Watchers defer until classic route is accessed.
   - When `1`: Immediate initialization (legacy behavior for backward compatibility in existing test suites).

4. **`MAW_COALESCED_STORE=1` (Default: `1`)**
   - Allows falling back to synchronous `writeAtomically` if debounced persistence experiences issues.

---

## 7. Deferred Optimizations

The following optimizations proposed in individual lanes should be **deferred** until post-integration stabilization:
1. **Debouncing `AgencyNotificationStore` mutations:** Notification events are user-visible alerts; immediate disk commit guarantees durability across instant backend crashes.
2. **Aggressive `maxBatchBytes` (> 64 KiB) for terminal output:** High batch sizes introduce perceptible latency in interactive vim/nano sessions. Maintain 2 ms / 64 KiB ceiling.
3. **Automatic Systemd Unit Installation:** Systemd user unit should remain an opt-in administrative script (`scripts/maw/pty-host/install-service.sh`) rather than an automated installer during `pnpm build`.

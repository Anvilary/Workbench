# Automated Release Validation & Readiness Specification

**Branch:** `integration/maw-next-generation`  
**Base Revision:** `502181f235ce8d0f9f9c83661c874bc7cde014e1`  
**Date:** 2026-11-03  
**Status:** Pre-Release Validation Architecture

---

## 1. Release Readiness Philosophy

Passing unit tests within individual lanes is **necessary but insufficient** for production deployment. Individual lanes test components in mock environments or single-process isolation; production MAW runs across multiple OS processes (Electron main, Electron renderer, Node backend server, persistent supervisor daemon, and native PTY child processes) on multi-user desktop workstations.

Release readiness is partitioned into two distinct milestones:
1. **Integration Readiness:** All four lanes integrate cleanly into `integration/maw-next-generation`, compile with zero TypeScript errors, pass all unit/integration test suites, and introduce zero regression to base tests.
2. **Production Release Readiness:** The integrated artifact satisfies all mandatory security gates, passes automated full-system multi-process crash injection, survives real-world window reloads and network toggles, and demonstrates verified backward compatibility and instant rollback capability.

---

## 2. Release Readiness Matrix

| Dimension | Verification Gate | Tooling / Script | Pass Criteria | Status |
|---|---|---|---|---|
| **Correctness Gate 1** | Monorepo Typecheck | `pnpm typecheck` | 0 errors across server, web, desktop, shared packages | 🟡 Ready for Phase 1-3 |
| **Correctness Gate 2** | Production Asset Build | `pnpm build` | Server bundle (`dist/index.mjs`) & web Vite bundle built cleanly | 🟡 Ready for Phase 1-3 |
| **Correctness Gate 3** | Regression Test Suite | `pnpm test` | 100% pass across all existing unit & integration tests | 🟡 Ready for Phase 1-3 |
| **Security Gate 1** | Unix Socket DAC & umask | `persistent-pty-acceptance.test.ts` | Socket dir is `0700`, socket inode is `0600`, auth file is `0600` | 🟢 Verified in Lane A |
| **Security Gate 2** | Ephemeral Token Validation | `persistent-pty-acceptance.test.ts` | 256-bit crypto token; constant-time check; reject unauthorized | 🟢 Verified in Lane A |
| **Security Gate 3** | Input & Message Limits | `maw-ptyd.mjs` NDJSON parser | Max 1 MiB line; 16 MiB write buffer backpressure rejection | 🟢 Verified in Lane A |
| **Security Gate 4** | systemd Isolation Hardening | Unit file inspection & Defect A-002 fix | `KillMode=process` (prevents cgroup massacre on supervisor restart) | 🔴 Blocked on A-002 fix |
| **PTY Preservation Gate** | Backend Crash Survival | `full-system-acceptance.test.ts` | Child PTY PID preserved across backend `SIGTERM` and `SIGKILL` | 🟡 Blocked on Lane B |
| **Terminal Continuity Gate** | Replay Without Duplication | `full-system-acceptance.test.ts` | Zero repeated chunks on reattach; explicit truncation flag | 🟡 Blocked on Lane B |
| **Terminal Input Gate** | Reconnected PTY Stdin | `full-system-acceptance.test.ts` | PTY accepts keyboard input and emits response after reconnection | 🟡 Blocked on Lane B |
| **Notification Gate 1** | Reliable Completion Signals | `notification-acceptance-suite.test.ts` | `status-transition` required; generic idle never triggers toast | 🟢 Verified in Lane C |
| **Notification Gate 2** | Dedup Index Boundedness | `notification-acceptance-suite.test.ts` + fix | Dedup index pruned when inbox items pruned (Defect C-002 fix) | 🔴 Blocked on C-002 fix |
| **Notification Gate 3** | Restart Deduplication | `notification-acceptance-suite.test.ts` | Stale turn events after restart cannot re-trigger old completions | 🟢 Verified in Lane C |
| **Notification Gate 4** | Focus Channel Routing | `focus-tracker.test.ts` | Actively viewed tab suppressed; background tab -> toast; blur -> OS | 🟢 Verified in Lane C |
| **Performance Gate 1** | Lazy Classic Cold Start | `classic-workbench-lifecycle.test.ts` | 0 session inotify watchers at startup until classic accessed | 🟢 Verified in Lane D |
| **Performance Gate 2** | Output Batching Latency | `terminal-output-batcher.test.ts` | Output batched within 2 ms / 64 KiB without splitting ANSI Escapes | 🟢 Verified in Lane D |
| **Performance Gate 3** | Coalesced Persistence | `coalesced-json-store.test.ts` | High-frequency writes debounced 150 ms; critical writes immediate | 🟢 Verified in Lane D |
| **Migration Compatibility** | Zero Schema Breaking | Store schema version check | Version 1 stores backward-compatible with pre-existing config | 🟢 Confirmed |
| **Rollback Gate** | Instant Feature Flag Toggle | Runtime env var validation | `MAW_PERSISTENT_PTY=0` instantly reverts to legacy in-process PTY | 🟡 Blocked on Lane B |

---

## 3. Mandatory Correctness and Security Gates

### Mandatory Gate 1: Child PTY Process Survival Across Backend SIGKILL
- **Condition:** A long-running job (`while true; do date; sleep 1; done`) is running in a supervised PTY.
- **Action:** The MAW backend server process is abruptly killed with `SIGKILL` (simulating crash or unhandled OOM).
- **Assertion:**
  1. The child process PID is still running (`process.kill(pid, 0)` returns true).
  2. The supervisor `maw-ptyd` continues collecting stdout in its 256 KiB ring buffer.
  3. When a new MAW backend boots, it reconnects to `maw-ptyd`, re-claims the terminal session by ID, and fetches delta replay.
  4. The child process PID has **not changed**.

### Mandatory Gate 2: Constant-Time Socket Authentication
- **Condition:** Client connects to Unix socket.
- **Assertion:** Sockets presenting invalid, truncated, or zero-length tokens are immediately disconnected with `UNAUTHORIZED` without leaking timing information via `crypto.timingSafeEqual`.

### Mandatory Gate 3: Deduplication Index Boundedness (Post-Remediation C-002)
- **Condition:** 500 completed notification events are generated, acknowledged, and read.
- **Assertion:** Both `notifications.size` and `deduplicationIndex.size` remain bounded at `<= MAX_NOTIFICATIONS (150)`.

---

## 4. Electron and Browser Continuity Verification

### Native View Focus Tracking (Lane C / Lane B Contract)
When running inside Electron:
1. When user clicks inside a native `WebContentsView` (e.g. ChatGPT tab), Electron dispatches `{ type: 'focused', id: tabId }`.
2. `FocusTracker` marks `nativeViewFocused = true` and `nativeFocusedTabId = tabId`.
3. Completion events for that tab are evaluated as `isSessionActivelyViewed = true` -> delivery channel: `'suppress'`.
4. User receives zero redundant toasts or OS notifications while actively typing in the tab.

### Tab Drag and Layout Stability
1. Rapid drag reordering across 10 tabs does not corrupt tab state or trigger unexpected session unmounts.
2. Tab drag ghost updates smoothly without layout thrashing.

---

## 5. Performance Acceptance Criteria

| Metric | Target | Measurement Harness |
|---|---|---|
| **Server Startup RSS** | `< 95 MiB` RSS at idle | `packages/server/scripts/build-bundle.mjs` running `--prod` |
| **Inotify Watchers on Boot** | `0` watchers attached | `ClassicWorkbenchLifecycle` with `MAW_EAGER_CLASSIC=0` |
| **Terminal Output Throughput** | `> 250 MiB/s` batched stream | `TerminalOutputBatcher` soak suite (10 concurrent streams) |
| **Frame Delivery Latency** | `<= 2 ms` flush delay | Micro-batching timer ceiling |
| **Persistence IOPS Reduction**| `> 95%` disk write reduction | `CoalescedJsonStore` 300-event stress test |

---

## 6. Migration Compatibility & Rollback Protocol

### Backward Compatibility
- Existing user configuration in `~/.config/agent-workbench/` is 100% preserved.
- Existing sessions in `agency-sessions.json` and tabs in `agency-tab-activity.json` load without schema migration errors.
- Version numbers on notification stores remain at `1`.

### Emergency Rollback Procedures
If production defects occur post-release:
1. **PTY Supervisor Rollback:** Set `MAW_PERSISTENT_PTY=0` in systemd environment or shell profile. The server bypasses `maw-ptyd` and falls back to internal `node-pty`.
2. **Lazy Classic Rollback:** Set `MAW_EAGER_CLASSIC=1`. The server eagerly starts legacy SessionIndex on boot as before.
3. **Output Batching Rollback:** Set `MAW_OUTPUT_BATCHING=0`. The server streams raw PTY chunks over WebSocket immediately.
4. **Binary Rollback:** Stop service, point systemd unit back to previous release tag, restart. Zero database schema migrations need unwinding.

---

## 7. Remaining Manual Acceptance Checks

Before tagging the final production release, the release architect must manually verify:
- [ ] Multi-monitor behavior: Electron window minimized to tray / background workspace receives native OS desktop notifications.
- [ ] OS notification click: Clicking native desktop notification focuses MAW window and switches to the alerting tab.
- [ ] Real system reboot: Verify that upon OS reboot, `maw-ptyd` starts cleanly and stale sockets in `/run/user/$UID/maw/` are cleanly cleaned up.
- [ ] High-DPI tab drag: Verify tab drag ghost tracking on high-DPI (Wayland / macOS Retina) displays.

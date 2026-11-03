# Lane B: Implementation Checkpoint & Tracking Log

- **Worktree:** `/home/user/Projects/MAW-reconnection`
- **Branch:** `feat/maw-reconnection`
- **Base Revision:** `502181f235ce8d0f9f9c83661c874bc7cde014e1`
- **Branch HEAD:** `4fe8c0e3896033c36e0c1e1832ffd0aba644a78f`
- **Protocol Version Adopted:** Version 1 (`PTY_PROTOCOL_CONTRACT.md`)
- **Status:** Complete (Tasks 1 - 8 Verified and Passed)

---

## 1. Component Implementation Status

| Component | Target Modules | Status | Verification Evidence |
|---|---|---|---|
| **Task 1: Contract Review** | Protocol v1 spec, `maw-ptyd.mjs`, `pty-host-client.ts` | **DONE** | Signed off in `CONTRACT_REVIEW.md`. Verified concurrent replay & live output determinism. |
| **Task 2: Backend Adapter** | `terminal-registry.ts`, `terminal-socket.ts`, `index.ts`, `agency-session-runtime.ts` | **DONE** | Integrated `PtyHostClient`, RemotePtySession, adoption on startup, graceful detach on shutdown (`detachAll()`), exit tombstone reaping. |
| **Task 3: Electron Reconnection** | `packages/desktop/main.mjs`, `policy.mjs`, `policy.test.mjs` | **DONE** | Secure `discoverBackendReadiness` validating local VFS DAC (`0700` dir, `0600` file, UID match, loopback check, PID alive probe). Live background broadcast `backend-reconnected` preserving native `views` without reload. |
| **Task 4: Terminal Reattachment** | `packages/web/src/TerminalView.tsx`, `packages/web/src/connection.ts` | **DONE** | Delta slicing with `sinceOffset`, zero-reset scrollback preservation (`reset: false`), duplicate chunk suppression (`offset <= lastRenderedOffset`), dynamic loopback endpoint switching. |
| **Task 5: Real Process Survival** | `task5-process-preservation.test.ts` | **DONE** | Mandatory acceptance test passed (951 ms): real synthetic child PID survives backend SIGTERM & SIGKILL, maintains execution during downtime, delta replay reattaches seamlessly, resize and exit continuity verified, zero orphan processes on close. |
| **Task 6: Failure Injection** | `task6-failure-injection.test.ts` | **DONE** | 5 comprehensive fault scenarios verified (1.5s): exit tombstone consumption during backend downtime, buffer overflow ring eviction triggering `reset: true`, bad auth token rejection (403), supervisor unreachability fallback to in-process PTY, high-volume reconnect stream deduplication. |
| **Task 7: Cross-Lane Compatibility** | Lane C (notifications) & Lane D (performance) | **DONE** | Verified compatibility across all 5 interaction dimensions: output micro-batching offset alignment, turn sequence monotonicity, decoupled supervisor execution, flush on shutdown, and lazy classic workbench support. |
| **Task 8: Automated Verification** | All test suites, typecheck, build, perf harness | **DONE** | Server: 246/246 PASS; Desktop: 18/18 PASS; Web: 49/49 PASS; Typecheck: 0 errors; Build: PASS (2.2s); Perf: 4/4 PASS (6957 MiB/s throughput, 0 long tasks). |

---

## 2. Completed Test Scenarios & Metrics

### A. Test Execution Summary
- **Unit & Integration Tests (Server):** 246 passed, 0 failed (4.32s).
- **Desktop Security & Policy Tests:** 18 passed, 0 failed (57ms).
- **Web Frontend Tests:** 49 passed, 0 failed (2.52s).
- **Full Workspace Typecheck:** `pnpm -r typecheck` passed cleanly across `@agent-workbench/shared`, `@agent-workbench/server`, `@agent-workbench/web`.
- **Production Build:** `pnpm build` succeeded in 2.23s.
- **Performance Regression Suite:** `pnpm perf` passed 4/4 checks:
  - OutputBuffer 4 KiB throughput: 6957 MiB/s (threshold: >= 500 MiB/s)
  - OutputBuffer 64 KiB throughput: 7389 MiB/s (threshold: >= 500 MiB/s)
  - Codex watcher latency: 0.024 ms/poll
  - Drag-and-drop: 0 long tasks, 98% reduction in layout queries.

### B. Real Process Preservation Evidence (Task 5)
```
✔ TASK 5 ACCEPTANCE: real child PTY survives backend restart, retains OS PID, reconnects with zero-reset delta replay (951.72ms)
✔ TASK 5 CONCURRENCY & UNGRACEFUL RECOVERY: multiple concurrent sessions survive backend SIGKILL (119.37ms)
```
1. Synthetic agent spawned via supervisor with OS PID.
2. Background job started (`START_JOB token=preservation-alpha`), emitting monotonic step counters.
3. Backend process killed (SIGTERM / SIGKILL).
4. Supervisor verified alive (`kill(supervisorPid, 0)`).
5. Original child PID verified alive (`kill(childPid, 0)`).
6. Child verified actively executing during backend downtime (monotonic offset advanced).
7. Backend restarted with new OS PID, ephemeral port, and rotated token.
8. WebSocket reconnected to new endpoint, reattached to original terminal ID.
9. Adopted session confirmed retaining exact original child PID (`backend2.registry.pidOf(id) === childPid`).
10. Delta replay with `sinceOffset` delivered only missed bytes with `reset: false` (scrollback intact).
11. Terminal input and resize confirmed interactive (`PING` -> `PONG pid=${childPid}`, `resize` -> `WINCH cols=120 rows=40`).
12. Process exit handled cleanly (`EXIT_WITH 0` -> `FINAL_ERROR_LINE code=0`).
13. Session closed and verified zero orphan processes remaining.

---

## 3. Security Findings & Trust Boundary

1. **Local Multi-User DAC Isolation:**
   - Linux VFS DAC rules provide strict unprivileged isolation without requiring root:
     - Runtime directory enforced with mode `0700`.
     - UNIX domain socket and token file enforced with mode `0600` and `umask 0177`.
     - File ownership validated via `stat.uid === process.getuid()`.
   - Handshake authentication uses 256-bit cryptographic tokens compared via `crypto.timingSafeEqual` in constant time.
2. **Endpoint Rediscovery Verification:**
   - Electron desktop verifies readiness file is a regular file owned by the current UID with mode `0600`.
   - Verifies target URL is strictly loopback (`127.0.0.1` or `localhost`).
   - Verifies target backend PID is actively alive in the OS.
   - Issues active probe `fetch(url)` before switching endpoints.
3. **Opt-In Safety:**
   - Persistent PTY mode is gated via `MAW_PERSISTENT_PTY=1` (and `MAW_DISABLE_PTYD != 1`). When unset, MAW runs 100% in legacy in-process mode.

---

## 4. Cross-Lane Coordination & Integration Boundary

1. **Lane A (PTY Supervisor):**
   - Adopted frozen contract Version 1 without any modifications.
   - Supervisor script `maw-ptyd.mjs` referenced externally via `MAW_PTYD_SCRIPT`, zero duplication into Lane B branch.
2. **Lane C (Notifications):**
   - Notification event identity preserved across restarts via stable `terminalId` mapping in `byTerminal`.
   - `TabActivityManager` handles server restart resilience with monotonic `turnSequence` advancing after reconnection.
3. **Lane D (Performance):**
   - Terminal output micro-batching operates cleanly with monotonic byte offsets: batched chunks carry the `offset` of the batch's last byte.
   - `maw-ptyd.mjs` remains an independent external process, not bundled into esbuild `dist/index.js`.
   - Graceful shutdown awaits `store.flush()` while calling `registry.disposeAll()` to detach without killing child PTYs.

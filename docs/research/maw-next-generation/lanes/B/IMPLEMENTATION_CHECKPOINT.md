# Lane B: Implementation Checkpoint & Tracking Log

- **Worktree:** `/home/user/Projects/MAW-reconnection`
- **Branch:** `feat/maw-reconnection`
- **Base Revision:** `502181f235ce8d0f9f9c83661c874bc7cde014e1`
- **Branch HEAD:** `502181f235ce8d0f9f9c83661c874bc7cde014e1` (Clean initial state)
- **Protocol Version Adopted:** Version 1 (`PTY_PROTOCOL_CONTRACT.md`)
- **Status:** In Progress (Task 1 Complete, Transitioning to Task 2 Backend Adapter)

---

## 1. Component Implementation Status

| Component | Target Modules | Status | Verification Evidence |
|---|---|---|---|
| **Task 1: Contract Review** | Protocol v1 spec, `maw-ptyd.mjs`, `pty-host-client.ts` | **DONE** | Signed off in `CONTRACT_REVIEW.md`. Verified concurrent replay & live output determinism. |
| **Task 2: Backend Adapter** | `terminal-registry.ts`, `terminal-socket.ts`, `index.ts`, `agency-session-runtime.ts` | **IN PROGRESS** | Integrating `PtyHostClient` adapter, lifecycle detach, tombstone reaping. |
| **Task 3: Electron Reconnection** | `packages/desktop/main.mjs`, `preload.cjs`, `policy.mjs` | **PENDING** | Verified readiness polling & in-place IPC reconnection without window reload. |
| **Task 4: Terminal Reattachment** | `packages/web/src/TerminalView.tsx`, `packages/web/src/connection.ts` | **PENDING** | Monotonic delta replay, zero-flicker scrollback preservation, duplicate chunk suppression. |
| **Task 5: Real Process Survival** | Integration test suite, disposable supervisor runner | **PENDING** | Synthetic PTY child PID survival across backend SIGTERM & SIGKILL. |
| **Task 6: Failure Injection** | Comprehensive fault matrix | **PENDING** | Simulating crashed backends, bad tokens, buffer overruns, slow clients. |
| **Task 7: Cross-Lane Compatibility** | Lane C (notifications) & Lane D (performance) | **ANALYZED** | Documenting explicit boundaries for Argon integration. |
| **Task 8: Automated Verification** | All test suites, typecheck, build, perf harness | **IN PROGRESS** | Baseline `pnpm test`, `pnpm build`, `pnpm perf` passing cleanly. |

---

## 2. Completed Test Scenarios

- [x] Baseline test verification: 100% passing across Desktop, Server, and Web packages.
- [x] Baseline performance harness verification: 4/4 checks PASSED (rAF elimination, Codex polling, PTY throughput, DnD responsiveness).
- [x] Independent Protocol Contract Review (11 protocol dimensions verified).

---

## 3. Known Issues & Edge Cases

- *Node.js `SO_PEERCRED`:* Documented in `CONTRACT_REVIEW.md`. Same-user local file DAC is enforced on directory (`0700`) and socket inode (`0600`) plus 256-bit token.
- *Opt-In Gating:* Persistent mode is kept opt-in via `MAW_PERSISTENT_PTY=1` to guarantee 100% backward compatibility for all legacy tests.
- *Supervisor Path Isolation:* Supervisor daemon source files are NOT duplicated into Lane B; test runners reference the supervisor executable dynamically via `MAW_PTYD_SCRIPT`.

---

## 4. Required Cross-Lane Coordination

- **Lane A:** Wire protocol Version 1 contract signed off without changes.
- **Lane C:** TabActivityManager turn sequence monotonicity will cleanly preserve turn counters across backend restarts.
- **Lane D:** Terminal output micro-batching (2 ms / 64 KiB) operates transparently on top of monotonic byte offsets.

---

## 5. Next Actions

1. Implement `packages/server/src/pty-host/pty-host-client.ts` adapter / integration in `packages/server/src/terminal-registry.ts`.
2. Update `packages/server/src/agency/agency-session-runtime.ts` to preserve `running` lifecycle when adopting surviving PTYs.
3. Wire `registry.detachAll()` to `SIGINT`/`SIGTERM` in `packages/server/src/index.ts`.
4. Update `packages/server/src/terminal-socket.ts` and `protocol.ts` for monotonic `sinceOffset` and `reset` replay flags.

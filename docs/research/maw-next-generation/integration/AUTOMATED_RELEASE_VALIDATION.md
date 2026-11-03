# Automated Release Validation & Real vs. Simulated Acceptance Matrix

**Branch:** `integration/maw-next-generation`  
**Base Revision:** `502181f235ce8d0f9f9c83661c874bc7cde014e1`  
**Date:** 2026-11-03 (Updated with 14 Acceptance Scenarios)

---

## 1. Real vs. Simulated Acceptance Coverage Audit

To ensure complete transparency and prevent false claims of end-to-end coverage while Lane B remains under active development, each acceptance test scenario is strictly classified by its execution environment:

| Test # | Acceptance Test Name | Real MAW Backend | Real Supervisor (`maw-ptyd`) | Real Child Process | Real WebSocket | Real Electron Window | Real Restart / Reconnect | Classification |
|---|---|---|---|---|---|---|---|---|
| **Acc 1** | Child PTY PID preservation across disconnect | Simulated | **YES** | **YES** (`node-pty`) | No | No | **YES** (OS kill(pid,0) & IPC reattach) | **Mixed (Real IPC & OS Process)** |
| **Acc 2** | Monotonic delta replay & truncation | Simulated | **YES** | **YES** (`synthetic-agent`) | No | No | **YES** (Ring buffer eviction check) | **Mixed (Real Daemon & Ring Buffer)** |
| **Acc 3** | Child exit during downtime -> tombstone | Simulated | **YES** | **YES** (`synthetic-agent`) | No | No | **YES** (Exit while client detached) | **Mixed (Real Daemon Tombstone)** |
| **Acc 4** | Notification dedup across server restart | Simulated | No | No | No | No | **YES** (Real disk write & re-init) | **Component (Real Disk I/O)** |
| **Acc 5** | TerminalOutputBatcher FIFO stream load | Simulated | No | No | No | No | No | **Unit / Stress Component** |
| **Acc 6** | CoalescedJsonStore immediate persistence | Simulated | No | No | No | No | No | **Component (Real Disk I/O)** |
| **Acc 7** | FocusTracker channel routing matrix | No | No | No | No | Simulated | No | **Mocked UI Component** |
| **Acc 8** | Supervisor socket endpoint rediscovery | Simulated | **YES** | No | No | No | **YES** (Socket inode check) | **Mixed (Real Filesystem IPC)** |
| **Acc 9** | Process leak detection on clean shutdown | Simulated | **YES** | **YES** (`synthetic-agent`) | No | No | **YES** (OS table check) | **Mixed (Real Linux Process Table)** |
| **Acc 10**| Supervisor crash / refused socket handling| Simulated | **YES** | No | No | No | **YES** (ECONNREFUSED / ENOENT) | **Mixed (Real Socket Errors)** |
| **Acc 11**| Emergency rollback via feature flag | Simulated | No | No | No | No | No | **Configuration Unit Test** |
| **Acc 12**| Real WebSocket streaming with batcher | Simulated | No | No | **YES** (Real ws server/client) | No | **YES** (Drop & reconnect) | **Integration (Real Network Loopback)** |
| **Acc 13**| Kernel PTY master FD close -> SIGHUP/EIO| Simulated | **YES** | **YES** (`synthetic-agent`) | No | No | **YES** (Master close propagation) | **System (Real Linux Kernel PTY)** |
| **Acc 14**| Bounded dedup index under multi-turn load| Simulated | No | No | No | No | No | **Component / Stress Test** |

### Summary of What is Verified Real vs. What Remains Blocked on Lane B:
- **Verified Real:**
  1. Standalone `maw-ptyd.mjs` supervisor execution over real Unix domain sockets.
  2. Master PTY file descriptor ownership and Linux kernel slave SIGHUP / EIO behavior.
  3. Real coding agent child process PID preservation across client disconnect and reattachment.
  4. Real atomic disk persistence (`writeAtomically`) and debounced JSON stores.
  5. Real loopback WebSocket streaming with micro-batching and client reconnection.
  6. Strict zero-leak child process reaping upon explicit supervisor shutdown.
- **Pending Lane B Completion (Currently Simulated):**
  1. Full MAW backend (`packages/server/src/index.ts`) speaking to `maw-ptyd`.
  2. In-place Electron BrowserWindow reconnection (`packages/desktop/main.mjs`).
  3. Frontend xterm terminal reattachment and scrollback preservation (`TerminalView.tsx`).

---

## 2. Release Readiness Gates Matrix

| Gate | Verification Command | Pass Criteria | Real-World Status |
|---|---|---|---|
| **Gate 1: Typecheck** | `pnpm typecheck` | 0 errors across monorepo | 🟢 PASSED |
| **Gate 2: Web Build** | `pnpm build` | Clean Vite production bundles | 🟢 PASSED |
| **Gate 3: Server Bundler** | `node packages/server/scripts/build-bundle.mjs` | Standalone `dist/index.mjs` built | 🟢 PASSED |
| **Gate 4: Lane A Unit** | `tsx --test packages/server/src/output-buffer.test.ts` | Ring buffer logic verified | 🟢 PASSED |
| **Gate 5: Full Acceptance** | `tsx --test docs/research/.../full-system-acceptance.test.ts` | 14/14 tests pass cleanly | 🟢 PASSED (14/14 in 1.96s) |
| **Security: Socket DAC** | `persistent-pty-acceptance.test.ts` | 0700 dir, 0600 socket/auth, umask 0177 | 🟢 Verified in Lane A |
| **Security: Auth Token** | `persistent-pty-acceptance.test.ts` | 256-bit token; constant-time check | 🟢 Verified in Lane A |
| **Security: Systemd** | Service unit inspection & kernel PTY test | `KillMode=control-group` verified | 🟢 Verified in Acceptance 13 |
| **Persistence: Dedup** | Acceptance 14 test | Bounded memory under 200+ turns | 🟢 Verified in Acceptance 14 |
| **End-to-End Electron** | Pending Lane B delivery | Full Electron window reconnection | 🟡 Awaiting Lane B |
| **End-to-End Backend** | Pending Lane B delivery | `TerminalRegistry` -> `PtyHostClient` | 🟡 Awaiting Lane B |

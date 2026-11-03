# Protocol Contract Sign-Off: Ready for Lane B Adapter Implementation

- **Date:** 2026-11-03
- **Lane:** Lane A (Persistent PTY Supervisor)
- **Status:** **CONTRACT FROZEN & READY FOR LANE B ADOPTION**
- **Contract Specification:** [`PTY_PROTOCOL_CONTRACT.md`](PTY_PROTOCOL_CONTRACT.md)

---

## 1. Verified Protocol Capabilities

All protocol requirements specified in the Next-Generation Implementation Master Plan have been implemented, tested, and validated in isolated disposable environments:

1. **PTY Lifecycle & Disconnection Survival:**
   - Real synthetic processes emit output continuously while backend disconnects.
   - Child processes maintain their original OS PID across backend detachment and reattachment.
   - Exit status (`exitCode`, `signal`) is observed by supervisor and stored in 10-minute tombstones.
   - Master PTY descriptors remain open in `maw-ptyd` across backend restarts.
2. **Local IPC & Security:**
   - Version 1 Unix domain socket protocol with NDJSON framing and Base64 stream encoding.
   - Unix socket parent directory enforced `0700` (`rwx------`) owned by `process.getuid()`.
   - Socket inode bound with `process.umask(0o177)` ensuring `0600` (`rw-------`) mode.
   - Ephemeral 256-bit cryptographic token mutual authentication validated with `crypto.timingSafeEqual`.
   - Node.js runtime `SO_PEERCRED` limitations documented; verified local alternative active.
   - Strict command validation, no shell interpolation, bounded line size (1 MiB), slow reader protection (16 MiB write buffer cap).
3. **Bounded Output Replay & Monotonic Byte Offsets:**
   - Enhanced `OutputBuffer` with `startOffset`, `endOffset`, and `sliceFrom(sinceOffset)`.
   - Reconnection with matching `sinceOffset` achieves zero-reset delta replay (preserving all 20,000 lines of scrollback).
   - Ring buffer overflow correctly reports `truncated: true` and flags `reset: true` when requested offset was evicted.
   - Alternate screen (`\x1b[?1049h`) escape sequence preservation verified.
4. **Interactive Controls & Process Groups:**
   - Terminal resizing (`resize`) propagates `TIOCSWINSZ` and triggers `SIGWINCH` in child process.
   - Process group signaling (`process.kill(-pid, signal)`) ensures complete teardown without orphans.

---

## 2. Test Verification Matrix

All 15 focused tests passed with 100% success:

| Test Suite | Tests | Result | Duration |
|---|---|---|---|
| `packages/server/src/output-buffer.test.ts` | 7 | **PASS** | ~135 ms |
| `packages/server/src/pty-host/persistent-pty-acceptance.test.ts` | 4 | **PASS** | ~1090 ms |
| `packages/server/src/pty-host/failure-injection.test.ts` | 4 | **PASS** | ~1190 ms |
| **Combined Lane A Test Suite** | **15** | **PASS** | **~1127 ms** |
| `pnpm test` (Full Repository Suite) | All | **PASS** | ~5.8 s |
| `pnpm perf` (Quantitative Regression Harness) | 4 | **PASS** | ~4.9 s |
| `pnpm typecheck` (All Workspace Packages) | 3 | **PASS** | Clean |

---

## 3. Integration Handoff Instructions for Lane B

Lane B may now develop against `PtyHostClient` and the protocol contract without risk of breaking changes:

1. **Client Adapter Location:**
   - `packages/server/src/pty-host/pty-host-client.ts`
   - `packages/server/src/pty-host/pty-host-types.ts`
2. **Connecting to Supervisor:**
   ```ts
   import { PtyHostClient } from './pty-host/pty-host-client.js';

   const client = await PtyHostClient.connectOrSpawn({
     autoSpawn: true, // Automatically launches maw-ptyd in background if not already active
   });
   ```
3. **Reconciling Existing Sessions on Startup:**
   - Upon connection, `client` receives `snapshot` containing all live `sessions` and `tombstones`.
   - For each live session, adopt its `id`, `sessionId`, and `pid` into `TerminalRegistry`.
   - For each tombstone, record `lastStopReason: 'process-exit'`, `lastExitCode: tombstone.exitCode`, and reap with `client.reapTombstone(id)`.
4. **Shutdown vs Detach:**
   - In `SIGINT`/`SIGTERM` graceful shutdown of `maw.service`, call `client.detach()` (or `registry.detachAll()`), **NEVER** `client.kill()`.
   - Call `client.kill(id)` only on explicit user tab close (`agency.tab.action: close` or `stop`).

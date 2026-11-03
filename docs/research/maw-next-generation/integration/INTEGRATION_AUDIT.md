# MAW Next-Generation Integration Audit

**Branch:** `integration/maw-next-generation`
**Base Revision:** `502181f235ce8d0f9f9c83661c874bc7cde014e1`
**Audit Date:** 2026-11-03
**Auditor:** Integration Principal / Independent Audit

---

## Lane Revision Verification

| Lane | Expected Rev | Actual HEAD | Branch | Match |
|------|-------------|-------------|--------|-------|
| A (PTY Supervisor) | `0311ae1` | `0311ae10f39bba39a7eb5c186c0239012cf314b0` | `feat/maw-pty-supervisor` | ✅ |
| B (Reconnection) | — still active — | `502181f` (= base) | `feat/maw-reconnection` | N/A |
| C (Notifications) | `2147c90` | `2147c90` | `feat/maw-notifications` | ✅ |
| D (Performance) | `7d85b1a` | `7d85b1a` | `feat/maw-performance` | ✅ |
| Integration | base | `502181f` | `integration/maw-next-generation` | ✅ |

> [!IMPORTANT]
> All expected lane revisions match. Lane B is confirmed at base — no production code added yet.

---

## Lane A — Persistent PTY Supervisor

### Overview

Lane A introduces `maw-ptyd.mjs` (standalone ESM daemon) and `pty-host-client.ts` (TypeScript IPC client) over a Unix domain socket with NDJSON protocol, 256-bit ephemeral token authentication, and 256 KiB ring-buffer output replay with monotonic byte offsets.

### Files Changed

| File | Type |
|------|------|
| `packages/server/src/pty-host/maw-ptyd.mjs` | New — daemon |
| `packages/server/src/pty-host/pty-host-client.ts` | New — client |
| `packages/server/src/pty-host/pty-host-types.ts` | New — protocol constants |
| `packages/server/src/output-buffer.ts` | New — TypeScript ring buffer |
| `packages/server/src/output-buffer.test.ts` | New — buffer unit tests |
| `packages/server/src/pty-host/persistent-pty-acceptance.test.ts` | New — acceptance tests |
| `packages/server/src/pty-host/failure-injection.test.ts` | New — failure injection tests |
| `packages/server/src/pty-host/fixtures/synthetic-agent.mjs` | New — test fixture |
| `scripts/maw/pty-host/maw-ptyd.service` | New — systemd template |
| `docs/research/maw-next-generation/lanes/A/PTY_PROTOCOL_CONTRACT.md` | New — frozen contract |
| `docs/research/maw-next-generation/lanes/A/CONTRACT_READY.md` | New — sign-off doc |

### Architecture

```
MAW Backend (index.ts)
   └── PtyHostClient (pty-host-client.ts)
          │  NDJSON over Unix socket
          ▼
    maw-ptyd.mjs (PtySupervisor)
          │  node-pty
          ▼
    PTY child processes (survive backend restart)
```

### Security Implementation

| Mechanism | Implementation | Status |
|-----------|---------------|--------|
| Directory permissions | `mkdirSync(dir, 0o700)` + uid check | ✅ Correct |
| Socket permissions | `process.umask(0o177)` before `server.listen()` | ✅ Correct |
| Token generation | `crypto.randomBytes(32)` | ✅ 256-bit entropy |
| Token file write | Atomic tmp→rename with `mode: 0o600` | ✅ Correct |
| Token verification | `crypto.timingSafeEqual(clientBuf, authToken)` | ✅ Constant-time |
| Zero-length guard | `clientTokenBuf.length !== this.authToken.length` checked first | ✅ Correct |
| Version negotiation | `VERSION_MISMATCH` error + socket close | ✅ Correct |
| Handshake timeout | 3000 ms hard timer | ✅ Correct |
| Backpressure | 16 MiB write-buffer quota, disconnect on exceed | ✅ Correct |

### Protocol Implementation

| Dimension | Assessment |
|-----------|-----------|
| NDJSON framing | Correct; 1 MiB line limit with `MAX_PAYLOAD_SIZE` check spanning multiple chunks |
| Monotonic offsets | `totalBytesPushed` counter, Unicode-safe `suffixWithinBytes` eviction |
| Replay semantics | `sliceFrom(sinceOffset)`: reset on evicted offset, delta on retained, empty on caught-up |
| Session idempotency | `spawn` with existing ID returns existing PID without re-spawning |
| Tombstone retention | 10-minute TTL, sweeper every 60 s |
| Broadcast events | `op: 'data'` broadcasts `offset` = `buffer.endOffset` after push (post-push, correct) |
| Backpressure on send | `writableLength > 16 MiB` disconnects slow client without blocking supervisor |

### Two Independent Ring Buffer Implementations

> [!WARNING]
> Lane A ships **two independent implementations** of the ring buffer:
> - `packages/server/src/output-buffer.ts` — TypeScript, exported class `OutputBuffer`
> - `maw-ptyd.mjs` — JavaScript inline class `SupervisorOutputBuffer`
>
> Both implement the same algorithm but are maintained separately. A divergence risk exists. See `CONFIRMED_FINDINGS.md` finding A-001.

### Dual Buffer Implementation — Alignment Check

The TypeScript and JavaScript implementations were compared. Both:
- Use `suffixWithinBytes` with identical surrogate-pair logic
- Use identical `sliceFrom` semantics with the same boundary conditions
- Handle alternate-screen detection (`\x1b[?1049h`) identically
- Emit `reset: true` for evicted offsets

At HEAD `0311ae1` they are equivalent. The risk is future drift.

### `attach` Operation Gap

`pty-host-types.ts` defines `PtyAttachRequest`. The client (`pty-host-client.ts`) does not expose an `attach()` method. The daemon's `_dispatch()` does not handle `op: 'attach'`. The operation is defined in the type contract but implemented nowhere. Lane B will need to implement or eliminate it.

### Systemd Isolation Assessment

The `maw-ptyd.service` template uses:
- `KillMode=control-group` — **kills all PTY children on daemon restart**; this undermines the supervisor's purpose of surviving backend restarts. See finding A-002.
- `PrivateTmp=true` — may conflict if supervisor writes socket to `XDG_RUNTIME_DIR` path derived from `/run/user/$UID` (which is NOT in `/tmp`); in practice no conflict because XDG_RUNTIME_DIR maps to `%t` in the unit.
- `Restart=on-failure` — daemon restarts on crash, but the cgroup kill means child PTYs are also killed on unintended crash.

### Test Coverage Assessment

| Test Suite | File | Approximate Cases |
|------------|------|------------------|
| Output buffer unit | `output-buffer.test.ts` | ~8 tests, 157 lines |
| Acceptance | `persistent-pty-acceptance.test.ts` | ~7 tests, 417 lines |
| Failure injection | `failure-injection.test.ts` | ~4 tests, 254 lines |

**Gaps identified:**
- No test for concurrent `attach+replay` race
- No test for symlink socket path attack
- No test for zero-length auth token
- No test for session ownership across different connections
- `attach` operation unimplemented and untested

---

## Lane C — Notifications

### Overview

Lane C adds a 5-state tab activity model (`idle`, `working`, `finished`, `unknown`, `failed`, plus `needs-input`), durable notification inbox with 150-item bound, focus-aware channel routing (suppress/toast/OS), and anti-storm deduplication via a stable keyed index.

### Files Changed

**Server:** `agency-notification-store.ts`, `tab-activity-manager.ts`, `notification-acceptance-suite.test.ts`
**Web:** `focus-tracker.ts`, `useNotificationStore.ts`, `NotificationToast.tsx`, `NotificationInbox.tsx`, `notification-labels.ts`, 3 test files, `agency.css`

### Completion Evidence / False Positives

Verified provider set in `tab-activity-manager.ts`:
```typescript
const VERIFIED_TURN_PROVIDERS = new Set<string>(['claude-code', 'opencode', 'antigravity'])
```

> [!WARNING]
> `codex` is NOT in `VERIFIED_TURN_PROVIDERS`. The acceptance test header mentions "Codex" as a verified provider but the actual code does not include it. Non-verified providers reaching `idle` produce `unknown` state, not `finished`. This is a false-positive _prevention_ — Codex tab activity reaching idle will not generate a completion notification.
>
> The test does verify Codex in the acceptance suite — check the test body to determine whether the suite mocks Codex differently. See finding C-001.

### Deduplication Index Bounding

The `deduplicationIndex` maps `deduplicationKey → {id, createdAt}`.

The inbox pruning logic (when `notifications.size > MAX_NOTIFICATIONS = 150`) prunes oldest **acknowledged-and-read** notification entries from `this.notifications`. However, it does **NOT** remove the corresponding `deduplicationIndex` entry.

This creates an unbounded deduplication index leak: pruned notifications leave orphan dedup keys behind indefinitely. Over time, with high notification volume and acknowledgement, the index grows without bound while the inbox stays capped.

> [!CAUTION]
> **Confirmed defect C-002** (blocking): `deduplicationIndex` entries for pruned notifications are not cleaned up. This is a slow memory leak. See `CONFIRMED_FINDINGS.md`.

### Focus Tracking — Electron Bridge Dependency

`focus-tracker.ts` subscribes to `window.mawChatGpt.subscribe` at constructor time. If the bridge is absent (browser-only, test environment), the try/catch prevents a throw but the tracker operates in degraded mode (no native view focus tracking). This is acceptable as a graceful fallback.

`nativeLayoutCoordinator.isViewing(tabId)` is imported from `./native-layout-coordinator.js`. In browser-only environments (no Electron), this coordinator should return `false` safely. The exact behavior depends on the coordinator's implementation (not directly in Lane C's changed files).

The 150ms `blur` heuristic to distinguish native-view clicks from true window blur is a correct approach. Edge case: if the OS delivers a `blur` event more than 150ms after the native view `focused` event (e.g., under load), the tracker may briefly lose native focus state.

### Inbox Retention vs Toast Suppression

`markRead(notificationId)` — marks individual notification `read = true` in store, persists.
`acknowledgeTab(workspaceId, tabId)` — marks all notifications for tab as `acknowledgedAt = now`, produces "done" state, persists.

These are correctly distinct operations. Reading in the inbox does not acknowledge the tab; the user must explicitly click "Done".

### Test Count Assessment

| File | Lines | Estimated Tests |
|------|-------|----------------|
| `notification-acceptance-suite.test.ts` | 535 | 8 top-level tests |
| `notifications.test.mjs` | 573 | ~20+ tests |
| `focus-tracker.test.ts` | 235 | ~10 tests |
| `notifications-browser-acceptance.test.mjs` | 236 | ~8 tests |

Estimated total: ~46-50 server+web tests. The "106 passing tests" reported likely includes the pre-existing server test suite (179 tests from Lane B's baseline). Lane C's own additions represent approximately 46-50 incremental tests.

### OS Notification Click Navigation

`dispatchOsNotification` routes `channel === 'os'` via `new Notification(item.title, {...})` with `onclick` dispatching `window.dispatchEvent(new CustomEvent('maw:select-tab', ...))`. This works in Electron's renderer context. The event must be consumed by the frontend router — this is a consumer dependency that Lane C cannot fully test in isolation.

---

## Lane D — Performance

### Overview

Lane D introduces three performance modules: `ClassicWorkbenchLifecycle` (lazy initialization), `TerminalOutputBatcher` (2ms/64KiB micro-batching), and `CoalescedJsonStore` (trailing-edge debounced persistence), plus a production ESM server bundle via `esbuild`.

### Files Changed

**Server:** `classic-workbench-lifecycle.ts`, `terminal-output-batcher.ts`, `coalesced-json-store.ts`, `build-bundle.mjs` (scripts), plus 4 test files
**Docs:** Lane D report, integration patch spec, benchmarks, soak tests, evidence JSON

### Classic Workbench Lifecycle

`ClassicWorkbenchLifecycle` correctly gates `SessionIndex.start()`, `vault.start()`, and `watchSessions()` behind a single idempotent promise. Concurrent calls are deduplicated via `startPromise`. On rejection, `startPromise = null` is reset (in the `.catch()` block) allowing retry.

> [!WARNING]
> **Finding D-001** (non-blocking): `dispose()` synchronously sets `this.disposed = true` and clears `this.started`, but if `ensureStarted()` is in-flight, the `if (this.disposed) return` check on line ~70 does fire correctly inside the async block. However, `stopWatching` and the `historyGrew` listener are set to `null` in `dispose()` **before** the in-flight start completes. If start completes after dispose, it sets `this.started = true` without ever being cleaned up, leaving a ghost started state. The `finally` in dispose does not await the in-flight promise.

### Terminal Output Batcher

The batcher correctly:
- Uses per-terminal queues to prevent cross-terminal mixing
- Clears the timer reference before flushing (no double-clearTimeout)
- Handles the single-chunk fast-path (`queue.chunks.length === 1 && first !== undefined ? first : queue.chunks.join('')`)
- Sets `queue.chunks = []` and `queue.bufferedBytes = 0` before calling `onFlush()`, preventing lost data on throw

**ANSI integrity**: String join (`chunks.join('')`) preserves multi-byte ANSI sequences correctly — these are JS strings, not raw bytes.

**`push()` on disposed batcher**: Correctly returns early via `if (this.disposed || chunk.length === 0) return`.

### Coalesced JSON Store

`executeWrite()` uses a single `inFlightWrite` promise to serialize writes. Two concurrent `saveImmediate()` calls: the second awaits the first via `await this.inFlightWrite`, then re-checks `isDirty`. No double-write is possible because `isDirty` is cleared before the write starts.

> [!WARNING]
> **Finding D-002** (non-blocking): On write error, `isDirty = true` and `pendingData = dataToWrite` are reset. However, `deferredsToNotify` was already replaced with `this.pendingDeferreds = []` before the write. If a subsequent `saveImmediate()` arrives after the error but before the retry, its deferred resolves when the retry succeeds — correct behavior. But the failed write's data is overwritten by `pendingData = dataToWrite` (the old value) before new data arrives. If new data arrives mid-retry, the old data is overwritten with new data. This is intentional (persistence is idempotent) but not explicitly documented.

### Production Bundle

`build-bundle.mjs` uses esbuild to produce `dist/index.mjs`. Externalizes `node-pty`, `ws`, `chokidar`, `express`, `fzstd`, `@xterm/headless`, `vite`.

> [!WARNING]
> **Finding D-003** (non-blocking): The build test `build-bundle.test.ts` checks `existsSync(bundlePath)` as its first assertion. If the bundle hasn't been built (CI fresh checkout), the test fails immediately. This is a CI ordering dependency — the bundle must be built before tests run. No pre-test build step is documented in the test runner config.

> [!WARNING]
> **Finding D-004** (non-blocking): The soak test `lane-d-soak.test.mjs` uses `await import(path.join(serverRoot, 'src/terminal-output-batcher.ts'))` — importing a `.ts` file directly. Node.js cannot execute TypeScript without a loader. This test will fail at runtime unless run via `tsx` or similar. It's located in `docs/` so may be intentionally documentation-only, but if it's part of CI it will fail.

### Benchmark Validity

| Benchmark | Claim | Evidence | Assessment |
|-----------|-------|----------|-----------|
| Cold startup | 393ms (tsx) → 229ms (bundle) = 41.9% reduction | Single-run wall clock, no sample count stated | **Insufficient** — no iteration count or CI environment baseline |
| inotify watchers | lazy=0 vs 2179 saved | Measured on a machine with ~2179 agent files | **Valid** for that machine; not generalizable |
| Frame batching | 20000→17 frames, 1176× reduction | Simulated in-process (no real PTY I/O) | **Valid** as microbenchmark; real PTY burst behavior unknown |
| Persistence | 300→1 writes, 99.7% reduction | In-process timer test | **Valid** as unit measurement |

Startup benchmark lacks iteration count and stddev for tsx baseline despite claiming stddev for bundle. Statistical rigor is insufficient for a production release gate.

---

## Lane B — Status and Contract

Lane B is at base revision `502181f` (no production code added yet). Published checkpoint confirms:
- Contract review (Task 1) of Lane A protocol: **DONE**, signed off
- Backend adapter (`terminal-registry.ts` integration): **IN PROGRESS**
- Electron reconnection: **PENDING**
- Terminal reattachment (`TerminalView.tsx`): **PENDING**
- Process survival tests: **PENDING**
- Failure injection: **PENDING**

Lane B explicitly adopts Lane A's Protocol Version 1 without amendments. Lane B plans to gate persistent mode behind `MAW_PERSISTENT_PTY=1` feature flag for backward compatibility.

---

## Summary Table

| Lane | Blocking Findings | Non-Blocking Findings | Test Coverage | Integration Risk |
|------|------------------|-----------------------|---------------|-----------------|
| A | A-002 (systemd KillMode) | A-001 (dual buffer), A-003 (attach unimplemented) | Good | Medium |
| C | C-002 (dedup index unbounded) | C-001 (Codex provider), C-003 (pruning silent) | Good | Low |
| D | — | D-001 (dispose race), D-002 (retry semantics), D-003 (CI ordering), D-004 (soak ts import) | Acceptable | Low |

See `CONFIRMED_FINDINGS.md` for full defect detail with repair recommendations.

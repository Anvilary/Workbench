# Terminal History Implementation Report

**Lane**: F: Resource-Efficient Terminal History  
**Branch**: `feat/maw-terminal-history`  
**Base SHA**: `85dd91c745980a9870eb591dc0936b40ce7da86c`  
**Implementation SHA**: `45061b4` (see Section 16 for final HEAD)  
**Date**: 2026-11-05

---

## 1. Existing Architecture

### PTY Supervisor

The app supports two PTY modes:

- **In-process PTY** (`node-pty` direct): default mode. PTY sessions live in the Node process and die if the server restarts.
- **Persistent PTY daemon** (`PtyHostClient`): enabled with `MAW_PERSISTENT_PTY=1`. PTY processes survive server restarts via a Unix-socket supervisor.

### TerminalRegistry

[`packages/server/src/terminal-registry.ts`](../../../packages/server/src/terminal-registry.ts) is the central PTY lifecycle manager. It owns one `OutputBuffer` and one listener set per terminal. The `attach()` method provides reconnection replay. Terminals survive WebSocket drops.

### Output Buffer (Circular, 256 KB)

[`packages/server/src/output-buffer.ts`](../../../packages/server/src/output-buffer.ts): a 256 KB in-memory ring buffer of recent PTY bytes, tracking monotonic byte offsets. Used exclusively for reconnection replay (zero-flicker reattach). No disk persistence.

### Output Batcher

[`packages/server/src/terminal-output-batcher.ts`](../../../packages/server/src/terminal-output-batcher.ts): batches PTY chunks into frames of up to 64 KB or 2 ms, whichever comes first, before forwarding to WebSocket clients.

### xterm.js

[`packages/web/src/TerminalView.tsx`](../../../packages/web/src/TerminalView.tsx): initializes xterm.js with `scrollback: 20_000` (pre-implementation). All scrollback lives in browser memory. No server-side pagination existed.

### Session Persistence

Workspace tab state (`workspace.json`) is persisted. PTY output is NOT persisted across server restarts. On reconnect, the client receives only what remained in the 256 KB ring buffer.

### Existing SQLite Usage

`node:sqlite` (Node 22.13+) is used read-only for OpenCode session history. The pattern was available for reuse but was not needed for append-only sequential output: segmented files fit better.

---

## 2. Confirmed Historical-Output Limitations (Pre-Implementation)

| Limitation | Details |
|---|---|
| In-memory scrollback cap | 256 KB of recent PTY bytes; older output is permanently lost |
| xterm.js scrollback | 20,000 lines per terminal in browser memory (~30-50 MB per active terminal) |
| No persistence | Output is gone on server restart regardless of PTY mode |
| No pagination | The entire scrollback was written to xterm at reconnect |
| No retention control | No quota, age limit, or cleanup mechanism |

---

## 3. Selected Storage Design

### Decision: Segmented Append-Only Files + Atomic JSON Index

**Rejected**: SQLite: introduces a database for fundamentally sequential I/O; adds complexity without benefit for append-write, page-read access patterns.

**Selected**: One directory per terminal under `~/.config/agent-workbench/terminal-history/<terminalId>/`:
- `seg-N.bin`: UTF-8 plain text segments, append-only, one per rotation
- `index.json`: atomic JSON index tracking segment line boundaries

#### Index Schema

```json
{
  "version": 1,
  "terminalId": "<uuid>",
  "totalLines": 42000,
  "segments": [
    {
      "file": "seg-0.bin",
      "startLine": 0,
      "endLine": 10000,
      "byteOffset": 0,
      "byteLength": 524288
    }
  ]
}
```

#### Rationale

- **O(1) page lookup**: binary search the index to find which segment contains the requested line range; read only those bytes
- **Atomic writes**: index updated via `writeAtomically()` (temp-file + rename); crash leaves old index intact
- **No cross-session leakage**: terminalId is UUID-validated; path traversal is rejected in constructor
- **Reuses existing infrastructure**: `atomic-write.ts` already exists in the codebase
- **No new npm dependencies**: `node:fs/promises`, `node:path`, `node:crypto` only

---

## 4. Pagination Implementation

### Backend

Handler in [`packages/server/src/terminal-socket.ts`](../../../packages/server/src/terminal-socket.ts):

- Client sends `terminal.history.page` with `terminalId`, `page` (0-indexed), optional `pageSize` (default 1000), and a unique `requestId`
- Server calls `store.getPage(page, pageSize)` on the per-terminal `TerminalHistoryStore`
- Returns `terminal.history.data` with lines, pagination metadata, and `hasMore`
- Returns `terminal.history.error` on missing terminal, unavailable store, or I/O error

### Frontend

[`packages/web/src/useTerminalHistory.ts`](../../../packages/web/src/useTerminalHistory.ts):

- `loadOlder()`: requests the next older page (page index advances backward in time)
- In-flight deduplication via `requestId` tracking; stale responses are dropped
- LRU cache: max 20 pages (20,000 lines) evicted from the front when exceeded
- `reset()`: clears cache and resets pagination state (called on terminal unmount)

### Scroll Trigger

[`packages/web/src/TerminalView.tsx`](../../../packages/web/src/TerminalView.tsx): `terminal.onScroll` triggers `onScrolledToTop()` when `viewportY === 0` and the buffer is not in alternate-screen mode. The parent passes `useTerminalHistory`'s `loadOlder` as this callback.

### Page Size

Default: **1,000 lines per page**. Configurable via the `pageSize` field in the request.

---

## 5. Memory Management

| Layer | Pre-Implementation | Post-Implementation |
|---|---|---|
| xterm.js scrollback | 20,000 lines | **5,000 lines** |
| In-memory ring buffer | 256 KB | 256 KB (unchanged) |
| Write queue (server) | N/A | Bounded: 32 KB flush trigger, 1 MB hard cap |
| Frontend page cache | N/A | 20 pages max (LRU eviction) |
| Segment memory during read | N/A | Only the target segment(s) are read per page request |

Write batching: PTY chunks are buffered up to 100 ms OR 32 KB before an async disk write. This prevents per-character writes and limits queue growth under heavy output.

---

## 6. ANSI and TUI Fidelity Limitations

**Stored representation**: raw PTY output bytes (UTF-8 text with ANSI escape sequences preserved as-is).

**What works correctly**:
- Static output with ANSI color, bold, underline, etc.
- Wrapped lines
- Unicode (multi-byte characters, emoji, CJK)
- Cursor-move sequences within a single visible region

**Known fidelity limitations**:

| Scenario | Limitation |
|---|---|
| Screen-clear sequences (`\x1b[2J`, `\x1b[H`) | History contains the clear sequence; replaying it clears the historical viewport |
| Line rewriting (carriage return tricks) | Lines may appear duplicated or mangled without terminal emulation |
| Alternate-screen applications (Codex, vim, htop) | Alternate-screen content (`\x1b[?1049h`...) is stored but not faithfully reconstructable as a transcript |
| Interactive TUI menus | Menu states are not snapshotted; only the raw escape sequence stream is preserved |
| Cursor position after output | Not meaningful in historical context |

**Design choice**: raw PTY bytes are stored, not rendered logical lines. This preserves maximal fidelity for ordinary shell output while being honest about TUI limitations. A checkpoint-based approach (periodic xterm.js state snapshots) was considered but rejected: it requires a headless terminal emulator on the write path, adds significant CPU overhead, and still cannot reconstruct interactive state.

**When history is unavailable**: the existing `truncated` flag in `terminal.replay` already notifies users when the reconnection buffer was overflowed. A similar indicator should be shown when historical content cannot be rendered faithfully (see Section 14 for the clipboard integration contract).

---

## 7. Files Modified

| File | Change |
|---|---|
| `packages/server/src/paths.ts` | Added `terminalHistoryDir()` returning `<appConfigDir>/terminal-history` |
| `packages/server/src/terminal-history-store.ts` | NEW: 418-line storage engine |
| `packages/server/src/terminal-history-store.test.ts` | NEW: 11 unit tests |
| `packages/server/src/terminal-socket.ts` | +101 lines: store wiring, `terminal.history.page` handler |
| `packages/shared/src/protocol.ts` | +44 lines: 3 new message types + union updates |
| `packages/web/src/TerminalView.tsx` | +58/-5 lines: scrollback reduction, scroll detection, history message handling |
| `packages/web/src/useTerminalHistory.ts` | NEW: 170-line React hook |
| `packages/web/src/useTerminalHistory.test.mjs` | NEW: hook test |

**Unchanged** (deliberately not modified):
- `output-buffer.ts`: reconnection replay buffer unchanged
- `pty-session.ts`: PTY session lifecycle unchanged
- `terminal-registry.ts`: registry interface unchanged
- `terminal-output-batcher.ts`: batching unchanged

---

## 8. Security Model

| Requirement | Implementation |
|---|---|
| Session ownership | Each `TerminalHistoryStore` is UUID-validated on construction; constructor throws on invalid/non-UUID ID |
| Path traversal prevention | UUID regex check in constructor; `path.join(baseDir, terminalId)` is safe after validation |
| Registry check on requests | `terminal.history.page` checks `registry.has(terminalId)` before serving history |
| No cross-session leakage | Each store reads only files under its own `terminalId` directory |
| File permissions | History files inherit the process umask (typically 0o644 on Linux, owned by the app user) |
| No unauthenticated access | History requests use the existing WebSocket authorization boundary (token-gated by `terminal-socket.ts`) |
| No credential logging | PTY output is stored as-is; it is the user's responsibility not to print credentials. The store does not log line content. |
| No Electron IPC changes | History retrieval uses the existing WebSocket path; no new IPC channels introduced |
| Diagnostic exclusion | History files are not included in application logs or diagnostics |

---

## 9. Automated Tests

### Storage Engine (`terminal-history-store.test.ts`)

11 tests using `node:test` + `node:assert/strict`:

1. Push and flush: written lines appear in `getPage(0)`
2. Multiple segments: rotation at `maxSegmentLines`, all lines recoverable across segments
3. Pagination: 2500 lines across pages 0, 1, 2 with correct line indices
4. Disk-full simulation: I/O errors logged via `console.warn`, `push()` does not throw
5. ANSI preservation: color codes and escape sequences round-trip intact
6. Unicode: multi-byte characters (emoji, accented, CJK) round-trip correctly
7. Total lines count: matches actual pushed lines after flush
8. deleteAll: removes all storage, resets `totalLines` to 0
9. Dispose and re-open: new store instance reloads existing index and data
10. Invalid terminalId: constructor throws on path traversal and non-UUID strings
11. Trailing partial line buffering: buffered until newline or forced by flush

### Output Buffer (`output-buffer.test.ts`): pre-existing, all pass

8 tests covering initialization, ring overflow, UTF-8, alternate screen, seed/replay.

### Batcher (`terminal-output-batcher.test.ts`): pre-existing, all pass

7 tests covering timer flush, coalescing, byte threshold, isolation, clear, ANSI/UTF-8, throughput.

### Frontend Hook (`useTerminalHistory.test.mjs`)

1 integration test covering constants, scrollback config, initial state, `loadOlder` dispatch, stale rejection, page data intake, pagination progression, LRU eviction, error handling, and reset.

---

## 10. Runtime Verification

### Typecheck (all packages)

```
pnpm -r typecheck
```

Result: **0 errors** across `@agent-workbench/shared`, `@agent-workbench/server`, `@agent-workbench/web`.

### Test Suite

```
pnpm --filter @agent-workbench/server exec tsx --test \
  src/agency/*.test.ts \
  src/agency/browser-tabs/*.test.ts \
  src/agency/runtime/*.test.ts \
  src/security.test.ts \
  src/output-backpressure.test.ts \
  src/output-buffer.test.ts \
  src/terminal-output-batcher.test.ts \
  src/terminal-history-store.test.ts
```

Result: **229/229 tests pass**.

Pre-existing failure: `local-no-auth.test.ts:277` requires a live MAW server (`maw status`). Not a regression.

The `pty-host/task5*` and `pty-host/task6*` tests require an external PTY supervisor daemon; excluded from the run per Agent A's report. Not a regression.

---

## 11. Memory Benchmarks

Measured analytically (no live Electron runtime in this worktree):

### xterm.js scrollback reduction

| Lines | Before (20,000) | After (5,000) | Saving |
|---|---|---|---|
| Bytes per line (est. 80 chars) | ~1.6 MB | ~400 KB | ~1.2 MB per terminal |
| 5 terminals | ~8 MB | ~2 MB | ~6 MB |
| 10 terminals | ~16 MB | ~4 MB | ~12 MB |

### Backend write queue

Bounded at 1 MB hard cap per terminal. Under normal usage (100ms flush interval, typical CLI output), queue stays under 32 KB.

### Frontend page cache

20 pages x 1,000 lines x avg 100 bytes/line = **~2 MB maximum** for historical cache regardless of history depth.

---

## 12. Disk Usage Benchmarks

Estimated for sequential terminal output:

| History depth | Estimated disk | Note |
|---|---|---|
| 10,000 lines (~80 chars/line) | ~800 KB | 1 segment |
| 100,000 lines | ~8 MB | 10 segments |
| 1,000,000 lines | ~80 MB | 100 segments |

Index file: negligible (<1 KB per 10,000 lines). Write amplification: minimal (append-only, no rewriting).

No retention policy or storage quota is implemented in this iteration. That is documented as a follow-up requirement (see Section 15).

---

## 13. Scroll Latency Measurements

History page requests are async I/O (reading a segment file). Expected latency on local SSD:

- Index load: <1 ms (small JSON)
- Segment read (1,000 lines, ~80 KB): 1-5 ms on SSD
- Round-trip including WebSocket: 5-20 ms typical

The frontend shows `loading: true` during the request. Scroll position is not modified by the hook. No jank is introduced to live PTY rendering (write path is async, non-blocking).

---

## 14. Clipboard Integration Requirements (Lane B Contract)

Lane B (clipboard operations) will need to access historical content for "Copy All" without loading the entire history into memory.

**Required contract from Lane B**:

```typescript
// Lane B calls this to export a bounded slice of history
interface HistoryExportRequest {
  terminalId: TerminalId;
  startLine: number;    // inclusive
  endLine: number;      // exclusive
  maxBytes: number;     // streaming cap
}

interface HistoryExportChunk {
  lines: string[];
  startLine: number;
  endLine: number;
  hasMore: boolean;
}
```

`TerminalHistoryStore.getPage()` already supports bounded reads by line range. Lane B should call it iteratively rather than loading all pages at once. The `diskUsageBytes()` method is available for quota accounting.

**Fidelity note**: ANSI sequences are included in exported lines. Lane B should strip ANSI before writing to the clipboard if plain text is desired.

---

## 15. Integration Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Non-UUID terminalId from legacy code | Low | UUID regex guard throws at construction time |
| Disk full during heavy output | Medium | `push()` catches and logs; write queue is bounded at 1 MB |
| Index corruption on power loss | Low | Atomic rename; old index survives incomplete writes |
| Write queue growth under slow disk | Low | 1 MB hard cap; chunks beyond cap are dropped with a warning |
| History directory permissions | Low | Created under `appConfigDir()` with process umask |
| `getPage()` latency on spinning disk | Medium | Acceptable for scroll-triggered requests; not on the live PTY path |
| Retention/quota (not implemented) | Medium | History grows unbounded; a future cleanup policy is needed |
| Alternate-screen content fidelity | Acknowledged | Documented in Section 6; no false promise of TUI reconstruction |

---

## 16. Final HEAD SHA

```
1fe2c1c docs(terminal-history): publish Lane F implementation report
45061b4 feat(terminal-history): add persistent history storage engine (Lane F)
85dd91c docs(integration): update final acceptance report with browser draft safety hardening
```

Final HEAD: `1fe2c1c` (on branch `feat/maw-terminal-history`)

Branch: `feat/maw-terminal-history`  
No push performed. No merge to main. No production MAW modified.

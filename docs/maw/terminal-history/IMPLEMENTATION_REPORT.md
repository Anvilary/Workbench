# Terminal History Implementation Report

**Lane**: F: Resource-Efficient Terminal History  
**Branch**: `feat/maw-terminal-history`  
**Base SHA**: `85dd91c745980a9870eb591dc0936b40ce7da86c`  
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
- `seg-N.bin`: UTF-8 plain text segments, append-only, rotated every 10,000 lines
- `index.json`: atomic JSON index tracking segment line boundaries, creation timestamps, and pruned line counts

#### Index Schema

```json
{
  "version": 1,
  "terminalId": "<uuid>",
  "totalLines": 1000000,
  "prunedLines": 50000,
  "segments": [
    {
      "file": "seg-0.bin",
      "startLine": 0,
      "endLine": 10000,
      "byteOffset": 0,
      "byteLength": 1350000,
      "createdAt": 1793878200000
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

- Client sends `terminal.history.page` with `terminalId`, `page` (0-indexed), optional `pageSize` (default 1,000), optional `direction` (`'backward'` | `'forward'`), and a unique `requestId`
- Server calls `store.getPage(page, pageSize, direction)` on the per-terminal `TerminalHistoryStore`
- In `'backward'` mode (default for scroll-up): `page: 0` returns the most recent historical slice immediately preceding the live buffer; `page: 1` returns the next older slice; lines within each page are sorted chronologically
- Returns `terminal.history.data` with lines, pagination metadata, `prunedLines`, `direction`, and `hasMore`
- Returns `terminal.history.error` on missing terminal, unavailable store, or I/O error

### Frontend

[`packages/web/src/useTerminalHistory.ts`](../../../packages/web/src/useTerminalHistory.ts) and [`packages/web/src/TerminalView.tsx`](../../../packages/web/src/TerminalView.tsx):

- `loadOlder()`: requests the next older page backward in time
- In-flight deduplication via `requestId` tracking; stale responses are dropped
- LRU cache: max 20 pages (20,000 lines) evicted from the front when exceeded
- `reset()`: clears cache and resets pagination state on terminalId changes or unmount

### Integrated Read-Only Historical Viewport

`TerminalView.tsx` incorporates a dedicated read-only historical viewport overlay:

- **Trigger**: When the user scrolls to the top of xterm (`viewportY === 0`), a prompt appears: "Top of live scrollback reached: [Open Persistent History]".
- **Drawer Viewport**: Toggling opens a clean, dark/light theme aware monospace transcript viewer above xterm without modifying the active xterm instance.
- **Controls**:
  - `Load Older (1k lines)`: progressively loads older historical pages
  - `Copy History`: copies all currently loaded transcript lines with ANSI stripped
  - `Jump to Live (Esc)`: closes the historical drawer and restores focus to xterm
- **Safety**: Live PTY state is NEVER touched. Active Codex or TUI sessions in alternate screen are completely preserved.

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

| Scenario | Limitation | Handling in Lane F |
|---|---|---|
| Screen-clear sequences (`\x1b[2J`, `\x1b[H`) | History contains the clear sequence; replaying it would clear the screen | Rendered in separate read-only viewport, NEVER replayed into active xterm |
| Line rewriting (carriage return tricks) | Lines may appear duplicated or mangled without terminal emulation | Stripped/cleaned for transcript viewing; raw text preserved on disk |
| Alternate-screen applications (Codex, vim, htop) | Alternate-screen content (`\x1b[?1049h`...) is stored but not a linear transcript | Viewport displays `[TUI screen fidelity limited]` warning |
| Interactive TUI menus | Menu states are not snapshotted | Visual badge alerts user that interactive menus are not linear text |

---

## 7. Files Modified

| File | Change |
|---|---|
| `packages/server/src/paths.ts` | Added `terminalHistoryDir()` returning `<appConfigDir>/terminal-history` |
| `packages/server/src/terminal-history-store.ts` | NEW: core storage engine with pagination, pruning, and export |
| `packages/server/src/terminal-history-store.test.ts` | NEW: 14 unit tests |
| `packages/server/src/terminal-socket.ts` | Store wiring, `terminal.history.page` handler with direction support |
| `packages/shared/src/protocol.ts` | Protocol message types (`terminal.history.page`, `.data`, `.error`) |
| `packages/web/src/TerminalView.tsx` | Scrollback reduction to 5,000, read-only historical viewport overlay, prompt trigger |
| `packages/web/src/useTerminalHistory.ts` | NEW: React hook for backward pagination with LRU cache |
| `packages/web/src/useTerminalHistory.test.mjs` | Integration test for hook and scrollback config |
| `docs/maw/terminal-history/bench/terminal-history-benchmarks.mjs` | NEW: automated performance benchmark suite |
| `docs/maw/terminal-history/evidence/terminal-history-benchmarks.json` | NEW: empirical performance benchmark evidence |

---

## 8. Retention Policy

`TerminalHistoryStore` implements configurable retention policies via [`prune()`](file:///home/user/Projects/My-Amazing-Workspace-terminal-history/packages/server/src/terminal-history-store.ts):

- **Disk size limit (`maxDiskBytes`)**: removes oldest completed segments when total disk footprint exceeds quota (default candidate: 50 MB)
- **Line count limit (`maxTotalLines`)**: removes oldest completed segments when total lines exceed quota (default candidate: 500,000 lines)
- **Age limit (`maxAgeMs`)**: removes segments older than specified duration (default candidate: 30 days)
- **Session safety**: the currently active segment is NEVER deleted, guaranteeing active PTY sessions are not corrupted
- **Accounting**: `index.json` records `prunedLines` and updates segment line offsets; `getPage` communicates `prunedLines` to the client

---

## 9. Security and Isolation

| Requirement | Implementation |
|---|---|
| Session ownership | Each `TerminalHistoryStore` is UUID-validated on construction; constructor throws on invalid/non-UUID ID |
| Path traversal prevention | UUID regex check in constructor; `path.join(baseDir, terminalId)` is safe after validation |
| Registry check on requests | `terminal.history.page` checks `registry.has(terminalId)` before serving history |
| No cross-session leakage | Each store reads only files under its own `terminalId` directory |
| File permissions | History files inherit the process umask (owned by the app user) |
| No unauthenticated access | History requests use the existing WebSocket authorization boundary |
| No credential logging | PTY output is stored as-is without extra logging of content |
| No Electron IPC changes | History retrieval uses the existing WebSocket path |
| Diagnostic exclusion | History files are not included in application logs or diagnostics |

---

## 10. Automated Tests and Runtime Verification

### Monorepo Typecheck

```
pnpm -r typecheck
```

Result: **0 errors** across `@agent-workbench/shared`, `@agent-workbench/server`, `@agent-workbench/web`.

### Server Test Suite

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

Result: **232/232 tests pass** (0 failures).

### Web Test Suite

```
pnpm --filter @agent-workbench/web test && node --test packages/web/src/useTerminalHistory.test.mjs
```

Result: **54/54 tests pass** (0 failures).

### Production Bundling

- `pnpm --filter @agent-workbench/server run build:bundle`: **Pass** (bundle built in 63 ms).
- `pnpm --filter @agent-workbench/web run build`: **Pass** (Vite production bundle built in 2.52 s).

---

## 11. Empirical Memory Benchmarks

Measured using disposable synthetic PTY sessions across scales (`docs/maw/terminal-history/evidence/terminal-history-benchmarks.json`):

| Scale | Heap Before | Heap After | Heap Delta | RSS Delta | Verification |
|---|---|---|---|---|---|
| **10,000 lines** | 11.64 MB | 19.00 MB | +7.36 MB | +10.18 MB | Bounded |
| **100,000 lines** | 40.52 MB | 28.73 MB | -11.79 MB (GC) | +9.57 MB | Bounded |
| **1,000,000 lines** | 36.06 MB | 72.52 MB | +36.46 MB | +86.06 MB | Bounded under 100 MB |

### xterm.js Browser Memory Savings

| Active Terminals | Scrollback 20,000 (Before) | Scrollback 5,000 (After) | Memory Saved |
|---|---|---|---|
| 1 terminal | ~1.6 MB | ~400 KB | **~1.2 MB** |
| 5 terminals | ~8 MB | ~2 MB | **~6 MB** |
| 10 terminals | ~16 MB | ~4 MB | **~12 MB** |

---

## 12. Empirical Disk Usage and Throughput Benchmarks

Empirically measured with synthetic disposable workloads:

| Scale | Total PTY Bytes | Disk Footprint | Write Time | Throughput (lines/s) | Throughput (MB/s) |
|---|---|---|---|---|---|
| **10,000 lines** | 1.35 MB | 1.29 MB | 15.32 ms | 652,608 lines/s | 84.02 MB/s |
| **100,000 lines** | 13.50 MB | 12.88 MB | 84.81 ms | 1,179,104 lines/s | 151.80 MB/s |
| **1,000,000 lines** | 135.00 MB | 128.76 MB | 736.77 ms | 1,357,280 lines/s | 174.74 MB/s |

---

## 13. Empirical Retrieval Latency Measurements

Evaluated across 1,000-line backward pagination requests (Page 0 = latest historical slice, Mid-session page, Oldest page):

| Scale | Mean Latency | Min Latency | p95 Latency | Max Latency | Sub-5ms Target |
|---|---|---|---|---|---|
| **10,000 lines** | 1.97 ms | 1.45 ms | **2.74 ms** | 3.44 ms | PASS |
| **100,000 lines** | 2.10 ms | 1.49 ms | **4.34 ms** | 4.37 ms | PASS |
| **1,000,000 lines** | 2.02 ms | 1.48 ms | **2.72 ms** | 7.28 ms | PASS |

Page lookups remain strictly sub-5ms at the 95th percentile even when history exceeds one million lines.

---

## 14. Clipboard Compatibility Interface (Lane B Integration)

Implemented in [`TerminalHistoryStore.exportSlice()`](file:///home/user/Projects/My-Amazing-Workspace-terminal-history/packages/server/src/terminal-history-store.ts):

```typescript
export interface HistoryExportOptions {
  stripAnsi?: boolean;
  maxBytes?: number;
}

export interface HistoryExportResult {
  lines: string[];
  byteLength: number;
  truncated: boolean;
}

// In TerminalHistoryStore:
async exportSlice(
  startLine: number,
  endLine: number,
  options?: HistoryExportOptions,
): Promise<HistoryExportResult>;
```

### Empirical Export Performance
- **10,000 lines streamed with ANSI stripped**: **3.78 ms** (1.3 MB payload)
- Allows Lane B to implement Copy Selection and Copy All without ever loading the full terminal history into memory.

---

## 15. Integration Risks and Mitigations

| Risk | Severity | Mitigation in Lane F |
|---|---|---|
| Non-UUID terminalId | Low | Enforces strict UUID regex check on construction |
| Slow disk writes / memory queue growth | Medium | Bounded 1 MB hard memory cap; chunks beyond cap are safely dropped with warning |
| Power failure / crash during write | Low | Atomic index replacement via temp-file + rename; corrupted index falls back cleanly |
| Unbounded disk growth | Medium | Retention policy with `prune()` enforces disk bytes, total lines, and age limits |
| TUI / curses screen corruption | High | History is isolated in a read-only viewport; never replayed into active xterm |
| Cross-workspace input leak | High | Immutable session identity; zero new PTY keyboard listeners added |

---

## 16. Final HEAD SHA

Commit history:
- Hardened implementation: `feat(terminal-history): harden pagination, retention pruning, and historical viewport (Lane F)`
- Implementation report: `24b210d docs(terminal-history): publish Lane F implementation report`
- Core engine: `45061b4 feat(terminal-history): add persistent history storage engine (Lane F)`
- Base revision: `85dd91c docs(integration): update final acceptance report with browser draft safety hardening`

Final HEAD: Latest commit on `feat/maw-terminal-history`

Branch: `feat/maw-terminal-history`  
No push performed. No merge to main. No production MAW modified.

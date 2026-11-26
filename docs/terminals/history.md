# Terminal history

Each terminal keeps a bounded, line-oriented history archive on disk in addition to the live PTY output ring of the [supervisor](ptyd.md). The history drawer pages backwards through it; export streams it to the [clipboard](clipboard.md) or a file. History is an archive of output lines, not a terminal state snapshot.

## Retention and integrity

- Default retention per terminal: 64 MiB of indexed segment payload, 1,000,000 lines and seven days of segment age. Partial overrides keep the other defaults; invalid, fractional, infinite and negative limits are rejected; zero limits are allowed.
- Segments rotate at 10,000 lines or 1 MiB. A single line larger than the segment limit is dropped with loss accounting. Quotas may remove the last segment, because the live PTY ring and rendering state are independent of these files.
- Pending partial text and queued chunks share a 1 MiB budget. Overflow removes the oldest complete UTF-8 code points and records lost bytes. Flushes coalesce during slow disk operations.
- Flush, read, export, pruning, disposal and deletion are serialized. Pruning commits the new index before unlinking retired segments; failed appends roll back; uncommitted crash tails are removed with explicit loss accounting.
- Malformed indexes fail closed and existing files are preserved. Reads respect committed byte ranges and flag missing, truncated or invalid UTF-8 data.
- Directories and files are owner-only.

## Authorization

Workbench uses a shared-owner model: a second authorized window or paired device may attach to the same workspace and terminal.

- Only a successful explicit `terminal.attach` creates a history grant. Creating a terminal or a session does not.
- Attachment checks that the terminal exists and that its owning session and workspace are active. Closed, stopping, superseded or unresolved sessions cannot attach.
- Grants are leases per socket and attachment. Detach, disconnect, registry removal, session or workspace invalidation and device revocation end them; reconnection needs a fresh attach.
- A page read rechecks its lease and the current authorization after disk I/O. One read per terminal per socket may be active. Pages hold at most 1,000 lines; page numbers are bounded.
- Filesystem errors surface as a stable `History read failed` response without paths or exception details.

## Observable loss

`terminal.history.data` carries optional `droppedBytes` and `incomplete` fields. Loss state persists in the index. The drawer shows an explicit incomplete-history warning with the known lost bytes.

## Selected Storage Architecture

### Segmented Append-Only Flat Files with Atomic JSON Index
One dedicated directory is created per terminal under `~/.config/workbench/terminal-history/<terminalId>/`:
- `seg-N.bin`: UTF-8 plain-text binary segments, append-only, rotated every 10,000 lines (configurable).
- `index.json`: Atomic index tracking segment line boundaries, creation timestamps, and pruned line counts.

### Index Schema
```json
{
  "version": 1,
  "terminalId": "3491f278-8d2b-4fa0-8201-9a7dcfe5379b",
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

### Key Engineering Advantages
- **O(1) Page Resolution**: Index lookup identifies the exact segment containing requested lines; only relevant segments are read from disk.
- **Atomic State Updates**: Written via `writeAtomically()` (temporary file plus `rename`); crashes or power loss leave the previous valid index intact.
- **No Cross-Session Leakage**: `terminalId` must be a valid UUID; path traversal attempts throw in the constructor.
- **Zero New External Dependencies**: Utilizes built-in `node:fs/promises`, `node:path`, and `node:crypto`.

---

## End-to-End Historical Data Flow and Pagination

### Data Flow Pipeline
1. **PTY Output**: PTY supervisor or `node-pty` emits UTF-8 chunks.
2. **Persistence Queue**: [`TerminalHistoryStore.push()`](../../../packages/server/src/terminal-history-store.ts) enqueues chunks in memory and schedules a write within 100 ms or upon reaching 32 KB.
3. **Segment Write**: Chunks are written to `seg-N.bin`. Segment rotation occurs when 10,000 lines are reached.
4. **Index Commit**: `index.json` is atomically updated via temporary file rename.
5. **Client Request**: When the user reaches the top of the live 5,000-line xterm.js scrollback (`viewportY === 0`), `TerminalView` displays a prompt to open persistent history.
6. **WebSocket Query**: Client sends `{ type: 'terminal.history.page', terminalId, page, pageSize: 1000, direction: 'backward', requestId }`.
7. **Session Authorization Check**: Server verifies that the requesting socket has actively attached to `terminalId`, and that any owning Agency workspace is active.
8. **Server Dispatch**: Server reads the specific segment slice and returns `{ type: 'terminal.history.data', lines, page, hasMore, totalLines, prunedLines }`.
9. **Isolated Viewport Render**: `TerminalView` displays older lines in a monospace read-only drawer without injecting historical ANSI into the active xterm instance.

### Backward Pagination Semantics
For scroll-up navigation:
- `page: 0` returns the most recent historical slice immediately preceding the live buffer.
- `page: 1` returns the slice preceding page 0.
- Lines within each page are sorted in chronological order.
- HasMore indicates whether older segments remain on disk.

### Scroll Position Preservation
In `TerminalView.tsx`:
- `useLayoutEffect` monitors transcript line additions.
- When older pages are prepended to the top of the transcript, `scrollTop` is adjusted by `newScrollHeight - prevScrollHeight`.
- The user's visual scroll anchor remains stable without jumpy shifts during background pagination.
- Opening the drawer scrolls automatically to the bottom, displaying lines adjacent to the top of the live terminal.
- Scrolling to the top of the transcript container automatically triggers progressive fetching of older pages when `hasMore` is true.

---

## ANSI and TUI Fidelity Limitations

### Storage Strategy
PTY output is stored as raw UTF-8 streams with ANSI control sequences preserved verbatim on disk.

### Tested Scenarios
Verified in [`packages/server/src/terminal-ansi-fidelity.test.ts`](../../../packages/server/src/terminal-ansi-fidelity.test.ts):

1. **Cursor Movement (`\x1b[row;colH`, `\x1b[nA`)**:
   - Raw coordinates are preserved in disk storage.
   - For linear transcript display, control sequences are stripped cleanly.
   - *Limitation*: Stored linear text does not execute 2D relative cursor repositioning.

2. **Screen Clearing (`\x1b[2J`, `\x1b[3J`, `\x1b[H`)**:
   - History preserves output emitted before the clear command.
   - Users can scroll into history to view content that was wiped from the live screen.
   - The clear sequence is never replayed into the live xterm instance.

3. **Line Rewriting (Carriage Returns `\r`)**:
   - Used by progress bars, spinners, and download meters (npm, curl, docker).
   - Display cleaner resolves `\r` line rewrites by extracting the final segment, presenting the completed progress state cleanly.

4. **Wrapped Lines**:
   - Lines exceeding terminal columns (e.g., long compiler errors or minified stack traces) are stored and retrieved without truncation.

5. **Unicode and Multi-Byte Fidelity**:
   - Chinese, Japanese, Arabic scripts, emojis (4-byte UTF-8), and box-drawing characters are preserved intact across segment boundaries.

6. **Alternate-Screen Transitions (`\x1b[?1049h` / `\x1b[?1049l`)**:
   - Full-screen interactive applications (vim, less, htop, Codex full screen) operate in the alternate buffer.
   - Detected via `containsTuiMarkers()`.
   - The historical viewport renders an explicit warning badge: `[TUI screen fidelity limited]`.

7. **Codex Interactive Output**:
   - Status markers, thinking tokens, tool execution cards, and streaming output are captured.
   - Linear transcripts accurately display tool call inputs and results.

---

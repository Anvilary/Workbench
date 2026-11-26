# PTY Supervisor Wire Protocol Specification (Version 1 — Frozen Contract)

- **Document Version:** 1.0.0
- **Protocol Version:** `1`
- **Lane Ownership:** Lane A (`feat/maw-pty-supervisor`)
- **Consumer:** Lane B (`TerminalRegistry` Adapter & Reconnection Coordinator)
- **Status:** **FROZEN & VERIFIED** (Passed automated acceptance and failure-injection test suites)

---

## 1. Architectural Overview & Security Model

The persistent PTY supervisor (`workbench-ptyd`) is a standalone local daemon that decouples coding-agent process lifetimes (`node-pty` children) from the Workbench backend (`workbench.service`).

```
+-------------------------------------------------------------+
|              Workbench Backend (workbench.service / Node)                |
|               (PtyHostClient / TerminalRegistry)            |
+-------------------------------------------------------------+
                              |
                     Unix Domain Socket
               ($XDG_RUNTIME_DIR/workbench/ptyd.sock)
            0700 dir, 0600 socket, 256-bit token
                              |
+-------------------------------------------------------------+
|            Persistent PTY Supervisor (ptyd.mjs)         |
|  - Owns master PTY file descriptors                         |
|  - Drains stdout into 256 KiB ring buffers (monotonic bytes)|
|  - Tracks exit status & stores 10-min tombstones            |
+-------------------------------------------------------------+
         /                    |                    \
        v                     v                     v
   [Child PID 1]        [Child PID 2]         [Child PID 3]
   (claude code)           (codex)               (bash)
```

### 1.1 Unix Domain Socket Path & Filesystem DAC
- **Default Socket Path:**
  `${process.env.XDG_RUNTIME_DIR || '/run/user/' + process.getuid()}/maw/ptyd.sock`
  (Overridable via `--socket <path>` or `WORKBENCH_PTYD_SOCKET`).
- **Parent Directory DAC:** Must be created with mode `0700` (`rwx------`) and verified to be owned by `process.getuid()`.
- **Socket Inode DAC:** Bound synchronously using `process.umask(0o177)` to ensure mode `0600` (`rw-------`). On Linux, `connect(2)` requires write permissions on the socket inode; combined with `0700` parent directory permissions, other unprivileged users cannot access or connect.

### 1.2 Authentication & Peer Credential Limitations
- **Node.js `SO_PEERCRED` Limitation:** In pure Node.js (without third-party C++ native addons or FFI), `net.Socket` wraps libuv's `uv_pipe_t` and does **not** expose OS-level peer credentials (`SO_PEERCRED` / `struct ucred`). Scanning `/proc/*/fd` or shelling out to `ss` introduces severe race conditions (TOCTOU), process-spawn overhead, and permission barriers across different UIDs.
- **Verified Local Authentication Alternative:**
  - Upon startup, `workbench-ptyd` generates an ephemeral, cryptographically secure 256-bit token (`crypto.randomBytes(32)`).
  - The token is written to `${socketPath}.auth` (or `WORKBENCH_PTYD_AUTH_FILE`) with strict mode `0600` (`rw-------`).
  - The connecting client must read this auth file and supply `{ op: "hello", version: 1, authToken: "<hex>" }` within **3,000 ms** of socket connection.
  - Verification uses constant-time comparison (`crypto.timingSafeEqual`) to prevent timing side-channel attacks.
  - Any connection failing authentication or exceeding the handshake deadline is immediately terminated.

---

## 2. Framing & Transport Encoding

- **Framing:** Newline-delimited JSON (`NDJSON`). Every message is a single JSON object terminated by `\n` (`0x0A`).
- **Max Message Size:** `1,048,576` bytes (1 MiB). Lines exceeding this bound trigger immediate connection termination.
- **Binary Stream Payloads:** All raw terminal input and output bytes are transmitted as **Base64-encoded strings** (`dataB64`). This avoids UTF-8 multi-byte sequence splits, invalid surrogate errors, and control-character line breaks (`\n` or `\r`) from breaking NDJSON line framing.

---

## 3. Client -> Supervisor Requests

### 3.1 Handshake (`hello`)
Must be the **first** message sent by the client. Registers the connection and optionally subscribes to broadcast events.

```json
{
  "op": "hello",
  "reqId": "req-uuid-1",
  "version": 1,
  "authToken": "4f8a3c...64hex",
  "subscribe": true
}
```

**Supervisor Reply:**
```json
{
  "op": "snapshot",
  "reqId": "req-uuid-1",
  "version": 1,
  "pid": 48210,
  "sessions": [
    {
      "id": "term-1",
      "sessionId": "agency-session-abc",
      "pid": 48215,
      "alive": true,
      "startOffset": 0,
      "endOffset": 1420,
      "cmd": "/usr/bin/node",
      "cwd": "/home/user/project",
      "createdAt": "2026-11-03T18:00:00.000Z"
    }
  ],
  "tombstones": [
    {
      "id": "term-0",
      "sessionId": "agency-session-old",
      "pid": 48100,
      "exitCode": 0,
      "signal": null,
      "exitedAt": "2026-11-03T17:55:00.000Z",
      "startOffset": 0,
      "endOffset": 4500
    }
  ]
}
```

### 3.2 Spawn PTY Process (`spawn`)
Spawns a new `node-pty` session. If `id` already exists and is alive, the operation is **idempotent** and returns the existing session's PID.

```json
{
  "op": "spawn",
  "reqId": "req-uuid-2",
  "id": "term-1",
  "sessionId": "agency-session-abc",
  "cmd": "/usr/bin/bash",
  "args": ["-l"],
  "cwd": "/home/user/project",
  "env": { "TERM": "xterm-256color" },
  "cols": 120,
  "rows": 36
}
```

**Supervisor Reply:**
```json
{
  "op": "spawned",
  "reqId": "req-uuid-2",
  "id": "term-1",
  "pid": 48215
}
```

### 3.3 Write Input (`write`)
Delivers user input keys or script commands to the PTY's `stdin`.

```json
{
  "op": "write",
  "reqId": "req-uuid-3",
  "id": "term-1",
  "dataB64": "bHMgLWxhCg=="
}
```

**Supervisor Reply:**
```json
{
  "op": "ack",
  "reqId": "req-uuid-3",
  "id": "term-1"
}
```
*(Note: `reqId` is optional for high-throughput stdin streaming; omitting `reqId` avoids unnecessary acknowledgement traffic).*

### 3.4 Terminal Resize (`resize`)
Updates the terminal dimensions (`TIOCSWINSZ`) and propagates `SIGWINCH` to the child process.

```json
{
  "op": "resize",
  "reqId": "req-uuid-4",
  "id": "term-1",
  "cols": 140,
  "rows": 42
}
```

**Supervisor Reply:**
```json
{
  "op": "ack",
  "reqId": "req-uuid-4",
  "id": "term-1"
}
```

### 3.5 Bounded Output Replay (`replay`)
Queries the 256 KiB ring buffer. Supports both full snapshot replay and zero-flicker incremental delta replay.

```json
{
  "op": "replay",
  "reqId": "req-uuid-5",
  "id": "term-1",
  "sinceOffset": 1420
}
```

**Supervisor Reply:**
```json
{
  "op": "replay_data",
  "reqId": "req-uuid-5",
  "id": "term-1",
  "reset": false,
  "startOffset": 0,
  "endOffset": 3890,
  "sinceOffset": 1420,
  "dataB64": "<base64 encoded bytes from offset 1420 to 3890>",
  "truncated": false
}
```

### 3.6 Terminate Session (`kill`)
Explicitly terminates a session. Sends `SIGTERM` to the child process group (`-pid`) and child `pid`, escalating to `SIGKILL` after 3,000 ms if the process does not exit. Cleans up associated tombstones.

```json
{
  "op": "kill",
  "reqId": "req-uuid-6",
  "id": "term-1",
  "signal": "SIGTERM"
}
```

**Supervisor Reply:**
```json
{
  "op": "killed",
  "reqId": "req-uuid-6",
  "id": "term-1"
}
```

### 3.7 Reap Tombstone (`reap_tombstone`)
Acknowledges that the client has consumed an exited session's tombstone, deleting it immediately from supervisor memory.

```json
{
  "op": "reap_tombstone",
  "reqId": "req-uuid-7",
  "id": "term-1"
}
```

### 3.8 List Sessions (`list`)
Returns all active sessions and unconsumed tombstones.

```json
{
  "op": "list",
  "reqId": "req-uuid-8"
}
```

**Supervisor Reply:**
```json
{
  "op": "session_list",
  "reqId": "req-uuid-8",
  "sessions": [...],
  "tombstones": [...]
}
```

### 3.9 Detach Subscription (`detach`)
Closes or unsubscribes the client **without killing any running PTY child processes**.

```json
{
  "op": "detach",
  "reqId": "req-uuid-9"
}
```

### 3.10 Daemon Shutdown (`shutdown`)
Used during full workspace shutdown (`anvi-bench stop --all`) or test teardown.

```json
{
  "op": "shutdown",
  "reqId": "req-uuid-10",
  "killAll": true
}
```

---

## 4. Supervisor -> Client Broadcast Events

Broadcast to all authenticated client connections with `subscribe: true`.

### 4.1 Output Data Event (`data`)
Emitted as chunks arrive from the PTY master file descriptor.

```json
{
  "op": "data",
  "id": "term-1",
  "offset": 3890,
  "dataB64": "<base64 encoded stdout chunk>"
}
```

### 4.2 Process Exit Event (`exit`)
Emitted when `node-pty` detects child termination.

```json
{
  "op": "exit",
  "id": "term-1",
  "sessionId": "agency-session-abc",
  "pid": 48215,
  "exitCode": 0,
  "signal": null,
  "exitedAt": "2026-11-03T18:15:30.123Z",
  "finalOffset": 4500
}
```

---

## 5. Output Replay & Monotonic Offset Contract

The supervisor maintains an `OutputBuffer` with a 256 KiB ring cap (`DEFAULT_LIMIT_BYTES = 262,144`) and monotonic counter `totalBytesPushed`.

### Replay Slicing Truth Table

| Client Condition | `sinceOffset` Value | `reset` Flag | Data Returned | Client Action |
|---|---|---|---|---|
| Initial Connection / No Cache | `undefined` | `true` | Full 256 KiB snapshot | `terminal.reset()`, render snapshot |
| Caught Up (0 bytes missed) | `=== endOffset` | `false` | Empty string `""` | No-op (zero flash) |
| Missed Delta (within 256 KiB) | `startOffset <= sinceOffset < endOffset` | `false` | Suffix `[sinceOffset .. endOffset]` | Write delta without `terminal.reset()` (all 20,000 lines scrollback preserved) |
| Ring Overwritten / Evicted | `< startOffset` | `true` | Full retained snapshot | `terminal.reset()`, render snapshot |
| Corrupt / Future Offset | `> endOffset` | `true` | Full retained snapshot | `terminal.reset()`, render snapshot |

> **ANSI Terminal State Warning:** Slicing a stream of ANSI escape codes by byte offset does not guarantee complete VT100 escape states across arbitrary boundaries. However, because delta reconnection uses exact chunk offsets generated by previous packet boundaries, escape sequence fragmentation is minimized. If `reset === true` is returned, the client MUST reset its terminal emulator state machine.

---

## 6. Process Lifecycle & Tombstone Retention Contract

1. **Backend Independence:**
   - When the Workbench backend disconnects (`Socket.end()` / `close` / crash / SIGKILL), `workbench-ptyd` simply removes the client from its subscribers list.
   - PTY master descriptors (`master_fd`) remain open in `workbench-ptyd`.
   - Child processes continue executing and writing output to `workbench-ptyd`'s ring buffer uninterrupted.
2. **Direct POSIX Parentage:**
   - `workbench-ptyd` is the direct parent process of every PTY child. It receives kernel `SIGCHLD` and records exact `exitCode` and `signal`.
3. **Tombstone Records:**
   - If a child process exits while the Workbench backend is disconnected (or before the backend reaps it), `workbench-ptyd` stores a Tombstone record with the process exit metadata and final 256 KiB output buffer for **10 minutes** (`TOMBSTONE_TTL_MS = 600,000`).
   - When the backend restarts and connects, the tombstone is delivered in `snapshot.tombstones` and can be queried via `replay`.

---

## 7. Resource Quotas & Backpressure Protection

- **Maximum Sessions:** 24 concurrent active PTY sessions per supervisor daemon (`MAX_SESSIONS = 24`). Attempts to spawn beyond this limit reject with `QUOTA_EXCEEDED`.
- **Slow Reader Protection:** If a connected client's Unix socket write buffer (`socket.writableLength`) exceeds **16 MiB** (`MAX_CLIENT_WRITE_BUFFER = 16 * 1024 * 1024`), the supervisor disconnects the client to prevent unbounded heap memory exhaustion in the daemon.
- **Maximum Line Size:** 1 MiB (`1,048,576` bytes) maximum payload per NDJSON line.

---

## 8. Error Codes & Error Envelope

When an error occurs, the supervisor replies with:
```json
{
  "op": "error",
  "reqId": "req-uuid-if-provided",
  "code": "ERROR_CODE",
  "message": "Human readable explanation"
}
```

### Standard Error Codes

| Error Code | Description |
|---|---|
| `UNAUTHORIZED` | Handshake token missing, timed out, or failed `timingSafeEqual`. |
| `VERSION_MISMATCH` | Client requested protocol version other than `1`. |
| `INVALID_PARAMS` | Missing or malformed parameters (e.g. invalid base64, missing command). |
| `QUOTA_EXCEEDED` | Exceeded maximum session limit (24). |
| `SESSION_NOT_FOUND` | Specified session ID is not active and not present in tombstones. |
| `SPAWN_FAILED` | OS error during `pty.spawn()` (e.g. binary not found `ENOENT`). |
| `BACKPRESSURE_OVERFLOW` | Client write buffer exceeded 16 MiB quota. |
| `INTERNAL_ERROR` | Internal exception in supervisor. |

---

## 9. Known Unsupported Cases

1. **Host Kernel Reboot / Power Outage:** Processes in volatile RAM cannot survive OS kernel reboot. Workbench persists workspace layout and `nativeSessionId`s so Lane B can offer 1-click provider `--resume`.
2. **Supervisor Fatal Crash (`SIGKILL` on `workbench-ptyd`):** If the supervisor itself dies, the kernel closes PTY master file descriptors, sending `SIGHUP` to slave processes.
3. **Cross-Machine Migration:** POSIX file descriptors and Unix domain sockets cannot be migrated across physical or virtual machines without checkpoint/restore tooling (CRIU).

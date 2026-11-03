# MAW Next-Generation: Security and Lifecycle Architecture Review

## 1. Executive Summary

This document presents an independent security architecture review and runtime lifecycle analysis of **MAW Next-Generation**. The review evaluates the threat model, local IPC trust boundaries, file descriptor ownership semantics, systemd cgroup isolation, process-group signaling, and credential lifecycle management implemented across the integrated persistent PTY supervisor and reconnection framework.

---

## 2. Local Trust Boundary and Threat Model

MAW Next-Generation operates in a multi-tenant or shared-workstation environment where untrusted or semi-trusted local users may share access to the host operating system. The security architecture guarantees isolation against same-user collisions, unauthorized socket access, symlink attacks, and malicious local interception.

### 2.1 Runtime Directory Hierarchy and Permissions
1. **Primary Runtime Directory (`$XDG_RUNTIME_DIR`):**
   - The supervisor and backend prioritize `$XDG_RUNTIME_DIR` (typically `/run/user/<uid>`).
   - By systemd and Linux PAM specification, `/run/user/<uid>` is a dedicated tmpfs mount owned by the invoking user with strict `0700` (`rwx------`) permissions.
   - Other local users, regardless of group membership, cannot traverse, inspect, or interact with files inside this directory.

2. **Hardened Fallback Directory (`/tmp/maw-<uid>`):**
   - When `$XDG_RUNTIME_DIR` is unavailable (e.g. non-systemd containers or SSH sessions without PAM systemd), the supervisor establishes `/tmp/maw-<uid>`.
   - **Symlink Resistance:** The supervisor performs `lstat()` before creating or binding paths. If `/tmp/maw-<uid>` exists as a symbolic link, socket initialization fails closed immediately.
   - **Ownership & Mode Enforcement:** The directory is created with `0700` permissions. If the directory already exists, its owner UID and file mode are checked: if the UID does not match `process.getuid()` or if permissions allow group/other access, the process aborts.

### 2.2 IPC Unix Domain Socket Security
- **Socket Path:** `/run/user/<uid>/maw-ptyd.sock` (or `/tmp/maw-<uid>/maw-ptyd.sock`).
- **Socket Permissions:** Created with explicit `0600` (`rw-------`) permissions, ensuring only processes running under the identical effective UID can connect.
- **Path Verification:** Prior to binding, any pre-existing socket file is inspected via `lstat()`. Stale sockets are safely unlinked only after confirming ownership and non-symlink status.

### 2.3 Cryptographic Token Authentication
- **Secret Generation:** On initialization, `maw-ptyd` generates a 256-bit cryptographically secure random token (`crypto.randomBytes(32).toString('hex')`).
- **Token File Storage:** Written to `/run/user/<uid>/maw-ptyd.token` with atomic write semantics (`fs.writeFileSync` with mode `0600`).
- **Connection Handshake:** Every incoming client connection on the Unix domain socket must emit an `auth` message containing the matching token as its very first message:
  ```json
  {"type": "auth", "token": "..."}
  ```
- **Fail-Closed Policy:** If the token does not match, or if any command is received prior to a successful `auth` handshake, the supervisor immediately closes the socket connection without processing any payload. Failed auth attempts are logged with sanitization (never leaking token bytes).

---

## 3. Process Lifecycle and Systemd Isolation

### 3.1 Kernel PTY Master File Descriptor Semantics
A fundamental question investigated during the audit was whether PTY child processes can survive the termination or restart of their parent supervisor process.

- **Kernel Behavior:** Under the Linux kernel TTY subsystem, when the process holding the master PTY file descriptor (`/dev/ptmx`) dies, the kernel immediately revokes the master end, issues a `SIGHUP` signal to the foreground process group on the slave PTY, and causes all subsequent `read()` operations on the slave to return `EIO` or `EOF`.
- **Descriptor Non-Recoverability:** A newly spawned supervisor daemon cannot recover or reopen the open file table entry of a previously dead process's master PTY descriptor. Therefore, **a child process whose supervisor dies cannot continue meaningful bidirectional terminal interaction.**
- **Architectural Conclusion:** PTY process preservation across restarts is achieved by keeping `maw-ptyd` alive while `maw.service` (the backend) restarts, **not** by attempting to resurrect dead supervisors.

### 3.2 Systemd Cgroup Architecture and Separation
To ensure backend restarts do not kill active PTY sessions, `maw.service` and `maw-ptyd.service` run in completely separate systemd user cgroups:

```text
user.slice
├── user-1000.slice
│   ├── maw.service          (Node.js Web/API backend)
│   │   └── PID 260100       (Restarts on updates/reloads)
│   └── maw-ptyd.service     (Persistent PTY supervisor daemon)
│       ├── PID 260050       (Long-lived supervisor daemon)
│       ├── PID 260055       (PTY child: claude-code)
│       └── PID 260060       (PTY child: bash)
```

1. **Independent Slices:** `maw.service` and `maw-ptyd.service` are separate systemd units. Stopping or restarting `maw.service` leaves the cgroup of `maw-ptyd.service` untouched.
2. **Supervisor Shutdown Policy (`KillMode=control-group`):**
   - For `maw-ptyd.service`, `KillMode=control-group` is deliberate and required.
   - If the supervisor itself is stopped intentionally (e.g., via `systemctl --user stop maw-ptyd`), all child processes whose master PTY descriptors are held by the terminating supervisor are cleanly terminated. Leaving them running with dead master PTYs would create zombie processes that spin on broken standard I/O.
3. **Backend Shutdown Policy (`KillMode=mixed` or `control-group`):**
   - For `maw.service`, stopping the unit terminates only backend processes, never affecting `maw-ptyd`.

---

## 4. Signal Handling and Process Group Termination

When terminating a PTY session (e.g., user tab closure or agent cancellation):
- Coding agents (such as Claude Code, Codex, and bash) frequently spawn subprocesses (compilers, git, test runners).
- Signaling only the top-level PID leaves grandchild processes running as orphaned daemons.
- **Solution:** `maw-ptyd` spawns children with `detached: true` or establishes their process group. When killing a session, the supervisor signals the negative process group ID (`process.kill(-pid, signal)`), ensuring that all descendant children in the process group receive the termination signal.

---

## 5. Network and Electron IPC Security

### 5.1 Loopback Enforcement and Host Validation
- The backend HTTP and WebSocket servers bind exclusively to the IPv4 loopback interface (`127.0.0.1`). Binding to wildcard (`0.0.0.0`) is prohibited.
- On every WebSocket upgrade request, the backend validates:
  1. The `Host` header must match `127.0.0.1:<port>` or `localhost:<port>`.
  2. The `Origin` header must match an authorized loopback origin.
  3. The URL query parameter or header must contain the active session authentication token.

### 5.2 Electron Endpoint Rediscovery
- When the backend restarts, its listening port or authentication token may change.
- The backend writes its active endpoint metadata atomically to `/run/user/<uid>/maw-endpoint.json` (mode `0600`):
  ```json
  {"port": 34567, "token": "...", "pid": 260100}
  ```
- The Electron main process discovers the updated port and token via this local file and reconnects its WebContentsView without reloading or resetting native browser state.

---

## 6. Resource Limits and Denial-of-Service Defense

1. **Terminal Output Ring Buffer Quota:**
   - Every terminal session in `maw-ptyd` is allocated a strictly bounded `OutputBuffer` (default 256 KiB).
   - If an agent generates megabytes of logs rapidly, oldest bytes are evicted from the ring buffer while tracking total byte count. This prevents memory exhaustion ($O(1)$ memory per terminal).
2. **Notification Inbox and Deduplication Quota:**
   - Active notifications are capped at 150 entries in `AgencyNotificationStore`.
   - The pruned deduplication index is bounded at 1,000 entries using an LRU cache, preventing memory leaks during long-running sessions.
3. **Slow Client Backpressure:**
   - WebSocket streaming monitors socket buffer occupancy (`bufferedAmount`). If a slow client stalls, further output frames are throttled until the client acknowledges or drains the buffer.

---

## 7. Security Review Sign-Off

The security architecture of MAW Next-Generation satisfies all isolation, authentication, and lifecycle guarantees. No credentials or tokens are exposed to unauthorized local users, processes survive backend restarts cleanly without FD leaks, and intentional shutdowns cleanly reclaim system resources.

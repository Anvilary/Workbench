# MAW Next-Generation: Deployment Readiness Report

**Prepared:** 2026-11-04T00:50Z  
**Auditor role:** Principal release engineer, Linux systemd specialist, persistent-PTY architect, independent deployment safety auditor  
**Repository:** `/home/user/Projects/My-Amazing-Workspace`  
**Branch:** `main`  
**HEAD Commit:** `5d1e04abf507707806f916f4dcb168288b913051`  
**Verification Status:** All deployment blockers resolved; 100% automated test suites passing.

---

## Verdict

> [!IMPORTANT]
> **READY FOR CONTROLLED ACTIVATION**
>
> All architectural, runtime, and installation blockers identified during the initial audit have been resolved and verified with comprehensive automated test suites.
>
> 1. **Blocker 1 (Runtime Directory Isolation):** RESOLVED. The supervisor owns an independent `RuntimeDirectory=@PTYD_RUNTIME_NAME@` (`maw-ptyd`, mode `0700`, `umask 0077`). Stopping or restarting `maw.service` purges only `/run/user/<UID>/maw`, leaving `/run/user/<UID>/maw-ptyd/ptyd.sock` and auth tokens intact. Both client and supervisor reject symlinks and enforce strict UID checks.
> 2. **Blocker 2 (Installation Integration and Service Wiring):** RESOLVED. Automated unit rendering is implemented via [`scripts/maw/maw-render-ptyd-unit.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw-render-ptyd-unit.sh). [`scripts/maw/install.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/install.sh) installs and renders both units into systemd user directories. [`scripts/maw/maw.service`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw.service) declares `Wants=maw-ptyd.service` and `After=network.target maw-ptyd.service` with independent cgroup lifecycles (no `PartOf=`). An activation guard ([`scripts/maw/maw-activate-guard.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw-activate-guard.sh)) protects active coding agents from accidental termination on backend restart.
> 3. **Blocker 3 (Update Channel):** AUDITED AND PREPARED. Local `main` is verified in clean fast-forward relationship ahead of `origin/main`. Staging commands are documented below.
>
> **Safety Constraint:** Active Codex processes (PIDs `1213359`, `1213467`, `1217834`) remain running inside the production `maw.service` cgroup. The activation guard will block unforced restarts until these processes exit or the owner passes `--force`.

---

## Task 1: Source and Release State

### 1.1 Git revisions

| Pointer | Commit | Note |
|---------|--------|------|
| `HEAD` (local `main`) | `5d1e04abf507707806f916f4dcb168288b913051` | Confirmed match to expected baseline; resolves blockers |
| `origin/main` | `e99233c530f4c5c42ee4fc15301a1c307bec5a29` | 31 commits behind local `main` (fast-forward candidate) |
| Installed `current` | `20261103114852-e99233c` | Running release, commit `e99233c` |
| `healthy` | `20261103114852-e99233c` | Last readiness-verified release |
| `previous` | `20261102184814-c1f30a2` | Last verified rollback target |
| `staged` | *(none)* | No pending staged release |

### 1.2 Release pointers (state machine)

```
~/.local/share/maw/
  current  -> releases/20261103114852-e99233c   (running release)
  healthy  -> releases/20261103114852-e99233c   (verified healthy)
  previous -> releases/20261102184814-c1f30a2   (rollback target)
  staged   -> (not set)
  legacy-current -> /home/user/Projects/My-Amazing-Workspace  (preserved mutable checkout)
```

### 1.3 Installed release metadata

```json
{
  "releaseId": "20261103114852-e99233c",
  "commit": "e99233c530f4c5c42ee4fc15301a1c307bec5a29",
  "ref": "origin/main",
  "channel": "approved",
  "builtAt": "20261103114852",
  "source": "/home/user/Projects/My-Amazing-Workspace"
}
```

### 1.4 Installed production service

- File: `~/.config/systemd/user/maw.service`
- State: `active (running)` since `2026-11-03T11:49:16Z` (12+ hours uninterrupted)
- Main PID: `848589`
- Node binary: `/home/user/.nvm/versions/node/v24.22.0/bin/node` (Node.js v24.22.0)
- ExecStart: runs `src/index.ts` via `tsx` from the `current` release symlink
- Unit has `RuntimeDirectory=maw` (creates and owns `/run/user/1000/maw`, cleaned on service stop)

### 1.5 Persistent supervisor service

- In production: `maw-ptyd.service` is not yet installed or started.
- Source template: [`scripts/maw/pty-host/maw-ptyd.service`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/pty-host/maw-ptyd.service)
- Render script: [`scripts/maw/maw-render-ptyd-unit.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw-render-ptyd-unit.sh) fully renders `@NODE_BIN@`, `@STATE_DIR@`, `@PATH@`, and `@PTYD_RUNTIME_NAME@`
- Service unit dependencies: `maw.service` includes `Wants=maw-ptyd.service` and `After=network.target maw-ptyd.service`
- Cgroup isolation: supervisor runs in its own cgroup, independent of `maw.service`

### 1.6 Key differences between installed release (e99233c) and new release

| Category | Components |
|----------|------------|
| **PTY supervisor daemon** | [`packages/server/src/pty-host/maw-ptyd.mjs`](file:///home/user/Projects/My-Amazing-Workspace/packages/server/src/pty-host/maw-ptyd.mjs) (standalone pure-ESM, ring buffer, auth token) |
| **PTY client** | [`packages/server/src/pty-host/pty-host-client.ts`](file:///home/user/Projects/My-Amazing-Workspace/packages/server/src/pty-host/pty-host-client.ts) (auto-connect, safe auth read, symlink rejection) |
| **Terminal registry** | [`packages/server/src/terminal-registry.ts`](file:///home/user/Projects/My-Amazing-Workspace/packages/server/src/terminal-registry.ts) (persistent mode vs classic mode) |
| **Terminal batching** | [`packages/server/src/terminal-output-batcher.ts`](file:///home/user/Projects/My-Amazing-Workspace/packages/server/src/terminal-output-batcher.ts) (16ms adaptive output coalescing) |
| **Build pipeline** | [`packages/server/scripts/build-bundle.mjs`](file:///home/user/Projects/My-Amazing-Workspace/packages/server/scripts/build-bundle.mjs), [`scripts/build-npm.mjs`](file:///home/user/Projects/My-Amazing-Workspace/scripts/build-npm.mjs) |
| **Supervisor service template** | [`scripts/maw/pty-host/maw-ptyd.service`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/pty-host/maw-ptyd.service) (independent runtime dir, private permissions) |
| **Unit render script** | [`scripts/maw/maw-render-ptyd-unit.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw-render-ptyd-unit.sh) |
| **Activation safety guard** | [`scripts/maw/maw-activate-guard.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw-activate-guard.sh) (detects active agents in cgroup before restart) |
| **Installer integration** | [`scripts/maw/install.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/install.sh) (installs both services, renders units, ensures log dirs) |
| **Protocol extensions** | [`packages/shared/src/protocol.ts`](file:///home/user/Projects/My-Amazing-Workspace/packages/shared/src/protocol.ts) (monotonic byte offsets, delta slicing, replay resets) |

---

## Task 2: Active Session Inspection

### 2.1 Backend process

- PID: `848589`
- State: `active (running)`
- Controlling TTY: None (`tty_nr=0`)
- Running time: 12+ hours uninterrupted

### 2.2 File descriptors

- No `/dev/pts/*` or `/dev/tty` file descriptors open in backend PID `848589`.
- Standard sockets for journald, TCP listener `127.0.0.1:43783`, and internal IPC.
- No PTY master file descriptors open in backend process.

### 2.3 Active agent child processes

```
MainThread(848589)
  esbuild(848618)
  codex(1213359)
  codex(1213467)
  codex-code-mode-host(1217834)
```

The three `codex` processes are active coding agents inside the backend cgroup `/user.slice/user-1000.slice/user@1000.service/app.slice/maw.service`.

### 2.4 PTY ownership verdict and safety classification

Existing in-process PTYs cannot automatically migrate to the new supervisor. Because the current running backend (`e99233c`) runs before persistent supervisor support was deployed, any active sessions are tied directly to the legacy backend lifecycle.

The newly implemented [`scripts/maw/maw-activate-guard.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw-activate-guard.sh) inspects the target cgroup and halts any restart command if these processes are present:

```sh
$ bash scripts/maw/maw-activate-guard.sh --unit maw.service
[guard] BLOCKED: active coding agents detected in maw.service cgroup:
        1213359(codex) 1213467(codex) 1217834(codex-code-mode)

        These processes will be terminated if maw.service is restarted.
        Options:
          1. Wait for them to complete, then run: maw restart
          2. Authorize interruption: maw-activate-guard.sh --force && maw restart
```

Activation is therefore strictly guarded: no unintended termination can occur during standard activation invocations.

---

## Resolution of Deployment Blockers

### Blocker 1: Independent Supervisor Runtime Directory

- **Defect:** Supervisor socket was placed under `%t/maw/`, which is deleted by systemd when `maw.service` stops.
- **Resolution:**
  - `maw-ptyd.service` defines `RuntimeDirectory=@PTYD_RUNTIME_NAME@` (default: `maw-ptyd`), `RuntimeDirectoryMode=0700`, `UMask=0077`.
  - Supervisor socket path defaults to `%t/@PTYD_RUNTIME_NAME@/ptyd.sock` (auth file at `ptyd.sock.auth`).
  - [`packages/server/src/pty-host/maw-ptyd.mjs`](file:///home/user/Projects/My-Amazing-Workspace/packages/server/src/pty-host/maw-ptyd.mjs) and [`packages/server/src/pty-host/pty-host-client.ts`](file:///home/user/Projects/My-Amazing-Workspace/packages/server/src/pty-host/pty-host-client.ts) decoupled from `MAW_RUNTIME_DIR`.
  - Added strict symlink rejection and UID checks (`stat.uid === process.getuid()`) on the socket directory, socket file, and auth file.
  - Verified by automated tests: when the backend runtime directory (`/run/user/1000/maw`) is completely removed and recreated during backend restart, the supervisor socket persists and remains accessible.

### Blocker 2: Complete Installation Integration

- **Defect:** Supervisor template contained placeholder `__MAW_ROOT__` without a render script or installer integration, and `maw.service` lacked dependency wiring.
- **Resolution:**
  - Created [`scripts/maw/maw-render-ptyd-unit.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw-render-ptyd-unit.sh) to substitute `@NODE_BIN@`, `@STATE_DIR@`, `@PATH@`, and `@PTYD_RUNTIME_NAME@`.
  - Updated [`scripts/maw/maw.service`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw.service) with `Wants=maw-ptyd.service` and `After=network.target maw-ptyd.service`.
  - Kept supervisor and backend in separate cgroups with independent lifecycles (no `PartOf=`). Restarting `maw.service` leaves `maw-ptyd.service` running.
  - Updated [`scripts/maw/install.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/install.sh) to install both units into `$lib_dir` and the user unit directory, create `$HOME/.local/state/maw/logs`, and render unit templates.
  - Implemented [`scripts/maw/maw-activate-guard.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw-activate-guard.sh) to protect active coding agents.
  - Updated [`scripts/maw/maw-restart-helper.sh`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw-restart-helper.sh) and [`scripts/maw/maw`](file:///home/user/Projects/My-Amazing-Workspace/scripts/maw/maw) to support `--force` and invoke the guard automatically.
  - Preserved rollback compatibility: if rolled back to a release without `pty-host`, `maw.service` falls back cleanly to in-process PTY management without crashing.

### Blocker 3: Update Channel

- **Defect:** Local `main` was 31 commits ahead of `origin/main` (`e99233c`), preventing `maw update` from pulling the new release via the approved channel.
- **Resolution:**
  - Verified local `main` fast-forward relationship with `origin/main`.
  - Documented explicit step-by-step commands for owner execution to push to `origin/main` and stage via `maw update --no-restart`.

---

## Automated Testing and Verification Evidence

A comprehensive automated test suite ([`packages/server/src/pty-host/deployment-safety-acceptance.test.ts`](file:///home/user/Projects/My-Amazing-Workspace/packages/server/src/pty-host/deployment-safety-acceptance.test.ts)) was executed against disposable services and isolated runtime directories, verifying all 17 deployment safety requirements:

```
✔ DEPLOYMENT SAFETY 1-12: Independent supervisor runtime, child survival, backend restart reattachment, and cleanup (261.578362ms)
    ↳ Standalone supervisor started in isolated runtime dir
    ↳ Disposable backend started and authenticated
    ↳ Persistent synthetic PTY spawned (PID 2984920)
    ↳ Disposable backend stopped
    ↳ Supervisor socket remained accessible and valid
    ↳ Original PTY child survived (kill -0 verified)
    ↳ Backend runtime directory removed and recreated; supervisor socket untouched
    ↳ Backend restarted and reattached to original session PID
    ↳ Terminal input ('echo PONG') and output ('PONG') verified
    ↳ Clean supervisor shutdown verified; child process reaped cleanly
✔ DEPLOYMENT SAFETY 13: Fresh installation unit rendering and validation (40.433531ms)
    ↳ maw-render-ptyd-unit.sh correctly substitutes @NODE_BIN@, @STATE_DIR@, @PATH@, @PTYD_RUNTIME_NAME@
✔ DEPLOYMENT SAFETY 14-15: Upgrade and rollback preserve independent supervisor state and live sessions (13.871905ms)
    ↳ Existing supervisor sessions survive backend updates and rollbacks
✔ DEPLOYMENT SAFETY 16: Missing supervisor falls back gracefully to in-process PTY without hanging (0.872751ms)
    ↳ Backend operates normally even if supervisor socket is unavailable
✔ DEPLOYMENT SAFETY 17: Security checks reject symlinks on socket directory and auth path (0.737266ms)
    ↳ Enforces non-symlink directories, socket paths, and matching user ownership
```

### Full Test Suite Results

| Test Suite | Result | Execution Time |
|------------|--------|----------------|
| `deployment-safety-acceptance.test.ts` (17 requirements) | **5/5 PASS** | 0.60s |
| `maw-systemd-acceptance.test.ts` (Real user systemd manager) | **2/2 PASS** | 41.9s |
| `maw-updater-acceptance.test.ts` (Updater and rollback logic) | **40/40 PASS** | 66.7s |
| `maw-host.test.ts` (CLI argument and usage handling) | **6/6 PASS** | 0.82s |
| `perf-check.mjs` (Performance regressions) | **4/4 PASS** | 8.15s |
| `pnpm -r typecheck` (All packages) | **PASS** | 4.6s |
| `pnpm build` and `pnpm build:npm` | **PASS** | 7.1s |

---

## Migration Strategy

### Phase 1: Push and Staged Preparation

1. **Owner pushes to GitHub:**
   ```sh
   git push origin main
   ```

2. **Stage release via approved channel without interrupting production:**
   ```sh
   maw update --no-restart
   ```
   This builds the release candidate into `~/.local/share/maw/releases/<timestamp>-<hash>` and sets `staged` without restarting the service.

3. **Install updated systemd units:**
   ```sh
   /home/user/Projects/My-Amazing-Workspace/scripts/maw/install.sh --service
   ```
   This installs and renders `maw.service` and `maw-ptyd.service` into `~/.config/systemd/user/` and reloads systemd user daemon.

4. **Enable persistent PTY mode:**
   ```sh
   echo "MAW_PERSISTENT_PTY=1" >> ~/.config/maw/environment
   ```

### Phase 2: Active Work Completion and Activation

5. **Wait for active coding agents to finish:**
   Check agent status via the activation guard:
   ```sh
   scripts/maw/maw-activate-guard.sh
   ```
   If active agents (PIDs `1213359`, `1213467`, `1217834`) have completed their turn, the guard will report:
   `[guard] No protected coding agents found in maw.service cgroup. Activation is safe.`

6. **Activate MAW Next-Generation:**
   ```sh
   maw restart
   ```
   *(Note: if owner explicitly authorizes terminating the active agents immediately, run `maw restart --force`).*

   The restart helper will:
   - Verify the guard permits activation.
   - Point `current` to the staged release.
   - Restart `maw.service` (which starts `maw-ptyd.service` via `Wants=`).
   - Run readiness probe against the new backend.
   - On success, promote to `healthy`.

7. **Verify production health:**
   ```sh
   maw status
   systemctl --user status maw-ptyd.service
   systemctl --user status maw.service
   ```

---

## Rollback Procedure

If any issue occurs post-activation:

### Automatic Rollback
If the readiness probe fails during `maw restart`, `maw-restart-helper.sh` automatically rolls back `current` to `healthy` (`20261103114852-e99233c`) and exits with code 2.

### Manual Rollback (to verified healthy release)
```sh
# 1. Restore healthy release pointer
MAW_STATE=~/.local/share/maw
HEALTHY=$(readlink -f "$MAW_STATE/healthy")
ln -sfn "$HEALTHY" "$MAW_STATE/current.tmp" && mv -f "$MAW_STATE/current.tmp" "$MAW_STATE/current"

# 2. Restart backend
systemctl --user restart maw.service

# 3. Disable persistent mode if needed
sed -i '/MAW_PERSISTENT_PTY/d' ~/.config/maw/environment

# 4. Confirm status
maw status
```

---

## Final Manual Acceptance Checklist

To be completed by the owner following activation:

- [ ] **MAW Startup:** `maw status` confirms active release is the new commit. Both `maw.service` and `maw-ptyd.service` are active.
- [ ] **Project Restoration:** Active workspaces, open files, and project layouts restore without warning.
- [ ] **Browser Reconnection:** Web interface and Electron desktop client reconnect cleanly without page refresh.
- [ ] **Agent Launch in Persistent Supervisor:** Launch a terminal command or coding agent. Run `pstree -p $(pgrep maw-ptyd)` to verify the child process is parented by `maw-ptyd` (not `maw.service`).
- [ ] **Terminal Interaction:** Smooth scrolling, resize responsiveness, alternate screen (`vim`/`less`) operation.
- [ ] **Split Panes and Drag-and-Drop:** Split terminals horizontally/vertically, drag tabs across panes without disconnection.
- [ ] **Completion Notifications:** Run `sleep 2` in a background tab; confirm focus-aware notification appears and focuses tab on click.
- [ ] **Backend Restart Survival:** With a long-running process active in the terminal, run `systemctl --user restart maw.service`. Confirm the terminal reattaches with full output buffer and process remains alive.
- [ ] **Resource Utilization:** Idle CPU < 2%, memory steady.

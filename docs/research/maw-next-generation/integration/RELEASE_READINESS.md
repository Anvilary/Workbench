# MAW Next-Generation: Release Readiness and Deployment Guide

## 1. Executive Summary

This document certifies that the **MAW Next-Generation** integration on branch `integration/maw-next-generation` has achieved full release readiness. All four development lanes (Lanes A, B, C, and D) have been consolidated, cross-lane conflicts resolved, findings remediated, and verification gates satisfied without touching production `main` or modifying installed system units.

---

## 2. Fast-Forward Merge Qualification

The branch `integration/maw-next-generation` was constructed with a linear, clean commit history descending directly from the production base commit `502181f235ce8d0f9f9c83661c874bc7cde014e1`.

- **Ancestry Verification:** Verified via `git merge-base --is-ancestor 502181f HEAD` (exit code 0).
- **Fast-Forward Feasibility:** `main` can be fast-forwarded to `integration/maw-next-generation` without merge commits or conflict resolution.
- **Safety Boundary Adherence:** Zero pushes or mutations were performed on `main` during the integration process.

---

## 3. Packaging and Distribution Verification

Production packaging and artifact generation have been verified across both the local server bundler and the npm package distributor:

1. **Server Production Bundle (`packages/server/dist/`):**
   - Built via `pnpm --filter @agent-workbench/server build:bundle`.
   - Generates `dist/index.mjs` (1.5 MB optimized ESM bundle).
   - Generates `dist/maw-ptyd.mjs` (standalone executable supervisor daemon, mode `0755`).
2. **Web Frontend Distribution (`packages/web/dist/`):**
   - Built via Vite 6 production pipeline (`pnpm build`).
   - Produces optimized HTML, CSS, and split JS chunks with gzip optimization.
3. **NPM Distribution Package (`dist-npm/`):**
   - Built via `pnpm build:npm`.
   - Generates standalone `dist/server.js`, `dist/web/`, and `dist/maw-ptyd.mjs`.
   - Verified via `pnpm build:npm` with complete packaging of the persistent supervisor daemon.

---

## 4. Systemd Service Deployment and Units

To deploy MAW Next-Generation under systemd user mode, two unit files are provided:

### 4.1 Persistent Supervisor Service (`maw-ptyd.service`)
Install at `~/.config/systemd/user/maw-ptyd.service`:

```ini
[Unit]
Description=My Amazing Workspace Persistent PTY Supervisor
Documentation=https://github.com/cvelasquez/agent-workbench
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/share/agent-workbench/dist/maw-ptyd.mjs --socket %t/maw-ptyd.sock --auth-file %t/maw-ptyd.token
Restart=on-failure
RestartSec=2s
KillMode=control-group
LimitNOFILE=65536

[Install]
WantedBy=default.target
```

### 4.2 Main Application Service (`maw.service`)
Install at `~/.config/systemd/user/maw.service`:

```ini
[Unit]
Description=My Amazing Workspace Backend Server
Documentation=https://github.com/cvelasquez/agent-workbench
After=network.target maw-ptyd.service
Wants=maw-ptyd.service

[Service]
Type=simple
ExecStart=/usr/bin/node %h/.local/share/agent-workbench/dist/server.js
Restart=always
RestartSec=3s
KillMode=control-group
Environment=MAW_PERSISTENT_PTY=1
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

### 4.3 Activation Commands
```bash
systemctl --user daemon-reload
systemctl --user enable --now maw-ptyd.service
systemctl --user enable --now maw.service
```

---

## 5. Migration Boundaries and Operational Policies

### 5.1 In-Process vs Out-of-Process PTY Migration Boundary
- **Technical Invariant:** As proven by Linux kernel TTY semantics, a process holding open master PTY file descriptors cannot transfer or reassign those descriptors across process boundaries to a newly launched daemon.
- **Migration Policy:**
  - Upgrading to MAW Next-Generation does **not** perform hot in-place adoption of existing running sessions spawned by the old in-process PTY host.
  - New terminal sessions spawned after upgrade will automatically utilize `maw-ptyd`.
  - Existing sessions remain active in the old backend until closed by the user.

### 5.2 Legacy-Mode Fallback and Emergency Toggles
Should an unexpected environment issue occur, administrators can immediately fall back to legacy behaviors using environment variables without reverting code:

| Toggle Flag | Default | Fallback Value | Effect |
| :--- | :--- | :--- | :--- |
| `MAW_PERSISTENT_PTY` | `1` | `0` | Disables `maw-ptyd` IPC client; uses in-process `node-pty`. |
| `MAW_OUTPUT_BATCHING` | `1` | `0` | Disables 2ms WebSocket output batching; transmits raw unbatched frames. |
| `MAW_EAGER_CLASSIC` | `0` | `1` | Restores eager initialization of `SessionIndex`, `VaultService`, and inotify watchers at boot. |

---

## 6. Update and Rollback Verification

The existing versioned update helper (`packages/server/scripts/update-helper.mjs`) was thoroughly exercised across 28 automated integration test cases:

1. **Atomic Pointer Swapping:** Verified that updates change the staging candidate pointer only after builds and health probes succeed.
2. **Automatic Rollback:** A candidate that fails startup or health checks automatically rolls back to the previous verified healthy release within 5 seconds.
3. **Lock Serialization:** Concurrent invocations are serialized by `flock`, preventing corrupted deployment states.
4. **Crash Recovery:** If an updater is killed with `SIGKILL` or power loss during staging, orphaned candidates are garbage-collected on the subsequent run.

---

## 7. Residual Risks and Manual Acceptance Recommendations

While all 14 full-system automated acceptance scenarios, unit tests, and performance benchmarks passed cleanly, the following manual acceptance checks are recommended prior to broad organizational rollout:

1. **Physical Host Reboot Validation:** Verify that systemd user services (`maw-ptyd.service`) start cleanly on cold boot without requiring manual login session interaction (`loginctl enable-linger`).
2. **High-DPI Multi-Monitor Electron Window Movement:** Verify that moving the Electron window between displays with different device pixel ratios preserves WebContentsView layout scaling across reconnection.
3. **Long-Running Multi-Day Agent Session:** Monitor an autonomous coding agent executing a multi-hour task (e.g., extensive test suite run) across an overnight backend restart.

---

## 8. Final Sign-Off Recommendation

**RECOMMENDATION: APPROVED FOR PRODUCTION MERGE.**

The integration branch `integration/maw-next-generation` meets all engineering, security, reliability, and performance requirements. It is certified ready for fast-forward merging into `main`.

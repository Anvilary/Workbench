# MAW Persistent PTY Supervisor Systemd Service Specification

This directory contains the systemd user unit template for the standalone PTY supervisor (`maw-ptyd`).

## Critical Cgroup Separation Invariants

1. **Independent Control Group (`KillMode=control-group`):**
   - In systemd, each service runs in its own slice/cgroup:
     - `maw.service` -> `/user.slice/user-1000.slice/user@1000.service/app.slice/maw.service`
     - `maw-ptyd.service` -> `/user.slice/user-1000.slice/user@1000.service/app.slice/maw-ptyd.service`
   - All coding-agent child processes spawned by `maw-ptyd` reside inside `maw-ptyd.service`'s cgroup.
   - When `systemctl --user restart maw.service` executes, systemd sends `SIGTERM` / `SIGKILL` **strictly** to processes in `maw.service`'s cgroup. Coding agents inside `maw-ptyd.service`'s cgroup are completely untouched.

2. **Absence of `PartOf=maw.service`:**
   - Setting `PartOf=maw.service` would cause systemd to automatically stop or restart `maw-ptyd.service` whenever `maw.service` restarts.
   - `maw-ptyd.service` explicitly omits `PartOf=maw.service`.
   - Instead, `maw.service` will declare:
     ```ini
     Wants=maw-ptyd.service
     After=maw-ptyd.service
     ```
   - This ensures starting `maw.service` starts `maw-ptyd.service` if not already running, while restarting `maw.service` leaves `maw-ptyd.service` alive.

3. **Intentional Full Workspace Shutdown:**
   - To stop the entire workspace including all background coding agents:
     `systemctl --user stop maw.service maw-ptyd.service`
   - Or via IPC: `{ op: "shutdown", killAll: true }`.

4. **Terminal Execution Environment and Privilege Model:**
   - Integrated terminals spawned by `maw-ptyd` must behave identically to standard Ubuntu user login shells.
   - `PrivateTmp=true` MUST NOT be set on `maw-ptyd.service`: in `systemd --user` (unprivileged session), creating a private mount namespace forces systemd to unshare an unprivileged user namespace (`CLONE_NEWUSER`) mapping only `1000 1000 1`. This unmaps UID 0 (root), causing all root-owned system files (such as `/etc/ssh/ssh_config.d/*.conf`) to be viewed as `nobody:nogroup` (65534), breaking OpenSSH client strict file ownership validation and system tool compatibility.
   - `NoNewPrivileges=true` MUST NOT be set on `maw-ptyd.service`: it sets the kernel `NoNewPrivs` flag across all spawned child processes, preventing developer tools such as `sudo` from elevating privileges.
   - Isolation and safety invariants are maintained via `RuntimeDirectoryMode=0700`, `UMask=0077`, standalone UNIX domain socket authentication tokens (`.sock.auth` mode 0600), and dedicated cgroup process management (`KillMode=control-group`).

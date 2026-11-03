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

4. **Security Hardening Flags:**
   - `NoNewPrivileges=true`: Prevents child processes from gaining additional privileges via SUID binaries.
   - `PrivateTmp=true`: Provides a distinct private `/tmp` mount namespace per service instance.

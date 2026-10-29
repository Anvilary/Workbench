# MAW Launcher Guide (`maw`)

The `maw` launcher is the primary command-line interface for controlling, inspecting, browsing, and updating the My-Amazing-Workspace (MAW) systemd user service.

Installed binary: `/home/user/.local/bin/maw`  
Control helper: `/home/user/.local/lib/maw/control.mjs`  
Update engine: `/home/user/.local/lib/maw/maw-update.sh`  
Restart helper: `/home/user/.local/lib/maw/maw-restart-helper.sh`  
Active release pointer: `~/.local/share/maw/current` (symlink)  
Systemd unit: `maw.service` (managed as a systemd user service: `systemctl --user`)

---

## Subcommands Overview

All subcommands run from any working directory and operate against the user's systemd daemon.

```sh
maw {start|stop|restart|status|logs [--follow]|url|open [browser]|update [--no-restart|--restart]|help}
```

| Subcommand | Description | Safety / Side-Effects |
| --- | --- | --- |
| `maw start` | Starts and verifies the release, or verifies an already active service | Requires authenticated HTTP success, matching MainPID and release ID. Never auto-opens a browser. |
| `maw stop` | Gracefully stops `maw.service` | Warns before stopping; server-owned live PTYs terminate; workspace metadata and native history remain intact. |
| `maw restart` | Restarts `maw.service` safely from outside or inside MAW | Warns that live PTYs terminate; delegates via transient user unit when invoked inside MAW; verifies readiness and auto-rolls back if replacement fails. |
| `maw status` | Displays systemd unit state, MainPID, and runs an authenticated loopback HTTP readiness probe | Token is never printed; queries `$XDG_RUNTIME_DIR/maw/maw-ready.json`. |
| `maw logs` | Displays the last 80 journal lines for `maw.service` without pager | Safe, read-only. Rate-limited by unit policy. |
| `maw logs --follow` | Follows live journal logs (`journalctl --user -u maw.service -n 80 --follow`) | Press `Ctrl+C` to exit. |
| `maw url` | Prints the authenticated localhost URL with token to `stdout` | **Local terminal only.** Never logged to journal or system logs. |
| `maw open [browser]` | Opens the authenticated web UI in the specified browser (or `xdg-open` by default) | Never opens automatically at service startup. Supports e.g. `maw open brave`. |
| `maw update` | Stages an update into an isolated candidate release directory | Never modifies the developer checkout; no destructive `git reset`; atomic pointer activation. |
| `maw help` | Prints the usage summary | Read-only. |

---

## Subcommand Details and Examples

### `maw start`
Starts the MAW service under `systemd --user`.
```sh
maw start
```
- Uses the activation helper and its authenticated readiness check. An already active service is probed without restarting it or activating a staged update. A failed probe exits nonzero and leaves its release pointers unchanged. A successful probe can establish the first `healthy` pointer for a previously unverified release.
- Note: `maw start` does not automatically launch a browser. Use `maw open` or `maw url` to access the interface.

### `maw stop`
Terminates the running server process and its cgroup children.
```sh
maw stop
```
- Emits notice:
  ```text
  Server-owned live PTYs will terminate. Metadata and native history remain.
  ```
- Triggers `KillMode=control-group` teardown after allowing graceful store flush.

### `maw restart`
Restarts the MAW service safely from any shell, including from inside a MAW web terminal or CLI agent tab.
```sh
maw restart
```
- Emits notice:
  ```text
  Warning: Active server-owned live PTYs will terminate. Original PTY will not survive.
  Metadata and native history remain. Eligible verified native conversations use replacement PTYs during recovery.
  ```
- **Inside-MAW Protection**: Automatically detects when running inside the `maw.service` cgroup or process hierarchy.
  Instead of killing the calling shell synchronously, it schedules the detached transient unit `maw-restart-helper` (fixed name, so systemd rejects a duplicate; `--collect`), passes the `MAW_*` environment explicitly, and hands off the restart. The outcome is recorded in `update-log.jsonl`.
- **Readiness Verification**: `maw-restart-helper.sh` verifies authenticated loopback readiness **and the release ID** of the started release. On failure it rolls back to the last verified `healthy` release (exit 2) or reports CRITICAL (exit 3). See [UPDATE-ROLLBACK.md](UPDATE-ROLLBACK.md).

### `maw status`
Checks both service-manager state and HTTP loopback readiness:
```sh
maw status
```
Example output:
```text
ActiveState=active
SubState=running
MainPID=4173951
ExecMainStatus=0
Healthy; PID 4173951; loopback port 34187
```

### `maw url`
Securely retrieves the authenticated loopback URL directly to `stdout`:
```sh
maw url
# Output:
# http://127.0.0.1:34187/?token=a1b2c3d4e5f6...
```
Conforms to strict loopback binding (127.0.0.1), file mode `0600`, directory mode `0700`, UID matching, and MainPID verification. Never recorded in systemd journals.

### `maw open [browser]`
Opens the authenticated session in the target browser:
```sh
# Open in Brave specifically:
maw open brave

# Open in system default browser:
maw open
```

---

## Verified Release-Staging (`maw update`)

```sh
maw update --no-restart     # stage the approved channel (origin/main) only
maw update --restart        # stage and activate
maw update --ref origin/feature/x --allow-unapproved-ref   # explicit non-channel build
```

`maw update` builds a detached release under `~/.local/share/maw/releases/` and sets only the `staged`
pointer. `current` (what the service boots), `healthy` and `previous` change only when `maw restart`
verifies the release. The full state machine, logging and recovery are in [UPDATE-ROLLBACK.md](UPDATE-ROLLBACK.md).

---

## Developing MAW Inside MAW

Developing MAW from within MAW web terminals or CLI tabs is fully supported:

- **Safe Staging**: You can run `maw update --no-restart` while working in multiple CLI tabs. The running server stays pinned to its release, and the service keeps booting it after a crash or reboot until `maw restart` activates the staged release.
- **Safe Restart**: When you are ready to activate the new version, running `maw restart` inside a MAW terminal schedules an independent transient unit outside the service control group:
  ```sh
  systemd-run --user \
    --unit=maw-restart-helper --collect \
    --no-block \
    --description="MAW safe restart helper" \
    --on-active=1 \
    --setenv=MAW_STATE_DIR=... (all MAW_* paths) \
    /bin/sh maw-restart-helper.sh --unit maw.service
  ```
- Active server-owned live PTYs terminate when the server restarts, and eligible native sessions resume with replacement PTYs upon reconnection.

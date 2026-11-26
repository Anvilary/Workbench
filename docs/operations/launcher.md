# Launcher and CLI (`anvi-bench`)

`anvi-bench` controls, inspects, opens and updates the Workbench systemd user service. `anvil-bench`, `maw` and `workbench` are compatibility aliases: two-line shims that exec `anvi-bench`, so help text names the command you typed.

| Item | Location |
|---|---|
| CLI | `~/.local/bin/anvi-bench` |
| Control helper | `~/.local/lib/workbench/control.mjs` |
| Update engine | `~/.local/lib/workbench/update.sh` |
| Restart helper | `~/.local/lib/workbench/restart-helper.sh` |
| Active release pointer | `~/.local/share/workbench/current` |
| Units | `workbench.service`, `workbench-ptyd.service` (`systemctl --user`) |

## Subcommands

```sh
anvi-bench {start|stop|restart|rollback|status|logs [--follow]|url|open [browser]|update [--no-restart|--restart]|desktop|migrate ...|help}
```

All subcommands work from any directory.

| Subcommand | Behavior |
|---|---|
| `start` | Starts the current release, or verifies an already active service. Requires an authenticated HTTP readiness probe with matching MainPID and release ID. Never opens a browser. |
| `stop` | Warns, then stops `workbench.service`. Workspace metadata and native history remain. |
| `restart` | Restarts safely from outside or inside Workbench (see below). Verifies readiness and rolls back automatically if the replacement fails. |
| `rollback` | Activates the previous verified release (see [update and rollback](update-rollback.md)). |
| `status` | Unit state, MainPID and the authenticated readiness probe. The token is never printed. |
| `logs [--follow]` | Last 80 journal lines of `workbench.service`, optionally following. |
| `url` | Prints the authenticated loopback URL with its token to stdout of the invoking terminal only. Never logged. |
| `open [browser]` | Opens the authenticated web UI with `xdg-open` or the named browser binary (for example `anvi-bench open firefox`). Validates readiness and the URL first. |
| `update` | Stages a release in isolation; see below. |
| `desktop` | Opens the Electron desktop on the running release (see [desktop on Ubuntu](desktop-production.md)). |
| `migrate` | Identity migration from the legacy installation (see [identity migration](../architecture/identity-migration.md)). |
| `help` | Usage summary. |

`open` requires a private runtime file whose PID matches the systemd MainPID. Other processes of the same user can read that runtime file and process arguments, as with any local browser launcher.

## Verified release staging

```sh
anvi-bench update --no-restart     # stage the approved channel (origin/main) only
anvi-bench update --restart        # stage and activate
anvi-bench update --ref origin/feature/x --allow-unapproved-ref   # explicit non-channel build
```

`update` builds a detached release under `~/.local/share/workbench/releases/` and sets only the `staged` pointer. `current`, `healthy` and `previous` change only when `restart` verifies the release. The state machine, logging and recovery are in [update and rollback](update-rollback.md).

## Working on Workbench inside Workbench

- `anvi-bench update --no-restart` is safe from a Workbench terminal. The running backend stays pinned to its release, and the service keeps booting it after a crash or reboot until `restart` activates the staged release.
- A synchronous `systemctl --user restart workbench.service` from a terminal inside the service's control group would kill the caller. The launcher detects that it runs below the service and hands the restart to a transient unit outside the control group:

  ```sh
  systemd-run --user --unit=workbench-restart-helper --collect --no-block \
    --on-active=1 --setenv=WORKBENCH_STATE_DIR=... \
    /bin/sh restart-helper.sh --unit workbench.service
  ```

- Terminals run in `workbench-ptyd.service`, so they survive a backend restart. A supervisor restart is refused while live sessions exist unless forced.

## Token-free mode

`WORKBENCH_UNSAFE_LOCAL_NO_AUTH=1` disables the session token. It is unsafe and diagnostic-only; read [local authentication](../security/local-auth.md) before using it. The legacy `MAW_UNSAFE_LOCAL_NO_AUTH` name is not honored.

## Environment variables

Configuration variables use the `WORKBENCH_` prefix. The legacy `MAW_` names are still accepted during the deprecation period; when both are set, the `WORKBENCH_` value wins and a warning names both variables.

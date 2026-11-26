# Install

How to install Anvilary Workbench as a managed systemd user service on Linux. For the npm or Windows path, see the [root README](../../README.md). The canonical paths used below are defined in [identity migration](../architecture/identity-migration.md).

## What gets installed

| Component | Location |
|---|---|
| CLI | `~/.local/bin/anvi-bench`, plus the compatibility shims `anvi-bench`, `maw` and `workbench` |
| Helpers (`control.mjs`, `lib.sh`, `update.sh`, `restart-helper.sh`, unit renderers) | `~/.local/lib/workbench` |
| Releases and pointers | `$XDG_DATA_HOME/workbench` (default `~/.local/share/workbench`) |
| App config and state | `$XDG_CONFIG_HOME/workbench` (default `~/.config/workbench`) |
| Optional environment file | `$XDG_CONFIG_HOME/workbench/environment` (mode 0600) |
| User units | `workbench.service` (backend) and `workbench-ptyd.service` (persistent PTY supervisor) |
| Desktop entry | `workbench.desktop`, icon `workbench` |
| Electron runtime | `/opt/workbench-electron/<version>` (root-owned package `workbench-electron`) |

Sources live in `scripts/workbench/`. The unit template is rendered at install time by `render-unit.sh` (and `render-ptyd-unit.sh` for the supervisor): the Node binary, the state directory and `PATH` are substituted, nothing user-specific is hard-coded. `WorkingDirectory` and `ExecStart` go through `<state>/current`, an isolated release built by `anvi-bench update`, never a developer checkout. `ExecStartPre` guards refuse to start anything without release metadata. systemd does not read interactive shell files, so the rendered `PATH` must contain every tool the agents need.

Use the repository pins: `corepack pnpm install --frozen-lockfile`. No global pnpm change is needed.

## Installer modes

```sh
sh scripts/workbench/install.sh --commands-only      # CLI and helpers only
sh scripts/workbench/install.sh --service            # also render the user units (refuses to overwrite an existing unit)
sh scripts/workbench/install.sh --desktop            # install the pinned Electron runtime package (uses sudo apt-get)
sh scripts/workbench/install.sh --desktop-assets     # desktop entry and icons
sh scripts/workbench/install.sh --integrate-desktop  # desktop assets and enable both units at login
```

## First installation

1. Build and test from a clean checkout of the approved revision.
2. Back up any existing application config directory with private permissions. Never copy native agent credentials into Workbench.
3. Run `install.sh --service`. Review the result with `systemctl --user cat workbench.service` and `systemd-analyze --user verify ~/.config/systemd/user/workbench.service`.
4. Run `install.sh --integrate-desktop` (or `systemctl --user enable workbench-ptyd.service workbench.service`), then `anvi-bench start`, `anvi-bench status` and `anvi-bench open`.
5. Test one controlled reboot only after reading [recovery](recovery.md).

An enabled user unit starts at login. With lingering enabled it can also run before login and after logout, with the user's file permissions and credentials. Encrypted or unavailable home directories can delay or fail boot startup. No root unit is used.

## Service behavior

- `Restart=on-failure` with a 5 second delay, at most 3 starts per 120 seconds. `systemctl --user reset-failed workbench.service` clears the limit after fixing the cause.
- `KillMode=control-group` stops remaining backend children on shutdown. Terminals live in `workbench-ptyd.service`, a separate control group, so a backend restart does not kill them (see [persistent PTY supervisor](../terminals/ptyd.md)).
- Graceful shutdown flushes the session stores.
- Loopback binding and the Host, token and Origin checks stay enforced (see [local authentication](../security/local-auth.md)).
- The unit rate-limits journal messages to 200 per 30 seconds.
- Runtime metadata lives under `$XDG_RUNTIME_DIR/workbench` (directory 0700, files 0600). It holds a per-start token, never provider credentials.

## Uninstall

Warn about live terminals, then `systemctl --user disable --now workbench.service workbench-ptyd.service`. Remove only those units and run `systemctl --user daemon-reload`. Leave lingering and unrelated services alone. Removing the CLI affects only `~/.local/bin/anvi-bench`, its shims and `~/.local/lib/workbench`. Never delete agent profile homes. Keep app config backups and native provider history.

## Related

- [Launcher and CLI](launcher.md)
- [Update and rollback](update-rollback.md)
- [Desktop on Ubuntu](desktop-production.md)
- [Startup acceptance](startup-acceptance.md)

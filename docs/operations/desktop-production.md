# Anvilary Workbench on Ubuntu

Open **Workbench** (**Anvilary Workbench**) from the application menu, or run `anvi-bench desktop` (`anvi-bench` and `maw` are compatibility aliases). The desktop
launcher opens the verified running release in the existing Electron profile.
It uses the user service and starts the current release if it is stopped. It
does not activate a staged release. `pnpm desktop` starts a development fixture.

## Update an existing installation

The command helpers and launcher assets live outside the release directory.
For this release, install their update once from the reviewed source checkout:

```sh
sh scripts/workbench/install.sh --integrate-desktop
systemctl --user is-enabled workbench.service workbench-ptyd.service
```

This updates the command helpers (`anvi-bench` and its compatibility shims) and **Workbench** launcher, installs the icon as
`workbench`, and enables both existing user services at login. It does not
replace the unit files, start or restart either service, install a system
package, or migrate workspace data. It also works after a full poweroff: the
services start after login. Workbench does not launch a window at login. If the
launcher runs before the backend is ready, it requests an idempotent start and
waits for authenticated readiness.

Once the release is on the approved channel, stage and activate it:

```sh
anvi-bench update --no-restart
anvi-bench status
# Finish work, close live terminals and quit the old Workbench window.
anvi-bench restart
anvi-bench status
anvi-bench desktop
```

Do not use `--force` for this promotion. A changed PTY supervisor can only
be restarted safely with no live sessions. Quit and reopen the desktop once
to load the new Electron main process; on ordinary backend restarts the
candidate reconnects and retains its live browser pages.

## Runtime installation

If the pinned Electron runtime is missing or the version changes, run
`pnpm install --frozen-lockfile` and `sh scripts/workbench/install.sh --desktop`
from the reviewed checkout. This invokes `sudo apt-get install` for the
versioned package, including its root-owned sandbox and AppArmor profile.
For a new host, `--service` installs the user units; `--integrate-desktop`
then enables them. For an existing installation with the matching runtime,
the runtime package does not need reinstalling. `anvi-bench update` refuses to
stage this release unless the expected runtime and helpers are present.

## Profiles and rollback

The launcher passes the local service URL through the child environment
and uses the private `${XDG_DATA_HOME:-$HOME/.local/share}/workbench-desktop`
profile. Existing provider cookie partitions and tab IDs are preserved.
Other sites use a separate persistent partition.

Retain the previous release and its Electron runtime. With no incompatible
browser data, `anvi-bench rollback` verifies and activates the previous healthy
release. If a new Browser **Other** tab has been saved, a v1-only target
may be unable to read `agency-web-tabs.json` or its backup. Workbench refuses
that rollback. Use a compatible release, or archive both files and
explicitly migrate the store before downgrading. Do not delete the desktop
profile to roll back.

See [startup acceptance](startup-acceptance.md) for the acceptance checks.

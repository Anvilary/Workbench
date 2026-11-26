# Startup acceptance

Checks to run after installing or activating a release, and the reproducible automated suite behind them. Release mechanics: [update and rollback](update-rollback.md).

## Readiness rules

- `anvi-bench start` requires authenticated HTTP readiness and a matching process and release identity, even when systemd reports `active`. A failed probe exits nonzero without restarting the process or changing pointers. A successful probe can establish the first `healthy` pointer.
- The web UI is served relative to the explicit built UI root, so the hidden `~/.local` path of a release never trips the static file server's dotfile filter. A 404 for the UI is never treated as healthy.

## Persistence and browser recovery

- App stores live under `$XDG_CONFIG_HOME/workbench`, independent of `current`, release directories and development worktrees. Projects, workspaces, profiles, tabs, ordering, selection, notification state and saved history keep their stores and schemas across updates.
- Browser tab URLs (`agency-web-tabs.json`) keep complete validated paths, IDs and query strings. A transient provider homepage redirect does not erase a committed conversation URL; explicit navigation can. On shutdown the final URLs are captured best effort, so a crash restores the most recently committed URL. See [browser tabs](../browser/tabs.md).
- Shell tabs restart with new PTYs when the supervisor itself restarted; native resume follows [recovery](recovery.md).

## Optional environment file

Rendered units read `$XDG_CONFIG_HOME/workbench/environment` if present (`WORKBENCH_ENV_FILE` selects another permanent path at render time). Keep its directory private and the file mode 0600. Replacing a release does not rewrite installed units or launcher scripts; refresh them with the installer when a release changes them.

## Production checklist

1. **Back up** the app config directory, release pointers and metadata, the installed helpers and the user units. Record the current PID, release IDs and project and session counts.
2. **Prepare** a permanent clean source clone at the approved revision. Refresh the commands with `sh scripts/workbench/install.sh --commands-only`. Review the rendered units before replacing them and reloading the user manager.
3. **Activate** with `anvi-bench update --restart` (or stage, then `anvi-bench restart`). `anvi-bench status` must report the right PID and release with successful authenticated HTTP, and `healthy` must name that release. Never create pointers by hand.
4. **Compare** project order, workspace names and directories, profiles and native IDs, tab names, order and selection, notification state and saved history. For each verified native profile, confirm the exact conversation resumes; accept a visible manual-recovery state where verification is unavailable.
5. **Rollback** once a verified `previous` exists: exercise `anvi-bench rollback` in an agreed window. Executable rollback does not restore data backups.
6. **Independence**: confirm the running process resolves into `~/.local/share/workbench/releases`, that app and native data live outside any worktree, and that `source_path` names a retained source clone. Then run `anvi-bench status`, `anvi-bench open` and a controlled restart.

## Reproducible verification

Run from a clean committed checkout. Real-systemd tests use uniquely named test units and disposable stores; they never control `workbench.service`.

```sh
pnpm typecheck
pnpm build
pnpm test:unit
pnpm check:systemd
WORKBENCH_REAL_SYSTEMD=1 WORKBENCH_REAL_RELEASE=1 pnpm test:runtime
```

The startup restoration check builds two real releases through the production updater, renders the production unit under a disposable home, drives the public launcher and Chromium with synthetic provider pages, and exercises update, restart, outage, final capture, rollback and source removal. It does not prove real provider authentication or account validity; those remain manual acceptance items. See [testing architecture](../architecture/testing.md) for the suite tiers.

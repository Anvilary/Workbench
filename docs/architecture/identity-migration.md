# Identity migration

This document defines the canonical identity of Anvilary Workbench and how an installation that still uses the legacy identity (the earlier "MAW" and "Agent Workbench" names) moves to it. Use the versioned migration when moving an installation with existing workspaces and browser profiles.

## Canonical identity

| Kind | Legacy | Canonical |
|---|---|---|
| Product | My Amazing Workspace, MAW, Agent Workbench | Anvilary Workbench (short: Workbench) |
| Root package | `agent-workbench` | `@anvilary/workbench` (private until distribution resumes; the `agent-workbench` npm name belongs to the upstream author and is never published from this fork) |
| Workspace packages | `@agent-workbench/{shared,server,web,desktop}` | `@anvilary/workbench-{shared,server,web,desktop}` |
| CLI | `maw`, `anvil-bench` | `anvi-bench`. `anvil-bench`, `maw` and `workbench` are compatibility shims that exec `anvi-bench`; help text names the invoked command |
| Environment variables | `MAW_*`, `AGENT_WORKBENCH_*` | `WORKBENCH_*` (see below) |
| Desktop bridge and IPC | `window.mawChatGpt`, `maw:*` | `window.workbench`, `workbench:*` (no alias: desktop and web ship together) |
| systemd units | `maw.service`, `maw-ptyd.service`, `maw-restart-helper` | `workbench.service`, `workbench-ptyd.service`, `workbench-restart-helper` |
| Runtime directories | `$XDG_RUNTIME_DIR/maw`, `$XDG_RUNTIME_DIR/maw-ptyd` | `$XDG_RUNTIME_DIR/workbench`, `$XDG_RUNTIME_DIR/workbench-ptyd` (socket and auth file names unchanged) |
| Release state | `~/.local/share/maw` | `$XDG_DATA_HOME/workbench` (`releases/`, pointers, `update-log.jsonl`, `source_path`, `node_path`) |
| Release metadata | `.maw-release-meta.json`, `.maw-candidate` | `.workbench-release-meta.json`, `.workbench-candidate` |
| App config and state | `~/.config/agent-workbench` | `$XDG_CONFIG_HOME/workbench` (Windows: `%APPDATA%/workbench`) |
| Environment file | `~/.config/maw/environment` | `$XDG_CONFIG_HOME/workbench/environment` |
| Desktop userData | `~/.local/share/maw-desktop` | `$XDG_DATA_HOME/workbench-desktop` (development prototype: `workbench-desktop-dev`) |
| Browser partitions | `persist:maw-<x>`, `persist:maw-profile-<id>-<provider>` | `persist:workbench-<x>`, `persist:workbench-profile-<id>-<provider>` |
| Logs | `~/.local/state/maw/logs` | `$XDG_STATE_HOME/workbench/logs` |
| Helpers | `~/.local/lib/maw` | `~/.local/lib/workbench` |
| Desktop entry and icon | `maw.desktop`, icon `maw-workspace` | `workbench.desktop`, `StartupWMClass=workbench`, icon `workbench` |
| Electron runtime | `/opt/maw-electron/<ver>` | `/opt/workbench-electron/<ver>`, package `workbench-electron` |
| Temporary directories | `<tmp>/agent-workbench/*` | `<tmp>/workbench/*` (ephemeral, not migrated) |

Unchanged on purpose:

- The Android `applicationId`, the `agentworkbench://` deep link and the `AgentWorkbenchAndroid` user agent. Changing them would break paired devices and the Android update path.
- Upstream attribution and licence files (see [LICENSING.md](../../LICENSING.md)).
- The internal `agency` module, CSS class and i18n key names, and persisted file names inside the config directory (`agency-*.json`).

Browser `localStorage` keys are migrated once inside the app (read old, write new, remove old).

### Environment variables

For supported overrides, Workbench reads `WORKBENCH_X`, then `MAW_X`, then the default. It also supports the original `AGENT_WORKBENCH_*` variables for cwd, debug, open, and restore. When the canonical and legacy values differ, the warning names the variables.

Exceptions:

- The migration drops both unsafe-auth flag names from the inherited environment file. Systemd installs require backend authentication. Direct standalone diagnostic runs can use the explicit canonical flag. See [local authentication](../security/local-auth.md).
- Test-only and evidence-only variables are renamed without aliases.

## Migration tool

Run `scripts/workbench/install.sh --migrate` or `anvi-bench migrate` with `plan`, `apply`, `verify`, `rollback`, or `clean`. Standalone server startup copies the legacy configuration only when the canonical directory is absent.

State is recorded in `$XDG_DATA_HOME/workbench/migration/identity-v1.json` (mode 0600), step by step, with source, destination and a checksum manifest. Completion of a step is re-verified from observable state, not trusted from the marker alone.

### Copy, never move

The legacy release, dependencies, config, userData and Electron runtime stay intact through the acceptance window. Original unit files, CLI scripts and desktop integration are preserved for rollback before their active entries are changed.

### `plan`

Read-only preflight. It prints the full step list and refuses (exit 2, with a precise reason) when:

- a legacy unit or restart helper is active or activating;
- any process of the current user holds the legacy PTY socket or runs Electron with the legacy userData;
- a destination exists without a matching v1 state file (never overwrite);
- free space is less than twice the copy size;
- the source checkout given with `--source` differs from the full SHA in `--expect-commit`, or the worktree has local changes.
- the private `--commit-map` differs from `--commit-map-sha256`, or the mapped legacy revision lies outside the candidate history.

Missing sources mean a fresh install: it exits 0 with "nothing to migrate".

### `apply`

1. **Backup.** Record checksums and archive the legacy config, environment, desktop data, release metadata and launchers under `$XDG_DATA_HOME/workbench-migration-backup`.
2. **Configuration.** Copy settings, workspaces and recoverable terminal history. Convert supported environment keys to `WORKBENCH_*` and remove the unsafe-auth flags.
3. **Desktop data.** Copy the profile and persistent partitions while Electron is stopped. Skip Chromium caches and lock files. Keep cookies, local storage, IndexedDB, service workers, dictionaries and preferences. Rewrite known paths in the copied Chromium preferences.
4. **Helpers and release.** Back up the legacy commands and install `anvi-bench` with aliases. Build the pinned revision into a new release tree using the normal updater. Authenticated readiness is required before the release can become healthy.
5. **Runtime and units.** Install the matching Electron package if `apply` returns exit 3, then rerun `apply`. The migration masks the legacy units and enables the canonical units without starting them.
6. **Desktop entry.** Install the canonical entry and icon, hide the legacy entry and update GNOME favorites when applicable.

Use the verified commit map only for the first canonical install. Subsequent updates use the normal release channel and ancestry checks.

### `verify`, `rollback`, `clean`

- `verify` checks that the canonical units are active, the socket is owned by the supervisor, the readiness probe reports the canonical release, the desktop uses the canonical userData, the initial config copy was verified and the legacy units are masked and inactive. The state becomes `verified` only when every check passes and the owner passes `--accept`.
- `rollback` (any state before `clean`) stops and disables the canonical units, unmasks and enables the legacy units, restores the CLI scripts, desktop entry override and favorites, and renames canonical copies to `*.rolled-back-<ts>` without deleting them.
- `clean` requires `verified` and `--yes`. It lists, then removes, the legacy units, helpers, release state, config, userData, environment file, desktop entry and icons. The backup is kept until the owner deletes it.

## Related

- [Install](../operations/install.md), [update and rollback](../operations/update-rollback.md), [launcher](../operations/launcher.md)
- [Browser profiles and partitions](../browser/profiles.md)
- [Architecture decisions](decisions.md)

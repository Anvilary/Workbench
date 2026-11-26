# Identity migration

This document defines the canonical identity of Anvilary Workbench and how an installation that still uses the legacy identity (the earlier "MAW" and "Agent Workbench" names) moves to it. The earlier cosmetic rebrand (product name in the UI, window title, server banner and the `anvil-bench` CLI) is complete. This document describes the target for the remaining persistent identifiers.

## Canonical identity

| Kind | Legacy | Canonical |
|---|---|---|
| Product | My Amazing Workspace, MAW, Agent Workbench | Anvilary Workbench (short: Workbench) |
| Root package | `agent-workbench` | `@anvilary/workbench` (private until distribution resumes; the `agent-workbench` npm name belongs to the upstream author and is never published from this fork) |
| Workspace packages | `@agent-workbench/{shared,server,web,desktop}` | `@anvilary/workbench-{shared,server,web,desktop}` |
| CLI | `maw`, `anvil-bench` | `anvi-bench`. `anvil-bench`, `maw` and `workbench` are compatibility shims that exec `anvi-bench`; help text names the invoked command |
| Environment variables | `MAW_*`, `AGENT_WORKBENCH_*` | `WORKBENCH_*` (see below) |
| Desktop bridge and IPC | `window.workbench`, `workbench:*` | `window.workbench`, `workbench:*` (no alias: desktop and web ship together) |
| systemd units | `workbench.service`, `workbench-ptyd.service`, `restart-helper` | `workbench.service`, `workbench-ptyd.service`, `workbench-restart-helper` |
| Runtime directories | `$XDG_RUNTIME_DIR/maw`, `$XDG_RUNTIME_DIR/workbench-ptyd` | `$XDG_RUNTIME_DIR/workbench`, `$XDG_RUNTIME_DIR/workbench-ptyd` (socket and auth file names unchanged) |
| Release state | `~/.local/share/workbench` | `$XDG_DATA_HOME/workbench` (`releases/`, pointers, `update-log.jsonl`, `source_path`, `node_path`) |
| Release metadata | `.workbench-release-meta.json`, `.workbench-candidate` | `.workbench-release-meta.json`, `.workbench-candidate` |
| App config and state | `~/.config/workbench` | `$XDG_CONFIG_HOME/workbench` (Windows: `%APPDATA%/workbench`) |
| Environment file | `~/.config/workbench/environment` | `$XDG_CONFIG_HOME/workbench/environment` |
| Desktop userData | `~/.local/share/workbench-desktop` | `$XDG_DATA_HOME/workbench-desktop` (development prototype: `workbench-desktop-dev`) |
| Browser partitions | `persist:workbench-<x>`, `persist:workbench-profile-<id>-<provider>` | `persist:workbench-<x>`, `persist:workbench-profile-<id>-<provider>` |
| Logs | `~/.local/state/workbench/logs` | `$XDG_STATE_HOME/workbench/logs` |
| Helpers | `~/.local/lib/workbench` | `~/.local/lib/workbench` |
| Desktop entry and icon | `workbench.desktop`, icon `workbench` | `workbench.desktop`, `StartupWMClass=workbench`, icon `workbench` |
| Electron runtime | `/opt/workbench-electron/<ver>`, package `workbench-electron` | `/opt/workbench-electron/<ver>`, package `workbench-electron` |
| Temporary directories | `<tmp>/agent-workbench/*` | `<tmp>/workbench/*` (ephemeral, not migrated) |

Unchanged on purpose:

- The Android `applicationId`, the `agentworkbench://` deep link and the `AgentWorkbenchAndroid` user agent. Changing them would break paired devices and the Android update path.
- Upstream attribution and licence files (see [LICENSING.md](../../LICENSING.md)).
- The internal `agency` module, CSS class and i18n key names, and persisted file names inside the config directory (`agency-*.json`).

Browser `localStorage` keys are migrated once inside the app (read old, write new, remove old).

### Environment variables

Each runtime resolves configuration through one resolver with one rule: `WORKBENCH_X` wins, else the legacy `WORKBENCH_X` (or `WORKBENCH_X`), else the default. When both names are set with different values, a single warning names both variables (never the values). Legacy names are accepted for a deprecation period and then removed.

Exceptions:

- `WORKBENCH_UNSAFE_LOCAL_NO_AUTH` has no legacy alias. The migration must not carry the token-free diagnostic mode forward (see [local authentication](../security/local-auth.md)).
- Test-only and evidence-only variables are renamed without aliases.

## Migration tool

One implementation, `scripts/workbench/migrate-identity.mjs` (Node, no dependencies), with the commands `plan | apply | verify | rollback | clean`. The Linux CLI exposes it as `anvi-bench migrate ...`. Non-systemd installs (Windows, npm) call only its `migrateConfigDir()` step at server startup: copy the legacy config directory to the canonical one when the canonical one is absent. It is idempotent.

State is recorded in `$XDG_DATA_HOME/workbench/migration/identity-v1.json` (mode 0600), step by step, with source, destination and a checksum manifest. Completion of a step is re-verified from observable state, not trusted from the marker alone.

### Copy, never move

The legacy installation (release state, units, config, userData, helpers, CLI scripts and the legacy Electron runtime) stays byte for byte intact until `clean`. Rollback therefore needs no data restore in the normal case. A backup archive is kept as defense in depth.

### `plan`

Read-only preflight. It prints the full step list and refuses (exit 2, with a precise reason) when:

- a legacy unit or restart helper is active or activating;
- any process of the current user holds the legacy PTY socket or runs Electron with the legacy userData;
- a destination exists without a matching v1 state file (never overwrite);
- free space is less than twice the copy size;
- the source checkout given with `--source` is not a clean checkout at `--expect-commit`.

Missing sources mean a fresh install: it exits 0 with "nothing to migrate".

### `apply`

Each step is idempotent:

1. **Backup.** Archive of the legacy config, environment file, userData without HTTP and GPU caches, release metadata (pointer targets, update log), units and desktop entry, under `$XDG_DATA_HOME/workbench-migration-backup/` (directory 0700, file 0600), with a verified checksum.
2. **Config.** Copy to `$XDG_CONFIG_HOME/workbench` preserving modes and timestamps; verify the manifest.
3. **Environment file.** Rename `WORKBENCH_X` and `WORKBENCH_X` keys to `WORKBENCH_X`. Drop `WORKBENCH_UNSAFE_LOCAL_NO_AUTH` (recorded by name only). Unknown keys are kept and listed by name. Values are never printed. Written with mode 0600.
4. **Desktop userData.** Copy to `$XDG_DATA_HOME/workbench-desktop`, excluding only Chromium caches (`Cache`, `Code Cache`, `GPUCache`, `DawnGraphiteCache`, `DawnWebGPUCache`, `GPUPersistentCache`, `ShaderCache`), `Crashpad` and `Singleton*` lock files. Cookies, Local Storage, IndexedDB, Service Worker data, dictionaries and preferences are copied. Inside the copy, `Partitions/maw-*` become `Partitions/workbench-*`, and absolute legacy paths in `Preferences` and `Local State` are rewritten. Cookies are stored without OS keyring encryption, so the directory rename does not affect their readability.
5. **Release state.** Build the first canonical release from the verified source with the normal updater in initial mode. It becomes `healthy` only after the normal readiness probe. Legacy releases are not copied.
6. **Helpers and CLI.** Install `~/.local/lib/workbench` and `anvi-bench`; replace `maw`, `anvil-bench` and `workbench` with shims. The legacy scripts are saved for rollback.
7. **Units.** Render `workbench.service` and `workbench-ptyd.service`. Disable and mask the legacy units (masking guarantees two supervisors can never run), enable the canonical units without starting them.
8. **Desktop entry.** Write `workbench.desktop` and the `workbench` icon, hide the legacy entry with a user override, and update a GNOME favorites entry if one exists.
9. **Electron runtime.** If `/opt/workbench-electron/<ver>` is missing, print the owner's install command and stop in the `awaiting-runtime` state (exit 3). Re-running `apply` continues.

### `verify`, `rollback`, `clean`

- `verify` checks that the canonical units are active, the socket is owned by the supervisor, the readiness probe reports the canonical release, the desktop uses the canonical userData, the config manifests match and the legacy units are masked and inactive. The state becomes `verified` only when every check passes and the owner passes `--accept`.
- `rollback` (any state before `clean`) stops and disables the canonical units, unmasks and enables the legacy units, restores the CLI scripts, desktop entry override and favorites, and renames canonical copies to `*.rolled-back-<ts>` without deleting them.
- `clean` requires `verified` and `--yes`. It lists, then removes, the legacy units, helpers, release state, config, userData, environment file, desktop entry and icons. The backup is kept until the owner deletes it.

## Related

- [Install](../operations/install.md), [update and rollback](../operations/update-rollback.md), [launcher](../operations/launcher.md)
- [Browser profiles and partitions](../browser/profiles.md)
- [Architecture decisions](decisions.md)

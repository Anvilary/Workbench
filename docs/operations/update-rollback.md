# Workbench Update, Activation and Rollback

State directory: `~/.local/share/workbench` (`WORKBENCH_STATE_DIR`). Service: `workbench.service` (`WORKBENCH_UNIT`).
Audit log: `~/.local/share/workbench/update-log.jsonl` (one JSON object per line).

## Release state machine

| Pointer (symlink) | Meaning | Written by |
|---|---|---|
| `releases/<id>/` | A built release. `.workbench-candidate` exists only while it is being built; `.workbench-release-meta.json` names it. | `anvi-bench update` |
| `staged` | Built and validated, **never activated**. | `anvi-bench update` only |
| `current` | What `workbench.service` boots (`WorkingDirectory`/`ExecStart` go through it). | restart helper only (and the installer's first release) |
| `healthy` | Last release whose readiness was verified **with its own release ID**. | restart helper, after verification |
| `previous` | The healthy release before `healthy`. | restart helper, after verification |

Consequences:

- Staging (`anvi-bench update --no-restart`) never changes `current`, `healthy` or `previous`. A crash restart,
  reboot or `systemctl --user restart` keeps booting the release that was running. Staging twice simply
  replaces `staged`; the verified rollback target is unaffected.
- A running server is pinned to the release it started from (Node resolves real paths at startup), so
  switching any pointer never changes the live process. Its readiness file (`$WORKBENCH_RUNTIME_DIR/maw-ready.json`)
  contains `pid`, the authenticated loopback `url` and `releaseId`.
- The service refuses to start anything that is not a release (`ExecStartPre` checks the metadata), so it
  never runs from a mutable developer checkout.

## `anvi-bench update`

```sh
anvi-bench update                 # stage the approved channel, prompt to activate in a terminal
anvi-bench update --no-restart    # stage only
anvi-bench update --restart       # stage and activate
anvi-bench update --ref origin/feature/x --allow-unapproved-ref   # explicit, confirmed, recorded as "unapproved"
```

- Target: the approved channel, `origin/main` by default (`WORKBENCH_UPDATE_CHANNEL` or one line in
  `$WORKBENCH_STATE_DIR/channel`). The branch the developer checkout tracks is never used implicitly.
- Builds from committed objects in a detached worktree under `releases/`; never resets, checks out or
  cleans the developer checkout (a dirty checkout is still refused, to surface uncommitted work).
- Steps: fetch → fast-forward check against the healthy release → engines check → frozen install →
  typecheck → build → profile tests → metadata → `staged`.
- Exclusive `flock` lock (`update.lock`): concurrent updaters are refused; the kernel releases the lock if
  the process dies, so there are no stale locks.
- HUP/INT/TERM abort the running step immediately, remove only this run's candidate (path and marker
  checked) and exit 130 with every pointer unchanged. After SIGKILL/power loss the next run removes the
  orphan: only entries inside `releases/` that carry the candidate marker or are registered worktrees of
  the source repository without release metadata, and that no pointer references.

## `anvi-bench restart` / `anvi-bench start` / `anvi-bench rollback` (activation)

The helper (`restart-helper.sh`) takes the restart lock and the update lock, then:

For `anvi-bench start` on an already active service, it verifies `current` against the authenticated HTTP probe without restarting or activating `staged`. HTTP 404, stale readiness, and a mismatched release fail the command. A successful probe establishes `healthy` if needed; no pointer is manufactured to bypass verification.

1. target = `staged` if present, else `current`.
2. `current := target`, `systemctl --user reset-failed`, `systemctl --user restart`.
3. Polls the authenticated readiness probe (`control.mjs status` with `WORKBENCH_EXPECT_RELEASE_ID`): the
   unit's MainPID must answer on its token URL **and** report the target's release ID. A unit that enters
   `failed` (e.g. start-limit-hit) is detected immediately; otherwise the timeout is 20 s
   (`WORKBENCH_READY_TIMEOUT`).
4. Success → `previous := healthy`, `healthy := target`, `staged` cleared, unreferenced releases
   garbage-collected (one spare kept, `WORKBENCH_KEEP_RELEASES`). Exit 0.
5. Failure (including a failing `systemctl restart`) → `staged` cleared (a failed release is never retried
   implicitly), `current := healthy`, reset-failed, restart, verify the healthy release ID.
   - recovered → exit **2**, "UPDATE FAILED, SERVICE RECOVERED".
   - rollback also failed, or no verified release exists, or the healthy release itself fails → exit **3**,
     "CRITICAL". The helper never loops.

Every transition is logged: `stage-success`, `activation-start`, `activation-success`, `activation-failure`,
`rollback-success`, `rollback-failure`, `activation-critical`, `activation-interrupted`, `orphan-removed`,
`release-removed`, `healthy-adopted`. `anvi-bench status` shows all pointers, warns when `current` is not the
verified healthy release, and prints the last log line.

Inside a Workbench terminal, `anvi-bench restart` delegates to a transient unit `workbench-restart-helper` (fixed name, so a
second scheduled restart is rejected by systemd; `--collect` frees the name afterwards) with the `WORKBENCH_*`
environment passed explicitly. The terminal is interrupted; the outcome is in the log.

`anvi-bench rollback` stages `previous` and activates it like any other release.

## Historical data when rolling back

Rollback restores executable releases and verifies service readiness. It does **not** guarantee that the
older release can read every historical record written by the newer release. This applies to both manual
rollback and automatic recovery after failed activation; readiness does not check historical-data compatibility.

The split-history release keeps live sessions in `agency-sessions.json` and closed tabs and superseded
conversation attempts in `agency-sessions-history.json`, in the application config directory (normally
`~/.config/workbench`, separate from `WORKBENCH_STATE_DIR`). The previous single-file release reads only
`agency-sessions.json`. After a downgrade, active sessions remain available through that file, but history
in the split file is invisible to the older UI. The older release leaves that file dormant on disk.
Restoring a split-history release loads both files again, including history retained before the downgrade
and records saved by the single-file release while it was running.

The updater and rollback helper do not delete, overwrite, merge or migrate session history. Do not copy
the history file over the live file or attempt a silent conversion for downgrade compatibility: that can
replace active-session metadata. Before a planned downgrade, stop the service and make a consistent backup
of both session files and their `.bak` companions. Keep the original files available for a later upgrade.

## Installation and migration

- `install.sh --service` builds the first release with the same pipeline (`update.sh --initial`) and
  points `current` at it; it becomes `healthy` on the first verified `anvi-bench start`.
- An old-layout `current` that points at a checkout is preserved as `legacy-current` (never deleted).
- A running release from an older build without `healthy` is adopted as healthy only when the live service
  proves it serves exactly that release (release ID, or its working directory for older servers).

## Manual recovery

```sh
anvi-bench status                                   # pointers, last log event, readiness
journalctl --user -u workbench-restart-helper      # delegated activation output
systemctl --user reset-failed workbench.service    # after a CRITICAL outcome
anvi-bench rollback                                 # activate the previous verified release
```

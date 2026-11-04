#!/bin/sh
# Activate a MAW release and verify it, with automatic rollback to the last verified healthy release.
#
# State machine (see maw-lib.sh for pointers):
#   target   = staged if present, else current (plain restart)
#   ACTIVATE   current := target; reset-failed; restart; wait for readiness of target's release ID
#   SUCCESS    previous := healthy (if different); healthy := target; staged cleared; GC; exit 0
#   FAILURE    staged cleared (never retried implicitly); if healthy exists and differs from target:
#              current := healthy; reset-failed; restart; verify healthy's release ID
#                ok   -> exit 2 (update failed, service recovered)
#                fail -> exit 3 (CRITICAL)
#              else -> exit 3 (CRITICAL: nothing verified to roll back to). Never loops.
# Every command failure is handled explicitly; `set -e` never decides the recovery path.
set -u

self_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=maw-lib.sh
. "$self_dir/maw-lib.sh"
maw_init_paths

control_script="${MAW_CONTROL_SCRIPT:-$self_dir/control.mjs}"
timeout_seconds="${MAW_READY_TIMEOUT:-20}"
mode=restart
force=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --unit) unit="$2"; shift 2 ;;
    --timeout) timeout_seconds="$2"; shift 2 ;;
    --start) mode=start; shift ;;
    --force) force=true; shift ;;
    *) shift ;;
  esac
done
export MAW_UNIT="$unit" MAW_RUNTIME_DIR="$runtime_dir"

[ -n "$node_bin" ] || { printf '%s\n' 'Error: node is not on PATH (set MAW_NODE_BIN).' >&2; exit 1; }

if ! maw_lock_restart; then
  printf '%s\n' 'A restart is already in progress. Duplicate restart avoided.' >&2
  exit 1
fi
if ! maw_lock_update 30; then
  printf '%s\n' 'An update is still being staged; retry maw restart when it finishes.' >&2
  exit 1
fi

phase=start
on_signal() {
  trap '' HUP INT TERM
  maw_log activation-interrupted signal "$1" phase "$phase" current "$(basename "$(maw_pointer_raw current)")"
  printf '%s\n' "Restart helper interrupted ($1) during $phase. 'current' may be unverified; run 'maw restart' to verify or roll back." >&2
  exit 130
}
trap 'on_signal HUP' HUP
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

sctl() { maw_sctl "$@"; }

unit_state() { sctl show "$unit" --property=ActiveState --value 2>/dev/null || true; }

# probe RELEASE_ID -> authenticated readiness of the unit's MainPID, serving exactly RELEASE_ID
# (empty RELEASE_ID = unmanaged legacy target; readiness only).
probe() {
  MAW_EXPECT_RELEASE_ID="$1" "$node_bin" "$control_script" status >/dev/null 2>&1
}

# start_and_verify DIR -> 0 when the service started from DIR reports DIR's release ID.
fail_reason=""
start_and_verify() {
  _id=$(maw_release_id "$1")
  sctl reset-failed "$unit" >/dev/null 2>&1 || true
  if ! sctl restart "$unit"; then
    # Type=exec: ExecStartPre failure, missing binary, start-limit-hit or unit errors.
    fail_reason="systemctl restart failed"
    return 1
  fi
  _i=0
  while [ "$_i" -lt "$timeout_seconds" ]; do
    sleep 1
    _i=$((_i + 1))
    if probe "$_id"; then return 0; fi
    if [ "$(unit_state)" = failed ]; then
      fail_reason="unit entered failed state ($(sctl show "$unit" --property=Result --value 2>/dev/null || true))"
      return 1
    fi
  done
  fail_reason="readiness timeout after ${timeout_seconds}s"
  return 1
}

current_raw=$(maw_pointer_raw current)
healthy=$(maw_pointer healthy)
staged=$(maw_pointer staged)
previous=$(maw_pointer previous)

# Idempotent start must prove the running release is operational. Do not restart
# a live service or activate a staged update just because readiness fails.
if [ "$mode" = start ] && [ "$(unit_state)" = active ]; then
  if ! maw_valid_release "$current_raw" || ! probe "$(maw_release_id "$current_raw")"; then
    maw_log start-unhealthy release "$(basename "$current_raw")"
    printf '%s\n' 'MAW is active but authenticated readiness failed. Inspect maw status and maw logs; use maw restart to activate a repaired release.' >&2
    exit 1
  fi
  if [ "$current_raw" != "$healthy" ]; then
    [ -z "$healthy" ] || maw_set_pointer previous "$healthy" || exit 1
    maw_set_pointer healthy "$current_raw" || exit 1
    maw_log healthy-adopted release "$(basename "$current_raw")"
  fi
  printf '%s\n' "MAW service $unit is already running and verified healthy on release $(basename "$current_raw")."
  exit 0
fi

# Migration from layouts without `healthy`: adopt the running release only when the live service proves
# it is serving exactly that release. A legacy (non-release) current is never adopted.
if [ -z "$healthy" ] && maw_valid_release "$current_raw" && probe "$(maw_release_id "$current_raw")"; then
  maw_set_pointer healthy "$current_raw" && healthy="$current_raw" &&
    maw_log healthy-adopted release "$(basename "$current_raw")"
fi

if [ -n "$staged" ]; then target="$staged"; else target="$current_raw"; fi
if [ -z "$target" ]; then
  printf '%s\n' "CRITICAL: no release to start ($state_dir/current is missing). Run the installer or maw update." >&2
  maw_log activation-critical reason 'no current release'
  exit 3
fi
target_name=$(basename "$target")
managed=true
maw_valid_release "$target" || managed=false

maw_log activation-start target "$target_name" mode "$mode" from "$(basename "$current_raw")" healthy "$(basename "${healthy:-none}")"
printf '%s\n' "Activating $target_name on $unit..."

# Activation guard: protect active coding agents from being killed by backend restart
guard_script="${MAW_ACTIVATE_GUARD:-$self_dir/maw-activate-guard.sh}"
if [ "$force" != true ] && [ -x "$guard_script" ]; then
  if ! "$guard_script" --unit "$unit"; then
    maw_log activation-blocked target "$target_name" reason 'active coding agents in unit cgroup'
    printf '%s\n' 'Activation refused: active coding agents detected in service cgroup.' \
      'Wait for tasks to finish, or pass --force (e.g. maw restart --force) to override.' >&2
    exit 1
  fi
fi

phase=switch
if [ "$managed" = true ] && [ "$target" != "$current_raw" ]; then
  if ! maw_set_pointer current "$target"; then
    maw_log activation-failure target "$target_name" reason 'could not switch current'
    printf '%s\n' 'Error: could not switch the current release pointer; nothing was restarted.' >&2
    exit 1
  fi
fi

phase=verify
if start_and_verify "$target"; then
  if [ "$managed" = true ]; then
    [ "$target" = "$staged" ] && maw_clear_pointer staged
    if [ "$target" != "$healthy" ]; then
      [ -n "$healthy" ] && maw_set_pointer previous "$healthy"
      maw_set_pointer healthy "$target"
    fi
  fi
  maw_log activation-success release "$target_name" managed "$managed"
  printf '%s\n' "MAW service $unit is healthy on release $target_name."
  "$node_bin" "$control_script" status || true
  # Garbage-collect unreferenced releases (never the pointed-to ones, never non-release paths).
  keep="${MAW_KEEP_RELEASES:-1}"
  rr=$(cd "$releases_dir" 2>/dev/null && pwd -P) || exit 0
  refs=" $(maw_pointer_raw current) $(maw_pointer_raw staged) $(maw_pointer_raw healthy) $(maw_pointer_raw previous) "
  # shellcheck disable=SC2012
  ls -1 "$rr" 2>/dev/null | sort -r | while IFS= read -r name; do
    d="$rr/$name"
    case "$refs" in *" $d "*) continue ;; esac
    maw_valid_release_name "$name" && [ -d "$d" ] && [ ! -L "$d" ] && [ ! -e "$d/.maw-candidate" ] &&
      [ "$(maw_release_id "$d")" = "$name" ] || continue
    if [ "$keep" -gt 0 ]; then keep=$((keep - 1)); continue; fi
    rm -rf -- "$d" && maw_log release-removed release "$name"
  done
  exit 0
fi

failed_reason="$fail_reason"
maw_log activation-failure target "$target_name" reason "$failed_reason"
printf '%s\n' "Error: release $target_name failed activation: $failed_reason." >&2
[ "$target" = "$staged" ] && maw_clear_pointer staged

phase=rollback
if [ -n "$healthy" ] && [ "$healthy" != "$target" ]; then
  healthy_name=$(basename "$healthy")
  printf '%s\n' "Rolling back to last verified healthy release $healthy_name..." >&2
  printf '%s\n' 'Executable rollback does not guarantee historical-data compatibility; older releases cannot display split session history.' >&2
  if maw_set_pointer current "$healthy" && start_and_verify "$healthy"; then
    maw_log rollback-success release "$healthy_name" failed "$target_name"
    printf '%s\n' "UPDATE FAILED, SERVICE RECOVERED: $healthy_name is active and verified healthy." \
      "The failed release $target_name was not kept staged." >&2
    exit 2
  fi
  maw_log rollback-failure release "$healthy_name" failed "$target_name" reason "$fail_reason"
  printf '%s\n' "CRITICAL: rollback to $healthy_name also failed ($fail_reason). MAW is DOWN." \
    "Inspect: maw logs; systemctl --user status $unit" >&2
  exit 3
fi

if [ "$target" = "$healthy" ]; then
  maw_log activation-critical reason 'verified healthy release failed to start' release "$target_name"
  printf '%s\n' "CRITICAL: the verified healthy release $target_name failed to start ($failed_reason). MAW is DOWN." >&2
else
  maw_log activation-critical reason 'no verified healthy release to roll back to' release "$target_name"
  printf '%s\n' "CRITICAL: no verified healthy release is available for rollback. MAW is DOWN." >&2
fi
printf '%s\n' "Inspect: maw logs; systemctl --user status $unit" >&2
[ -n "$previous" ] && printf '%s\n' "An older verified release exists ($(basename "$previous")): maw rollback" >&2
exit 3

#!/bin/sh
# Activate a Workbench release and verify it, with automatic rollback to the last verified healthy release.
#
# State machine (see lib.sh for pointers):
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
# shellcheck source=lib.sh
. "$self_dir/lib.sh"
wb_init_paths

control_script="${WORKBENCH_CONTROL_SCRIPT:-$self_dir/control.mjs}"
timeout_seconds="${WORKBENCH_READY_TIMEOUT:-20}"
cli_name="${WORKBENCH_CLI_NAME:-workbench}"
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
export WORKBENCH_UNIT="$unit" WORKBENCH_RUNTIME_DIR="$runtime_dir"

[ -n "$node_bin" ] || { printf '%s\n' 'Error: node is not on PATH (set WORKBENCH_NODE_BIN).' >&2; exit 1; }

if ! wb_lock_restart; then
  printf '%s\n' 'A restart is already in progress. Duplicate restart avoided.' >&2
  exit 1
fi
if ! wb_lock_update 30; then
  printf '%s\n' "An update is still being staged; retry $cli_name restart when it finishes." >&2
  exit 1
fi

phase=start
on_signal() {
  trap '' HUP INT TERM
  wb_log activation-interrupted signal "$1" phase "$phase" current "$(basename "$(wb_pointer_raw current)")"
  printf '%s\n' "Restart helper interrupted ($1) during $phase. 'current' may be unverified; run '$cli_name restart' to verify or roll back." >&2
  exit 130
}
trap 'on_signal HUP' HUP
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

sctl() { wb_sctl "$@"; }

unit_state() { sctl show "$unit" --property=ActiveState --value 2>/dev/null || true; }
ptyd_unit_state() { sctl show "${WORKBENCH_PTYD_UNIT:-workbench-ptyd.service}" --property=ActiveState --value 2>/dev/null || true; }

backend_may_write() {
  case "$(unit_state)" in inactive|failed) return 1 ;; *) return 0 ;; esac
}

# probe RELEASE_ID -> authenticated readiness of the unit's MainPID, serving exactly RELEASE_ID
# (empty RELEASE_ID = unmanaged legacy target; readiness only).
probe() {
  WORKBENCH_EXPECT_RELEASE_ID="$1" "$node_bin" "$control_script" status >/dev/null 2>&1
}

# start_and_verify DIR -> 0 when the service started from DIR reports DIR's release ID.
fail_reason=""
backend_stopped=false
ptyd_promoted=false
ptyd_bundle_changed() {
  ! cmp -s "$1/packages/server/dist/ptyd.mjs" "$2/packages/server/dist/ptyd.mjs" ||
    ! cmp -s "$1/packages/server/dist/terminal-state.mjs" "$2/packages/server/dist/terminal-state.mjs"
}
start_and_verify() {
  _id=$(wb_release_id "$1")
  sctl reset-failed "$unit" "${WORKBENCH_PTYD_UNIT:-workbench-ptyd.service}" >/dev/null 2>&1 || true
  if [ "$restart_ptyd" = true ]; then
    ptyd_promoted=true
    if ! sctl restart "${WORKBENCH_PTYD_UNIT:-workbench-ptyd.service}"; then
      fail_reason="PTY supervisor restart failed"
      return 1
    fi
    restart_ptyd=false
  fi
  if [ "$backend_stopped" = true ]; then
    if ! sctl start "$unit"; then
      fail_reason="systemctl start failed after backend quiescence"
      return 1
    fi
    backend_stopped=false
  else
    if ! sctl restart "$unit"; then
      # Type=exec: ExecStartPre failure, missing binary, start-limit-hit or unit errors.
      fail_reason="systemctl restart failed"
      return 1
    fi
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

restore_backend() {
  [ "$backend_stopped" = true ] || return 0
  if ! sctl start "$unit"; then return 1; fi
  backend_stopped=false
  _restore_id=$(wb_release_id "$current_raw")
  _restore_i=0
  while [ "$_restore_i" -lt "$timeout_seconds" ]; do
    sleep 1
    _restore_i=$((_restore_i + 1))
    if probe "$_restore_id"; then return 0; fi
    [ "$(unit_state)" = failed ] && return 1
  done
  return 1
}

current_raw=$(wb_pointer_raw current)
healthy=$(wb_pointer healthy)
staged=$(wb_pointer staged)
previous=$(wb_pointer previous)

# Idempotent start must prove the running release is operational. Do not restart
# a live service or activate a staged update just because readiness fails.
if [ "$mode" = start ] && [ "$(unit_state)" = active ]; then
  if ! wb_valid_release "$current_raw" || ! probe "$(wb_release_id "$current_raw")"; then
    wb_log start-unhealthy release "$(basename "$current_raw")"
    printf '%s\n' "Workbench is active but authenticated readiness failed. Inspect $cli_name status and $cli_name logs; use $cli_name restart to activate a repaired release." >&2
    exit 1
  fi
  if [ "$current_raw" != "$healthy" ]; then
    [ -z "$healthy" ] || wb_set_pointer previous "$healthy" || exit 1
    wb_set_pointer healthy "$current_raw" || exit 1
    wb_log healthy-adopted release "$(basename "$current_raw")"
  fi
  printf '%s\n' "Workbench service $unit is already running and verified healthy on release $(basename "$current_raw")."
  exit 0
fi

# Migration from layouts without `healthy`: adopt the running release only when the live service proves
# it is serving exactly that release. A legacy (non-release) current is never adopted.
if [ -z "$healthy" ] && wb_valid_release "$current_raw" && probe "$(wb_release_id "$current_raw")"; then
  wb_set_pointer healthy "$current_raw" && healthy="$current_raw" &&
    wb_log healthy-adopted release "$(basename "$current_raw")"
fi

if [ -n "$staged" ]; then target="$staged"; else target="$current_raw"; fi
if [ -z "$target" ]; then
  printf '%s\n' "CRITICAL: no release to start ($state_dir/current is missing). Run the installer or $cli_name update." >&2
  wb_log activation-critical reason 'no current release'
  exit 3
fi
target_name=$(basename "$target")
managed=true
wb_valid_release "$target" || managed=false

if ! "$node_bin" "$control_script" check-data "$target"; then
  wb_log activation-blocked target "$target_name" reason 'target release cannot preserve existing browser data'
  printf '%s\n' 'Activation refused to protect browser data.' \
    'No release pointer or service was changed.' >&2
  exit 1
fi

# The supervisor is an independent service, so restarting Workbench does not load a
# changed supervisor binary. Promote it only after its authenticated snapshot
# confirms there are no live PTYs; authentication or snapshot failures defer
# the activation before any release pointer or service is changed.
restart_ptyd=false
running_ptyd=""
if [ "$managed" = true ] && [ "$(ptyd_unit_state)" = active ]; then
  if ! running_ptyd=$("$node_bin" "$control_script" ptyd-release) || ! wb_valid_release "$running_ptyd"; then
    wb_log activation-blocked target "$target_name" reason 'could not verify running PTY supervisor release'
    printf '%s\n' 'Activation deferred: the running PTY supervisor release could not be verified.' >&2
    exit 1
  fi
  if ptyd_bundle_changed "$running_ptyd" "$target"; then
    if ! "$node_bin" "$control_script" ptyd-empty >/dev/null 2>&1; then
      wb_log activation-blocked target "$target_name" reason 'PTY supervisor is not authenticated or has live sessions'
      printf '%s\n' 'Activation deferred: the PTY supervisor could not be authenticated or still has live sessions.' \
        "Retry $cli_name restart after all terminal sessions have finished. No release pointer or service was changed." >&2
      exit 1
    fi
    restart_ptyd=true
  fi
fi

wb_log activation-start target "$target_name" mode "$mode" from "$(basename "$current_raw")" healthy "$(basename "${healthy:-none}")"
printf '%s\n' "Activating $target_name on $unit..."

# Activation guard: protect active coding agents from being killed by backend restart
guard_script="${WORKBENCH_ACTIVATE_GUARD:-$self_dir/activate-guard.sh}"
if [ "$force" != true ] && [ -x "$guard_script" ]; then
  if ! WORKBENCH_CLI_NAME="$cli_name" "$guard_script" --unit "$unit"; then
    wb_log activation-blocked target "$target_name" reason 'active coding agents in unit cgroup'
    printf '%s\n' 'Activation refused: active coding agents detected in service cgroup.' \
      "Wait for tasks to finish, or pass --force (e.g. $cli_name restart --force) to override." >&2
    exit 1
  fi
fi

# Stop admission and let pending writes flush before changing release or
# replacing the supervisor. The preflight checks keep refusals non-disruptive.
if { [ "$target" != "$current_raw" ] || [ "$restart_ptyd" = true ]; } && backend_may_write; then
  backend_stopped=true
  if ! sctl stop "$unit"; then
    restore_backend || true
    wb_log activation-blocked target "$target_name" reason 'could not quiesce backend before release switch'
    printf '%s\n' 'Activation deferred: Workbench could not be stopped safely for the release switch.' >&2
    exit 1
  fi
  if ! "$node_bin" "$control_script" check-data "$target"; then
    wb_log activation-blocked target "$target_name" reason 'target cannot preserve data flushed by the backend'
    printf '%s\n' 'Activation refused to protect browser data. No release pointer was changed.' >&2
    if ! restore_backend; then
      printf '%s\n' "Warning: previous backend readiness was not restored. Inspect $cli_name status." >&2
    fi
    exit 1
  fi
  if [ "$restart_ptyd" = true ] && ! "$node_bin" "$control_script" ptyd-empty >/dev/null 2>&1; then
    _restored=false
    restore_backend && _restored=true
    wb_log activation-blocked target "$target_name" reason 'PTY sessions appeared while backend was quiesced'
    printf '%s\n' 'Activation deferred: PTY sessions appeared before the supervisor could be restarted.' \
      'No release pointer was changed.' >&2
    if [ "$_restored" = true ]; then
      printf '%s\n' 'The previous backend is healthy.' >&2
    else
      printf '%s\n' "Warning: previous backend readiness was not restored; inspect $cli_name status." >&2
    fi
    exit 1
  fi
fi

phase=switch
if [ "$managed" = true ] && [ "$target" != "$current_raw" ]; then
  if ! wb_set_pointer current "$target"; then
    wb_log activation-failure target "$target_name" reason 'could not switch current'
    printf '%s\n' 'Error: could not switch the current release pointer.' >&2
    if [ "$backend_stopped" = true ]; then
      if restore_backend; then
        printf '%s\n' 'The previous backend is healthy; the supervisor was not restarted.' >&2
      else
        printf '%s\n' "Warning: previous backend readiness was not restored; inspect $cli_name status." >&2
      fi
    fi
    exit 1
  fi
fi

phase=verify
if start_and_verify "$target"; then
  if [ "$managed" = true ]; then
    [ "$target" = "$staged" ] && wb_clear_pointer staged
    if [ "$target" != "$healthy" ]; then
      [ -n "$healthy" ] && wb_set_pointer previous "$healthy"
      wb_set_pointer healthy "$target"
    fi
    wb_refresh_desktop_assets_if_enabled "$target" || true
  fi
  wb_log activation-success release "$target_name" managed "$managed"
  printf '%s\n' "Workbench service $unit is healthy on release $target_name."
  "$node_bin" "$control_script" status || true
  # Garbage-collect unreferenced releases (never the pointed-to ones, never non-release paths).
  keep="${WORKBENCH_KEEP_RELEASES:-1}"
  rr=$(cd "$releases_dir" 2>/dev/null && pwd -P) || exit 0
  refs=" $(wb_pointer_raw current) $(wb_pointer_raw staged) $(wb_pointer_raw healthy) $(wb_pointer_raw previous) $running_ptyd "
  # shellcheck disable=SC2012
  ls -1 "$rr" 2>/dev/null | sort -r | while IFS= read -r name; do
    d="$rr/$name"
    case "$refs" in *" $d "*) continue ;; esac
    wb_valid_release_name "$name" && [ -d "$d" ] && [ ! -L "$d" ] && [ ! -e "$d/.workbench-candidate" ] &&
      [ "$(wb_release_id "$d")" = "$name" ] || continue
    if [ "$keep" -gt 0 ]; then keep=$((keep - 1)); continue; fi
    rm -rf -- "$d" && wb_log release-removed release "$name"
  done
  exit 0
fi

failed_reason="$fail_reason"
wb_log activation-failure target "$target_name" reason "$failed_reason"
printf '%s\n' "Error: release $target_name failed activation: $failed_reason." >&2
[ "$target" = "$staged" ] && wb_clear_pointer staged

phase=rollback
if [ -n "$healthy" ] && [ "$healthy" != "$target" ]; then
  healthy_name=$(basename "$healthy")
  if [ "$backend_stopped" = false ] && backend_may_write; then
    if ! sctl stop "$unit"; then
      wb_log rollback-failure release "$healthy_name" failed "$target_name" reason 'could not quiesce backend before rollback'
      printf '%s\n' 'CRITICAL: automatic rollback was deferred because Workbench could not be stopped safely.' >&2
      exit 3
    fi
    backend_stopped=true
  fi
  if ! "$node_bin" "$control_script" check-data "$healthy"; then
    wb_log rollback-failure release "$healthy_name" failed "$target_name" reason 'target release cannot preserve existing browser data'
    printf '%s\n' "CRITICAL: automatic rollback to $healthy_name was blocked to protect browser data." \
      "The browser tab store was preserved. Inspect $cli_name status and $cli_name logs before choosing a compatible release." >&2
    exit 3
  fi
  if [ "$ptyd_promoted" = true ] && [ "$(ptyd_unit_state)" = active ] &&
    ! "$node_bin" "$control_script" ptyd-empty >/dev/null 2>&1; then
    wb_log rollback-failure release "$healthy_name" failed "$target_name" reason 'live PTY sessions or unverifiable supervisor'
    printf '%s\n' 'CRITICAL: automatic rollback was deferred to protect PTY sessions.' \
      "The supervisor is still running. Inspect $cli_name status and $cli_name logs." >&2
    exit 3
  fi
  printf '%s\n' "Rolling back to last verified healthy release $healthy_name..." >&2
  printf '%s\n' 'Executable rollback does not guarantee historical-data compatibility; older releases cannot display split session history.' >&2
  if [ "$ptyd_promoted" = true ]; then
    if [ -f "$healthy/packages/server/dist/ptyd.mjs" ] && [ -f "$healthy/packages/server/dist/terminal-state.mjs" ]; then
      restart_ptyd=true
    else
      restart_ptyd=false
      if ! sctl stop "${WORKBENCH_PTYD_UNIT:-workbench-ptyd.service}"; then
        wb_log rollback-failure release "$healthy_name" failed "$target_name" reason 'could not stop the empty supervisor'
        exit 3
      fi
    fi
  fi
  if wb_set_pointer current "$healthy" && start_and_verify "$healthy"; then
    wb_refresh_desktop_assets_if_enabled "$healthy" || true
    wb_log rollback-success release "$healthy_name" failed "$target_name"
    printf '%s\n' "UPDATE FAILED, SERVICE RECOVERED: $healthy_name is active and verified healthy." \
      "The failed release $target_name was not kept staged." >&2
    exit 2
  fi
  wb_log rollback-failure release "$healthy_name" failed "$target_name" reason "$fail_reason"
  printf '%s\n' "CRITICAL: rollback to $healthy_name also failed ($fail_reason). Workbench is DOWN." \
    "Inspect: $cli_name logs; systemctl --user status $unit" >&2
  exit 3
fi

if [ "$target" = "$healthy" ]; then
  wb_log activation-critical reason 'verified healthy release failed to start' release "$target_name"
  printf '%s\n' "CRITICAL: the verified healthy release $target_name failed to start ($failed_reason). Workbench is DOWN." >&2
else
  wb_log activation-critical reason 'no verified healthy release to roll back to' release "$target_name"
  printf '%s\n' "CRITICAL: no verified healthy release is available for rollback. Workbench is DOWN." >&2
fi
printf '%s\n' "Inspect: $cli_name logs; systemctl --user status $unit" >&2
[ -n "$previous" ] && printf '%s\n' "An older verified release exists ($(basename "$previous")): $cli_name rollback" >&2
exit 3

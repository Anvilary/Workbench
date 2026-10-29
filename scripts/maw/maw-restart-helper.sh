#!/bin/sh
set -eu

unit="${MAW_UNIT:-maw.service}"
state_dir="${MAW_STATE_DIR:-/home/alteixeira20/.local/share/maw}"
runtime_dir="${MAW_RUNTIME_DIR:-${XDG_RUNTIME_DIR:-/tmp}/maw}"
lock_file="${MAW_RESTART_LOCK:-$runtime_dir/restart.lock}"

# Resolve control.mjs
self_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${MAW_CONTROL_SCRIPT:-}" ]; then
  control_script="$MAW_CONTROL_SCRIPT"
elif [ -f "$self_dir/control.mjs" ]; then
  control_script="$self_dir/control.mjs"
else
  control_script=/home/alteixeira20/.local/lib/maw/control.mjs
fi

node_bin=$(command -v node 2>/dev/null || printf '%s' '/home/alteixeira20/.nvm/versions/node/v24.22.0/bin/node')
[ -n "$node_bin" ] || node_bin='/home/alteixeira20/.nvm/versions/node/v24.22.0/bin/node'

timeout_seconds=20

while [ "$#" -gt 0 ]; do
  case "$1" in
    --unit)
      unit="$2"
      shift 2
      ;;
    --timeout)
      timeout_seconds="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

export MAW_UNIT="$unit"
export MAW_RUNTIME_DIR="$runtime_dir"

# Check / acquire restart lock
mkdir -p "$(dirname "$lock_file")" 2>/dev/null || true
if [ -f "$lock_file" ]; then
  existing_pid=$(cat "$lock_file" 2>/dev/null || true)
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    printf '%s\n' "Restart already in progress (PID: $existing_pid). Avoiding duplicate." >&2
    exit 1
  fi
fi
echo "$$" > "$lock_file"
trap 'rm -f "$lock_file"' EXIT INT TERM

# Brief delay to allow caller process to complete its exit when delegated
sleep 1

# Execute restart
printf '%s\n' "Executing restart of $unit..."
systemctl --user restart "$unit"

# Poll readiness
ready=false
for i in $(seq 1 "$timeout_seconds"); do
  sleep 1
  if "$node_bin" "$control_script" status >/dev/null 2>&1; then
    ready=true
    break
  fi
done

if [ "$ready" = true ]; then
  printf '%s\n' "MAW service $unit restarted successfully and is healthy."
  "$node_bin" "$control_script" status
  exit 0
fi

# Service failed readiness check: attempt rollback
printf '%s\n' "Error: Service $unit failed readiness check after restart." >&2

current_link="$state_dir/current"
previous_link="$state_dir/previous"

if [ -L "$previous_link" ] && [ -d "$previous_link" ]; then
  prev_target=$(readlink -f "$previous_link")
  printf '%s\n' "Initiating automatic rollback to previous verified release: $prev_target" >&2
  ln -sfn "$prev_target" "${current_link}.tmp"
  mv -Tf "${current_link}.tmp" "$current_link"
  
  printf '%s\n' "Restarting $unit with previous release..." >&2
  systemctl --user restart "$unit"
  
  rollback_ready=false
  for i in $(seq 1 "$timeout_seconds"); do
    sleep 1
    if "$node_bin" "$control_script" status >/dev/null 2>&1; then
      rollback_ready=true
      break
    fi
  done
  
  if [ "$rollback_ready" = true ]; then
    printf '%s\n' "Rollback succeeded. Previous verified release ($prev_target) is active and healthy." >&2
    exit 1
  else
    printf '%s\n' "Critical: Rollback to previous release also failed readiness." >&2
    exit 1
  fi
else
  printf '%s\n' "No previous verified release available for rollback." >&2
  exit 1
fi

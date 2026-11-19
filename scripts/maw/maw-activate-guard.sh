#!/bin/sh
# Activation guard for Anvilary Workbench (MAW) deployment.
#
# Refuses to restart maw.service while protected active coding agents remain inside the
# maw.service cgroup, unless the owner explicitly authorizes interruption.
#
# Usage:
#   maw-activate-guard.sh [--force] [--unit <unit>]
#
# Exit codes:
#   0  - safe to proceed (no protected agents, unit not active, or --force provided)
#   1  - protected agents present (or active unit cgroup unverifiable); activation blocked
#   2  - usage error
#
# POSIX sh; no bashisms.
set -eu

self_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$self_dir/maw-lib.sh" ]; then
  # shellcheck source=maw-lib.sh
  . "$self_dir/maw-lib.sh"
fi

force=false
unit="${MAW_UNIT:-maw.service}"
cli_name="${MAW_CLI_NAME:-anvil-bench}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) force=true; shift ;;
    --unit)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { printf '%s\n' "Usage: maw-activate-guard.sh [--force] [--unit <unit>]" >&2; exit 2; }
      unit="$2"; shift 2 ;;
    *) printf '%s\n' "Usage: maw-activate-guard.sh [--force] [--unit <unit>]" >&2; exit 2 ;;
  esac
done

guard_sctl() {
  if command -v maw_sctl >/dev/null 2>&1; then
    maw_sctl "$@"
  else
    _uid=$(id -u 2>/dev/null || true)
    _rdir="${XDG_RUNTIME_DIR:-}"
    [ -z "$_rdir" ] && [ -n "$_uid" ] && [ -d "/run/user/$_uid" ] && _rdir="/run/user/$_uid"
    if [ -n "$_rdir" ]; then
      env XDG_RUNTIME_DIR="$_rdir" systemctl --user "$@"
    else
      systemctl --user "$@"
    fi
  fi
}

# Determine unit state and cgroup path using systemd's view, not by scanning /proc directly.
systemctl_ok=false
active_state=""
load_state=""
maw_cgroup=""
if _st=$(guard_sctl show "$unit" --property=ActiveState --value 2>/dev/null); then
  systemctl_ok=true
  active_state="$_st"
  load_state=$(guard_sctl show "$unit" --property=LoadState --value 2>/dev/null || true)
  maw_cgroup=$(guard_sctl show "$unit" --property=ControlGroup --value 2>/dev/null || true)
fi

if [ -z "$maw_cgroup" ]; then
  # Stopped, failed, or non-existent units have no running cgroup processes.
  if [ "$systemctl_ok" = true ]; then
    case "$active_state" in
      inactive|failed)
        printf '%s\n' "[guard] Unit $unit is not active ($active_state). Activation is safe."
        exit 0
        ;;
    esac
    if [ "$load_state" = "not-found" ]; then
      printf '%s\n' "[guard] Unit $unit is not loaded (not-found). Activation is safe."
      exit 0
    fi
  fi

  # Either systemctl is unavailable or an active/transitioning unit reported no cgroup.
  if [ "$unit" = "maw.service" ]; then
    if [ "$systemctl_ok" = false ]; then
      printf '%s\n' "[guard] Cannot determine $unit state or cgroup (systemctl unavailable). Proceeding conservatively." >&2
    else
      printf '%s\n' "[guard] Cannot determine $unit cgroup while unit state is '${active_state:-unknown}'. Proceeding conservatively." >&2
    fi
    if [ "$force" = false ]; then
      printf '%s\n' \
        "[guard] BLOCKED: cannot verify no protected agents are running." \
        "        Rerun with: $cli_name restart --force (or $cli_name start --force)" >&2
      exit 1
    fi
  fi
  exit 0
fi

# Remove leading / for the cgroupfs path.
cgroup_rel="${maw_cgroup#/}"
cgroup_root="${MAW_CGROUP_ROOT:-/sys/fs/cgroup}"
proc_root="${MAW_PROC_ROOT:-/proc}"

# Enumerate PIDs in the cgroup via cgroupfs. On cgroup v2 this is cgroup.procs.
cgroup_procs_file="${cgroup_root}/${cgroup_rel}/cgroup.procs"

if [ ! -f "$cgroup_procs_file" ]; then
  # cgroup v1 fallback - not expected in modern kernels but be defensive.
  printf '%s\n' "[guard] cgroup.procs not found at $cgroup_procs_file; skipping agent check." >&2
  exit 0
fi

# Identify coding-agent processes by executable name (all supported CLIs).
# Exact match avoids false positives (e.g. ping/pipewire must not match pi).
AGENT_PATTERNS="codex|codex-code-mode|claude|opencode|agy|antigravity|pi"

match_agent_name() {
  _candidate="$1"
  printf '%s' "$_candidate" | grep -Eq "^($AGENT_PATTERNS)$"
}

# For JS runtimes (node/nodejs/bun/deno), inspect argv script basename so node-hosted
# CLIs (e.g. claude, codex, pi, opencode) are detected without flagging Workbench itself.
detect_runtime_agent() {
  _cmdline_file="$1"
  [ -r "$_cmdline_file" ] || return 1
  _arg_idx=0
  _skip_next=false
  _found=""
  while IFS= read -r _arg; do
    _arg_idx=$((_arg_idx + 1))
    [ "$_arg_idx" -eq 1 ] && continue
    if [ "$_skip_next" = true ]; then
      _skip_next=false
      continue
    fi
    case "$_arg" in
      -e|--eval|-p|--print|-r|--require|--import|--loader|--conditions|-C)
        _skip_next=true
        continue
        ;;
      -*)
        continue
        ;;
      "")
        continue
        ;;
      *)
        _base=$(basename -- "$_arg" 2>/dev/null || true)
        _base="${_base%.mjs}"
        _base="${_base%.cjs}"
        _base="${_base%.js}"
        if match_agent_name "$_base"; then
          _found="$_base"
        fi
        break
        ;;
    esac
  done <<EOF
$(tr '\0' '\n' < "$_cmdline_file" 2>/dev/null || true)
EOF
  if [ -n "$_found" ]; then
    printf '%s' "$_found"
    return 0
  fi
  return 1
}

protected_pids=""
while IFS= read -r pid; do
  [ -n "$pid" ] || continue
  comm=""
  comm=$(cat "${proc_root}/${pid}/comm" 2>/dev/null || true)
  if match_agent_name "$comm"; then
    protected_pids="$protected_pids $pid($comm)"
  else
    case "$comm" in
      node|nodejs|bun|deno)
        _agent_name=$(detect_runtime_agent "${proc_root}/${pid}/cmdline" 2>/dev/null || true)
        if [ -n "$_agent_name" ]; then
          protected_pids="$protected_pids $pid($_agent_name)"
        fi
        ;;
    esac
  fi
done < "$cgroup_procs_file"

protected_pids="${protected_pids# }"  # strip leading space

if [ -z "$protected_pids" ]; then
  printf '%s\n' "[guard] No protected coding agents found in $unit cgroup. Activation is safe."
  exit 0
fi

if [ "$force" = true ]; then
  printf '%s\n' \
    "[guard] WARNING: --force specified. Protected agents will be terminated by $unit restart:" \
    "        $protected_pids" \
    "        Proceeding." >&2
  exit 0
fi

printf '%s\n' \
  "[guard] BLOCKED: active coding agents detected in $unit cgroup:" \
  "        $protected_pids" \
  "" \
  "        These processes will be terminated if $unit is restarted." \
  "        Options:" \
  "          1. Wait for them to complete, then run: $cli_name restart" \
  "          2. Authorize interruption: $cli_name restart --force" >&2
exit 1

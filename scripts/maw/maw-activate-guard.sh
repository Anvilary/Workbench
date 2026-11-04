#!/bin/sh
# Activation guard for MAW Next-Generation deployment.
#
# Refuses to restart maw.service while protected active coding agents remain inside the
# maw.service cgroup, unless the owner explicitly authorizes interruption.
#
# Usage:
#   maw-activate-guard.sh [--force]
#
# Exit codes:
#   0  - safe to proceed (no protected agents, or --force provided)
#   1  - protected agents present; activation blocked
#   2  - usage error
#
# POSIX sh; no bashisms.
set -eu

force=false
unit="${MAW_UNIT:-maw.service}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) force=true; shift ;;
    --unit) unit="$2"; shift 2 ;;
    *) printf '%s\n' "Usage: maw-activate-guard.sh [--force] [--unit <unit>]" >&2; exit 2 ;;
  esac
done

# Determine the cgroup path of the target unit using systemd's view, not by scanning /proc directly.
# systemctl show outputs the cgroup path; fall back to a heuristic if systemctl is unavailable.
maw_cgroup=""
_uid=$(id -u 2>/dev/null || true)
_rdir="${XDG_RUNTIME_DIR:-}"
[ -z "$_rdir" ] && [ -n "$_uid" ] && [ -d "/run/user/$_uid" ] && _rdir="/run/user/$_uid"

if _cg=$(env XDG_RUNTIME_DIR="$_rdir" systemctl --user show "$unit" --property=ControlGroup --value 2>/dev/null); then
  maw_cgroup="$_cg"
fi

if [ -z "$maw_cgroup" ]; then
  # If the unit is not yet active/known or systemctl is unavailable, check if this is the production unit.
  if [ "$unit" = "maw.service" ]; then
    printf '%s\n' "[guard] Cannot determine $unit cgroup (systemctl unavailable). Proceeding conservatively." >&2
    if [ "$force" = false ]; then
      printf '%s\n' \
        "[guard] BLOCKED: cannot verify no protected agents are running." \
        "        Rerun with --force to override (this will terminate any active coding agents)." >&2
      exit 1
    fi
  fi
  exit 0
fi

# Remove leading / for the cgroupfs path.
cgroup_rel="${maw_cgroup#/}"

# Enumerate PIDs in the cgroup via cgroupfs.  On cgroup v2 this is cgroup.procs.
cgroup_procs_file="/sys/fs/cgroup/${cgroup_rel}/cgroup.procs"

if [ ! -f "$cgroup_procs_file" ]; then
  # cgroup v1 fallback - not expected in modern kernels but be defensive.
  printf '%s\n' "[guard] cgroup.procs not found at $cgroup_procs_file; skipping agent check." >&2
  exit 0
fi

# Identify coding-agent processes by executable name.  We look for known agent binaries.
# This list is intentionally conservative: an unknown process is NOT treated as an agent.
AGENT_PATTERNS="codex|codex-code-mode"

protected_pids=""
while IFS= read -r pid; do
  [ -n "$pid" ] || continue
  comm=""
  comm=$(cat "/proc/$pid/comm" 2>/dev/null || true)
  if printf '%s' "$comm" | grep -Eq "^($AGENT_PATTERNS)"; then
    protected_pids="$protected_pids $pid($comm)"
  fi
done < "$cgroup_procs_file"

protected_pids="${protected_pids# }"  # strip leading space

if [ -z "$protected_pids" ]; then
  printf '%s\n' "[guard] No protected coding agents found in maw.service cgroup. Activation is safe."
  exit 0
fi

if [ "$force" = true ]; then
  printf '%s\n' \
    "[guard] WARNING: --force specified. Protected agents will be terminated by maw.service restart:" \
    "        $protected_pids" \
    "        Proceeding." >&2
  exit 0
fi

printf '%s\n' \
  "[guard] BLOCKED: active coding agents detected in maw.service cgroup:" \
  "        $protected_pids" \
  "" \
  "        These processes will be terminated if maw.service is restarted." \
  "        Options:" \
  "          1. Wait for them to complete, then run: maw restart" \
  "          2. Authorize interruption: maw-activate-guard.sh --force && maw restart" >&2
exit 1

#!/bin/sh
# Print workbench-ptyd.service rendered for this machine, to stdout.
# Used by install.sh (--service) and by the systemd acceptance test.
#
# Variables honoured:
#   WORKBENCH_NODE_BIN       (default: node on PATH)
#   WORKBENCH_STATE_DIR      (default: ${XDG_DATA_HOME:-$HOME/.local/share}/workbench)
#   WORKBENCH_BIN_DIR        (default: $HOME/.local/bin)
#   WORKBENCH_PTYD_RUNTIME_NAME  (default: workbench-ptyd)
#
# The rendered unit declares RuntimeDirectory=<PTYD_RUNTIME_NAME>, so systemd manages
# /run/user/<UID>/<PTYD_RUNTIME_NAME> independently from the workbench.service runtime directory.
# Stopping or restarting workbench.service does NOT clean the supervisor's runtime directory.
set -eu
: "${HOME:?HOME is required}"
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$script_dir/lib.sh"
wb_init_paths
[ -n "$node_bin" ] && [ -x "$node_bin" ] || { printf '%s\n' 'node not found; set WORKBENCH_NODE_BIN.' >&2; exit 1; }
state_dir="${WORKBENCH_STATE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/workbench}"
bin_dir="${WORKBENCH_BIN_DIR:-$HOME/.local/bin}"
ptyd_runtime_name="${WORKBENCH_PTYD_RUNTIME_NAME:-workbench-ptyd}"
log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/workbench/logs"
# systemd treats '%' as a specifier: escape it; also escape sed replacement metacharacters.
esc() { printf '%s' "$1" | sed 's/%/%%/g; s/[&|\\]/\\&/g'; }
ptyd_template="$script_dir/pty-host/workbench-ptyd.service"
if [ ! -f "$ptyd_template" ] && [ -f "$script_dir/workbench-ptyd.service" ]; then
  ptyd_template="$script_dir/workbench-ptyd.service"
fi
sed -e "s|@NODE_BIN@|$(esc "$node_bin")|g" \
    -e "s|@STATE_DIR@|$(esc "$state_dir")|g" \
    -e "s|@PATH@|$(esc "$(dirname "$node_bin"):$bin_dir:/usr/local/bin:/usr/bin:/bin")|g" \
    -e "s|@PTYD_RUNTIME_NAME@|$(esc "$ptyd_runtime_name")|g" \
    -e "s|@LOG_DIR@|$(esc "$log_dir")|g" \
    "$ptyd_template"

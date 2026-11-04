#!/bin/sh
# Print maw-ptyd.service rendered for this machine, to stdout.
# Used by install.sh (--service) and by the systemd acceptance test.
#
# Variables honoured:
#   MAW_NODE_BIN       (default: node on PATH)
#   MAW_STATE_DIR      (default: $HOME/.local/share/maw)
#   MAW_BIN_DIR        (default: $HOME/.local/bin)
#   MAW_PTYD_RUNTIME_NAME  (default: maw-ptyd)
#
# The rendered unit declares RuntimeDirectory=<PTYD_RUNTIME_NAME>, so systemd manages
# /run/user/<UID>/<PTYD_RUNTIME_NAME> independently from the maw.service runtime directory.
# Stopping or restarting maw.service does NOT clean the supervisor's runtime directory.
set -eu
: "${HOME:?HOME is required}"
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
node_bin="${MAW_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
[ -n "$node_bin" ] && [ -x "$node_bin" ] || { printf '%s\n' 'node not found; set MAW_NODE_BIN.' >&2; exit 1; }
state_dir="${MAW_STATE_DIR:-$HOME/.local/share/maw}"
bin_dir="${MAW_BIN_DIR:-$HOME/.local/bin}"
ptyd_runtime_name="${MAW_PTYD_RUNTIME_NAME:-maw-ptyd}"
# systemd treats '%' as a specifier: escape it; also escape sed replacement metacharacters.
esc() { printf '%s' "$1" | sed 's/%/%%/g; s/[&|\\]/\\&/g'; }
ptyd_template="$script_dir/pty-host/maw-ptyd.service"
if [ ! -f "$ptyd_template" ] && [ -f "$script_dir/maw-ptyd.service" ]; then
  ptyd_template="$script_dir/maw-ptyd.service"
fi
sed -e "s|@NODE_BIN@|$(esc "$node_bin")|g" \
    -e "s|@STATE_DIR@|$(esc "$state_dir")|g" \
    -e "s|@PATH@|$(esc "$(dirname "$node_bin"):$bin_dir:/usr/local/bin:/usr/bin:/bin")|g" \
    -e "s|@PTYD_RUNTIME_NAME@|$(esc "$ptyd_runtime_name")|g" \
    "$ptyd_template"

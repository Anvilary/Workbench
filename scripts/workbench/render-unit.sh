#!/bin/sh
# Print workbench.service rendered for this machine. Used by install.sh and by the real-systemd acceptance test,
# so both use exactly the production template.
#   WORKBENCH_NODE_BIN (default: node on PATH)  WORKBENCH_STATE_DIR  WORKBENCH_BIN_DIR  WORKBENCH_RUNTIME_NAME (default: workbench)
set -eu
: "${HOME:?HOME is required}"
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$script_dir/lib.sh"
wb_init_paths
[ -n "$node_bin" ] && [ -x "$node_bin" ] || { printf '%s\n' 'node not found; set WORKBENCH_NODE_BIN.' >&2; exit 1; }
state_dir="${WORKBENCH_STATE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/workbench}"
bin_dir="${WORKBENCH_BIN_DIR:-$HOME/.local/bin}"
runtime_name="${WORKBENCH_RUNTIME_NAME:-workbench}"
env_file="${WORKBENCH_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/workbench/environment}"
# systemd treats '%' as a specifier: escape it; also escape sed replacement metacharacters.
esc() { printf '%s' "$1" | sed 's/%/%%/g; s/[&|\\]/\\&/g'; }
sed -e "s|@NODE_BIN@|$(esc "$node_bin")|g" \
    -e "s|@STATE_DIR@|$(esc "$state_dir")|g" \
    -e "s|@PATH@|$(esc "$(dirname "$node_bin"):$bin_dir:/usr/local/bin:/usr/bin:/bin")|g" \
    -e "s|@RUNTIME_NAME@|$(esc "$runtime_name")|g" \
    -e "s|@ENV_FILE@|$(esc "$env_file")|g" \
    "$script_dir/workbench.service"

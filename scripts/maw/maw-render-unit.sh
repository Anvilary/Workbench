#!/bin/sh
# Print maw.service rendered for this machine. Used by install.sh and by the real-systemd acceptance test,
# so both use exactly the production template.
#   MAW_NODE_BIN (default: node on PATH)  MAW_STATE_DIR  MAW_BIN_DIR  MAW_RUNTIME_NAME (default: maw)
set -eu
: "${HOME:?HOME is required}"
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
node_bin="${MAW_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
[ -n "$node_bin" ] && [ -x "$node_bin" ] || { printf '%s\n' 'node not found; set MAW_NODE_BIN.' >&2; exit 1; }
state_dir="${MAW_STATE_DIR:-$HOME/.local/share/maw}"
bin_dir="${MAW_BIN_DIR:-$HOME/.local/bin}"
runtime_name="${MAW_RUNTIME_NAME:-maw}"
# systemd treats '%' as a specifier: escape it; also escape sed replacement metacharacters.
esc() { printf '%s' "$1" | sed 's/%/%%/g; s/[&|\\]/\\&/g'; }
sed -e "s|@NODE_BIN@|$(esc "$node_bin")|g" \
    -e "s|@STATE_DIR@|$(esc "$state_dir")|g" \
    -e "s|@PATH@|$(esc "$(dirname "$node_bin"):$bin_dir:/usr/local/bin:/usr/bin:/bin")|g" \
    -e "s|@RUNTIME_NAME@|$(esc "$runtime_name")|g" \
    "$script_dir/maw.service"

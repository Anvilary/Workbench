#!/bin/sh
# Install the maw launcher scripts and, with --service, the systemd user unit plus an initial release.
#
# The service never runs from the developer checkout: --service builds the first release with the same
# isolated staging as `maw update` (maw-update.sh --initial) and points `current` at it.
set -eu

: "${HOME:?HOME is required}"
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
state_dir="${MAW_STATE_DIR:-$HOME/.local/share/maw}"
lib_dir="${MAW_LIB_DIR:-$HOME/.local/lib/maw}"
bin_dir="${MAW_BIN_DIR:-$HOME/.local/bin}"
unit_dir="${MAW_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
unit_name="${MAW_UNIT:-maw.service}"
runtime_name="${MAW_RUNTIME_NAME:-maw}"
node_bin="${MAW_NODE_BIN:-$(command -v node 2>/dev/null || true)}"

mode="${1:---commands-only}"
case "$mode" in
  --commands-only) ;;
  --service)
    test -f "$repo_dir/packages/server/src/maw-host.ts" || {
      printf '%s\n' 'Deploy the verified feature to the original repository before installing its service.' >&2
      exit 1
    }
    [ -n "$node_bin" ] && [ -x "$node_bin" ] || { printf '%s\n' 'node not found; set MAW_NODE_BIN.' >&2; exit 1; }
    ;;
  *) printf '%s\n' 'Usage: install.sh [--commands-only|--service]' >&2; exit 2 ;;
esac

install -d -m 700 "$lib_dir" "$state_dir" "$state_dir/releases"
install -d "$bin_dir"
[ -f "$state_dir/source_path" ] || printf '%s\n' "$repo_dir" > "$state_dir/source_path"

install -m 644 "$script_dir/maw-lib.sh" "$lib_dir/maw-lib.sh"
install -m 644 "$script_dir/control.mjs" "$lib_dir/control.mjs"
install -m 755 "$script_dir/maw-update.sh" "$lib_dir/maw-update.sh"
install -m 755 "$script_dir/maw-restart-helper.sh" "$lib_dir/maw-restart-helper.sh"
install -m 755 "$script_dir/maw" "$lib_dir/maw"
install -m 755 "$script_dir/maw" "$bin_dir/maw"

if [ "$mode" = --service ]; then
  install -d "$unit_dir"
  test ! -e "$unit_dir/$unit_name" || {
    printf '%s\n' "$unit_name already exists; inspect and back it up before replacement." >&2; exit 1;
  }
  # A legacy `current` (from the old installer) points at a mutable checkout. No service unit exists yet
  # (checked above), so nothing boots it: preserve the link as `legacy-current` and build a real release.
  if [ -L "$state_dir/current" ] || [ -e "$state_dir/current" ]; then
    current_target=$(readlink -f "$state_dir/current" 2>/dev/null || true)
    case "$current_target" in
      "$(cd "$state_dir/releases" && pwd -P)"/*) ;;
      *)
        printf '%s\n' "Preserving legacy current ($current_target) as $state_dir/legacy-current." >&2
        [ ! -e "$state_dir/legacy-current" ] && [ ! -L "$state_dir/legacy-current" ] || {
          printf '%s\n' "$state_dir/legacy-current already exists; inspect it before reinstalling." >&2; exit 1; }
        mv "$state_dir/current" "$state_dir/legacy-current"
        ;;
    esac
  fi
  if [ ! -L "$state_dir/current" ] && [ ! -e "$state_dir/current" ]; then
    printf '%s\n' 'Building the initial isolated release (same pipeline as maw update)...'
    MAW_STATE_DIR="$state_dir" MAW_NODE_BIN="$node_bin" MAW_BIN_DIR="$bin_dir" \
      /bin/sh "$lib_dir/maw-update.sh" --initial --source "$repo_dir"
  fi
  MAW_NODE_BIN="$node_bin" MAW_STATE_DIR="$state_dir" MAW_BIN_DIR="$bin_dir" MAW_RUNTIME_NAME="$runtime_name" \
    /bin/sh "$script_dir/maw-render-unit.sh" > "$unit_dir/$unit_name.tmp" && mv -f "$unit_dir/$unit_name.tmp" "$unit_dir/$unit_name"
  chmod 644 "$unit_dir/$unit_name"
  systemctl --user daemon-reload
  printf '%s\n' 'Service installed but not enabled or started. Start and verify it with: maw start'
fi

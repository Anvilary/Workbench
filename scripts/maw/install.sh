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
  --desktop)
    [ -n "$node_bin" ] && [ -x "$node_bin" ] || { printf '%s\n' 'Node is required to build the desktop package.' >&2; exit 1; }
    test -f "$repo_dir/packages/desktop/package.json" || { printf '%s\n' 'Desktop source is missing.' >&2; exit 1; }
    ;;
  --service)
    test -f "$repo_dir/packages/server/src/maw-host.ts" || {
      printf '%s\n' 'Deploy the verified feature to the original repository before installing its service.' >&2
      exit 1
    }
    [ -n "$node_bin" ] && [ -x "$node_bin" ] || { printf '%s\n' 'node not found; set MAW_NODE_BIN.' >&2; exit 1; }
    ;;
  *) printf '%s\n' 'Usage: install.sh [--commands-only|--service|--desktop]' >&2; exit 2 ;;
esac

install -d -m 700 "$lib_dir" "$state_dir" "$state_dir/releases"
install -d "$bin_dir"
[ -f "$state_dir/source_path" ] || printf '%s\n' "$repo_dir" > "$state_dir/source_path"

install -m 644 "$script_dir/maw-lib.sh" "$lib_dir/maw-lib.sh"
install -m 644 "$script_dir/control.mjs" "$lib_dir/control.mjs"
for desktop_file in service-readiness.mjs desktop-runtime.mjs desktop-launch.mjs; do
  install -m 644 "$script_dir/$desktop_file" "$lib_dir/$desktop_file"
done
if [ -f "$repo_dir/packages/desktop/package.json" ]; then
  "$node_bin" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).devDependencies.electron)' "$repo_dir/packages/desktop/package.json" > "$lib_dir/desktop-runtime-version"
fi

install -m 755 "$script_dir/maw-update.sh" "$lib_dir/maw-update.sh"
install -m 755 "$script_dir/maw-restart-helper.sh" "$lib_dir/maw-restart-helper.sh"
install -m 755 "$script_dir/maw-render-unit.sh" "$lib_dir/maw-render-unit.sh"
install -m 644 "$script_dir/maw.service" "$lib_dir/maw.service"
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
    /bin/sh "$lib_dir/maw-render-unit.sh" > "$unit_dir/$unit_name.tmp" && mv -f "$unit_dir/$unit_name.tmp" "$unit_dir/$unit_name"
  chmod 644 "$unit_dir/$unit_name"
  # shellcheck source=scripts/maw/maw-lib.sh
  . "$script_dir/maw-lib.sh"
  maw_sctl daemon-reload
  printf '%s\n' 'Service installed but not enabled or started. Start and verify it with: maw start'
fi

if [ "$mode" = --desktop ]; then
  "$node_bin" "$script_dir/build-desktop-deb.mjs"
  desktop_version=$(cat "$lib_dir/desktop-runtime-version")
  desktop_arch=$(dpkg --print-architecture)
  sudo apt-get install "$repo_dir/dist-desktop/maw-electron-${desktop_version}_${desktop_arch}.deb"
  desktop_apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  install -d "$desktop_apps"
  # Desktop Exec uses quoted absolute paths, independent of the graphical PATH.
  "$node_bin" -e '
    const fs=require("fs"); const command=process.argv[1];
    if (/[\n\r]/.test(command)) throw Error("Invalid launcher path");
    const escaped=command.replace(/([\\"`$])/g,"\\$1").replace(/%/g,"%%");
    fs.writeFileSync(process.argv[2], `[Desktop Entry]\nType=Application\nName=My Amazing Workspace\nExec="${escaped}" desktop\nTerminal=false\nCategories=Development;\n`);
  ' "$bin_dir/maw" "$desktop_apps/maw.desktop"
  printf '%s\n' 'Desktop installed. Start the existing service with maw start if needed, then launch: maw desktop'
fi

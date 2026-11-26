#!/bin/sh
# Install the maw launcher scripts and, with --service, the systemd user units plus an initial release.
#
# The service never runs from the developer checkout: --service builds the first release with the same
# isolated staging as `maw update` (update.sh --initial) and points `current` at it.
#
# Two systemd units are installed:
#   workbench.service      - main backend (bundled ESM dist/index.mjs)
#   workbench-ptyd.service - persistent PTY supervisor (independent cgroup, independent RuntimeDirectory)
#
# The supervisor's RuntimeDirectory (workbench-ptyd by default) is separate from workbench.service's RuntimeDirectory
# (maw by default).  Restarting workbench.service does NOT clean the supervisor's runtime directory, so the
# supervisor socket survives backend restarts.
set -eu

: "${HOME:?HOME is required}"
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib.sh
. "$script_dir/lib.sh"
wb_init_paths
repo_dir=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
state_dir="${WORKBENCH_STATE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/workbench}"
lib_dir="${WORKBENCH_LIB_DIR:-$HOME/.local/lib/workbench}"
bin_dir="${WORKBENCH_BIN_DIR:-$HOME/.local/bin}"
unit_dir="${WORKBENCH_SYSTEMD_USER_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
unit_name="${WORKBENCH_UNIT:-workbench.service}"
ptyd_unit_name="${WORKBENCH_PTYD_UNIT:-workbench-ptyd.service}"
runtime_name="${WORKBENCH_RUNTIME_NAME:-workbench}"
ptyd_runtime_name="${WORKBENCH_PTYD_RUNTIME_NAME:-workbench-ptyd}"
node_bin="${WORKBENCH_NODE_BIN:-$node_bin}"

mode="${1:---commands-only}"
if [ "$mode" = --migrate ]; then
  shift
  [ -n "$node_bin" ] && [ -x "$node_bin" ] || { printf '%s\n' 'Node is required for migration.' >&2; exit 1; }
  exec "$node_bin" "$script_dir/migrate-identity.mjs" "$@"
fi

# A legacy service file or release pointer requires the explicit identity migration.
# Once both legacy names are masked, only the verified migration owns this transition.
legacy_state="${XDG_DATA_HOME:-$HOME/.local/share}/maw"
legacy_unit=false
for legacy in maw.service maw-ptyd.service; do
  if [ -e "$unit_dir/$legacy" ] || [ -L "$unit_dir/$legacy" ]; then
    if [ "$(readlink "$unit_dir/$legacy" || true)" != /dev/null ]; then legacy_unit=true; fi
  fi
done
if [ "$legacy_unit" = true ] ||
   { [ -L "$legacy_state/current" ] && [ ! -f "$state_dir/migration/identity-v1.json" ]; }; then
  printf '%s\n' 'A legacy Workbench installation exists. Run install.sh --migrate plan before installing canonical commands or services.' >&2
  exit 2
fi
if [ "$unit_name" = maw.service ] || [ "$ptyd_unit_name" = maw-ptyd.service ] ||
   [ "$runtime_name" = "$ptyd_runtime_name" ]; then
  printf '%s\n' 'Workbench requires separate canonical backend and supervisor identities.' >&2
  exit 2
fi
case "$mode" in
  --commands-only) ;;
  --desktop-assets) ;;
  --integrate-desktop)
    for installed_unit in "$unit_name" "$ptyd_unit_name"; do
      [ -f "$unit_dir/$installed_unit" ] || { printf '%s\n' "Missing $installed_unit. Install user services first with --service." >&2; exit 1; }
    done
    ;;
  --desktop)
    [ -n "$node_bin" ] && [ -x "$node_bin" ] || { printf '%s\n' 'Node is required to build the desktop package.' >&2; exit 1; }
    test -f "$repo_dir/packages/desktop/package.json" || { printf '%s\n' 'Desktop source is missing.' >&2; exit 1; }
    ;;
  --service)
    test -f "$repo_dir/packages/server/src/workbench-host.ts" || {
      printf '%s\n' 'Deploy the verified feature to the original repository before installing its service.' >&2
      exit 1
    }
    [ -n "$node_bin" ] && [ -x "$node_bin" ] || { printf '%s\n' 'node not found; set WORKBENCH_NODE_BIN.' >&2; exit 1; }
    ;;
  *) printf '%s\n' 'Usage: install.sh [--commands-only|--service|--desktop|--desktop-assets|--integrate-desktop|--migrate COMMAND]' >&2; exit 2 ;;
esac

install -d -m 700 "$lib_dir" "$state_dir" "$state_dir/releases"
install -d "$bin_dir"
[ -f "$state_dir/source_path" ] || printf '%s\n' "$repo_dir" > "$state_dir/source_path"
[ -n "$node_bin" ] && printf '%s\n' "$node_bin" > "$state_dir/node_path"

install -m 644 "$script_dir/lib.sh" "$lib_dir/lib.sh"
install -m 644 "$script_dir/control.mjs" "$lib_dir/control.mjs"
for desktop_file in service-readiness.mjs desktop-runtime.mjs desktop-launch.mjs; do
  install -m 644 "$script_dir/$desktop_file" "$lib_dir/$desktop_file"
done
install -m 644 "$repo_dir/packages/shared/src/workbench-env.mjs" "$lib_dir/env.mjs"
install -m 644 "$script_dir/migrate-identity.mjs" "$lib_dir/migrate-identity.mjs"
if [ -f "$repo_dir/packages/desktop/package.json" ]; then
  desktop_target_version=$("$node_bin" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).devDependencies.electron)' "$repo_dir/packages/desktop/package.json")
  # Preserve a working bootstrap until the replacement package is installed.
  [ -f "$lib_dir/desktop-runtime-version" ] || printf '%s' "$desktop_target_version" > "$lib_dir/desktop-runtime-version"
fi

install -m 755 "$script_dir/update.sh" "$lib_dir/update.sh"
install -m 755 "$script_dir/restart-helper.sh" "$lib_dir/restart-helper.sh"
install -m 755 "$script_dir/render-unit.sh" "$lib_dir/render-unit.sh"
install -m 755 "$script_dir/render-ptyd-unit.sh" "$lib_dir/render-ptyd-unit.sh"
install -m 755 "$script_dir/activate-guard.sh" "$lib_dir/activate-guard.sh"
install -m 644 "$script_dir/workbench.service" "$lib_dir/workbench.service"
install -m 644 "$script_dir/pty-host/workbench-ptyd.service" "$lib_dir/workbench-ptyd.service"
install -d -m 755 "$lib_dir/pty-host"
install -m 644 "$script_dir/pty-host/workbench-ptyd.service" "$lib_dir/pty-host/workbench-ptyd.service"
for cli in anvi-bench maw anvil-bench workbench; do
  install -m 755 "$script_dir/$cli" "$lib_dir/$cli"
  install -m 755 "$script_dir/$cli" "$bin_dir/$cli"
done
printf '1\n' > "$lib_dir/desktop-launcher-api"
printf '2\n' > "$lib_dir/activation-helper-api.tmp"
mv -f "$lib_dir/activation-helper-api.tmp" "$lib_dir/activation-helper-api"

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
    _initial_headless="${WORKBENCH_HEADLESS:-}"
    if [ -z "$_initial_headless" ]; then
      if [ -z "${desktop_target_version:-}" ] || [ ! -x "/opt/workbench-electron/$desktop_target_version/electron" ]; then
        _initial_headless=1
        printf 'headless\n' > "$state_dir/headless"
      fi
    elif [ "$_initial_headless" = 1 ]; then
      printf 'headless\n' > "$state_dir/headless"
    fi
    WORKBENCH_STATE_DIR="$state_dir" WORKBENCH_LIB_DIR="$lib_dir" WORKBENCH_NODE_BIN="$node_bin" WORKBENCH_BIN_DIR="$bin_dir" \
      WORKBENCH_HEADLESS="$_initial_headless" \
      /bin/sh "$lib_dir/update.sh" --initial --source "$repo_dir"
  fi
  # Render and install workbench.service (backend)
  WORKBENCH_NODE_BIN="$node_bin" WORKBENCH_STATE_DIR="$state_dir" WORKBENCH_BIN_DIR="$bin_dir" WORKBENCH_RUNTIME_NAME="$runtime_name" \
    /bin/sh "$lib_dir/render-unit.sh" > "$unit_dir/$unit_name.tmp" && mv -f "$unit_dir/$unit_name.tmp" "$unit_dir/$unit_name"
  chmod 644 "$unit_dir/$unit_name"
  # Render and install workbench-ptyd.service.
  # The supervisor has its own RuntimeDirectory (@PTYD_RUNTIME_NAME@, default: workbench-ptyd).
  # It is NOT coupled to workbench.service via PartOf=; restarting workbench.service leaves the supervisor alive.
  WORKBENCH_NODE_BIN="$node_bin" WORKBENCH_STATE_DIR="$state_dir" WORKBENCH_BIN_DIR="$bin_dir" \
    WORKBENCH_PTYD_RUNTIME_NAME="$ptyd_runtime_name" \
    /bin/sh "$lib_dir/render-ptyd-unit.sh" > "$unit_dir/$ptyd_unit_name.tmp" && \
    mv -f "$unit_dir/$ptyd_unit_name.tmp" "$unit_dir/$ptyd_unit_name"
  chmod 644 "$unit_dir/$ptyd_unit_name"
  # Create the shared log directory that both units append to.
  install -d -m 700 "${XDG_STATE_HOME:-$HOME/.local/state}/workbench/logs"
  # shellcheck source=scripts/workbench/lib.sh
  . "$script_dir/lib.sh"
  wb_sctl daemon-reload
  printf '%s\n' 'Service installed but not enabled or started. Start and verify it with: anvi-bench start (or legacy: maw start)'
fi

if [ "$mode" = --desktop ]; then
  rm -f "$state_dir/headless"
  "$node_bin" "$script_dir/build-desktop-deb.mjs"
  desktop_version="$desktop_target_version"
  desktop_arch=$(dpkg --print-architecture)
  sudo apt-get install "$repo_dir/dist-desktop/workbench-electron-${desktop_version}_${desktop_arch}.deb"
  printf '%s' "$desktop_target_version" > "$lib_dir/desktop-runtime-version.tmp"
  mv -f "$lib_dir/desktop-runtime-version.tmp" "$lib_dir/desktop-runtime-version"
fi

if [ "$mode" = --desktop ] || [ "$mode" = --desktop-assets ] || [ "$mode" = --integrate-desktop ]; then
  wb_refresh_desktop_assets "$repo_dir" "$bin_dir/anvi-bench"
  printf '%s\n' 'Desktop installed. Start the existing service with anvi-bench start if needed, then launch: anvi-bench desktop'
fi

if [ "$mode" = --integrate-desktop ]; then
  rm -f "$state_dir/headless"
  # Enable login/cold-boot startup without restarting either live service.
  wb_sctl enable "$unit_name" "$ptyd_unit_name"
  printf '%s\n' 'Workbench user services enabled for login. Existing services were not restarted.'
fi

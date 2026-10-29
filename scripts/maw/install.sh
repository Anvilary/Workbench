#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
state_dir="${MAW_STATE_DIR:-/home/user/.local/share/maw}"

case "${1:---commands-only}" in
  --commands-only) ;;
  --service)
    test -f "$repo_dir/packages/server/src/maw-host.ts" || {
      printf '%s\n' 'Deploy the verified feature to the original repository before installing its service.' >&2
      exit 1
    }
    ;;
  *) printf '%s\n' 'Usage: install.sh [--commands-only|--service]' >&2; exit 2 ;;
esac

install -d -m 700 /home/user/.local/lib/maw
install -d /home/user/.local/bin
install -d -m 700 "$state_dir"
install -d -m 700 "$state_dir/releases"

# Initialize current release pointer to repo checkout if not already initialized
if [ ! -e "$state_dir/current" ] && [ ! -L "$state_dir/current" ]; then
  ln -s "$repo_dir" "$state_dir/current"
fi
printf '%s\n' "$repo_dir" > "$state_dir/source_path"

install -m 644 "$script_dir/control.mjs" /home/user/.local/lib/maw/control.mjs
install -m 755 "$script_dir/maw-update.sh" /home/user/.local/lib/maw/maw-update.sh
install -m 755 "$script_dir/maw-restart-helper.sh" /home/user/.local/lib/maw/maw-restart-helper.sh
install -m 755 "$script_dir/maw" /home/user/.local/bin/maw

if [ "${1:---commands-only}" = --service ]; then
  install -d /home/user/.config/systemd/user
  test ! -e /home/user/.config/systemd/user/maw.service || {
    printf '%s\n' 'maw.service already exists; inspect and back it up before replacement.' >&2; exit 1;
  }
  install -m 644 "$script_dir/maw.service" /home/user/.config/systemd/user/maw.service
  systemctl --user daemon-reload
  printf '%s\n' 'Service installed but not enabled or started. Follow docs/maw/OPERATIONS.md.'
fi

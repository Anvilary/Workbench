#!/bin/sh
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
case "${1:---commands-only}" in
  --commands-only) ;;
  --service)
    test -f /home/alteixeira20/Projects/My-Amazing-Workspace/packages/server/src/maw-host.ts || {
      printf '%s\n' 'Deploy the verified feature to the original repository before installing its service.' >&2
      exit 1
    }
    ;;
  *) printf '%s\n' 'Usage: install.sh [--commands-only|--service]' >&2; exit 2 ;;
esac
install -d -m 700 /home/alteixeira20/.local/lib/maw
install -d /home/alteixeira20/.local/bin
install -m 644 "$script_dir/control.mjs" /home/alteixeira20/.local/lib/maw/control.mjs
install -m 755 "$script_dir/maw" /home/alteixeira20/.local/bin/maw
if [ "${1:---commands-only}" = --service ]; then
  install -d /home/alteixeira20/.config/systemd/user
  test ! -e /home/alteixeira20/.config/systemd/user/maw.service || {
    printf '%s\n' 'maw.service already exists; inspect and back it up before replacement.' >&2; exit 1;
  }
  install -m 644 "$script_dir/maw.service" /home/alteixeira20/.config/systemd/user/maw.service
  systemctl --user daemon-reload
  printf '%s\n' 'Service installed but not enabled or started. Follow docs/maw/OPERATIONS.md.'
fi

# Shared helpers for maw-update.sh, maw-restart-helper.sh and maw (POSIX sh, sourced).
#
# Release state machine (all pointers are symlinks inside $state_dir, replaced atomically):
#
#   releases/<id>/  built release; `.maw-candidate` exists only while it is being built
#   staged   -> releases/<id>   built and validated, never activated (written only by maw-update.sh)
#   current  -> releases/<id>   what maw.service boots (written only by the restart helper / --initial)
#   healthy  -> releases/<id>   last release whose readiness was verified with its own release ID
#   previous -> releases/<id>   the healthy release before `healthy`
#
# Only the restart helper promotes a release to `healthy`, and only after the running service reported
# that release's ID through the authenticated readiness probe. Staging never touches current/healthy/previous.

# Deterministic Node.js executable resolution.
# Resolves one supported Node.js executable (>=20) with compatible Corepack/pnpm support.
# Honors MAW_NODE_BIN, checks NVM, PATH, and system paths.
maw_resolve_node() {
  if [ -n "${MAW_NODE_BIN:-}" ]; then
    if [ -x "$MAW_NODE_BIN" ]; then
      _ver=$("$MAW_NODE_BIN" -v 2>/dev/null || true)
      case "$_ver" in
        v[2-9][0-9]*)
          printf '%s' "$MAW_NODE_BIN"
          return 0
          ;;
      esac
    fi
    printf '%s\n' "Error: MAW_NODE_BIN is set to '$MAW_NODE_BIN' but it is not a valid Node executable (>=20 required)." >&2
    return 1
  fi

  _user_home="${HOME:-}"
  if [ -z "$_user_home" ] || [ ! -d "$_user_home" ]; then
    _user_home=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)
  fi
  _real_home=""
  if [ -n "$(id -u 2>/dev/null || true)" ]; then
    _real_home=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)
  fi

  _candidates=""

  if [ -n "${state_dir:-}" ] && [ -f "$state_dir/node_path" ]; then
    _saved=$(cat "$state_dir/node_path" 2>/dev/null | tr -d '[:space:]')
    [ -n "$_saved" ] && [ -x "$_saved" ] && _candidates="$_candidates $_saved"
  fi

  [ -n "${NVM_BIN:-}" ] && [ -x "$NVM_BIN/node" ] && _candidates="$_candidates $NVM_BIN/node"

  for _nd in "${NVM_DIR:-}" "${_user_home:+$_user_home/.nvm}" "${_real_home:+$_real_home/.nvm}"; do
    [ -n "$_nd" ] && [ -d "$_nd" ] || continue
    if [ -f "$_nd/alias/default" ]; then
      _def=$(cat "$_nd/alias/default" 2>/dev/null | tr -d '[:space:]')
      if [ -n "$_def" ]; then
        for _nv in $(ls -d "$_nd/versions/node"/v"$_def"* "$_nd/versions/node"/"$_def"* 2>/dev/null | sort -Vr); do
          [ -x "$_nv/bin/node" ] && _candidates="$_candidates $_nv/bin/node"
        done
      fi
    fi
    for _nv in $(ls -d "$_nd/versions/node"/v* 2>/dev/null | sort -Vr); do
      [ -x "$_nv/bin/node" ] && _candidates="$_candidates $_nv/bin/node"
    done
  done

  _path_node=$(command -v node 2>/dev/null || true)
  [ -n "$_path_node" ] && _candidates="$_candidates $_path_node"

  for _sys in /usr/local/bin/node /usr/bin/node /opt/node/bin/node; do
    [ -x "$_sys" ] && _candidates="$_candidates $_sys"
  done

  _tested=""
  _first_ge20=""
  for _cand in $_candidates; do
    case " $_tested " in *" $_cand "*) continue ;; esac
    _tested="$_tested $_cand"
    [ -x "$_cand" ] || continue

    _v=$("$_cand" -v 2>/dev/null || true)
    case "$_v" in
      v[2-9][0-9]*) ;;
      *) continue ;;
    esac
    [ -n "$_first_ge20" ] || _first_ge20="$_cand"

    _cand_dir=$(dirname "$_cand")
    if [ -x "$_cand_dir/corepack" ]; then
      if env PATH="$_cand_dir:$PATH" "$_cand" "$_cand_dir/corepack" pnpm --version >/dev/null 2>&1; then
        printf '%s' "$_cand"
        return 0
      fi
    elif [ -x "$_cand_dir/pnpm" ]; then
      if env PATH="$_cand_dir:$PATH" "$_cand" "$_cand_dir/pnpm" --version >/dev/null 2>&1; then
        printf '%s' "$_cand"
        return 0
      fi
    fi
  done

  if [ -n "$_first_ge20" ]; then
    printf '%s' "$_first_ge20"
    return 0
  fi

  return 1
}

maw_init_paths() {
  : "${HOME:?HOME is required}"
  state_dir="${MAW_STATE_DIR:-$HOME/.local/share/maw}"
  releases_dir="${MAW_RELEASES_DIR:-$state_dir/releases}"
  log_file="${MAW_LOG_FILE:-$state_dir/update-log.jsonl}"
  update_lock="${MAW_UPDATE_LOCK:-$state_dir/update.lock}"
  _uid=$(id -u 2>/dev/null || true)
  _user_rdir="${XDG_RUNTIME_DIR:-}"
  if [ -z "$_user_rdir" ] && [ -n "$_uid" ] && [ -d "/run/user/$_uid" ]; then
    _user_rdir="/run/user/$_uid"
  fi
  runtime_dir="${MAW_RUNTIME_DIR:-${_user_rdir:-/tmp}/maw}"
  restart_lock="${MAW_RESTART_LOCK:-$runtime_dir/restart.lock}"
  unit="${MAW_UNIT:-maw.service}"
  ptyd_unit="${MAW_PTYD_UNIT:-maw-ptyd.service}"
  node_bin="${MAW_NODE_BIN:-$(maw_resolve_node 2>/dev/null || true)}"
  if [ -n "$node_bin" ]; then
    node_dir=$(dirname "$node_bin")
    _cur_node=$(command -v node 2>/dev/null || true)
    _cur_cp=$(command -v corepack 2>/dev/null || true)
    _need_prepend=false
    if [ "$_cur_node" != "$node_bin" ]; then
      _need_prepend=true
    fi
    case "$_cur_cp" in
      /usr/bin/*|/bin/*|/usr/local/bin/*|"")
        _need_prepend=true
        ;;
    esac
    case "$_cur_cp" in
      /tmp/*|*/maw-test-*|*/fixture*|*/fixtures*|*/bin/corepack)
        case "$_cur_cp" in
          /usr/*|/bin/*|/opt/*) ;;
          *) _need_prepend=false ;;
        esac
        ;;
    esac
    if [ "$_need_prepend" = true ]; then
      case "$PATH" in
        "$node_dir":*) ;;
        *) PATH="$node_dir:$PATH"; export PATH ;;
      esac
    fi
    export MAW_NODE_BIN="$node_bin"
    if [ -d "$state_dir" ] && [ -w "$state_dir" ]; then
      printf '%s\n' "$node_bin" > "$state_dir/node_path" 2>/dev/null || true
    fi
  fi
}

# Run a systemd user command (systemctl, systemd-run, journalctl) scoped to the canonical systemd user bus.
# Never modifies the global shell environment or provider authentication variables.
maw_systemd_cmd() {
  _cmd="$1"; shift
  _uid=$(id -u 2>/dev/null || true)
  _rdir="${MAW_SYSTEMD_RUNTIME_DIR:-}"
  if [ -z "$_rdir" ]; then
    if [ -n "$_uid" ] && [ -d "/run/user/$_uid" ] && { [ -S "/run/user/$_uid/systemd/private" ] || [ -S "/run/user/$_uid/bus" ]; }; then
      _rdir="/run/user/$_uid"
    elif [ -n "${XDG_RUNTIME_DIR:-}" ] && { [ -S "$XDG_RUNTIME_DIR/systemd/private" ] || [ -S "$XDG_RUNTIME_DIR/bus" ]; }; then
      _rdir="$XDG_RUNTIME_DIR"
    elif [ -n "$_uid" ] && [ -d "/run/user/$_uid" ]; then
      _rdir="/run/user/$_uid"
    else
      _rdir="${XDG_RUNTIME_DIR:-}"
    fi
  fi

  _bus="${MAW_SYSTEMD_BUS_ADDRESS:-}"
  if [ -z "$_bus" ]; then
    if [ -n "$_rdir" ] && [ -S "$_rdir/bus" ]; then
      _bus="unix:path=$_rdir/bus"
    elif [ -n "$_uid" ] && [ -S "/run/user/$_uid/bus" ]; then
      _bus="unix:path=/run/user/$_uid/bus"
    fi
  fi

  if [ -n "$_bus" ]; then
    if [ -n "$_rdir" ]; then
      env XDG_RUNTIME_DIR="$_rdir" DBUS_SESSION_BUS_ADDRESS="$_bus" "$_cmd" "$@"
    else
      env DBUS_SESSION_BUS_ADDRESS="$_bus" "$_cmd" "$@"
    fi
  else
    if [ -n "$_rdir" ]; then
      env -u DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR="$_rdir" "$_cmd" "$@"
    else
      env -u DBUS_SESSION_BUS_ADDRESS "$_cmd" "$@"
    fi
  fi
}

maw_sctl() { maw_systemd_cmd systemctl --user "$@"; }
maw_systemd_run() { maw_systemd_cmd systemd-run --user "$@"; }
maw_journalctl() { maw_systemd_cmd journalctl --user "$@"; }

maw_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# maw_log EVENT [key value]... -> one JSON line. Values are JSON-escaped.
maw_log() {
  _event="$1"; shift
  _line="{\"ts\":\"$(maw_now)\",\"event\":\"$_event\""
  while [ "$#" -ge 2 ]; do
    _v=$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r\t' '   ')
    _line="$_line,\"$1\":\"$_v\""
    shift 2
  done
  mkdir -p "$(dirname "$log_file")" 2>/dev/null || true
  printf '%s}\n' "$_line" >> "$log_file" 2>/dev/null || true
}

# Release IDs are generated by maw-update.sh: UTC timestamp, short commit, optional numeric suffix.
maw_valid_release_name() {
  printf '%s' "$1" | grep -Eq '^[0-9]{14}-[0-9a-f]{4,40}(-[0-9]+)?$'
}

# maw_release_id DIR -> prints releaseId from DIR/.maw-release-meta.json (empty on any problem).
maw_release_id() {
  [ -f "$1/.maw-release-meta.json" ] || return 0
  "$node_bin" -e '
    try { const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          if (typeof m.releaseId === "string") process.stdout.write(m.releaseId); } catch {}
  ' "$1/.maw-release-meta.json" 2>/dev/null || true
}

maw_release_commit() {
  [ -f "$1/.maw-release-meta.json" ] || return 0
  "$node_bin" -e '
    try { const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          if (typeof m.commit === "string") process.stdout.write(m.commit); } catch {}
  ' "$1/.maw-release-meta.json" 2>/dev/null || true
}

# Checks if release declares supervisor in metadata or schema >= 2
maw_release_is_nextgen() {
  [ -f "$1/.maw-release-meta.json" ] || return 1
  [ -n "$node_bin" ] || return 1
  "$node_bin" -e '
    try {
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit((m.supervisor === true || Number(m.schema) >= 2) ? 0 : 1);
    } catch { process.exit(1); }
  ' "$1/.maw-release-meta.json" 2>/dev/null
}

# A usable release: a real (non-symlink) directory directly inside releases_dir, named like a release,
# finished (no candidate marker), whose metadata names itself, with the service entry points present.
# Next-generation releases require the server bundle and standalone supervisor.
# Historical legacy releases (which predate the supervisor contract) remain valid rollback targets.
maw_valid_release() {
  _d="$1"
  [ -n "$_d" ] && [ -d "$_d" ] && [ ! -L "$_d" ] || return 1
  _rr=$(cd "$releases_dir" 2>/dev/null && pwd -P) || return 1
  _dp=$(cd "$_d" 2>/dev/null && pwd -P) || return 1
  [ "$(dirname "$_dp")" = "$_rr" ] || return 1
  _name=$(basename "$_dp")
  maw_valid_release_name "$_name" || return 1
  [ ! -e "$_dp/.maw-candidate" ] || return 1
  [ "$(maw_release_id "$_dp")" = "$_name" ] || return 1
  [ -f "$_dp/packages/server/src/index.ts" ] && [ -f "$_dp/packages/server/src/maw-host.ts" ] || return 1
  [ -e "$_dp/packages/server/node_modules/tsx/dist/loader.mjs" ] || return 1
  if maw_release_is_nextgen "$_dp"; then
    [ -f "$_dp/packages/server/dist/index.mjs" ] || return 1
    [ -f "$_dp/packages/server/dist/maw-ptyd.mjs" ] || return 1
  fi
  return 0
}

# maw_pointer NAME -> physical path of a VALID release the pointer names, or empty.
maw_pointer() {
  _l="$state_dir/$1"
  [ -L "$_l" ] || return 0
  _t=$(readlink -f "$_l" 2>/dev/null || true)
  if maw_valid_release "$_t"; then printf '%s' "$_t"; fi
}

# maw_pointer_raw NAME -> physical target whatever it is (legacy layouts point outside releases_dir).
maw_pointer_raw() {
  [ -L "$state_dir/$1" ] || [ -e "$state_dir/$1" ] || return 0
  readlink -f "$state_dir/$1" 2>/dev/null || true
}

# maw_set_pointer NAME RELEASE_DIR -> atomic replace; refuses anything that is not a valid release.
maw_set_pointer() {
  maw_valid_release "$2" || { printf '%s\n' "Refusing to point $1 at an invalid release: $2" >&2; return 1; }
  _tmp="$state_dir/.$1.tmp.$$"
  rm -f "$_tmp"
  ln -s "$2" "$_tmp" && mv -Tf "$_tmp" "$state_dir/$1"
}

maw_clear_pointer() {
  if [ -L "$state_dir/$1" ]; then rm -f "$state_dir/$1"; fi
}

# Lock helpers (flock(1)): the kernel releases the lock when the holder dies, including SIGKILL, so no
# PID files, no stale-lock guessing and no PID-reuse wedge.
maw_lock_update() {   # $1 = wait seconds (0 = fail immediately)
  mkdir -p "$(dirname "$update_lock")" || return 1
  exec 9>>"$update_lock" || return 1
  if [ "${1:-0}" -gt 0 ]; then flock -w "$1" 9; else flock -n 9; fi
}

maw_lock_restart() {
  mkdir -p "$(dirname "$restart_lock")" 2>/dev/null || return 1
  exec 8>>"$restart_lock" || return 1
  flock -n 8
}

# maw_restart_locked -> 0 if some process currently holds the restart lock.
maw_restart_locked() {
  [ -e "$restart_lock" ] || return 1
  ! flock -n "$restart_lock" true 2>/dev/null
}

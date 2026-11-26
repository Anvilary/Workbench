# Shared helpers for update.sh, restart-helper.sh and maw (POSIX sh, sourced).
#
# Release state machine (all pointers are symlinks inside $state_dir, replaced atomically):
#
#   releases/<id>/  built release; `.workbench-candidate` exists only while it is being built
#   staged   -> releases/<id>   built and validated, never activated (written only by update.sh)
#   current  -> releases/<id>   what workbench.service boots (written only by the restart helper / --initial)
#   healthy  -> releases/<id>   last release whose readiness was verified with its own release ID
#   previous -> releases/<id>   the healthy release before `healthy`
#
# Only the restart helper promotes a release to `healthy`, and only after the running service reported
# that release's ID through the authenticated readiness probe. Staging never touches current/healthy/previous.

# Deterministic Node.js executable resolution.
# Resolves one supported Node.js executable (>=20) with compatible Corepack/pnpm support.
# Honors WORKBENCH_NODE_BIN, checks NVM, PATH, and system paths.
wb_resolve_node() {
  if [ -n "${WORKBENCH_NODE_BIN:-}" ]; then
    if [ -x "$WORKBENCH_NODE_BIN" ]; then
      _ver=$("$WORKBENCH_NODE_BIN" -v 2>/dev/null || true)
      case "$_ver" in
        v[2-9][0-9]*)
          printf '%s' "$WORKBENCH_NODE_BIN"
          return 0
          ;;
      esac
    fi
    printf '%s\n' "Error: WORKBENCH_NODE_BIN is set to '$WORKBENCH_NODE_BIN' but it is not a valid Node executable (>=20 required)." >&2
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

# Copy documented legacy operational overrides into the canonical environment once.
wb_env_compat() {
  [ "${_WORKBENCH_COMPAT_PID:-}" != "$$" ] || return 0
  _WORKBENCH_COMPAT_PID=$$
  for _wb_suffix in \
    ACTIVATE_GUARD BIN_DIR CGROUP_FILE CGROUP_ROOT CLI_NAME CONTROL_SCRIPT ENV_FILE \
    EXPECT_RELEASE_ID HEADLESS HELPER_UNIT KEEP_RELEASES LIB_DIR LOG_FILE NODE_BIN \
    PROC_ROOT PTYD_RUNTIME_NAME PTYD_UNIT READY_TIMEOUT RELEASES_DIR RESTART_HELPER RESTART_LOCK \
    RUNTIME_DIR RUNTIME_NAME SOURCE_DIR STATE_DIR SYSTEMD_BUS_ADDRESS SYSTEMD_RUNTIME_DIR SYSTEMD_USER_DIR \
    UNIT UPDATE_CHANNEL UPDATE_LOCK UPDATE_REF UPDATE_SCRIPT \
  ; do
    _wb_new=WORKBENCH_$_wb_suffix
    _wb_old=MAW_$_wb_suffix
    eval '_wb_has_new=${'"$_wb_new"'+x} _wb_new_value=${'"$_wb_new"'-} _wb_has_old=${'"$_wb_old"'+x} _wb_old_value=${'"$_wb_old"'-}'
    [ "$_wb_has_old" = x ] || continue
    if [ "$_wb_has_new" != x ]; then
      export "$_wb_new=$_wb_old_value"
    elif [ "$_wb_new_value" != "$_wb_old_value" ]; then
      printf 'Ignoring %s because %s is set\n' "$_wb_old" "$_wb_new" >&2
    fi
  done
}

wb_init_paths() {
  wb_env_compat
  : "${HOME:?HOME is required}"
  state_dir="${WORKBENCH_STATE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/workbench}"
  releases_dir="${WORKBENCH_RELEASES_DIR:-$state_dir/releases}"
  log_file="${WORKBENCH_LOG_FILE:-$state_dir/update-log.jsonl}"
  update_lock="${WORKBENCH_UPDATE_LOCK:-$state_dir/update.lock}"
  _uid=$(id -u 2>/dev/null || true)
  _user_rdir="${XDG_RUNTIME_DIR:-}"
  if [ -z "$_user_rdir" ] && [ -n "$_uid" ] && [ -d "/run/user/$_uid" ]; then
    _user_rdir="/run/user/$_uid"
  fi
  runtime_dir="${WORKBENCH_RUNTIME_DIR:-${_user_rdir:-/tmp}/workbench}"
  restart_lock="${WORKBENCH_RESTART_LOCK:-$runtime_dir/restart.lock}"
  unit="${WORKBENCH_UNIT:-workbench.service}"
  ptyd_unit="${WORKBENCH_PTYD_UNIT:-workbench-ptyd.service}"
  node_bin="${WORKBENCH_NODE_BIN:-$(wb_resolve_node 2>/dev/null || true)}"
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
    export WORKBENCH_NODE_BIN="$node_bin"
    if [ -d "$state_dir" ] && [ -w "$state_dir" ]; then
      printf '%s\n' "$node_bin" > "$state_dir/node_path" 2>/dev/null || true
    fi
  fi
}

# Run a systemd user command (systemctl, systemd-run, journalctl) scoped to the canonical systemd user bus.
# Never modifies the global shell environment or provider authentication variables.
wb_systemd_cmd() {
  _cmd="$1"; shift
  _uid=$(id -u 2>/dev/null || true)
  _rdir="${WORKBENCH_SYSTEMD_RUNTIME_DIR:-}"
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

  _bus="${WORKBENCH_SYSTEMD_BUS_ADDRESS:-}"
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

wb_sctl() { wb_systemd_cmd systemctl --user "$@"; }
wb_systemd_run() { wb_systemd_cmd systemd-run --user "$@"; }
wb_journalctl() { wb_systemd_cmd journalctl --user "$@"; }

wb_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# wb_log EVENT [key value]... -> one JSON line. Values are JSON-escaped.
wb_log() {
  _event="$1"; shift
  _line="{\"ts\":\"$(wb_now)\",\"event\":\"$_event\""
  while [ "$#" -ge 2 ]; do
    _v=$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r\t' '   ')
    _line="$_line,\"$1\":\"$_v\""
    shift 2
  done
  mkdir -p "$(dirname "$log_file")" 2>/dev/null || true
  printf '%s}\n' "$_line" >> "$log_file" 2>/dev/null || true
}

# Release IDs are generated by update.sh: UTC timestamp, short commit, optional numeric suffix.
wb_valid_release_name() {
  printf '%s' "$1" | grep -Eq '^[0-9]{14}-[0-9a-f]{4,40}(-[0-9]+)?$'
}

# wb_release_id DIR -> prints releaseId from DIR/.workbench-release-meta.json (empty on any problem).
wb_release_id() {
  [ -f "$1/.workbench-release-meta.json" ] || return 0
  "$node_bin" -e '
    try { const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          if (typeof m.releaseId === "string") process.stdout.write(m.releaseId); } catch {}
  ' "$1/.workbench-release-meta.json" 2>/dev/null || true
}

wb_release_commit() {
  [ -f "$1/.workbench-release-meta.json" ] || return 0
  "$node_bin" -e '
    try { const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          if (typeof m.commit === "string") process.stdout.write(m.commit); } catch {}
  ' "$1/.workbench-release-meta.json" 2>/dev/null || true
}

# Checks if release declares supervisor in metadata or schema >= 2
wb_release_is_nextgen() {
  [ -f "$1/.workbench-release-meta.json" ] || return 1
  [ -n "$node_bin" ] || return 1
  "$node_bin" -e '
    try {
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit((m.supervisor === true || Number(m.schema) >= 2) ? 0 : 1);
    } catch { process.exit(1); }
  ' "$1/.workbench-release-meta.json" 2>/dev/null
}

# A usable release: a real (non-symlink) directory directly inside releases_dir, named like a release,
# finished (no candidate marker), whose metadata names itself, with the service entry points present.
# Next-generation releases require the server bundle and standalone supervisor.
# Historical legacy releases (which predate the supervisor contract) remain valid rollback targets.
wb_valid_release() {
  _d="$1"
  [ -n "$_d" ] && [ -d "$_d" ] && [ ! -L "$_d" ] || return 1
  _rr=$(cd "$releases_dir" 2>/dev/null && pwd -P) || return 1
  _dp=$(cd "$_d" 2>/dev/null && pwd -P) || return 1
  [ "$(dirname "$_dp")" = "$_rr" ] || return 1
  _name=$(basename "$_dp")
  wb_valid_release_name "$_name" || return 1
  [ ! -e "$_dp/.workbench-candidate" ] || return 1
  [ "$(wb_release_id "$_dp")" = "$_name" ] || return 1
  [ -f "$_dp/packages/server/src/index.ts" ] && [ -f "$_dp/packages/server/src/workbench-host.ts" ] || return 1
  [ -e "$_dp/packages/server/node_modules/tsx/dist/loader.mjs" ] || return 1
  if wb_release_is_nextgen "$_dp"; then
    [ -f "$_dp/packages/server/dist/index.mjs" ] || return 1
    [ -f "$_dp/packages/server/dist/ptyd.mjs" ] || return 1
    [ -f "$_dp/packages/server/dist/terminal-state.mjs" ] || return 1
  fi
  return 0
}

# wb_pointer NAME -> physical path of a VALID release the pointer names, or empty.
wb_pointer() {
  _l="$state_dir/$1"
  [ -L "$_l" ] || return 0
  _t=$(readlink -f "$_l" 2>/dev/null || true)
  if wb_valid_release "$_t"; then printf '%s' "$_t"; fi
}

# wb_pointer_raw NAME -> physical target whatever it is (legacy layouts point outside releases_dir).
wb_pointer_raw() {
  [ -L "$state_dir/$1" ] || [ -e "$state_dir/$1" ] || return 0
  readlink -f "$state_dir/$1" 2>/dev/null || true
}

# wb_set_pointer NAME RELEASE_DIR -> atomic replace; refuses anything that is not a valid release.
wb_set_pointer() {
  wb_valid_release "$2" || { printf '%s\n' "Refusing to point $1 at an invalid release: $2" >&2; return 1; }
  _tmp="$state_dir/.$1.tmp.$$"
  rm -f "$_tmp"
  ln -s "$2" "$_tmp" && mv -Tf "$_tmp" "$state_dir/$1"
}

wb_clear_pointer() {
  if [ -L "$state_dir/$1" ]; then rm -f "$state_dir/$1"; fi
}

# Lock helpers (flock(1)): the kernel releases the lock when the holder dies, including SIGKILL, so no
# PID files, no stale-lock guessing and no PID-reuse wedge.
wb_lock_update() {   # $1 = wait seconds (0 = fail immediately)
  mkdir -p "$(dirname "$update_lock")" || return 1
  exec 9>>"$update_lock" || return 1
  if [ "${1:-0}" -gt 0 ]; then flock -w "$1" 9; else flock -n 9; fi
}

wb_lock_restart() {
  mkdir -p "$(dirname "$restart_lock")" 2>/dev/null || return 1
  exec 8>>"$restart_lock" || return 1
  flock -n 8
}

# wb_restart_locked -> 0 if some process currently holds the restart lock.
wb_restart_locked() {
  [ -e "$restart_lock" ] || return 1
  ! flock -n "$restart_lock" true 2>/dev/null
}

# Refresh installed desktop icons (hicolor) and workbench.desktop launcher from RELEASE_DIR.
# Arguments: RELEASE_DIR [EXPLICIT_LAUNCHER_BIN]
# When EXPLICIT_LAUNCHER_BIN is omitted (automatic activation/rollback refresh), skips
# cleanly if RELEASE_DIR has no desktop icon assets and preserves any existing Exec= line.
wb_refresh_desktop_assets() {
  _release_dir="${1:-}"
  _explicit_launcher="${2:-}"
  [ -n "$_release_dir" ] && [ -d "$_release_dir" ] || return 0
  [ -n "${node_bin:-}" ] && [ -x "$node_bin" ] || return 0

  _icon_root="$_release_dir/packages/desktop/assets/icons"
  _has_icons=false
  for _s in 16 24 32 48 64 96 128 192 256 512; do
    if [ -f "$_icon_root/workbench-${_s}.png" ]; then
      _has_icons=true
      break
    fi
  done
  if [ -z "$_explicit_launcher" ] && [ "$_has_icons" != true ]; then
    return 0
  fi

  _data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  _desktop_apps="$_data_home/applications"
  _hicolor_dir="$_data_home/icons/hicolor"
  install -d "$_desktop_apps"

  for _s in 16 24 32 48 64 96 128 192 256 512; do
    _icon_src="$_icon_root/workbench-${_s}.png"
    if [ -f "$_icon_src" ]; then
      _icon_dir="$_hicolor_dir/${_s}x${_s}/apps"
      install -d "$_icon_dir"
      _tmp_icon="$_icon_dir/.workbench.png.tmp.$$"
      install -m 644 "$_icon_src" "$_tmp_icon" && mv -f "$_tmp_icon" "$_icon_dir/workbench.png"
    fi
  done

  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -f -t "$_hicolor_dir" 2>/dev/null || true
  fi

  _default_launcher="${WORKBENCH_BIN_DIR:-$HOME/.local/bin}/anvi-bench"
  "$node_bin" -e '
    const fs = require("fs");
    const desktopPath = process.argv[1];
    const explicitBin = process.argv[2];
    const defaultBin = process.argv[3];
    let execLine = "";
    if (!explicitBin && fs.existsSync(desktopPath)) {
      const existing = fs.readFileSync(desktopPath, "utf8");
      const match = existing.match(/^Exec=[^\n\r]+$/m);
      if (match) execLine = match[0];
    }
    if (!execLine) {
      const cmd = explicitBin || defaultBin;
      if (/[\n\r]/.test(cmd)) throw Error("Invalid launcher path");
      const escaped = cmd.replace(/([\\\"`$])/g, "\\$1").replace(/%/g, "%%");
      execLine = `Exec="${escaped}" desktop`;
    }
    const content = `[Desktop Entry]\nType=Application\nName=Workbench\nGenericName=Anvilary Workbench\n${execLine}\nIcon=workbench\nStartupWMClass=workbench\nTerminal=false\nCategories=Development;\nKeywords=Anvilary;Workbench;anvi-bench;Workbench;Workbench;Workspace;Terminal;ChatGPT;GitHub;\n`;
    const tmp = `${desktopPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, desktopPath);
  ' "$_desktop_apps/workbench.desktop" "$_explicit_launcher" "$_default_launcher"

  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$_desktop_apps" 2>/dev/null || true
  fi
}

# Refresh desktop integration assets after activation or rollback only on non-headless
# installations that already have desktop integration installed.
wb_refresh_desktop_assets_if_enabled() {
  [ "${WORKBENCH_HEADLESS:-}" = "1" ] && return 0
  [ -f "$state_dir/headless" ] && return 0
  _data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  [ -f "$_data_home/applications/workbench.desktop" ] || return 0
  wb_refresh_desktop_assets "${1:-}"
}

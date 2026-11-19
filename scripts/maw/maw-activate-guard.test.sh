#!/bin/sh
# Regression tests for maw-activate-guard.sh and start --force handling.
#
# Usage: sh scripts/maw/maw-activate-guard.test.sh
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
script_dir="$repo_dir/scripts/maw"
guard="$script_dir/maw-activate-guard.sh"
anvil_bin="$script_dir/anvil-bench"

pass=0
fail=0
cleanup_dirs=""
cleanup() {
  for _d in $cleanup_dirs; do
    [ -d "$_d" ] && rm -rf -- "$_d"
  done
}
trap cleanup EXIT

make_dir() {
  _td=$(mktemp -d "${TMPDIR:-/tmp}/maw-guard-test-XXXXXX")
  cleanup_dirs="$cleanup_dirs $_td"
  printf '%s' "$_td"
}

begin() { printf '  TEST: %s ... ' "$1"; }
ok()    { pass=$((pass + 1)); printf 'ok\n'; }
fail()  { fail=$((fail + 1)); printf 'FAIL\n' >&2; printf '        %s\n' "$@" >&2; }

make_mock_systemctl() {
  _bin="$1"
  _rc="$2"
  _active="$3"
  _load="$4"
  _cg="$5"
  cat > "$_bin/systemctl" <<EOF
#!/bin/sh
if [ "$_rc" -ne 0 ]; then
  exit $_rc
fi
case "\$*" in
  *ActiveState*) printf '%s\n' "$_active" ;;
  *LoadState*) printf '%s\n' "$_load" ;;
  *ControlGroup*) printf '%s\n' "$_cg" ;;
  *) printf '\n' ;;
esac
exit 0
EOF
  chmod 755 "$_bin/systemctl"
}

printf 'Running activation guard regression tests...\n\n'

# 1. Stopped production maw.service with empty ControlGroup must NOT block
begin "1. inactive maw.service with empty ControlGroup exits 0"
td=$(make_dir); mkdir -p "$td/bin"
make_mock_systemctl "$td/bin" 0 "inactive" "loaded" ""
if out=$(PATH="$td/bin:/usr/bin:/bin" /bin/sh "$guard" --unit maw.service 2>&1); then
  ok
else
  fail "expected exit 0 for inactive maw.service, got non-zero: $out"
fi

# 2. Failed production maw.service with empty ControlGroup must NOT block
begin "2. failed maw.service with empty ControlGroup exits 0"
td=$(make_dir); mkdir -p "$td/bin"
make_mock_systemctl "$td/bin" 0 "failed" "loaded" ""
if out=$(PATH="$td/bin:/usr/bin:/bin" /bin/sh "$guard" --unit maw.service 2>&1); then
  ok
else
  fail "expected exit 0 for failed maw.service, got non-zero: $out"
fi

# 3. Unloaded unit (not-found) must NOT block
begin "3. not-found maw.service exits 0"
td=$(make_dir); mkdir -p "$td/bin"
make_mock_systemctl "$td/bin" 0 "" "not-found" ""
if out=$(PATH="$td/bin:/usr/bin:/bin" /bin/sh "$guard" --unit maw.service 2>&1); then
  ok
else
  fail "expected exit 0 for not-found maw.service, got non-zero: $out"
fi

# 4. Unavailable systemctl blocks maw.service unless --force
begin "4. unavailable systemctl blocks maw.service without --force and allows with --force"
td=$(make_dir); mkdir -p "$td/bin"
make_mock_systemctl "$td/bin" 1 "" "" ""
if PATH="$td/bin:/usr/bin:/bin" MAW_CLI_NAME=anvil-bench /bin/sh "$guard" --unit maw.service >/dev/null 2>&1; then
  fail "expected exit 1 when systemctl fails without --force"
else
  if PATH="$td/bin:/usr/bin:/bin" MAW_CLI_NAME=anvil-bench /bin/sh "$guard" --unit maw.service --force >/dev/null 2>&1; then
    ok
  else
    fail "expected exit 0 when systemctl fails with --force"
  fi
fi

# 5. Active maw.service with empty ControlGroup blocks without --force
begin "5. active maw.service with empty ControlGroup blocks without --force"
td=$(make_dir); mkdir -p "$td/bin"
make_mock_systemctl "$td/bin" 0 "active" "loaded" ""
if PATH="$td/bin:/usr/bin:/bin" /bin/sh "$guard" --unit maw.service >/dev/null 2>&1; then
  fail "expected exit 1 for active maw.service with empty ControlGroup"
else
  ok
fi

# 6. Detects all supported coding agent binaries and emits valid override hint
begin "6. detects codex, claude, opencode, agy, antigravity, pi and fixes override hint"
td=$(make_dir); mkdir -p "$td/bin" "$td/cg/user.slice/maw.service" "$td/proc"
make_mock_systemctl "$td/bin" 0 "active" "loaded" "/user.slice/maw.service"
all_detected=true
for agent in codex codex-code-mode claude opencode agy antigravity pi; do
  rm -rf "$td/proc/1001"
  mkdir -p "$td/proc/1001"
  printf '%s\n' "$agent" > "$td/proc/1001/comm"
  printf '1001\n' > "$td/cg/user.slice/maw.service/cgroup.procs"
  set +e
  out=$(PATH="$td/bin:/usr/bin:/bin" MAW_CLI_NAME=anvil-bench MAW_CGROUP_ROOT="$td/cg" MAW_PROC_ROOT="$td/proc" \
    /bin/sh "$guard" --unit maw.service 2>&1)
  rc=$?
  set -e
  if [ "$rc" -ne 1 ]; then
    fail "agent '$agent' was not blocked (rc=$rc)"
    all_detected=false
    break
  fi
  if printf '%s' "$out" | grep -Fq 'maw-activate-guard.sh --force'; then
    fail "broken hint still present in output for '$agent': $out"
    all_detected=false
    break
  fi
  if ! printf '%s' "$out" | grep -Fq 'anvil-bench restart --force'; then
    fail "expected 'anvil-bench restart --force' hint for '$agent', got: $out"
    all_detected=false
    break
  fi
done
[ "$all_detected" = true ] && ok

# 7. Detects node-hosted coding agent via cmdline without flagging Workbench server or ping/pipewire
begin "7. detects node-hosted claude without false positives on server, ping, or pipewire"
td=$(make_dir); mkdir -p "$td/bin" "$td/cg/user.slice/maw.service" "$td/proc"
make_mock_systemctl "$td/bin" 0 "active" "loaded" "/user.slice/maw.service"
# Safe processes only: Workbench server, ping, pipewire, bash
mkdir -p "$td/proc/2001" "$td/proc/2002" "$td/proc/2003" "$td/proc/2004"
printf 'node\n' > "$td/proc/2001/comm"
printf '/usr/bin/node\0/opt/maw/packages/server/dist/index.mjs\0--prod\0' > "$td/proc/2001/cmdline"
printf 'ping\n' > "$td/proc/2002/comm"
printf 'pipewire\n' > "$td/proc/2003/comm"
printf 'bash\n' > "$td/proc/2004/comm"
printf '2001\n2002\n2003\n2004\n' > "$td/cg/user.slice/maw.service/cgroup.procs"
if ! out=$(PATH="$td/bin:/usr/bin:/bin" MAW_CGROUP_ROOT="$td/cg" MAW_PROC_ROOT="$td/proc" /bin/sh "$guard" --unit maw.service 2>&1); then
  fail "false positive on safe processes: $out"
else
  # Now add node-hosted claude
  mkdir -p "$td/proc/2005"
  printf 'node\n' > "$td/proc/2005/comm"
  printf '/usr/bin/node\0/usr/local/bin/claude\0--resume\0' > "$td/proc/2005/cmdline"
  printf '2001\n2002\n2005\n' > "$td/cg/user.slice/maw.service/cgroup.procs"
  if PATH="$td/bin:/usr/bin:/bin" MAW_CGROUP_ROOT="$td/cg" MAW_PROC_ROOT="$td/proc" /bin/sh "$guard" --unit maw.service >/dev/null 2>&1; then
    fail "expected node-hosted claude to be blocked"
  else
    ok
  fi
fi

# 8. anvil-bench start accepts --force and rejects unknown flags
begin "8. anvil-bench start accepts --force and rejects unknown options"
td=$(make_dir); mkdir -p "$td/bin" "$td/state" "$td/runtime"
make_mock_systemctl "$td/bin" 0 "inactive" "loaded" ""
cat > "$td/mock-helper.sh" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" > "$MAW_HELPER_ARGS_FILE"
exit 0
EOF
chmod 755 "$td/mock-helper.sh"
if ! env PATH="$td/bin:/usr/bin:/bin" HOME="$td" MAW_STATE_DIR="$td/state" MAW_RUNTIME_DIR="$td/runtime" \
    MAW_CGROUP_FILE="$td/no-cgroup" MAW_RESTART_HELPER="$td/mock-helper.sh" MAW_HELPER_ARGS_FILE="$td/args" \
    /bin/sh "$anvil_bin" start --force >/dev/null 2>&1; then
  fail "anvil-bench start --force failed"
else
  got_args=$(cat "$td/args")
  case "$got_args" in
    *"--start --force"*)
      set +e
      env PATH="$td/bin:/usr/bin:/bin" HOME="$td" MAW_STATE_DIR="$td/state" MAW_RUNTIME_DIR="$td/runtime" \
        MAW_CGROUP_FILE="$td/no-cgroup" MAW_RESTART_HELPER="$td/mock-helper.sh" \
        /bin/sh "$anvil_bin" start --unknown >/dev/null 2>&1
      bad_rc=$?
      set -e
      if [ "$bad_rc" -eq 2 ]; then
        ok
      else
        fail "expected exit 2 for unknown start flag, got $bad_rc"
      fi
      ;;
    *)
      fail "expected --start --force passed to helper, got: $got_args"
      ;;
  esac
fi

printf '\nResults: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

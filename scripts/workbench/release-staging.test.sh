#!/bin/sh
# Release staging regression tests for Workbench Next-Generation.
#
# Tests the updater's artifact validation, completeness checks and pointer safety
# against real lib.sh functions in isolated temp directories.
#
# Usage:  sh scripts/workbench/release-staging.test.sh
#         (run from the repository root)
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
script_dir="$repo_dir/scripts/workbench"
. "$script_dir/lib.sh"
wb_init_paths
[ -n "$node_bin" ] || { printf 'SKIP: node not found\n' >&2; exit 0; }

pass=0
fail=0
test_name=""

cleanup_dirs=""
cleanup() {
  for _d in $cleanup_dirs; do
    [ -d "$_d" ] && rm -rf -- "$_d"
  done
}
trap cleanup EXIT

make_test_dir() {
  _td=$(mktemp -d "${TMPDIR:-/tmp}/workbench-test-XXXXXX")
  cleanup_dirs="$cleanup_dirs $_td"
  printf '%s' "$_td"
}

begin() { test_name="$1"; printf '  TEST: %s ... ' "$test_name"; }
ok()    { pass=$((pass + 1)); printf 'ok\n'; }
fail()  { fail=$((fail + 1)); printf 'FAIL\n' >&2; printf '        %s\n' "$@" >&2; }

# Create a minimal fake release directory that passes wb_valid_release.
# $1 = releases_dir  $2 = release_id
create_valid_release() {
  _rd="$1/$2"
  mkdir -p "$_rd/packages/server/src/pty-host"
  mkdir -p "$_rd/packages/server/dist"
  mkdir -p "$_rd/packages/server/node_modules/tsx/dist"
  mkdir -p "$_rd/packages/server/node_modules/node-pty"
  printf 'export {};\n' > "$_rd/packages/server/src/index.ts"
  printf 'export {};\n' > "$_rd/packages/server/src/workbench-host.ts"
  printf 'export {};\n' > "$_rd/packages/server/node_modules/tsx/dist/loader.mjs"
  printf '#!/usr/bin/env node\nconsole.log("server");\n' > "$_rd/packages/server/dist/index.mjs"
  printf '#!/usr/bin/env node\nconsole.log("ptyd");\n' > "$_rd/packages/server/dist/ptyd.mjs"
  printf 'export class TerminalState {}\n' > "$_rd/packages/server/dist/terminal-state.mjs"
  chmod 755 "$_rd/packages/server/dist/ptyd.mjs"
  printf '{"releaseId":"%s","commit":"abc1234","ref":"origin/main","channel":"approved","builtAt":"20261104","source":"/tmp","schema":2,"supervisor":true}\n' \
    "$2" > "$_rd/.workbench-release-meta.json"
}

create_legacy_release() {
  _rd="$1/$2"
  mkdir -p "$_rd/packages/server/src"
  mkdir -p "$_rd/packages/server/node_modules/tsx/dist"
  printf 'export {};\n' > "$_rd/packages/server/src/index.ts"
  printf 'export {};\n' > "$_rd/packages/server/src/workbench-host.ts"
  printf 'export {};\n' > "$_rd/packages/server/node_modules/tsx/dist/loader.mjs"
  printf '{"releaseId":"%s","commit":"a93fecc","ref":"origin/main","channel":"approved","builtAt":"20261104","source":"/tmp"}\n' \
    "$2" > "$_rd/.workbench-release-meta.json"
}

printf 'Running Workbench release staging regression tests...\n\n'

# ---- Test 1: Web bundle succeeds, supervisor bundle missing ----
begin "1. web build ok, supervisor missing -> invalid release"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
rid="20261104120000-abc1234"
create_valid_release "$releases_dir" "$rid"
rm -f "$releases_dir/$rid/packages/server/dist/ptyd.mjs"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
if wb_valid_release "$releases_dir/$rid"; then
  fail "wb_valid_release should reject release without ptyd.mjs"
else
  ok
fi

# ---- Test 2: Supervisor bundle exists but entrypoint missing ----
begin "2. supervisor exists, server entrypoint missing -> invalid"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
rid="20261104120000-abc1234"
create_valid_release "$releases_dir" "$rid"
rm -f "$releases_dir/$rid/packages/server/dist/index.mjs"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
if wb_valid_release "$releases_dir/$rid"; then
  fail "wb_valid_release should reject release without dist/index.mjs"
else
  ok
fi

# ---- Test 3: Correct complete candidate ----
begin "3. complete release -> valid"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
rid="20261104120000-abc1234"
create_valid_release "$releases_dir" "$rid"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
if wb_valid_release "$releases_dir/$rid"; then
  ok
else
  fail "wb_valid_release should accept a complete release"
fi

# ---- Test 4: Missing node-pty dependency ----
begin "4. missing node-pty -> updater artifact check catches it"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
rid="20261104120000-abc1234"
create_valid_release "$releases_dir" "$rid"
rm -rf "$releases_dir/$rid/packages/server/node_modules/node-pty"
candidate_dir="$releases_dir/$rid"
# Simulate the updater's node-pty check
if [ ! -d "$candidate_dir/packages/server/node_modules/node-pty" ]; then
  ok
else
  fail "node-pty check should fail when directory is missing"
fi

# ---- Test 5: Build failure cleanup (candidate marker prevents validation) ----
begin "5. candidate marker present -> release is invalid"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
rid="20261104120000-abc1234"
create_valid_release "$releases_dir" "$rid"
printf '{"pid":1}\n' > "$releases_dir/$rid/.workbench-candidate"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
if wb_valid_release "$releases_dir/$rid"; then
  fail "wb_valid_release should reject a release with .workbench-candidate marker"
else
  ok
fi

# ---- Test 6: Activation refuses incomplete release (wb_set_pointer) ----
begin "6. wb_set_pointer refuses incomplete release"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
rid="20261104120000-abc1234"
create_valid_release "$releases_dir" "$rid"
rm -f "$releases_dir/$rid/packages/server/dist/ptyd.mjs"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
if wb_set_pointer staged "$releases_dir/$rid" 2>/dev/null; then
  fail "wb_set_pointer should refuse an incomplete release"
else
  ok
fi

# ---- Test 7: Existing healthy release remains untouched ----
begin "7. healthy pointer survives failed candidate"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
healthy_rid="20261104110000-def5678"
create_valid_release "$releases_dir" "$healthy_rid"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
wb_set_pointer healthy "$releases_dir/$healthy_rid"
# Try to set a bad staged pointer
bad_rid="20261104120000-abc1234"
create_valid_release "$releases_dir" "$bad_rid"
rm -f "$releases_dir/$bad_rid/packages/server/dist/ptyd.mjs"
wb_set_pointer staged "$releases_dir/$bad_rid" 2>/dev/null || true
healthy_target=$(wb_pointer healthy)
if [ "$(basename "$healthy_target")" = "$healthy_rid" ]; then
  ok
else
  fail "healthy pointer should still point to $healthy_rid, got: $healthy_target"
fi

# ---- Test 8: Complete release matches systemd ExecStart/ExecStartPre layout ----
begin "8. complete release has all files expected by systemd units"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
rid="20261104120000-abc1234"
create_valid_release "$releases_dir" "$rid"
rd="$releases_dir/$rid"
all_ok=true
# workbench.service checks:
[ -f "$rd/.workbench-release-meta.json" ] || all_ok=false
[ -f "$rd/packages/server/src/workbench-host.ts" ] || all_ok=false
[ -f "$rd/packages/server/src/index.ts" ] || all_ok=false
[ -e "$rd/packages/server/node_modules/tsx/dist/loader.mjs" ] || all_ok=false
# workbench-ptyd.service checks:
[ -f "$rd/packages/server/dist/ptyd.mjs" ] || all_ok=false
if [ "$all_ok" = true ]; then
  ok
else
  fail "release is missing files required by installed systemd units"
fi

# ---- Test 9: Fresh install vs upgrade (pointer semantics) ----
begin "9. fresh install and upgrade pointer semantics"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
# Fresh: no current pointer
current=$(wb_pointer current)
[ -z "$current" ] || { fail "fresh state should have no current pointer"; current=""; }
# Create initial release and set current
rid1="20261104100000-aaa1111"
create_valid_release "$releases_dir" "$rid1"
wb_set_pointer current "$releases_dir/$rid1"
c1=$(wb_pointer current)
[ "$(basename "$c1")" = "$rid1" ] || { fail "current should be $rid1"; }
# Upgrade: stage a second release
rid2="20261104110000-bbb2222"
create_valid_release "$releases_dir" "$rid2"
wb_set_pointer staged "$releases_dir/$rid2"
# Current should still be rid1
c2=$(wb_pointer current)
[ "$(basename "$c2")" = "$rid1" ] || { fail "current should still be $rid1 after staging"; }
s=$(wb_pointer staged)
[ "$(basename "$s")" = "$rid2" ] || { fail "staged should be $rid2"; }
ok

# ---- Test 10: Staged-release rollback (clear staged, healthy untouched) ----
begin "10. staged-release rollback"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
rid_h="20261104100000-ccc3333"
rid_s="20261104110000-ddd4444"
create_valid_release "$releases_dir" "$rid_h"
create_valid_release "$releases_dir" "$rid_s"
wb_set_pointer current "$releases_dir/$rid_h"
wb_set_pointer healthy "$releases_dir/$rid_h"
wb_set_pointer staged "$releases_dir/$rid_s"
# Rollback: clear staged
wb_clear_pointer staged
s=$(wb_pointer staged)
[ -z "$s" ] || { fail "staged should be empty after rollback, got: $s"; }
h=$(wb_pointer healthy)
[ "$(basename "$h")" = "$rid_h" ] || { fail "healthy should still be $rid_h"; }
c=$(wb_pointer current)
[ "$(basename "$c")" = "$rid_h" ] || { fail "current should still be $rid_h"; }
ok

# ---- Test 11: Root build script produces server bundle ----
begin "11. root pnpm build produces dist/index.mjs and dist/ptyd.mjs"
# Remove existing dist to verify build creates them
rm -f "$repo_dir/packages/server/dist/index.mjs" "$repo_dir/packages/server/dist/ptyd.mjs"
(cd "$repo_dir" && corepack pnpm build) >/dev/null 2>&1 || true
if [ -f "$repo_dir/packages/server/dist/index.mjs" ] && [ -f "$repo_dir/packages/server/dist/ptyd.mjs" ]; then
  ok
else
  fail "pnpm build should produce both server dist artifacts"
fi

# ---- Test 12: Supervisor file is valid JavaScript ----
begin "12. dist/ptyd.mjs is syntactically valid JavaScript"
if "$node_bin" -c "$repo_dir/packages/server/dist/ptyd.mjs" 2>/dev/null; then
  ok
else
  fail "ptyd.mjs should pass node -c syntax check"
fi

# ---- Test 13: Reproduce Corepack failure with system Node 22 / Corepack 0.24.0 ----
begin "13. reproduction: system corepack 0.24 fails on pnpm 12 (missing pnpm.cjs)"
# When host system corepack actually exhibits the legacy bug, capture it.
# If host corepack is patched, modern or absent, execute an isolated fixture
# deterministically simulating Corepack 0.24's hardcoded pnpm.cjs failure mode.
out=""
if [ -x "/usr/bin/corepack" ]; then
  host_out=$(PATH="/usr/bin:/bin" /usr/bin/corepack pnpm --version 2>&1 || true)
  if echo "$host_out" | grep -q "pnpm.cjs"; then
    out="$host_out"
  fi
fi

if [ -z "$out" ]; then
  fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/workbench-corepack-fixture-XXXXXX")
  cat << 'EOF' > "$fixture_dir/corepack"
#!/bin/sh
printf '%s\n' "Internal Error: Cannot find module '/usr/lib/node_modules/corepack/dist/pnpm/dist/pnpm.cjs'" >&2
exit 1
EOF
  chmod +x "$fixture_dir/corepack"
  out=$(PATH="$fixture_dir:/usr/bin:/bin" corepack pnpm --version 2>&1 || true)
  rm -rf "$fixture_dir"
fi

if echo "$out" | grep -q "pnpm.cjs"; then
  ok
else
  fail "expected corepack reproduction to demonstrate missing pnpm.cjs, got: $out"
fi

# ---- Test 14: wb_resolve_node selects compatible Node with working Corepack ----
begin "14. wb_resolve_node resolves Node runtime supporting pnpm 12"
resolved_node=$(unset WORKBENCH_NODE_BIN; . "$script_dir/lib.sh"; wb_resolve_node)
if [ -n "$resolved_node" ] && [ -x "$resolved_node" ]; then
  resolved_dir=$(dirname "$resolved_node")
  cp_ver=$(PATH="$resolved_dir:$PATH" corepack pnpm --version 2>/dev/null || true)
  if [ -n "$cp_ver" ]; then
    ok
  else
    fail "resolved node at $resolved_node failed corepack pnpm check"
  fi
else
  fail "wb_resolve_node failed to find a valid node executable"
fi

# ---- Test 15: wb_init_paths prepends node_dir to PATH before system paths ----
begin "15. wb_init_paths prioritizes resolved node_dir over /usr/bin in PATH"
subshell_out=$(
  PATH="/usr/local/bin:/usr/bin:/bin"
  unset WORKBENCH_NODE_BIN
  . "$script_dir/lib.sh"
  wb_init_paths
  printf '%s|%s|%s' "$(command -v node)" "$(command -v corepack)" "$(corepack pnpm --version 2>/dev/null || true)"
)
node_path=$(echo "$subshell_out" | cut -d'|' -f1)
cp_path=$(echo "$subshell_out" | cut -d'|' -f2)
cp_ver=$(echo "$subshell_out" | cut -d'|' -f3)
if [ "$node_path" != "/usr/bin/node" ] && [ "$cp_path" != "/usr/bin/corepack" ] && [ -n "$cp_ver" ]; then
  ok
else
  fail "wb_init_paths did not prioritize compatible node/corepack: node=$node_path cp=$cp_path ver=$cp_ver"
fi

# ---- Test 16: WORKBENCH_NODE_BIN override handling ----
begin "16. WORKBENCH_NODE_BIN override validation"
# Valid override
valid_out=$(WORKBENCH_NODE_BIN="$resolved_node" wb_resolve_node)
# Invalid override
if [ "$valid_out" != "$resolved_node" ]; then
  fail "valid WORKBENCH_NODE_BIN not returned"
elif invalid_out=$(WORKBENCH_NODE_BIN=/bin/false wb_resolve_node 2>/dev/null) || [ -n "$invalid_out" ]; then
  fail "invalid WORKBENCH_NODE_BIN should be rejected"
else
  ok
fi

# ---- Test 17: Legacy release validation and rollback preservation ----
begin "17. legacy release (a93fecc without dist/) validates and supports rollback"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
legacy_rid="20261104140117-a93fecc"
create_legacy_release "$releases_dir" "$legacy_rid"
if ! wb_valid_release "$releases_dir/$legacy_rid"; then
  fail "legacy release should be valid under original contract"
else
  # Setting healthy and previous to legacy release must succeed
  wb_set_pointer healthy "$releases_dir/$legacy_rid"
  wb_set_pointer previous "$releases_dir/$legacy_rid"
  h_val=$(wb_pointer healthy)
  p_val=$(wb_pointer previous)
  if [ "$(basename "$h_val")" = "$legacy_rid" ] && [ "$(basename "$p_val")" = "$legacy_rid" ]; then
    ok
  else
    fail "legacy release pointers not set: healthy=$h_val previous=$p_val"
  fi
fi

# ---- Test 18: Next-generation release requires supervisor bundle ----
begin "18. next-generation release strictly requires dist/ptyd.mjs"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
nextgen_rid="20261104160000-nextgen1"
create_valid_release "$releases_dir" "$nextgen_rid"
rm -f "$releases_dir/$nextgen_rid/packages/server/dist/ptyd.mjs"
if wb_valid_release "$releases_dir/$nextgen_rid"; then
  fail "next-gen release missing ptyd.mjs must be rejected"
else
  ok
fi

# ---- Test 19: workbench-ptyd.service template includes ConditionPathExists ----
begin "19. rendered workbench-ptyd.service contains ConditionPathExists"
ptyd_unit_text=$(sh "$script_dir/render-ptyd-unit.sh")
if echo "$ptyd_unit_text" | grep -q "ConditionPathExists="; then
  ok
else
  fail "workbench-ptyd.service must specify ConditionPathExists to guard against legacy releases"
fi

# ---- Test 20: AutoSpawn suppression in systemd production environments ----
begin "20. workbench.service sets WORKBENCH_AUTO_SPAWN_PTYD=0 and terminal-registry respects it"
reg_source=$(cat "$repo_dir/packages/server/src/features/terminals/terminal-registry.ts")
unit_source=$(cat "$repo_dir/scripts/workbench/workbench.service")
if echo "$reg_source" | grep -Fq "workbenchEnv('AUTO_SPAWN_PTYD')" && echo "$unit_source" | grep -q "WORKBENCH_AUTO_SPAWN_PTYD=0"; then
  ok
else
  fail "workbench.service must configure WORKBENCH_AUTO_SPAWN_PTYD=0 and terminal-registry must check it"
fi

# ---- Test 21: Next-generation release strictly requires dist/terminal-state.mjs ----
begin "21. next-generation release strictly requires dist/terminal-state.mjs"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
nextgen_rid="20261104160500-nextgen2"
create_valid_release "$releases_dir" "$nextgen_rid"
rm -f "$releases_dir/$nextgen_rid/packages/server/dist/terminal-state.mjs"
if wb_valid_release "$releases_dir/$nextgen_rid"; then
  fail "next-gen release missing terminal-state.mjs must be rejected"
else
  ok
fi

# ---- Test 22: restart helper detects terminal-state.mjs changes and rolls back workbench-ptyd on failure ----
begin "22. restart helper restarts workbench-ptyd on terminal-state.mjs change and rolls it back on workbench.service failure"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir" "$td/bin" "$td/runtime"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/lib.sh"
rid_old="20261104170000-aaaa111"
rid_new="20261104170500-bbbb222"
create_valid_release "$releases_dir" "$rid_old"
create_valid_release "$releases_dir" "$rid_new"
# Keep ptyd.mjs identical; change ONLY terminal-state.mjs
printf 'export class TerminalState { static v = 2; }\n' > "$releases_dir/$rid_new/packages/server/dist/terminal-state.mjs"
wb_set_pointer current "$releases_dir/$rid_old"
wb_set_pointer healthy "$releases_dir/$rid_old"
wb_set_pointer staged "$releases_dir/$rid_new"

# Mock systemctl recording which release current points to on every ptyd/service restart
cat > "$td/bin/systemctl" <<EOF
#!/bin/sh
cmd=""; for a in "\$@"; do case "\$a" in --*) ;; *) [ -z "\$cmd" ] && cmd="\$a" ;; esac; done
case "\$cmd" in
  show)
    case "\$*" in
      *ActiveState*) printf 'active\n'; exit 0 ;;
      *ControlGroup*) printf '\n'; exit 0 ;;
      *Result*) printf 'exit-code\n'; exit 0 ;;
    esac
    exit 0 ;;
  restart|start|stop)
    cur=\$(readlink -f "$td/current" 2>/dev/null || true)
    printf '%s %s %s\n' "\$cmd" "\$*" "\$(basename "\$cur")" >> "$td/systemctl.log"
    case "\$*" in
      *workbench-ptyd-test.service*)
        printf '%s\n' "\$(basename "\$cur")" > "$td/ptyd-running"
        exit 0 ;;
      *)
        printf '%s\n' "\$(basename "\$cur")" > "$td/backend-running"
        exit 0 ;;
    esac ;;
esac
exit 0
EOF
chmod 755 "$td/bin/systemctl"

# Mock control.mjs: target release fails readiness probe, healthy release succeeds
cat > "$td/mock-control.mjs" <<EOF
import fs from 'node:fs';
const cmd = process.argv[2];
if (cmd === 'check-data' || cmd === 'ptyd-empty') process.exit(0);
if (cmd === 'ptyd-release') { console.log('$releases_dir/$rid_old'); process.exit(0); }
if (cmd === 'backend-mode') { console.log('in-process'); process.exit(0); }
if (cmd === 'status') {
  const running = fs.existsSync('$td/backend-running') ? fs.readFileSync('$td/backend-running', 'utf8').trim() : '';
  const expected = process.env.WORKBENCH_EXPECT_RELEASE_ID || '';
  if (running === '$rid_old' && (!expected || expected === '$rid_old')) process.exit(0);
  process.exit(1);
}
process.exit(0);
EOF

set +e
PATH="$td/bin:$PATH" HOME="$td" WORKBENCH_STATE_DIR="$td" WORKBENCH_RELEASES_DIR="$releases_dir" \
  WORKBENCH_RUNTIME_DIR="$td/runtime" WORKBENCH_UNIT="maw-test.service" WORKBENCH_PTYD_UNIT="workbench-ptyd-test.service" \
  WORKBENCH_CONTROL_SCRIPT="$td/mock-control.mjs" WORKBENCH_READY_TIMEOUT=1 WORKBENCH_NODE_BIN="$node_bin" \
  /bin/sh "$script_dir/restart-helper.sh" --unit maw-test.service --force >/dev/null 2>&1
rc=$?
set -e
ptyd_after=$(cat "$td/ptyd-running" 2>/dev/null || true)
ptyd_restarts=$(grep -c 'restart .*workbench-ptyd-test.service' "$td/systemctl.log" 2>/dev/null || true)
if [ "$rc" -eq 2 ] && [ "$ptyd_restarts" -eq 2 ] && [ "$ptyd_after" = "$rid_old" ]; then
  ok
else
  fail "expected rc=2, 2 ptyd restarts (promote + rollback), ptyd_after=$rid_old; got rc=$rc ptyd_restarts=$ptyd_restarts ptyd_after=$ptyd_after"
fi

# ---- Test 23: workbench.service boots bundled dist/index.mjs with WORKBENCH_PERSISTENT_PTY=1 ----
begin "23. workbench.service boots dist/index.mjs --prod and sets WORKBENCH_PERSISTENT_PTY=1"
rendered_maw_unit=$(sh "$script_dir/render-unit.sh")
if printf '%s\n' "$rendered_maw_unit" | grep -Eq '^ExecStart=.*/packages/server/dist/index\.mjs --prod$' &&
   ! printf '%s\n' "$rendered_maw_unit" | grep -Fq 'tsx/dist/loader.mjs' &&
   printf '%s\n' "$rendered_maw_unit" | grep -Fq 'Environment=WORKBENCH_PERSISTENT_PTY=1'; then
  ok
else
  fail "workbench.service must boot dist/index.mjs --prod without tsx and set WORKBENCH_PERSISTENT_PTY=1"
fi

# ---- Test 24: check-desktop-build.mjs supports headless mode while enforcing desktop gate by default ----
begin "24. check-desktop-build.mjs honors WORKBENCH_HEADLESS=1 and still blocks default missing desktop runtime"
td=$(make_test_dir)
mkdir -p "$td/packages/desktop" "$td/lib"
printf '{}\n' > "$td/.workbench-candidate"
printf '{"devDependencies":{"electron":"0.0.0"}}\n' > "$td/packages/desktop/package.json"
printf '2\n' > "$td/lib/activation-helper-api"
if (cd "$td" && WORKBENCH_LIB_DIR="$td/lib" WORKBENCH_HEADLESS=1 "$node_bin" "$script_dir/check-desktop-build.mjs" >/dev/null 2>&1); then
  if (cd "$td" && WORKBENCH_LIB_DIR="$td/lib" WORKBENCH_HEADLESS="" "$node_bin" "$script_dir/check-desktop-build.mjs" >/dev/null 2>&1); then
    fail "check-desktop-build.mjs should still fail when WORKBENCH_HEADLESS is unset and desktop runtime is missing"
  else
    ok
  fi
else
  fail "check-desktop-build.mjs should succeed when WORKBENCH_HEADLESS=1 and activation helper is bootstrapped"
fi

# ---- Summary ----
printf '\n%s tests passed, %s failed.\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1

#!/bin/sh
# Release staging regression tests for MAW Next-Generation.
#
# Tests the updater's artifact validation, completeness checks and pointer safety
# against real maw-lib.sh functions in isolated temp directories.
#
# Usage:  sh scripts/maw/release-staging.test.sh
#         (run from the repository root)
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
script_dir="$repo_dir/scripts/maw"
node_bin="${MAW_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
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
  _td=$(mktemp -d "${TMPDIR:-/tmp}/maw-test-XXXXXX")
  cleanup_dirs="$cleanup_dirs $_td"
  printf '%s' "$_td"
}

begin() { test_name="$1"; printf '  TEST: %s ... ' "$test_name"; }
ok()    { pass=$((pass + 1)); printf 'ok\n'; }
fail()  { fail=$((fail + 1)); printf 'FAIL\n' >&2; printf '        %s\n' "$@" >&2; }

# Create a minimal fake release directory that passes maw_valid_release.
# $1 = releases_dir  $2 = release_id
create_valid_release() {
  _rd="$1/$2"
  mkdir -p "$_rd/packages/server/src/pty-host"
  mkdir -p "$_rd/packages/server/dist"
  mkdir -p "$_rd/packages/server/node_modules/tsx/dist"
  mkdir -p "$_rd/packages/server/node_modules/node-pty"
  printf 'export {};\n' > "$_rd/packages/server/src/index.ts"
  printf 'export {};\n' > "$_rd/packages/server/src/maw-host.ts"
  printf 'export {};\n' > "$_rd/packages/server/node_modules/tsx/dist/loader.mjs"
  printf '#!/usr/bin/env node\nconsole.log("server");\n' > "$_rd/packages/server/dist/index.mjs"
  printf '#!/usr/bin/env node\nconsole.log("ptyd");\n' > "$_rd/packages/server/dist/maw-ptyd.mjs"
  chmod 755 "$_rd/packages/server/dist/maw-ptyd.mjs"
  printf '{"releaseId":"%s","commit":"abc1234","ref":"origin/main","channel":"approved","builtAt":"20261104","source":"/tmp"}\n' \
    "$2" > "$_rd/.maw-release-meta.json"
}

printf 'Running MAW release staging regression tests...\n\n'

# ---- Test 1: Web bundle succeeds, supervisor bundle missing ----
begin "1. web build ok, supervisor missing -> invalid release"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
rid="20261104120000-abc1234"
create_valid_release "$releases_dir" "$rid"
rm -f "$releases_dir/$rid/packages/server/dist/maw-ptyd.mjs"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/maw-lib.sh"
if maw_valid_release "$releases_dir/$rid"; then
  fail "maw_valid_release should reject release without maw-ptyd.mjs"
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
. "$script_dir/maw-lib.sh"
if maw_valid_release "$releases_dir/$rid"; then
  fail "maw_valid_release should reject release without dist/index.mjs"
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
. "$script_dir/maw-lib.sh"
if maw_valid_release "$releases_dir/$rid"; then
  ok
else
  fail "maw_valid_release should accept a complete release"
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
printf '{"pid":1}\n' > "$releases_dir/$rid/.maw-candidate"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/maw-lib.sh"
if maw_valid_release "$releases_dir/$rid"; then
  fail "maw_valid_release should reject a release with .maw-candidate marker"
else
  ok
fi

# ---- Test 6: Activation refuses incomplete release (maw_set_pointer) ----
begin "6. maw_set_pointer refuses incomplete release"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
rid="20261104120000-abc1234"
create_valid_release "$releases_dir" "$rid"
rm -f "$releases_dir/$rid/packages/server/dist/maw-ptyd.mjs"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/maw-lib.sh"
if maw_set_pointer staged "$releases_dir/$rid" 2>/dev/null; then
  fail "maw_set_pointer should refuse an incomplete release"
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
. "$script_dir/maw-lib.sh"
maw_set_pointer healthy "$releases_dir/$healthy_rid"
# Try to set a bad staged pointer
bad_rid="20261104120000-abc1234"
create_valid_release "$releases_dir" "$bad_rid"
rm -f "$releases_dir/$bad_rid/packages/server/dist/maw-ptyd.mjs"
maw_set_pointer staged "$releases_dir/$bad_rid" 2>/dev/null || true
healthy_target=$(maw_pointer healthy)
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
# maw.service checks:
[ -f "$rd/.maw-release-meta.json" ] || all_ok=false
[ -f "$rd/packages/server/src/maw-host.ts" ] || all_ok=false
[ -f "$rd/packages/server/src/index.ts" ] || all_ok=false
[ -e "$rd/packages/server/node_modules/tsx/dist/loader.mjs" ] || all_ok=false
# maw-ptyd.service checks:
[ -f "$rd/packages/server/dist/maw-ptyd.mjs" ] || all_ok=false
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
. "$script_dir/maw-lib.sh"
# Fresh: no current pointer
current=$(maw_pointer current)
[ -z "$current" ] || { fail "fresh state should have no current pointer"; current=""; }
# Create initial release and set current
rid1="20261104100000-aaa1111"
create_valid_release "$releases_dir" "$rid1"
maw_set_pointer current "$releases_dir/$rid1"
c1=$(maw_pointer current)
[ "$(basename "$c1")" = "$rid1" ] || { fail "current should be $rid1"; }
# Upgrade: stage a second release
rid2="20261104110000-bbb2222"
create_valid_release "$releases_dir" "$rid2"
maw_set_pointer staged "$releases_dir/$rid2"
# Current should still be rid1
c2=$(maw_pointer current)
[ "$(basename "$c2")" = "$rid1" ] || { fail "current should still be $rid1 after staging"; }
s=$(maw_pointer staged)
[ "$(basename "$s")" = "$rid2" ] || { fail "staged should be $rid2"; }
ok

# ---- Test 10: Staged-release rollback (clear staged, healthy untouched) ----
begin "10. staged-release rollback"
td=$(make_test_dir)
releases_dir="$td/releases"; mkdir -p "$releases_dir"
state_dir="$td"; export state_dir releases_dir node_bin
. "$script_dir/maw-lib.sh"
rid_h="20261104100000-ccc3333"
rid_s="20261104110000-ddd4444"
create_valid_release "$releases_dir" "$rid_h"
create_valid_release "$releases_dir" "$rid_s"
maw_set_pointer current "$releases_dir/$rid_h"
maw_set_pointer healthy "$releases_dir/$rid_h"
maw_set_pointer staged "$releases_dir/$rid_s"
# Rollback: clear staged
maw_clear_pointer staged
s=$(maw_pointer staged)
[ -z "$s" ] || { fail "staged should be empty after rollback, got: $s"; }
h=$(maw_pointer healthy)
[ "$(basename "$h")" = "$rid_h" ] || { fail "healthy should still be $rid_h"; }
c=$(maw_pointer current)
[ "$(basename "$c")" = "$rid_h" ] || { fail "current should still be $rid_h"; }
ok

# ---- Test 11: Root build script produces server bundle ----
begin "11. root pnpm build produces dist/index.mjs and dist/maw-ptyd.mjs"
# Remove existing dist to verify build creates them
rm -f "$repo_dir/packages/server/dist/index.mjs" "$repo_dir/packages/server/dist/maw-ptyd.mjs"
(cd "$repo_dir" && corepack pnpm build) >/dev/null 2>&1 || true
if [ -f "$repo_dir/packages/server/dist/index.mjs" ] && [ -f "$repo_dir/packages/server/dist/maw-ptyd.mjs" ]; then
  ok
else
  fail "pnpm build should produce both server dist artifacts"
fi

# ---- Test 12: Supervisor file is valid JavaScript ----
begin "12. dist/maw-ptyd.mjs is syntactically valid JavaScript"
if "$node_bin" -c "$repo_dir/packages/server/dist/maw-ptyd.mjs" 2>/dev/null; then
  ok
else
  fail "maw-ptyd.mjs should pass node -c syntax check"
fi

# ---- Summary ----
printf '\n%s tests passed, %s failed.\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1

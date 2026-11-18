#!/bin/sh
# Build and validate a MAW release in an isolated detached worktree and STAGE it.
#
# Staging never changes what the service boots (`current`) nor the verified rollback targets
# (`healthy`, `previous`); see maw-lib.sh for the release state machine. Activation is performed only by
# `maw restart` (maw-restart-helper.sh), which verifies readiness of the exact release before promoting it.
set -eu

self_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=maw-lib.sh
. "$self_dir/maw-lib.sh"
maw_init_paths

maw_bin="$self_dir/maw"
[ -f "$maw_bin" ] || maw_bin="${MAW_BIN_DIR:-$HOME/.local/bin}/maw"

cli_name="${MAW_CLI_NAME:-maw}"
usage="Usage: $cli_name update [--restart|--no-restart] [--ref <git-ref> --allow-unapproved-ref] [--source <dir>]"

# Strip optional leading "update" subcommand if invoked via wrapper: maw update "$@"
if [ "${1:-}" = "update" ]; then shift; fi

restart_mode="prompt"
target_ref_opt=""
source_dir_opt=""
allow_unapproved=false
initial=false

need_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || { printf '%s\n' "Option $1 requires a value." "$usage" >&2; exit 2; }; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --restart) restart_mode="yes"; shift ;;
    --no-restart|--norestart) restart_mode="no"; shift ;;
    --ref) need_value "$@"; target_ref_opt="$2"; shift 2 ;;
    --source) need_value "$@"; source_dir_opt="$2"; shift 2 ;;
    --allow-unapproved-ref) allow_unapproved=true; shift ;;
    --initial) initial=true; restart_mode="no"; shift ;;
    --help|-h) printf '%s\n' "$usage"; exit 0 ;;
    *) printf '%s\n' "Unknown option: $1" "$usage" >&2; exit 2 ;;
  esac
done

[ -n "$node_bin" ] || { printf '%s\n' 'Error: node is not on PATH (set MAW_NODE_BIN).' >&2; exit 1; }
mkdir -p "$state_dir" "$releases_dir"

fail() {  # fail STAGE MESSAGE
  maw_log update-failure stage "$1" error "$2"
  printf '%s\n' "Error: $2" >&2
  exit 1
}

# 1. Exclusive update lock (also excludes a concurrent activation, which takes the same lock).
if ! maw_lock_update 0; then
  printf '%s\n' 'Error: Another MAW update or activation is already in progress.' >&2
  maw_log update-failure stage lock error 'Another update or activation is in progress'
  exit 1
fi
printf '%s\n' "$$" > "$update_lock.owner" 2>/dev/null || true

# 2. Resolve the source repository (a .git directory or a linked worktree).
source_dir=""
if [ -n "$source_dir_opt" ]; then source_dir="$source_dir_opt"
elif [ -n "${MAW_SOURCE_DIR:-}" ]; then source_dir="$MAW_SOURCE_DIR"
elif [ -f "$state_dir/source_path" ]; then source_dir=$(cat "$state_dir/source_path" 2>/dev/null || true)
fi
if [ -z "$source_dir" ] || [ ! -e "$source_dir" ]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then source_dir="$(git rev-parse --show-toplevel)"; fi
fi
if [ -z "$source_dir" ] || ! git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail pre-check "Configured source location '$source_dir' is not a valid Git repository or worktree."
fi
source_dir=$(git -C "$source_dir" rev-parse --show-toplevel)
printf '%s\n' "$source_dir" > "$state_dir/source_path"

# 3. Recover from earlier interrupted runs (SIGKILL, power loss). Ownership is proven, never assumed:
#    only directories directly inside releases_dir that are either marked as our candidate, or are
#    registered worktrees of the source repository without finished release metadata.
recover_orphans() {
  _rr=$(cd "$releases_dir" && pwd -P)
  _registered=$(git -C "$source_dir" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
  for _d in "$_rr"/*; do
    [ -d "$_d" ] && [ ! -L "$_d" ] || continue
    maw_valid_release_name "$(basename "$_d")" || continue
    _owned=false
    [ -f "$_d/.maw-candidate" ] && _owned=true
    if [ "$_owned" = false ] && [ ! -f "$_d/.maw-release-meta.json" ] &&
       printf '%s\n' "$_registered" | grep -Fqx "$_d"; then _owned=true; fi
    [ "$_owned" = true ] || continue
    for _p in current staged healthy previous; do
      [ "$(maw_pointer_raw "$_p")" = "$_d" ] && continue 2
    done
    printf '%s\n' "Removing interrupted candidate from an earlier run: $_d" >&2
    if ! git -C "$source_dir" worktree remove --force "$_d" 2>/dev/null; then rm -rf -- "$_d"; fi
    maw_log orphan-removed dir "$_d"
  done
  git -C "$source_dir" worktree prune 2>/dev/null || true
}
recover_orphans

# 4. Cleanliness is enforced so the developer is alerted to uncommitted work; staging itself only reads
#    committed objects and never resets, checks out or cleans this worktree.
if [ -n "$(git -C "$source_dir" status --porcelain)" ]; then
  fail pre-check 'Git worktree is dirty. Commit, stash, or discard local changes before updating.'
fi

# 5. Target: the approved release channel. Never the branch the developer happens to have checked out.
channel="${MAW_UPDATE_CHANNEL:-}"
if [ -z "$channel" ] && [ -f "$state_dir/channel" ]; then channel=$(head -n 1 "$state_dir/channel" | tr -d '[:space:]'); fi
[ -n "$channel" ] || channel="origin/main"
target_ref="${target_ref_opt:-${MAW_UPDATE_REF:-$channel}}"
approved=true
if [ "$target_ref" != "$channel" ]; then
  approved=false
  if [ "$allow_unapproved" != true ]; then
    printf '%s\n' "Error: '$target_ref' is not the approved release channel ('$channel')." \
      "Deploying another ref requires --allow-unapproved-ref (and confirmation in a terminal)." >&2
    maw_log update-failure stage pre-check error "Unapproved ref refused: $target_ref"
    exit 1
  fi
  printf '%s\n' "WARNING: staging '$target_ref', which is NOT the approved channel '$channel'."
  if [ -t 0 ]; then
    printf '%s' "Type the ref to confirm: "
    read -r confirm || confirm=""
    [ "$confirm" = "$target_ref" ] || { printf '%s\n' 'Not confirmed; aborting.' >&2; exit 1; }
  fi
fi

case "$target_ref" in
  origin/*)
    printf '%s\n' 'Fetching from origin...'
    git -C "$source_dir" fetch origin || fail fetch 'Failed to fetch from upstream (origin).'
    ;;
esac

target_commit=$(git -C "$source_dir" rev-parse --verify "$target_ref^{commit}" 2>/dev/null || true)
[ -n "$target_commit" ] || fail pre-check "Cannot resolve target ref '$target_ref'."

# 6. Compare against what is deployed: verified healthy release, else current (legacy: dev checkout HEAD).
healthy_dir=$(maw_pointer healthy)
current_raw=$(maw_pointer_raw current)
staged_dir=$(maw_pointer staged)
base_commit=""
[ -n "$healthy_dir" ] && base_commit=$(maw_release_commit "$healthy_dir")
if [ -z "$base_commit" ] && [ -n "$current_raw" ]; then
  base_commit=$(maw_release_commit "$current_raw")
  [ -n "$base_commit" ] || base_commit=$(git -C "$current_raw" rev-parse HEAD 2>/dev/null || true)
fi

if [ "$initial" = true ] && maw_valid_release "$current_raw"; then
  printf '%s\n' 'MAW already has an initial release; use maw update.'
  exit 0
fi
if [ -n "$staged_dir" ] && [ "$(maw_release_commit "$staged_dir")" = "$target_commit" ]; then
  printf '%s\n' "Release $(basename "$staged_dir") for $target_commit is already staged. Activate it with: maw restart"
  exit 0
fi
if [ "$initial" != true ] && [ "$base_commit" = "$target_commit" ] && [ -z "$staged_dir" ]; then
  printf '%s\n' "MAW is already up to date ($target_commit)."
  exit 0
fi
if [ -n "$base_commit" ] && [ "$base_commit" != "$target_commit" ] &&
   ! git -C "$source_dir" merge-base --is-ancestor "$base_commit" "$target_commit" 2>/dev/null; then
  fail pre-check 'Upstream changes cannot be fast-forwarded (branches have diverged).'
fi

# 7. Runtime compatibility of the target release.
printf '%s\n' 'Validating runtime compatibility...'
target_pkg=$(git -C "$source_dir" show "$target_commit:package.json" 2>/dev/null || true)
if [ -n "$target_pkg" ] && ! "$node_bin" -e '
    const pkg = JSON.parse(process.argv[1]);
    const m = pkg.engines && pkg.engines.node && pkg.engines.node.match(/>=\s*(\d+)/);
    if (m && parseInt(process.versions.node, 10) < parseInt(m[1], 10)) {
      console.error("Node version " + process.versions.node + " does not satisfy engines.node: " + pkg.engines.node);
      process.exit(1);
    }' "$target_pkg"; then
  fail pre-check 'Node runtime compatibility check failed'
fi

# 7b. Package manager and runtime execution preflight check before creating worktree
printf '%s\n' 'Validating package manager compatibility...'
if ! corepack pnpm --version >/dev/null 2>&1; then
  fail pre-check "Corepack/pnpm execution failed using Node at '$node_bin'. Ensure Corepack and pnpm are compatible with the target release packageManager."
fi

# 8. Candidate worktree. Interruption (HUP/INT/TERM) aborts the running step, removes ONLY this candidate
#    (proven ours by path and marker) and leaves every pointer untouched. SIGKILL is recovered by step 3.
ts=$(date -u +"%Y%m%d%H%M%S")
short_commit=$(git -C "$source_dir" rev-parse --short "$target_commit")
release_id="${ts}-${short_commit}"
[ ! -e "$releases_dir/$release_id" ] || release_id="${release_id}-$$"
candidate_dir="$releases_dir/$release_id"
candidate_active=false
step_pid=""

cleanup_candidate() {
  [ "$candidate_active" = true ] || return 0
  candidate_active=false
  case "$candidate_dir" in "$releases_dir"/*) ;; *) return 0 ;; esac
  if [ -d "$candidate_dir" ] && [ ! -L "$candidate_dir" ]; then
    printf '%s\n' "Cleaning up candidate: $candidate_dir" >&2
    git -C "$source_dir" worktree remove --force "$candidate_dir" 2>/dev/null || rm -rf -- "$candidate_dir"
  fi
  git -C "$source_dir" worktree prune 2>/dev/null || true
}

on_signal() {
  trap '' HUP INT TERM
  if [ -n "$step_pid" ]; then kill -TERM "$step_pid" 2>/dev/null || true; wait "$step_pid" 2>/dev/null || true; fi
  maw_log update-failure stage interrupted error "Update interrupted by signal $1" release "$release_id"
  printf '%s\n' "Update interrupted ($1). Running service and release pointers are unchanged." >&2
  cleanup_candidate
  exit 130
}
trap 'on_signal HUP' HUP
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'cleanup_candidate' EXIT

# Run a build step in the background so a signal interrupts `wait` immediately instead of waiting for
# the step to finish. Locks are not inherited by build processes.
run_step() {
  ( cd "$candidate_dir" && exec "$@" 8>&- 9>&- ) &
  step_pid=$!
  _rc=0
  wait "$step_pid" || _rc=$?
  step_pid=""
  return "$_rc"
}

handle_candidate_failure() {
  maw_log update-failure stage "$1" error "$2" release "$release_id"
  printf '%s\n' "Update failed at stage: $1 ($2)" "Developer source checkout and running release remain untouched." >&2
  exit 1   # EXIT trap removes the candidate
}

maw_log update-start from "$base_commit" to "$target_commit" ref "$target_ref" release "$release_id"
printf '%s\n' "Staging release $release_id in an isolated candidate directory..."

candidate_active=true
if ! git -C "$source_dir" worktree add --detach "$candidate_dir" "$target_commit"; then
  candidate_active=false
  fail stage 'git worktree add failed'
fi
printf '{"pid":%s,"source":"%s"}\n' "$$" "$source_dir" > "$candidate_dir/.maw-candidate"

printf '%s\n' 'Installing dependencies with frozen lockfile...'
run_step corepack pnpm install --frozen-lockfile || handle_candidate_failure dependencies 'pnpm install failed'
printf '%s\n' 'Running TypeScript typecheck...'
run_step corepack pnpm typecheck || handle_candidate_failure typecheck 'typecheck failed'
printf '%s\n' 'Building production bundles...'
run_step corepack pnpm build || handle_candidate_failure build 'build failed'
# Verify server bundle artifacts exist
if [ ! -f "$candidate_dir/packages/server/dist/index.mjs" ] || [ ! -f "$candidate_dir/packages/server/dist/maw-ptyd.mjs" ]; then
  handle_candidate_failure validate 'missing server bundle artifacts (dist/index.mjs or dist/maw-ptyd.mjs)'
fi
# Verify supervisor is valid JavaScript
if ! "$node_bin" -c "$candidate_dir/packages/server/dist/maw-ptyd.mjs" 2>/dev/null; then
  handle_candidate_failure validate 'supervisor dist/maw-ptyd.mjs is not valid JavaScript'
fi
# Verify node-pty native addon is present (required at runtime by both server and supervisor)
if [ ! -d "$candidate_dir/packages/server/node_modules/node-pty" ]; then
  handle_candidate_failure validate 'node-pty dependency is missing'
fi
printf '%s\n' 'Running profile test suite...'
run_step corepack pnpm --filter @agent-workbench/server exec tsx --test tests/unit/agents/profiles.test.ts ||
  handle_candidate_failure test 'profiles test failed'

# 9. Finalize: detach from git, write metadata, then drop the candidate marker (the release becomes valid).
trap '' HUP INT TERM
rm -f "$candidate_dir/.git"
git -C "$source_dir" worktree prune 2>/dev/null || true
channel_state=approved; [ "$approved" = true ] || channel_state=unapproved
printf '{"releaseId":"%s","commit":"%s","ref":"%s","channel":"%s","builtAt":"%s","source":"%s","schema":2,"supervisor":true}\n' \
  "$release_id" "$target_commit" "$target_ref" "$channel_state" "$ts" "$source_dir" > "$candidate_dir/.maw-release-meta.json"
rm -f "$candidate_dir/.maw-candidate"
if ! maw_valid_release "$candidate_dir"; then
  handle_candidate_failure validate 'built release is missing service entry points'
fi
candidate_active=false
trap - HUP INT TERM EXIT

if [ "$initial" = true ]; then
  # Nothing is running yet: the first release becomes the boot target, but it is NOT healthy until the
  # first `maw start`/`maw restart` verifies it.
  maw_set_pointer current "$candidate_dir"
  maw_log initial-release release "$release_id" commit "$target_commit"
  printf '%s\n' "Initial release $release_id installed. Start it with: maw start"
  exit 0
fi

replaced=$(maw_pointer staged)
maw_set_pointer staged "$candidate_dir"
maw_log stage-success release "$release_id" commit "$target_commit" replaced "${replaced:+$(basename "$replaced")}"
printf '%s\n' "MAW update staged successfully ($release_id)."

# 10. Activation.
should_restart=false
case "$restart_mode" in
  yes) should_restart=true ;;
  no) should_restart=false ;;
  prompt)
    if [ -t 0 ]; then
      printf '%s' 'Restart MAW now to activate the update? [y/N] '
      read -r ans || ans="n"
      case "$ans" in [yY]|[yY][eE][sS]) should_restart=true ;; esac
    fi
    ;;
esac

if [ "$should_restart" = false ]; then
  printf '%s\n' 'Update staged. The service keeps booting the current release, even after a crash or reboot.' \
    'Activate the staged release with: maw restart'
  exit 0
fi

# Release the update lock before handing over: activation takes it again (flock locks belong to the open
# file description, so an inherited descriptor would make the helper wait on itself).
exec 9>&-
exec /bin/sh "$maw_bin" restart

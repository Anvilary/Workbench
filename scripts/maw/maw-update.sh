#!/bin/sh
set -eu

PATH="${PATH}:/home/user/.nvm/versions/node/v24.22.0/bin:/home/user/.local/bin"
export PATH

# Configuration and directories
unit="${MAW_UNIT:-maw.service}"
state_dir="${MAW_STATE_DIR:-/home/user/.local/share/maw}"
releases_dir="${MAW_RELEASES_DIR:-$state_dir/releases}"
current_link="${MAW_CURRENT_LINK:-$state_dir/current}"
previous_link="${MAW_PREVIOUS_LINK:-$state_dir/previous}"
log_file="${MAW_LOG_FILE:-$state_dir/update-log.jsonl}"
lock_file="${MAW_UPDATE_LOCK:-$state_dir/update.lock}"

self_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
maw_bin="$self_dir/maw"
[ -f "$maw_bin" ] || maw_bin="/home/user/.local/bin/maw"

# Strip optional leading "update" subcommand if invoked via wrapper: maw update "$@"
if [ "${1:-}" = "update" ]; then
  shift
fi

restart_mode="prompt"
target_ref_opt=""
source_dir_opt=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --restart)
      restart_mode="yes"
      shift
      ;;
    --no-restart)
      restart_mode="no"
      shift
      ;;
    --ref)
      target_ref_opt="$2"
      shift 2
      ;;
    --source)
      source_dir_opt="$2"
      shift 2
      ;;
    --help|-h)
      printf '%s\n' 'Usage: maw update [--restart|--no-restart] [--ref <git-ref>] [--source <dir>]'
      exit 0
      ;;
    *)
      printf '%s\n' "Unknown option: $1" >&2
      printf '%s\n' 'Usage: maw update [--restart|--no-restart] [--ref <git-ref>] [--source <dir>]' >&2
      exit 2
      ;;
  esac
done

mkdir -p "$state_dir" "$releases_dir" 2>/dev/null || true

# Logging helpers
log_json() {
  local json="$1"
  printf '%s\n' "$json" >> "$log_file"
}

log_start() {
  local from="$1" to="$2" ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  log_json "{\"ts\":\"$ts\",\"event\":\"update-start\",\"from\":\"$from\",\"to\":\"$to\"}"
}

log_success() {
  local commit="$1" prev="$2" ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  log_json "{\"ts\":\"$ts\",\"event\":\"update-success\",\"commit\":\"$commit\",\"prev\":\"$prev\"}"
}

log_failure() {
  local stage="$1" error="$2" ts escaped_error
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  escaped_error=$(printf '%s' "$error" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  log_json "{\"ts\":\"$ts\",\"event\":\"update-failure\",\"stage\":\"$stage\",\"error\":\"$escaped_error\"}"
}

# 1. Update concurrency lock
if [ -f "$lock_file" ]; then
  lock_pid=$(cat "$lock_file" 2>/dev/null || true)
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    printf '%s\n' "Error: Another MAW update is already in progress (PID: $lock_pid)." >&2
    log_failure "lock" "Another update is in progress"
    exit 1
  fi
fi
echo "$$" > "$lock_file"
cleanup_lock() {
  rm -f "$lock_file"
}
trap cleanup_lock EXIT INT TERM

# 2. Resolve source repository location (support .git directory and .git worktree file)
source_dir=""
if [ -n "$source_dir_opt" ]; then
  source_dir="$source_dir_opt"
elif [ -n "${MAW_SOURCE_DIR:-}" ]; then
  source_dir="$MAW_SOURCE_DIR"
elif [ -f "$state_dir/source_path" ]; then
  source_dir=$(cat "$state_dir/source_path" 2>/dev/null || true)
fi

if [ -z "$source_dir" ] || [ ! -e "$source_dir" ]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    source_dir="$(git rev-parse --show-toplevel)"
  fi
fi

if [ -z "$source_dir" ] || ! git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '%s\n' "Error: Configured source location '$source_dir' is not a valid Git repository or worktree." >&2
  log_failure "pre-check" "Invalid Git repository or worktree location"
  exit 1
fi

source_dir=$(git -C "$source_dir" rev-parse --show-toplevel)
printf '%s\n' "$source_dir" > "$state_dir/source_path"

# 3. Check developer worktree cleanliness
# Cleanliness is strictly enforced so the developer is alerted to uncommitted work,
# but our staging mechanism never performs git reset --hard on this worktree.
if [ -n "$(git -C "$source_dir" status --porcelain)" ]; then
  printf '%s\n' 'Error: Git worktree is dirty. Commit, stash, or discard local changes before updating.' >&2
  log_failure "pre-check" "Git worktree is dirty"
  exit 1
fi

# 4. Determine and verify target update reference
target_ref=""
if [ -n "$target_ref_opt" ]; then
  target_ref="$target_ref_opt"
elif [ -n "${MAW_UPDATE_REF:-}" ]; then
  target_ref="$MAW_UPDATE_REF"
else
  # Default to upstream tracking branch if configured
  if git -C "$source_dir" rev-parse --symbolic-full-name @{u} >/dev/null 2>&1; then
    # Verify no unpushed local commits would be orphaned
    unpushed=$(git -C "$source_dir" log @{u}..HEAD --oneline 2>/dev/null || true)
    if [ -n "$unpushed" ]; then
      printf '%s\n' 'Error: Local commits exist that are not on upstream tracking branch.' >&2
      printf '%s\n' 'Aborting to avoid orphaning local commits:' >&2
      printf '%s\n' "$unpushed" >&2
      log_failure "pre-check" "Local commits not on upstream"
      exit 1
    fi
    target_ref="@{u}"
  elif git -C "$source_dir" rev-parse --verify origin/main >/dev/null 2>&1; then
    target_ref="origin/main"
  else
    target_ref="HEAD"
  fi
fi

# 5. Fetch upstream if remote reference
case "$target_ref" in
  origin/*|@{u})
    printf '%s\n' 'Fetching from origin...'
    if ! git -C "$source_dir" fetch origin; then
      printf '%s\n' 'Error: Failed to fetch from upstream (origin).' >&2
      log_failure "fetch" "git fetch origin failed"
      exit 1
    fi
    ;;
esac

target_commit=$(git -C "$source_dir" rev-parse --verify "$target_ref^{commit}" 2>/dev/null || true)
if [ -z "$target_commit" ]; then
  printf '%s\n' "Error: Cannot resolve target ref '$target_ref'." >&2
  log_failure "pre-check" "Cannot resolve target ref"
  exit 1
fi

# 6. Check currently deployed commit and fast-forward eligibility
current_commit=""
if [ -f "$current_link/.maw-release-meta.json" ]; then
  current_commit=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('$current_link/.maw-release-meta.json')).commit || '') } catch { console.log('') }")
elif [ -d "$current_link" ]; then
  current_commit=$(git -C "$current_link" rev-parse HEAD 2>/dev/null || true)
fi
[ -n "$current_commit" ] || current_commit=$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)

if [ "$current_commit" = "$target_commit" ]; then
  printf '%s\n' "MAW is already up to date ($target_commit)."
  exit 0
fi

if ! git -C "$source_dir" merge-base --is-ancestor "$current_commit" "$target_commit" 2>/dev/null; then
  printf '%s\n' 'Error: Upstream changes cannot be fast-forwarded (branches have diverged).' >&2
  log_failure "pre-check" "Upstream changes cannot be fast-forwarded"
  exit 1
fi

# 7. Validate runtime and dependency compatibility of target release
printf '%s\n' 'Validating runtime compatibility...'
target_pkg=$(git -C "$source_dir" show "$target_commit:package.json" 2>/dev/null || true)
if [ -n "$target_pkg" ]; then
  if ! node -e "
    const pkg = JSON.parse(process.argv[1]);
    const current = process.versions.node;
    if (pkg.engines && pkg.engines.node) {
      const match = pkg.engines.node.match(/>=\s*(\d+)/);
      if (match) {
        const minMajor = parseInt(match[1], 10);
        const currentMajor = parseInt(current.split('.')[0], 10);
        if (currentMajor < minMajor) {
          console.error('Node version ' + current + ' does not satisfy engines.node: ' + pkg.engines.node);
          process.exit(1);
        }
      }
    }
  " "$target_pkg"; then
    printf '%s\n' 'Error: Runtime dependency compatibility check failed.' >&2
    log_failure "pre-check" "Node runtime compatibility check failed"
    exit 1
  fi
fi

# 8. Create candidate release directory using detached worktree
# This ensures the developer's source checkout is NEVER touched or modified!
ts=$(date -u +"%Y%m%d%H%M%S")
short_commit=$(git -C "$source_dir" rev-parse --short "$target_commit")
release_id="${ts}-${short_commit}"
candidate_dir="$releases_dir/$release_id"

log_start "$current_commit" "$target_commit"
printf '%s\n' "Staging release $release_id in immutable candidate directory..."

candidate_active=false
cleanup_candidate() {
  if [ "$candidate_active" = true ] && [ -d "$candidate_dir" ]; then
    printf '%s\n' "Cleaning up failed candidate directory: $candidate_dir" >&2
    git -C "$source_dir" worktree remove --force "$candidate_dir" 2>/dev/null || rm -rf "$candidate_dir"
    git -C "$source_dir" worktree prune 2>/dev/null || true
  fi
}

if ! git -C "$source_dir" worktree add --detach "$candidate_dir" "$target_commit"; then
  log_failure "stage" "git worktree add failed"
  printf '%s\n' 'Error: Failed to create isolated candidate worktree.' >&2
  exit 1
fi
candidate_active=true

handle_candidate_failure() {
  local stage="$1" error_msg="$2"
  log_failure "$stage" "$error_msg"
  printf '%s\n' "Update failed at stage: $stage ($error_msg)" >&2
  printf '%s\n' "Developer source checkout and running release remain untouched." >&2
  cleanup_candidate
  candidate_active=false
  exit 1
}

# 9. Build and verify release candidate inside candidate directory
cd "$candidate_dir"

printf '%s\n' 'Installing dependencies with frozen lockfile...'
if ! corepack pnpm install --frozen-lockfile; then
  handle_candidate_failure "dependencies" "pnpm install failed"
fi

printf '%s\n' 'Running TypeScript typecheck...'
if ! corepack pnpm typecheck; then
  handle_candidate_failure "typecheck" "typecheck failed"
fi

printf '%s\n' 'Building production bundles...'
if ! corepack pnpm build; then
  handle_candidate_failure "build" "build failed"
fi

printf '%s\n' 'Running profile test suite...'
if ! corepack pnpm --filter @agent-workbench/server exec tsx --test src/agents/profiles/profiles.test.ts; then
  handle_candidate_failure "test" "profiles test failed"
fi

# 10. Detach git worktree metadata to make release directory immutable
rm -f "$candidate_dir/.git"
git -C "$source_dir" worktree prune 2>/dev/null || true
candidate_active=false

# Write release metadata
printf '{"releaseId":"%s","commit":"%s","builtAt":"%s","source":"%s"}\n' \
  "$release_id" "$target_commit" "$ts" "$source_dir" > "$candidate_dir/.maw-release-meta.json"

# 11. Atomically switch release pointers
# Preserve previous release pointer for rollback capability
if [ -L "$current_link" ] || [ -d "$current_link" ]; then
  old_target=$(readlink -f "$current_link" 2>/dev/null || true)
  if [ -n "$old_target" ] && [ "$old_target" != "$candidate_dir" ]; then
    ln -sfn "$old_target" "${previous_link}.tmp"
    mv -Tf "${previous_link}.tmp" "$previous_link"
  fi
fi

ln -sfn "$candidate_dir" "${current_link}.tmp"
mv -Tf "${current_link}.tmp" "$current_link"

log_success "$target_commit" "$current_commit"
printf '%s\n' "MAW update staged successfully ($release_id)."

# 12. Restart handling
should_restart=false
case "$restart_mode" in
  yes)
    should_restart=true
    ;;
  no)
    should_restart=false
    ;;
  prompt)
    if [ -t 0 ]; then
      printf '%s' 'Restart MAW now to apply the update? [y/N] '
      read -r ans || ans="n"
      case "$ans" in
        [yY]|[yY][eE][sS]) should_restart=true ;;
        *) should_restart=false ;;
      esac
    else
      should_restart=false
    fi
    ;;
esac

if [ "$should_restart" = false ]; then
  printf '%s\n' 'Update staged. Running service remains active on previous release.'
  printf '%s\n' 'Activate the validated update anytime with: maw restart'
  exit 0
fi

# Execute safe restart
exec /bin/sh "$maw_bin" restart

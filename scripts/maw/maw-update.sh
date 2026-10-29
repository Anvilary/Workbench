#!/bin/sh
set -eu

PATH="/home/user/.nvm/versions/node/v24.22.0/bin:/home/user/.local/bin:$PATH"
export PATH

# Resolve repository working directory
repo_dir=$(systemctl --user show maw.service --property=WorkingDirectory --value 2>/dev/null || true)
if [ -z "$repo_dir" ] || [ ! -d "$repo_dir/.git" ]; then
  if [ -d "/home/user/Projects/My-Amazing-Workspace/.git" ]; then
    repo_dir="/home/user/Projects/My-Amazing-Workspace"
  elif git rev-parse --show-toplevel >/dev/null 2>&1; then
    repo_dir="$(git rev-parse --show-toplevel)"
  else
    printf '%s\n' 'Error: Cannot locate MAW repository.' >&2
    exit 1
  fi
fi
cd "$repo_dir"

# Strip optional leading "update" subcommand if invoked via wrapper: maw update "$@"
if [ "${1:-}" = "update" ]; then
  shift
fi

restart_mode="prompt"

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
    --help|-h)
      printf '%s\n' 'Usage: maw update [--restart|--no-restart]'
      exit 0
      ;;
    *)
      printf '%s\n' "Unknown option: $1" >&2
      printf '%s\n' 'Usage: maw update [--restart|--no-restart]' >&2
      exit 2
      ;;
  esac
done

LOG_FILE="$HOME/.local/share/maw/update-log.jsonl"

log_json() {
  local json="$1"
  mkdir -p "$HOME/.local/share/maw" 2>/dev/null || true
  printf '%s\n' "$json" >> "$LOG_FILE"
}

log_start() {
  local from="$1" to="$2" ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  log_json "{\"ts\":\"$ts\",\"event\":\"update-start\",\"from\":\"$from\",\"to\":\"$to\"}"
}

log_success() {
  local commit="$1" prev="$2" ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  log_json "{\"ts\":\"$ts\",\"event\":\"update-success\",\"commit\":\"$commit\"}"
}

log_failure() {
  local stage="$1" error="$2" ts escaped_error
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  escaped_error=$(printf '%s' "$error" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  log_json "{\"ts\":\"$ts\",\"event\":\"update-failure\",\"stage\":\"$stage\",\"error\":\"$escaped_error\"}"
}

is_inside_maw() {
  local maw_pid check_pid
  maw_pid=$(systemctl --user show maw.service --property=MainPID --value 2>/dev/null) || return 1
  [ -n "$maw_pid" ] && [ "$maw_pid" -gt 0 ] 2>/dev/null || return 1
  check_pid=$$
  while [ -n "$check_pid" ] && [ "$check_pid" -gt 1 ] 2>/dev/null; do
    check_pid=$(ps -o ppid= -p "$check_pid" 2>/dev/null | tr -d ' ') || break
    case "$check_pid" in ''|*[!0-9]*) break ;; esac
    [ "$check_pid" = "$maw_pid" ] && return 0
  done
  return 1
}

prev_commit=""
dist_backup=""

handle_failure() {
  local stage="$1" error_msg="$2" do_rollback
  log_failure "$stage" "$error_msg"
  printf '%s\n' "Update failed at stage: $stage ($error_msg)" >&2

  if [ -n "$prev_commit" ]; then
    do_rollback=true
    if [ -t 0 ]; then
      printf '%s' "Build/test failed. Roll back to $prev_commit? [Y/n] " >&2
      read -r ans || ans="y"
      case "$ans" in
        [nN]*) do_rollback=false ;;
        *) do_rollback=true ;;
      esac
    fi

    if [ "$do_rollback" = true ]; then
      printf '%s\n' "Rolling back git commit to $prev_commit..." >&2
      git reset --hard "$prev_commit"
      if [ -n "$dist_backup" ] && [ -d "$dist_backup" ]; then
        printf '%s\n' "Restoring previous web dist from $dist_backup..." >&2
        rm -rf packages/web/dist
        cp -a "$dist_backup" packages/web/dist
      fi
      printf '%s\n' "Reinstalling dependencies for $prev_commit..." >&2
      corepack pnpm install --frozen-lockfile >/dev/null 2>&1 || true
      printf '%s\n' "Rollback to $prev_commit completed. Running server remains safe." >&2
    else
      printf '%s\n' "Rollback skipped. Worktree remains at $(git rev-parse --short HEAD)." >&2
    fi
  fi
  exit 1
}

# 1. Check git worktree is clean
if [ -n "$(git status --porcelain)" ]; then
  printf '%s\n' 'Error: Git worktree is dirty. Commit, stash, or discard local changes before updating.' >&2
  log_failure "pre-check" "Git worktree is dirty"
  exit 1
fi

# 2. Check upstream tracking branch is configured
if ! git rev-parse --symbolic-full-name @{u} >/dev/null 2>&1; then
  current_branch=$(git branch --show-current 2>/dev/null || echo "HEAD")
  printf '%s\n' "Error: Branch '$current_branch' has no upstream tracking branch configured." >&2
  log_failure "pre-check" "No upstream tracking branch configured"
  exit 1
fi

# 3. Check for local commits not on upstream
unpushed=$(git log @{u}..HEAD --oneline 2>/dev/null || true)
if [ -n "$unpushed" ]; then
  printf '%s\n' 'Error: Local commits exist that are not on upstream tracking branch.' >&2
  printf '%s\n' 'Aborting to prevent losing or orphaning local commits:' >&2
  printf '%s\n' "$unpushed" >&2
  log_failure "pre-check" "Local commits not on upstream"
  exit 1
fi

# 4. Fetch upstream
printf '%s\n' 'Fetching upstream...'
if ! git fetch origin; then
  printf '%s\n' 'Error: Failed to fetch from upstream (origin).' >&2
  log_failure "fetch" "git fetch origin failed"
  exit 1
fi

# 5. Check if already up to date
head_hash=$(git rev-parse HEAD)
upstream_hash=$(git rev-parse @{u})

if [ "$head_hash" = "$upstream_hash" ]; then
  printf '%s\n' "MAW is already up to date ($head_hash)."
  exit 0
fi

# 6. Check if fast-forward is possible
if ! git merge-base --is-ancestor HEAD @{u}; then
  printf '%s\n' 'Error: Upstream changes cannot be fast-forwarded (branches have diverged).' >&2
  printf '%s\n' 'Rebase or merge manually.' >&2
  log_failure "pre-check" "Upstream changes cannot be fast-forwarded"
  exit 1
fi

# 7. Check runtime/dependency compatibility
printf '%s\n' 'Checking runtime compatibility...'
if ! node -e '
  const fs = require("fs");
  const current = process.versions.node;
  if (fs.existsSync(".nvmrc")) {
    const nvmrc = fs.readFileSync(".nvmrc", "utf8").trim().replace(/^v/, "");
    if (nvmrc && !current.startsWith(nvmrc)) {
      console.error(`Node version mismatch with .nvmrc. Required: ${nvmrc}, Current: ${current}`);
      process.exit(1);
    }
  }
  if (fs.existsSync("package.json")) {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    if (pkg.engines && pkg.engines.node) {
      const match = pkg.engines.node.match(/>=\s*(\d+)/);
      if (match) {
        const minMajor = parseInt(match[1], 10);
        const currentMajor = parseInt(current.split(".")[0], 10);
        if (currentMajor < minMajor) {
          console.error(`Node version ${current} does not satisfy engines.node: ${pkg.engines.node}`);
          process.exit(1);
        }
      }
    }
  }
'; then
  printf '%s\n' 'Error: Runtime dependency compatibility check failed.' >&2
  log_failure "pre-check" "Node runtime compatibility check failed"
  exit 1
fi

# 8. Record previous state, backup dist, log start
prev_commit="$head_hash"
target_commit="$upstream_hash"
backup_dir="$HOME/.local/share/maw/backups"
ts=$(date -u +"%Y%m%d%H%M%S")
dist_backup="$backup_dir/dist-$ts"

if [ -d "packages/web/dist" ]; then
  mkdir -p "$backup_dir"
  cp -a packages/web/dist "$dist_backup"
fi

log_start "$prev_commit" "$target_commit"

# 9. Fast-forward merge
printf '%s\n' "Updating from $prev_commit to $target_commit..."
if ! git merge --ff-only @{u}; then
  handle_failure "merge" "git merge --ff-only failed"
fi

# 10. Install dependencies
printf '%s\n' 'Installing dependencies with frozen lockfile...'
if ! corepack pnpm install --frozen-lockfile; then
  handle_failure "dependencies" "pnpm install failed"
fi

# 11. Typecheck
printf '%s\n' 'Running TypeScript typecheck...'
if ! corepack pnpm typecheck; then
  handle_failure "typecheck" "typecheck failed"
fi

# 12. Build
printf '%s\n' 'Building production bundles...'
if ! corepack pnpm build; then
  handle_failure "build" "build failed"
fi

# 13. Test
printf '%s\n' 'Running profile test suite...'
if ! corepack pnpm --filter @agent-workbench/server exec tsx --test src/agents/profiles/profiles.test.ts; then
  handle_failure "test" "profiles test failed"
fi

# 14. Record update-success
log_success "$target_commit" "$prev_commit"
printf '%s\n' "MAW update staged successfully ($target_commit)."

# 15. Restart handling
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
  printf '%s\n' 'Update staged. Restart MAW manually with: maw restart'
  exit 0
fi

printf '%s\n' 'Server-owned live PTYs will terminate. Metadata and native history remain.' >&2
printf '%s\n' 'Eligible verified native conversations use replacement PTYs during recovery.' >&2

if is_inside_maw; then
  printf '%s\n' 'Restarting MAW from inside MAW. Your current terminal session will be interrupted. Use maw status to verify.' >&2
  systemd-run --user --unit="maw-restart-$(date +%s)" --no-block \
    --description="MAW safe restart after update" \
    --on-active=2 \
    systemctl --user restart maw.service
else
  systemctl --user restart maw.service
fi

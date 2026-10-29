# MAW Update and Rollback Guide

This guide details the release-staging architecture, state boundaries, safety guarantees, automated fallbacks, and executable recovery procedures for the `maw update` command.

Repository location: `/home/alteixeira20/Projects/My-Amazing-Workspace`  
Releases directory: `~/.local/share/maw/releases`  
Active release pointer: `~/.local/share/maw/current` (symlink)  
Previous release pointer: `~/.local/share/maw/previous` (symlink)  
Update audit log: `~/.local/share/maw/update-log.jsonl`  
Service name: `maw.service`

---

## Verified Release-Staging Architecture

`maw update` implements an isolated release-staging model that completely separates candidate release builds from both the live running service and the developer's source repository.

### Key Architectural Principles
1. **Developer Worktree Immutability**:
   - `maw update` **never** executes destructive git commands (`git reset --hard`, `git checkout -- .`) against the developer's active source repository or worktree.
   - Candidate releases are built in separate, immutable directories (`~/.local/share/maw/releases/<release-id>`) using detached Git worktrees.
   - Even if concurrent modifications or uncommitted edits take place in the developer's checkout during update staging, those modifications survive completely untouched.
2. **Zero In-Place Dependency or Asset Replacement**:
   - The running server runs out of `~/.local/share/maw/current` (an atomic symlink pointing to an immutable release directory).
   - Candidate releases install their dependencies (`pnpm install --frozen-lockfile`) and build frontend bundles (`pnpm build`) entirely inside the candidate directory.
   - Assets and dependencies currently loaded or served by the live server are never overwritten or deleted while running.
3. **Explicit and Verified Update Source**:
   - Update target ref is explicitly determined (default: `origin/main` or verified tracking upstream; customizable via `--ref <ref>`).
   - Arbitrary uncommitted branches or detached development states are never accidentally deployed.
4. **Git Worktree Compatibility**:
   - Both standard Git repositories (with `.git` directories) and linked Git worktrees (with `.git` files) are supported natively using Git inspection commands (`git rev-parse --is-inside-work-tree`, `--show-toplevel`, `--git-dir`).
   - If an invalid repository path is detected, the updater refuses execution rather than silently falling back to an unexpected directory.

---

## State Boundaries: What `maw update` Touches vs. Preserves

### What `maw update` Preserves
- **Developer Source Checkouts and Worktrees**:
  - The working directory, staged index, stash, untracked files, and local branch pointers are never reset or cleaned up.
- **Application Configuration**:
  - Main configuration root at `~/.config/agent-workbench/` (or designated `$XDG_CONFIG_HOME` path).
  - Profile settings and arguments in `agency-profiles.json`.
  - Native identity mappings in `agency-native-identities.json`.
- **Workspaces and Session Metadata**:
  - `agency-workspaces.json`: All workspace configurations, project assignments, tab order, and active tab selections.
  - `agency-sessions.json`: Historical tab associations, session IDs, and persistent terminal/agent references.
- **Native Authentication & Provider Storage**:
  - Codex configuration and conversation state (`~/.codex*`).
  - Antigravity / AGY profiles, conversation trees, and settings (`~/.gemini/antigravity-cli`, `~/.local/share/agy*-profile/`).
  - Claude Code state directories (`~/.claude/`).
  - System keyrings, GNOME Keyring daemon, and D-Bus session helpers.
- **Running Server State (with `--no-restart`)**:
  - The active server process continues serving existing loaded modules and active PTYs without disruption until an explicit restart.

---

## Automated Safety and Rollback Behavior

During execution, `maw update` enforces strict pre-flight and staging gates:

| Stage | Safety Gate | Behavior on Failure |
| --- | --- | --- |
| Pre-flight | `git status --porcelain` | **Refuses execution.** Alerts developer to uncommitted changes. Developer worktree is untouched. |
| Divergence Check | Upstream comparison | **Refuses execution.** Prevents orphaning local commits or pulling non-fast-forward diverged history. |
| Runtime Check | Node version vs engines | **Refuses execution.** Validates runtime version compatibility before staging. |
| Isolated Staging | `git worktree add --detach` | Builds candidate in `~/.local/share/maw/releases/<release-id>`. |
| Dependencies & Build | `pnpm install`, `typecheck`, `build`, tests | **Candidate Discarded.** If any build/test step fails, the candidate directory is deleted. Developer worktree and running server remain untouched. |
| Activation | Service readiness probe | **Automatic Rollback.** If replacement service fails readiness probe within timeout, symlink `current` reverts to `previous` and service restarts. |

---

## Executable Rollback Procedures

### Automated Rollback (Activation Failure)
If `maw restart` (or `maw update --restart`) fails to achieve readiness on the replacement service:
1. `maw-restart-helper.sh` detects failure during loopback token/readiness polling.
2. It inspects `~/.local/share/maw/previous`.
3. It atomically reverts `~/.local/share/maw/current` to point to the previous verified release.
4. It restarts `maw.service` with the verified previous release and re-verifies readiness.
5. Audit logs in `~/.local/share/maw/update-log.jsonl` record the activation failure and rollback result.

### Manual Rollback Procedure
If regressions are discovered after a successful update and restart, rollback to the previous verified release immediately:

```sh
# 1. Inspect active and previous release pointers
ls -l ~/.local/share/maw/current ~/.local/share/maw/previous

# 2. Atomically revert 'current' to the previous release
ln -sfn "$(readlink -f ~/.local/share/maw/previous)" ~/.local/share/maw/current.tmp
mv -Tf ~/.local/share/maw/current.tmp ~/.local/share/maw/current

# 3. Restart the service safely
maw restart

# 4. Verify healthy operation
maw status
maw url
```

Notice that this manual rollback does not modify git or rebuild packages: it simply switches the release symlink pointer and restarts the service in milliseconds.

---

## Recovery from a Service Failure or Crashed State

If an update or service crash leaves `maw.service` in a failed state:

1. **Check Failure State**:
   ```sh
   maw status
   maw logs
   ```
2. **Clear Transient Rate Limits**:
   If systemd applied start rate-limiting:
   ```sh
   systemctl --user reset-failed maw.service
   ```
3. **Clear Stale Runtime Locks**:
   If a dead process left a stale readiness or restart lock:
   ```sh
   rm -f "${XDG_RUNTIME_DIR:-/tmp}/maw/maw-ready.json"
   rm -f "${XDG_RUNTIME_DIR:-/tmp}/maw/restart.lock"
   ```
4. **Restore Previous Release Pointer**:
   ```sh
   if [ -L ~/.local/share/maw/previous ]; then
     ln -sfn "$(readlink -f ~/.local/share/maw/previous)" ~/.local/share/maw/current.tmp
     mv -Tf ~/.local/share/maw/current.tmp ~/.local/share/maw/current
   fi
   ```
5. **Start and Verify**:
   ```sh
   maw start
   maw status
   ```

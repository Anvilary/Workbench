# MAW Update and Rollback Guide

This guide details the state boundaries, safety guarantees, automated fallbacks, and manual recovery procedures for the `maw update` command.

Repository location: `/home/alteixeira20/Projects/My-Amazing-Workspace`  
Update audit log: `~/.local/share/maw/update-log.jsonl`  
Service name: `maw.service`

---

## State Boundaries: What `maw update` Touches vs. Preserves

`maw update` operates strictly within the application source tree and package build artifacts. It isolates runtime data, persistent configurations, and native provider authentication from the upgrade lifecycle.

### What `maw update` Preserves
- **Application Configuration**:
  - Main configuration root at `~/.config/agent-workbench/` (or designated `$XDG_CONFIG_HOME` path).
  - Profile settings and arguments in `agency-profiles.json`.
  - Native identity mappings in `agency-native-identities.json`.
- **Workspaces and Session Metadata**:
  - `agency-workspaces.json`: All workspace configurations, project assignments, tab order, and active tab selections.
  - `agency-sessions.json`: Historical tab associations, session IDs, and persistent terminal/agent references.
- **Native Authentication & Provider Storage**:
  - Codex configuration and conversation state (`~/.codex`, `~/.codex-ar`, `~/.codex03`, etc.).
  - Antigravity / AGY profiles, conversation trees, and settings (`~/.gemini/antigravity-cli`, `~/.local/share/agy*-profile/`).
  - Claude Code state directories (`~/.claude/`).
  - System keyrings, GNOME Keyring daemon, and D-Bus session helpers.
- **Runtime Environment**:
  - Any environment variables configured in systemd unit overrides or shell profiles.

### What `maw update` Does NOT Touch
- **The Running Server (Until Explicitly Restarted)**:
  - If executed with `--no-restart`, the running server process continues serving existing loaded in-memory JavaScript and PTY connections without disruption.
  - Even if dependencies are re-installed or frontend bundles recompiled, the running Node.js process does not reload until `maw restart` is triggered.
- **Provider Credentials**:
  - MAW never copies, imports, decrypts, or writes provider authentication tokens, API keys, or keyring secrets during updates.
- **Durable Provider History**:
  - Provider session transcripts and conversation databases remain strictly in provider-native directories, outside the MAW git repository.

---

## Automated Safety and Rollback Behavior

During execution, `maw update` guards against corruption at multiple stages:

| Stage | Safety Gate | Behavior on Failure |
| --- | --- | --- |
| Pre-flight | `git status --porcelain` | **Aborts immediately.** Update refuses to run if uncommitted, modified, or untracked files are detected. |
| Divergence Check | Upstream comparison | **Aborts immediately.** Refuses if local commits exist that are not on upstream. |
| Fetch & Merge | `git merge --ff-only` | **Aborts immediately.** Never creates merge commits or resolves merge conflicts. |
| Dependency Install | `corepack pnpm install --frozen-lockfile` | Fails closed if `pnpm-lock.yaml` is out of sync or missing packages. |
| Verification | `pnpm typecheck`, tests, `pnpm build` | **Automated Rollback Triggered.** |

### The Automated Rollback Sequence
If `pnpm typecheck`, profile tests, or `pnpm build` fail after git has merged new commits:
1. The script immediately executes:
   ```sh
   git reset --hard "$prev_commit"
   corepack pnpm install --frozen-lockfile
   corepack pnpm build
   ```
2. The working directory and bundle artifacts are restored to the exact state corresponding to `$prev_commit`.
3. An audit failure entry is recorded in `~/.local/share/maw/update-log.jsonl`.
4. The running service is **not restarted**, allowing live sessions to continue operating without interruption.

---

## Manual Rollback Procedure

If an update succeeds in building, but unexpected regressions are discovered after restarting, or if an automated rollback was aborted externally, follow this manual rollback procedure:

### Step 1: Identify the Previous Good Commit
Inspect the update log to find the previous commit hash (`prev_commit`):
```sh
tail -n 5 ~/.local/share/maw/update-log.jsonl
```
Example log entry:
```json
{"timestamp":"2026-10-29T00:30:00Z","event":"update","prev_commit":"be67f1b","target_commit":"a1c2d3e","status":"success","restarted":false}
```

Alternatively, inspect git reflog:
```sh
git -C /home/alteixeira20/Projects/My-Amazing-Workspace reflog -n 5
```

### Step 2: Roll Back the Git Working Tree
Reset the repository to the identified previous commit:
```sh
git -C /home/alteixeira20/Projects/My-Amazing-Workspace reset --hard <prev_commit>
```

### Step 3: Reinstall Dependencies and Rebuild
Ensure package-lock alignment and build clean production bundles:
```sh
cd /home/alteixeira20/Projects/My-Amazing-Workspace
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

### Step 4: Restart the Service (If Needed)
If the service was already running the newer code, restart it to load the rolled-back build:
```sh
maw restart
```

Verify that the service is running normally:
```sh
maw status
```

---

## Recovery from a Failed Update that Left the Service Stopped

If an update or restart failed mid-operation and left `maw.service` in an inactive or failed state, use the following recovery steps:

### 1. Inspect Service Failure and Logs
Check systemd unit status and recent logs to diagnose the failure:
```sh
systemctl --user status maw.service
maw logs
```

### 2. Reset Systemd Failure Rate Limits
If systemd has placed `maw.service` in a rate-limited backoff state (`start-limit-hit`):
```sh
systemctl --user reset-failed maw.service
```

### 3. Clear Stale Runtime Readiness Files
If an unexpected server crash occurred, verify whether stale runtime files exist:
```sh
ls -la "$XDG_RUNTIME_DIR/maw/"
```
If `maw-ready.json` points to a dead PID (verified with `ps aux | grep node`), remove stale locks:
```sh
rm -f "$XDG_RUNTIME_DIR/maw/maw-ready.json"
```

### 4. Restore Stable Commit and Rebuild
Execute the rollback steps:
```sh
cd /home/alteixeira20/Projects/My-Amazing-Workspace
git reset --hard <prev_commit>
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

### 5. Start the Service and Verify Health
```sh
maw start
maw status
```
Confirm the output indicates:
```text
ActiveState=active
SubState=running
Healthy; PID <pid>; loopback port <port>
```
Once healthy, re-open the UI using `maw open` or retrieve the loopback URL via `maw url`.

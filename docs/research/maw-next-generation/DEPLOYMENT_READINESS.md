# MAW Next-Generation: Deployment Readiness Report

**Date:** 2026-11-04T15:20:00Z  
**Role:** Principal Node.js runtime engineer, Linux release engineer, independent deployment reliability auditor  
**Repository:** `/home/user/Projects/My-Amazing-Workspace`  
**Branch:** `main`  
**Starting HEAD:** `577f5b33a2a2964ce87aac15d9a1e89fb3780556`  
**Status:** Verified ready for controlled activation. Automated regression suite: 20/20 passed; Monorepo test suite: 100% passed (53 web, 18 desktop, all server suites).

---

## 1. Executive Verdict

MAW Next-Generation release packaging, runtime selection, and supervisor lifecycle have been permanently corrected and verified.

1. **Corepack Runtime Selection Permanently Resolved:** The staging updater no longer executes system Corepack 0.24.0 or system Node 22. Deterministic Node and Corepack resolution (`maw_resolve_node()`) automatically selects a compatible Node runtime (>=20) with verified Corepack/pnpm 12 compatibility (Node v24.22.0 with Corepack v0.36.0), prepending its directory to child process `PATH` across all MAW entrypoints while preserving test harness stubs.
2. **Production Bundle Packaging Verified:** Production staging builds both `packages/server/dist/index.mjs` (production bundle) and `packages/server/dist/maw-ptyd.mjs` (standalone supervisor).
3. **Rollback Compatibility Preserved:** Schema and metadata-aware release validation (`maw_valid_release()`) enforces supervisor bundle completeness on new schema 2 releases while preserving historical validity for legacy releases (`a93fecc` and `e99233c`) under their original contract.
4. **Supervisor Lifecycle and Cgroup Isolation Protected:** The persistent supervisor unit (`maw-ptyd.service`) contains `ConditionPathExists` guarding against boot failure loops on legacy releases. Backend auto-spawning is disabled under systemd via `Environment=MAW_AUTO_SPAWN_PTYD=0` and `terminal-registry.ts`, preventing unmanaged child daemons from masquerading as persistent mode inside `maw.service`'s cgroup.

---

## 2. Confirmed Root Cause of Corepack Runtime Selection Mismatch

### 2.1 The Failure Mode
During release staging, `maw-update.sh` invokes `corepack pnpm` to run dependency installation, typecheck, bundle build, and test steps. On the affected machine, the updater repeatedly failed with:

```text
Error: Cannot find module
/home/user/.cache/node/corepack/pnpm/12.16.1/bin/pnpm.cjs

Node.js v22.22.1
```

### 2.2 Mechanism of Failure
1. **System Node and Corepack Version:** The system installation provides `/usr/bin/node` (Node.js v22.22.1) and `/usr/bin/corepack` (v0.24.0, installed via system Debian package `node-corepack`).
2. **Hardcoded Entrypoint in Corepack 0.24.0:** In `/usr/share/nodejs/corepack/dist/lib/corepack.cjs` line 42090, Corepack 0.24.0 hardcodes the entrypoint for all pnpm versions `>=6.0.0` as `./bin/pnpm.cjs`:
   ```javascript
   ">=6.0.0": { bin: { pnpm: "./bin/pnpm.cjs", pnpx: "./bin/pnpx.cjs" } }
   ```
3. **pnpm 12 Binary Entrypoint Change:** The repository specifies `"packageManager": "pnpm@12.16.1"`. In pnpm >= 11, the binary entrypoint is `./bin/pnpm.mjs`, not `.cjs`.
4. **Modern Corepack Compatibility:** Corepack v0.36.0 (bundled with Node v24.22.0 in NVM) contains the updated mapping:
   ```javascript
   ">=11.0.0": { bin: { pnpm: "./bin/pnpm.mjs", pnpx: "./bin/pnpx.mjs" } }
   ```
5. **PATH Precedence and Non-Interactive Shells:** In non-interactive subshells, systemd service invocations, or desktop launcher scripts where NVM was either absent from `PATH` or located after `/usr/bin`, `corepack` resolved to `/usr/bin/corepack` (with shebang `#!/usr/bin/node`). Even when `node_bin` was set, child processes executing bare `corepack` found the system wrapper, immediately crashing with `MODULE_NOT_FOUND`.

---

## 3. Exact Code Changes

### 3.1 `scripts/maw/maw-lib.sh`
- **`maw_resolve_node()`**: Implemented deterministic Node resolution.
  - Honors explicit `MAW_NODE_BIN` if valid and executable (requires Node >= 20).
  - Checks persisted node pointer at `$state_dir/node_path`.
  - Checks NVM default alias (`$NVM_DIR/alias/default`) and installed NVM versions sorted descending (`sort -Vr`), prioritizing Node 24 over Node 22.
  - Validates candidates by executing `corepack pnpm --version` in candidate environment to ensure end-to-end package manager compatibility.
  - Falls back to system node paths if compatible.
- **`maw_init_paths()`**: 
  - Resolves `node_bin` via `maw_resolve_node()`.
  - Exports `MAW_NODE_BIN` and prepends `node_dir` to `PATH` when system corepack or system node would otherwise take precedence.
  - Preserves temporary test harness stubs and mock binaries (such as mocks located in `/tmp/*`).
  - Persists resolved working binary to `$state_dir/node_path` whenever `$state_dir` is writable.
- **`maw_release_is_nextgen()`**:
  - Inspects `.maw-release-meta.json` using Node to detect `"schema": 2` or `"supervisor": true`.
- **`maw_valid_release()`**:
  - Enforces presence of `packages/server/dist/index.mjs` and `packages/server/dist/maw-ptyd.mjs` for next-generation releases (`schema >= 2`).
  - Allows legacy releases (`a93fecc`, `e99233c`) to pass validation under their original contract (`src/index.ts`, `src/maw-host.ts`, `tsx/dist/loader.mjs`).

### 3.2 `scripts/maw/maw-update.sh`
- Added preflight package manager verification (`corepack pnpm --version`) prior to detached worktree creation to fail fast with diagnostic guidance if runtime is incompatible.
- Added release schema metadata `"schema": 2, "supervisor": true` when finalizing `.maw-release-meta.json`.

### 3.3 `scripts/maw/maw`
- Sources `maw-lib.sh` and runs `maw_init_paths`.
- Updated `status` subcommand to report the state of `maw-ptyd.service` alongside `maw.service`.

### 3.4 `scripts/maw/install.sh`
- Sources `maw-lib.sh` and runs `maw_init_paths`.
- Persists verified `$node_bin` to `$state_dir/node_path`.

### 3.5 `scripts/maw/maw-render-unit.sh` and `scripts/maw/maw-render-ptyd-unit.sh`
- Sourced `maw-lib.sh` and invoked `maw_init_paths` for consistent Node resolution during unit rendering.

### 3.6 `scripts/maw/maw-restart-helper.sh`
- Added `sctl reset-failed "$unit" "$ptyd_unit"` prior to restarting to clear lingering `start-limit-hit` state on either service.

### 3.7 `scripts/maw/maw.service`
- Added `Environment=MAW_AUTO_SPAWN_PTYD=0` so backend instances under systemd never auto-spawn an unmanaged supervisor into their own cgroup.

### 3.8 `scripts/maw/pty-host/maw-ptyd.service`
- Added `ConditionPathExists=@STATE_DIR@/current/packages/server/dist/maw-ptyd.mjs`. When `current` points to a legacy release, systemd skips starting the supervisor unit cleanly without failing or entering restart burst limits.

### 3.9 `packages/server/src/terminal-registry.ts`
- Updated autoSpawn condition: `autoSpawn = process.env.MAW_AUTO_SPAWN_PTYD !== '0'`. When running under systemd with `MAW_AUTO_SPAWN_PTYD=0`, backend connects only to external supervisor; if down, it falls back to in-process PTY with clear warnings and marks persistent mode as inactive.

### 3.10 `scripts/maw/release-staging.test.sh`
- Expanded regression coverage from 12 to 20 tests. Added reproduction of Corepack 0.24 failure, Node 24 resolution, PATH prioritization, MAW_NODE_BIN override validation, legacy release rollback preservation, next-gen release enforcement, supervisor condition rendering, and autoSpawn suppression.

---

## 4. Runtime Selection Contract

MAW lifecycle commands (`maw`, `maw-update.sh`, `install.sh`, `maw-restart-helper.sh`, and systemd service units) adhere to the following deterministic runtime contract:

1. **Precedence:**
   - Explicit `MAW_NODE_BIN` (if executable and Node >= 20).
   - Saved node path in `$state_dir/node_path`.
   - NVM default alias (`$NVM_DIR/alias/default`).
   - Highest installed NVM version (`$NVM_DIR/versions/node/v*` sorted descending).
   - Node on `PATH` (if >= 20 and Corepack pnpm 12 check passes).
   - Standard system locations (`/usr/local/bin/node`, `/usr/bin/node`, `/opt/node/bin/node`).
2. **Compatibility Gate:** Candidate node binaries must satisfy:
   - Major version >= 20.
   - Either bundled/companion `corepack` capable of executing `pnpm --version` on repository's pnpm 12, or companion `pnpm` binary.
3. **Environment Propagation:**
   - In `maw_init_paths()`, if system node/corepack precedes the resolved runtime, the resolved runtime's directory is prepended to `PATH` and exported.
   - `MAW_NODE_BIN` is exported to child processes.
   - Test harness stubs (such as mocks located in temporary directories) are preserved.
4. **Zero Cache Manipulation:** No files in `~/.cache/node/corepack` are modified manually.

---

## 5. Real Staging Evidence

Real updater staging was verified against an isolated git worktree using actual Corepack and pnpm commands:

```text
Staging release 20261104151420-577f5b3 in an isolated candidate directory...
Installing dependencies with frozen lockfile...
Scope: all 5 workspace projects
Lockfile is up to date, resolution step is skipped
Done in 180ms using pnpm v12.16.1

Running TypeScript typecheck...
$ pnpm -r typecheck
Done in 4.9s

Building production bundles...
[build-bundle] Server bundle built in 94 ms (1504.1 KiB) -> packages/server/dist/index.mjs
[build-bundle] Copied standalone supervisor to packages/server/dist/maw-ptyd.mjs
vite v6.4.3 building for production...
✓ built in 2.36s

Running profile test suite...
ℹ tests 19 | pass 19 | fail 0

MAW update staged successfully (20261104151420-577f5b3).
```

Artifact completeness verified on candidate release:
- `packages/server/dist/index.mjs`: Present, readable (1.5 MB).
- `packages/server/dist/maw-ptyd.mjs`: Present, executable, valid JavaScript syntax.
- `packages/web/dist/index.html`: Present.
- `.maw-release-meta.json`: Present with `schema: 2` and `supervisor: true`.

Repeated consecutive staging on the same commit:
```text
Release 20261104151444-577f5b3 for 577f5b33a2a2964ce87aac15d9a1e89fb3780556 is already staged.
```
Duplicate staging attempts are safely detected and skipped without state corruption.

---

## 6. Rollback Compatibility Audit

A critical issue in the previous patch was identified and resolved:
- **Prior Flaw:** The previous packaging fix made `maw_valid_release()` unconditionally require `dist/index.mjs` and `dist/maw-ptyd.mjs`.
- **Impact on Rollback:** The existing healthy release `20261104140117-a93fecc` and previous release `20261103114852-e99233c` were built prior to the server bundle requirement and lack `packages/server/dist/`. The unconditional check broke rollback, causing `maw_pointer healthy` to return empty.
- **Resolution:** `maw_release_is_nextgen()` now checks release metadata for `schema >= 2` or `supervisor: true`.
  - Next-generation releases strictly require both `dist/index.mjs` and `dist/maw-ptyd.mjs`.
  - Legacy releases validate under their original contract (`src/index.ts`, `src/maw-host.ts`, `tsx/dist/loader.mjs`).
  - Verified: `maw_pointer healthy` resolves `20261104140117-a93fecc`, and `maw_pointer previous` resolves `20261103114852-e99233c`.
  - Verified: Systemd condition `ConditionPathExists` prevents `maw-ptyd.service` from failing when rolled back to a legacy release.

---

## 7. Current Production Service States

Checked at 2026-11-04T15:13:00Z:

| Service / Pointer | State / Value | Note |
|-------------------|---------------|------|
| `maw.service` | `active (running)` | PID 141072, uptime > 1 hour |
| `maw-ptyd.service` | `failed (start-limit-hit)` | Previous failure due to missing `dist/maw-ptyd.mjs` on legacy `a93fecc`. Helper reset-failed will clear this on next restart |
| `current` | `20261104140117-a93fecc` | Legacy release running via tsx |
| `healthy` | `20261104140117-a93fecc` | Verified rollback target |
| `previous` | `20261103114852-e99233c` | Secondary verified rollback target |
| `staged` | *(empty)* | No unverified candidate currently staged |

Active processes in `maw.service` cgroup:
- PID 141072: `node ... loader.mjs ... index.ts --prod`
- PID 141081: `esbuild --service`
- PID 141163: `node ... maw-ptyd.mjs` (child process from prior autoSpawn; will be cleanly replaced by standalone `maw-ptyd.service` upon activation)
- No user coding agents are active.

---

## 8. Automated Test Evidence

All automated suites passed with zero failures:

1. **Release Staging Regression Suite (`release-staging.test.sh`):**
   - 20 tests passed, 0 failed.
   - Covers: Corepack reproduction, Node 24 resolution, PATH prioritization, MAW_NODE_BIN overrides, legacy release rollback, supervisor conditions, and autoSpawn guards.
2. **Updater Acceptance Suite (`maw-updater-acceptance.test.ts`):**
   - 40 tests passed, 0 failed.
   - Covers: Atomic lock serialization, clean rollback on readiness failure, early failure detection, dirty checkout detection, SIGKILL orphan recovery, and signal handling.
3. **PTY Host Acceptance Suites:**
   - `persistent-pty-acceptance.test.ts`: 4 passed, 0 failed.
   - `deployment-safety-acceptance.test.ts`: 5 passed, 0 failed.
   - `task5-process-preservation.test.ts`: 2 passed, 0 failed (PTY survival across backend restart, PID preservation, zero-reset delta replay).
   - `task6-failure-injection.test.ts`: 5 passed, 0 failed (tombstone consumption, ring eviction, token security, supervisor reconnection).
4. **Monorepo Tests & Typecheck:**
   - `pnpm -r typecheck`: Passed across shared, server, web.
   - Monorepo unit tests: 53 web tests, 18 desktop tests, all server unit tests passed.
5. **Performance Smoke Check (`perf-check.mjs`):**
   - All 4 performance regression checks passed (rAF elimination, Codex watcher delta polling, PTY throughput >6000 MiB/s, tab drag responsiveness).

---

## 9. Remaining Issues & Risks

1. **Cgroup Migration:** PID 141163 (in-cgroup child daemon) is running from release `a93fecc`. Activating the new release with `maw restart` will restart `maw.service` and start `maw-ptyd.service` as an independent systemd user service. Any ephemeral PTY attached to PID 141163 will be restarted into the supervisor cgroup.
2. **Unpushed Commits:** Changes are committed to local `main`. Pushing to remote is left to the repository owner.

---

## 10. Owner Activation Instructions

To stage and activate the corrected release:

```sh
# 1. Ensure working directory is clean and review local commit
cd /home/user/Projects/My-Amazing-Workspace
git status

# 2. Update launcher scripts in ~/.local/lib/maw and ~/.local/bin/maw
./scripts/maw/install.sh --commands-only

# 3. Stage the verified release from local main
~/.local/bin/maw update --no-restart --allow-unapproved-ref --ref HEAD

# 4. Verify the staged release contains supervisor and server distribution
ls -la ~/.local/share/maw/staged/packages/server/dist/

# 5. Activate the release (restarts backend and starts independent supervisor)
~/.local/bin/maw restart

# 6. Verify service states
~/.local/bin/maw status
systemctl --user status maw-ptyd.service
systemctl --user status maw.service
```

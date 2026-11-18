# CI Architecture, Release Readiness, and GitHub Administration Runbook

## 1. CI tiers

The CI workflow uses a read-only repository token. PRs targeting `main` or `develop` automatically run Tier 1. Pushes to those branches and the publish workflow run all tiers.

| Tier | Jobs |
| --- | --- |
| 1 | Linux typecheck and invariant checks, server unit and security, web unit, Electron-free desktop unit, Windows validation, npm build and Node 22 Linux install/start smoke |
| 2 | Server integration and Chromium integration and E2E |
| 3 | Server runtime and release staging, sandboxed Electron suites and Debian package inspection, remaining Node 20/22 Linux/macOS/Windows npm smoke matrix, Android tests/lint/debug APK |

### Maintainer approval

For an additional pre-merge run, dispatch **CI** on the intended branch and enable `run_heavy`. Confirm the resulting run identifies the intended commit. GitHub requires repository write access for workflow dispatch. Fork PRs still receive the automatic Tier 1 check. Use a same-repository review branch for an explicitly approved full run of a fork commit. [GitHub workflow dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

`CI Gate` requires all Tier 1 jobs to succeed. A full run requires every Tier 2 and Tier 3 job to succeed. A fast run accepts skipped optional jobs. The reusable workflow runs the full gate for publish and rehearsal. Publish downloads and reuses the tarball produced and smoke-tested by CI.

### Repository administration

Configure `CI Gate` as the required PR status on the protected branches. If previous workflow job names are required, coordinate migration to the aggregate check when activating this workflow. Keep conditional job names out of the required-check list and verify the gate source is GitHub Actions. Repository settings and npm trusted-publisher registration are administrative tasks.

## 2. Local release checklist

Use disposable HOME and XDG directories and a dedicated Xvfb display. Leave `MAW_UNSAFE_LOCAL_NO_AUTH` and `MAW_REAL_SYSTEMD` unset. Run the following from an isolated checkout.

1. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, and `pnpm check`. The checks include localization and settings compatibility.
2. Run `pnpm test:unit`, `pnpm test:security`, `pnpm test:integration`, `pnpm test:runtime`, `pnpm test:e2e`, and `pnpm test:staging`. Install Playwright Chromium for web integration and E2E.
3. Run desktop `test:security`, `test:e2e`, `test:runtime`, `test:staging`, and `test:production` on an isolated display with the sandboxed Electron runtime. For the Nautilus case, use a separate D-Bus session and set `MAW_NAUTILUS_TEST_ISOLATED=1`.
4. Run `pnpm build:npm` and `node .github/scripts/check-tarball.mjs`. Run `npm pack --pack-destination "$PWD" ./dist-npm` and pass the resulting tarball to `node .github/scripts/smoke.mjs`. The archive includes the standalone PTY supervisor and renderer state module. The check accepts the file manifest formats from npm 10/11 and npm 12.
5. Run `pnpm perf:full` with the built web UI and Chromium. Record the runner, workload, completion metrics, and whether a matched comparison was possible.

The publish workflow uses npm trusted publishing with OIDC. A manual publish dispatch runs the same full CI gate and performs an npm dry run. A version tag additionally requires the tagged version to match `package.json`.

## 3. GitHub Repository Rename / Transfer Runbook (`user/My-Amazing-Workspace` -> `Anvilary/Workbench`)

Do not transfer the GitHub repository until all existing installations have upgraded past the transitional compatibility bridge or you are ready to update the default remote URL.

### Compatibility Invariants Preserved in Code
- **CLI Entrypoints**: Both `anvil-bench` and legacy `maw` / `agent-workbench` binaries are installed and resolve to the same CLI dispatcher.
- **Workspace Package Filter**: Internal monorepo packages retain `@agent-workbench/{shared,server,web,desktop}` so existing installed `maw update` scripts (`pnpm --filter @agent-workbench/server ...`) succeed across the upgrade boundary.
- **Persistent Paths and Identities**:
  - Electron production `userData` and effective `sessionData` use `$XDG_DATA_HOME/maw-desktop` (default `~/.local/share/maw-desktop`) through `scripts/maw/desktop-launch.mjs`. Direct Electron launches honor `MAW_DESKTOP_DATA_DIR` and otherwise use `appData/maw-desktop-prototype`. The prototype wrapper supplies its own disposable Chromium directory.
  - Browser partitions: `persist:maw-chatgpt`, `persist:maw-github`, `persist:maw-perplexity`, `persist:maw-browser` for the `Main` profile, and `persist:maw-profile-<id>-<provider>` for custom profiles.
  - Systemd user unit: `maw.service`.
  - PTY supervisor socket and state dir: `~/.local/share/maw-ptyd` / `$XDG_RUNTIME_DIR/maw-ptyd`.

### Step-by-Step Transfer Procedure (When Authorized)
1. **Pre-Transfer Check**:
   - Confirm no active CI release jobs are running.
   - Verify `Anvilary` GitHub organization exists and has `NPM_TOKEN` configured if org-level secrets are used.
2. **Transfer / Rename on GitHub**:
   - In GitHub Repository Settings -> General -> Danger Zone -> Transfer repository to `Anvilary` and rename to `Workbench` (`https://github.com/Anvilary/Workbench`).
   - GitHub automatically redirects git HTTP/SSH operations from `user/My-Amazing-Workspace` to `Anvilary/Workbench` as long as no new repository is created at the old path.
3. **Update Local and Metadata Remotes**:
   - Update `package.json`, `scripts/build-npm.mjs`, and `scripts/maw/maw-env.sh` (`MAW_REPO_URL` default) to `https://github.com/Anvilary/Workbench.git`.
   - Run `git remote set-url origin git@github.com:Anvilary/Workbench.git` in local checkouts.
4. **Post-Transfer Smoke Test**:
   - Trigger `CI` via `workflow_dispatch` and confirm `CI Gate` passes.
   - Run `maw update --check` / `anvil-bench update --check` in an isolated staging home directory.

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

Before publishing covered binaries or npm packages, verify the exact corresponding source is publicly available, the build matches that revision, and the artifact includes the AGPL license, upstream MIT license, attribution notices and corresponding-source directions. See [LICENSING.md](../../LICENSING.md).

Use disposable HOME and XDG directories and a dedicated Xvfb display. Leave `WORKBENCH_UNSAFE_LOCAL_NO_AUTH` and `WORKBENCH_REAL_SYSTEMD` unset. Run the following from an isolated checkout.

1. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, and `pnpm check`. The checks include localization and settings compatibility.
2. Run `pnpm test:unit`, `pnpm test:security`, `pnpm test:integration`, `pnpm test:runtime`, `pnpm test:e2e`, and `pnpm test:staging`. Install Playwright Chromium for web integration and E2E.
3. Run desktop `test:security`, `test:e2e`, `test:runtime`, `test:staging`, and `test:production` on an isolated display with the sandboxed Electron runtime. For the Nautilus case, use a separate D-Bus session and set `WORKBENCH_NAUTILUS_TEST_ISOLATED=1`.
4. Run `pnpm build:npm` and `node .github/scripts/check-tarball.mjs`. Run `npm pack --pack-destination "$PWD" ./dist-npm` and pass the resulting tarball to `node .github/scripts/smoke.mjs`. The archive includes the standalone PTY supervisor and renderer state module. The check accepts the file manifest formats from npm 10/11 and npm 12.
5. Run `pnpm perf:full` with the built web UI and Chromium. Record the runner, workload, completion metrics, and whether a matched comparison was possible.

The publish workflow uses npm trusted publishing with OIDC. A manual publish dispatch runs the same full CI gate and performs an npm dry run. A version tag additionally requires the tagged version to match `package.json`.

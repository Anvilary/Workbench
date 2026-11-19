# Testing Architecture

All test suites live under package-scoped `tests/` trees grouped by verification tier and domain, keeping source directories focused on production modules.

## Directory Taxonomy

Each testable package (`packages/desktop`, `packages/server`, `packages/web`) organizes suites under `tests/`:

```text
packages/<pkg>/tests/
├── helpers/          # Shared path resolvers (`paths.ts` / `paths.mjs`)
├── fixtures/         # Package test fixtures and harnesses (when applicable)
├── unit/             # Pure module, validation, layout, and state-machine tests
├── integration/      # Multi-module store, protocol, and DOM/React integration tests
├── runtime/          # PTY supervisor, lifecycle, concurrency, and crash recovery tests
├── security/         # Auth, origin/host validation, filesystem isolation, IPC boundary tests
└── e2e/              # Headless Chromium and sandboxed Electron end-to-end acceptance tests
```

## Path Resolution Helpers

Every test tree uses dedicated root helpers (`tests/helpers/paths.ts` for `@agent-workbench/server`, `tests/helpers/paths.mjs` for `@agent-workbench/web` and `@agent-workbench/desktop`) exporting `REPO_ROOT`, package roots (`SERVER_ROOT`, `WEB_ROOT`, `DESKTOP_ROOT`), `SERVER_SRC` / `WEB_SRC`, and `SCRIPTS_MAW_DIR`. Tests never rely on volatile `process.cwd()` lookups or fragile hardcoded depth arithmetic.

## Running Suites

### Root Commands

- `pnpm typecheck`: Type-checks `shared`, `server` (including `tests/**/*.ts`), and `web` (including `tests/**/*.ts`).
- `pnpm test:unit`: Fast pure-Node unit tests across desktop, server, and web (no browser or Electron binary required).
- `pnpm test:integration`: Store, protocol, and integration tests across desktop, server, and web.
- `pnpm test:production`: Ubuntu desktop `.deb` package and launcher integration checks.
- `pnpm test:runtime`: Server PTY supervisor, lifecycle, concurrency, and recovery tests plus desktop resource-pool runtime tests.
- `pnpm test:security`: Server authentication, filesystem isolation, and IPC boundary tests plus desktop browser security tests.
- `pnpm test:e2e`: Headless Chromium web E2E suite and sandboxed Electron desktop E2E suite.
- `pnpm test:staging:shell`: Shell release-staging and activation-guard regression suites.
- `pnpm test:staging`: Shell staging suites plus sandboxed Electron staging-release tests.
- `pnpm test`: Runs default package suites (`desktop`, `server`, `web`).
- `pnpm check`: Runs 32 server invariant check scripts (`packages/server/scripts/check-*.mjs`).
- `pnpm check:e2e`, `pnpm check:systemd`, `pnpm check:package`, `pnpm check:native-context`: Run the remaining browser-backed, real-systemd, npm-package, and operator-context check scripts under `packages/server/scripts/`.

### Environment Notes

- `MAW_UNSAFE_LOCAL_NO_AUTH`: Security and remote-access pairing tests expect token-auth mode unless explicitly testing no-auth behavior; unset `MAW_UNSAFE_LOCAL_NO_AUTH` when running `pnpm check` or server test tiers from a local dev shell where it may be exported.
- `MAW_REAL_SYSTEMD=1`: Enables the 3 live user-systemd tests in `packages/server/tests/runtime/lifecycle/maw-systemd-acceptance.test.ts` (automatically skipped when unset).
- `MAW_TEST_ARTIFACTS_DIR`: Overrides where acceptance UI screenshots are written (defaults under OS `tmpdir()`).

## CI tiers

The [CI and release runbook](./ci-and-release-runbook.md) lists the automatic jobs, full-run authorization and required check semantics. Browser-backed web tests are integration or E2E. The web commands discover tests recursively within each tier, and cap concurrent browser test files to reduce runner contention. Desktop security E2E uses real sandboxed Electron, while its policy and orchestrator unit cases require only Node.

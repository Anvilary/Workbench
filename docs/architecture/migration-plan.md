# Migration Plan and Architectural Roadmap

Anvilary Architecture v1 establishes clear structural boundaries incrementally without interrupting live desktop/PTY deployments or breaking updater compatibility.

## Completed Phases (Milestones 1-6)

1. **Shared Foundations**: Extracted reusable server utilities (`packages/server/src/shared/`) and frontend UI/hook/layout primitives (`packages/web/src/shared/`) with dedicated unit suites.
2. **Frontend Feature Extraction**: Decomposed `SettingsDialog.tsx`, `AgencySidebar.tsx`, `AgencyWorkspaceView.tsx`, and `PaneHeader.tsx` into `packages/web/src/features/{settings,workspaces,browser,panes}/` plus initial barrels for `{terminals,agents,editor}/`.
3. **Backend and Desktop Boundaries**: Extracted `packages/desktop/src/{security,ipc,browser}/` from `main.mjs`, migrated layout/browser-tab/editor-tab stores onto `SerialQueue` + `loadWithBackupRecovery` + `writeSnapshotWithBackup`, and added backend feature barrels under `packages/server/src/features/`.
4. **Hierarchical Test Layout**: Moved all 135 baseline test files (plus 3 fixtures and 3 new unit suites for shared/desktop foundations) into `packages/{desktop,server,web}/tests/{unit,integration,runtime,security,e2e}/` with cwd-independent `tests/helpers/paths.{ts,mjs}` resolvers.
5. **Sharded CI and Documentation**: Reorganized `.github/workflows/ci.yml` into parallel jobs while preserving `workflow_call` for `publish.yml` and added `docs/architecture/`.

## Retained Compatibility Shims and Constraints

- `packages/server/src/agents/profiles/profiles.test.ts` and `packages/server/src/agency/native-context.test.ts` remain 1-line forwarding shims so external scripts targeting the historical paths keep working alongside updated paths in `scripts/maw/maw-update.sh`, `scripts/maw/validate-release.mjs`, and `packages/server/scripts/check-native-systemd.mjs`.
- Package roots (`packages/shared`, `packages/server`, `packages/web`, `packages/desktop`) intentionally stay at `packages/*` until a dedicated updater migration updates `scripts/maw/maw-lib.sh` and live installation checks.

## Optional Follow-Up Work (Not Executed Automatically)

- **Centralized Anvilary UI Package**: Keep frontend primitives copy-local inside `packages/web/src/shared/` until a second Anvilary Tools consumer validates shared versioning needs.
- **Tier 2 Maintainer CI Gating**: Heavy release-gating suites (`desktop-and-browser-e2e`, `smoke`, `android`) currently run cleanly as CI jobs while keeping `workflow_call` compatibility with `publish.yml`. Two optional patterns can gate costly PR runs without losing pre-release verification:
  - **Option A (`workflow_dispatch` + `push` / `workflow_call`)**: Run `desktop-and-browser-e2e`, `smoke`, and `android` on `push`, manual `workflow_dispatch`, and `publish.yml` (`workflow_call`), keeping PR feedback focused on `fast-checks`, `server-runtime-and-integration`, and `package`.
  - **Option B (PR Label Gate)**: Add `if: github.event_name != 'pull_request' || contains(github.event.pull_request.labels.*.name, 'run-e2e')` on heavy matrix/device jobs.
- **Remaining Extraction Candidates**:
  - Continue decomposing `packages/server/src/index.ts` HTTP/WebSocket route registrations into `packages/server/src/features/{workspaces,sessions,agents,settings}/`.
  - Split remaining dialog/controller state inside `packages/web/src/agency/AgencyWorkspaceView.tsx` and `AgencySidebar.tsx` into feature hooks once stabilized.
  - Reconcile pre-existing drifted checks (`inline-rename.test.mjs`, `pane-interactions.test.mjs`, `browser-link-navigation.test.mjs`, `browser-tabs.test.mjs`, `tab-ux-browser.test.mjs`, `pane-inspection.test.mjs`, `terminal-lifecycle.test.mjs`, `scripts/check-settings.mjs` check 4.1, and `.github/scripts/check-tarball.mjs` vs `scripts/build-npm.mjs` `dist/maw-ptyd.mjs` allowlist) against current product behavior in a dedicated PR.

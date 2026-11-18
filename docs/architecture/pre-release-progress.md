# Anvilary Workbench Pre-Release Implementation Progress

**Integration branch**: `feat/anvilary-pre-release` (branched from `feat/anvilary-workbench-rebrand` `8ee4916`, matching `main` baseline `b1ebaf2`)
**Worktree**: `/home/user/Projects/My-Amazing-Workspace-pre-release`

## Track Status Summary

| Track | Scope | Implementation | Validation | Notes |
| --- | --- | --- | --- | --- |
| A | Rebranding & Internal Naming | In Progress (Phase 1 committed `8ee4916`) | Partial | Evaluating remaining safe internal renames & updater constraints (`maw-update.sh:266`). |
| B | CI, Testing & Packaging Stabilization | Pending (Wave 1) | Pending | Fixing tarball, settings check, i18n, orphaned/broken E2E, `build-bundle.test.ts`, `production.test.mjs`, 3-tier CI. |
| C | Centralized Resource Lifecycle | Pending (Wave 2-3) | Pending | Portal `ModalDialog`, pane close button & confirmation, project cascade delete, leak/race fixes. |
| D | Workspace & Project Drag-and-Drop | Pending (Wave 2-3) | Pending | Fix `model.ts` order sort, `reordered` protocol parsing, flicker/constraint/Escape/auto-scroll. |
| E | Fluid Tab Drag-and-Drop | Pending (Wave 2-3) | Pending | Fix drag-shield `elementFromPoint`, cross-pane spatial drop, variable widths, overflow scroll, split/empty drop. |
| F | Browser Navigation & Picker Refinements | Pending (Wave 3) | Pending | Direct Other URL input, Search Engine direct open, simplified Favorite preview. |
| G | Settings UX & Visual Refinement | Pending (Wave 3) | Pending | Prominent Projects header/`+`, collapsible subsections, search engine delete without BUILT-IN badge, monochrome SVG provider icons. |
| H | Browser Authentication & Profiles | Pending (Wave 2-3) | Pending | Fix ChatGPT OAuth/partition persistence, YubiKey FIDO2 PIN regressions, `Main` + custom/cloned browser profiles. |
| I | Performance & Resource Efficiency | Measuring Baseline | Pending | Baseline -> targeted optimizations -> regression benchmarks. |
| J | Regression Preservation | Pending (Wave 4) | Pending | Full regression sweep + Electron screenshots/recordings. |
| K | Release Engineering | Pending (Wave 4) | Pending | Packaging, installer, upgrade/rollback safety, release candidate verification. |

## Implemented Commits

- `8ee4916` (`feat/anvilary-workbench-rebrand` baseline): Initial Anvilary Workbench user-facing rebranding & `anvil-bench` CLI alias.

## Baseline Known Regressions (Before Wave 1)

- `.github/scripts/check-tarball.mjs`: fails with `Unexpected files in the tarball: dist/maw-ptyd.mjs` (`scripts/build-npm.mjs:75-78` copies `maw-ptyd.mjs` without `terminal-state.mjs`).
- `packages/server/scripts/check-settings.mjs`: Check 4.1 fails because expected status shape omits `browser`.
- `packages/server/scripts/check-i18n.mjs`: 11 failures (`B2` 8 locales missing `agency.terminal.*` search keys, `C1` 23 unused keys, `C4` missing `{ name }`, `L1` 42 JSX literals).
- `packages/server/tests/unit/shared/build-bundle.test.ts`: fails on clean checkout before `pnpm build` (spawns `--prod` without `packages/web/dist`).
- `packages/desktop/tests/integration/desktop/production.test.mjs`: missing `.deb` pre-build in standalone run and missing `pathToFileURL` import at line 51.
- 7 un-CI'd Web test files (`inline-rename`, `browser-tabs`, `tab-ux-browser`, `pane-inspection`, `pane-interactions`, `terminal-lifecycle`, `browser-link-navigation`) failing + 4 orphaned tests (`inline-rename`, `pane-interactions`, `browser-link-navigation`, `scripts/maw/release-staging.test.sh`).
- `.github/workflows/ci.yml`: runs `test:unit` before `build`, omits Linux `pnpm check`, duplicates desktop/web tests, runs heavy E2E/smoke/Android automatically on PRs.
- ChatGPT login persistence: `open()` reloads non-durable auth URLs mid-flow; `authHosts` misses `login.microsoft.com`; `chat.openai.com` clipboard/media mismatch; no `cookies.flushStore()` on auth commit.
- YubiKey FIDO2 PIN: `webauthn-backend.mjs` omits `proc.stdin.end()` after writing PIN; single-attempt PIN dialog; resident cred ID fallback overwrites `credentialId`; single device/credential attempt; popup dialog `paneBounds` uses main-window coordinates.
- No hardware YubiKey available in isolated test environment (physical tap/PIN end-to-end with real hardware must be explicitly documented alongside mocked/IPC tests).

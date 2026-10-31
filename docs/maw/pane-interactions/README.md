# Pane interactions acceptance

These captures show the actual `AgencyWorkspaceView`, pane headers, xterm and Electron WebContentsViews, using production CSS. All pages, session records and profiles are synthetic. No authenticated ChatGPT profile, owner workspace data or production service was used.

- [Add menu over a native page](01-add-menu.png)
- [Terminal created in the right pane](02-terminal-in-right-pane.png)
- [Lightweight drag preview and landing target](03-pane-landing.png)
- [Completed left/right swap](04-panes-swapped.png)
- [Diagonal swap in a 2×2 grid](04-grid-swapped.png)
- [Asymmetric four-pane swap](04-asymmetric-swapped.png)
- [Native content restored after swapping and resizing](05-native-content-restored.png)
- [Short interaction recording](pane-interactions.webm)

The recording includes opening the add menu, creating a terminal, canceling a drag, dropping outside, and a successful swap. The floating card contains header text only. Native page bitmaps exist in memory during menus/drag animation; normal operation never writes those bitmaps to disk. The screenshots and recording in this directory are explicit synthetic acceptance evidence.

## Validation

On Linux with Chromium sandboxing enabled:

- `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, `pnpm check`: passed. The build reports the existing large-chunk warning; check-docs skips its absent internal guide.
- Agency/server suites: 171 passed with `--test-concurrency=1`, including shared tree operations, ownership, durable layout reload, delayed creation, terminal lifecycle, activity and notification semantics.
- Frontend interaction/regression suites: 40 passed, including real component/CSS menu hit testing, focus races, delayed snapshots, keyboard movement, all tree shapes, tab dragging, dividers, reduced motion, and stable document/window listener counts.
- Model suite: 13 passed, including retaining creation responses across stale snapshots.
- Electron acceptance/regression suites: 19 passed, with actual `xdotool` mouse drags across native surfaces; Terminal + native page, CLI + native page, two native pages, four mixed panes, four native pages, and asymmetric four native panes. Clipboard, downloads, focus, repeated swaps, cancel/outside releases, sandbox policy and cold desktop restart passed.
- A real isolated `/bin/sh` PTY retained its PID, scrollback, selection, viewport and single attachment through repeated native-surface swaps.

The initial parallel domain run intermittently hit the unchanged runtime test's asynchronous exit-code assertion (`null` versus `7`). The complete serial domain run passed all 171 tests. Legacy browser fixtures now use the current pane-header selectors and re-read tab bounds after reordering; the lifecycle fixture waits for the existing 60ms initial terminal fit before seeding user scroll state.

## Reproduce

Use a disposable Linux display, an installed Electron sandbox helper with its required ownership/mode, and temporary test profiles:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm check
pnpm --filter @agent-workbench/server exec tsx --test --test-concurrency=1 src/agency/split-layout.test.ts src/agency/tab-coordinator.test.ts
node --test packages/web/src/agency/split/pane-interactions.test.mjs
DISPLAY=:107 MAW_PANE_EVIDENCE_DIR="$PWD/docs/maw/pane-interactions" \
  node --test --test-concurrency=1 packages/desktop/pane-interactions.test.mjs
```

The desktop test always creates and removes its own temporary data directory. Its HTTPS protocol handler supplies deterministic native fixture pages; it does not inject scripts into ChatGPT. A separate sandboxed Electron process is used for each scenario.

Authenticated live ChatGPT login/navigation has not been validated here. Persistence is covered by real desktop cold restart and backend file reload, not by rebooting the laptop or restarting the production service. Whole-pane movement is deliberately disabled while maximized; restore the layout first.

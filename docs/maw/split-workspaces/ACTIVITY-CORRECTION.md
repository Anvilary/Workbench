# Final multi-pane activity correction

PR #24, branch `feat/maw-split-workspaces`. Builds on reviewed commit
`8cfd535658a36b18f855f3f4385b2e3fe35b021e`. Validation date: 2026-10-31.

## Behavior

`AgencyWorkspaceView` tracks displayed tab IDs in a set, independently of the
focused pane. One pane reporting ready or hidden cannot overwrite another pane's
readiness. The focused pane's selected tab is synchronized through the existing
`agency.tab.action` select or `agency.webTab.select` operation.

`usePaneInspection` serializes selection and acknowledgement. Focus changes,
disconnects, and unmounts invalidate queued inspections. Acknowledgement requires
a successful selection response, a matching server-selected tab, current display
readiness, a visible document, and finished activity. Successful and in-flight
acknowledgements are deduplicated by workspace, tab, and activity version. Errors
leave completion pending; a current selection failure restores the server-selected
pane and displays the error. The pointer's subsequent focus event cannot retry a
failed selection as part of the same click.

The backend's `AgencyTabCoordinator.inspect` holds the existing workspace
selection mutex across `canInspect` and acknowledgement. Existing workspace,
project, ownership, open-tab, and browser-runtime checks remain in effect.

The split tree, terminal holders, native view registrations, and session lifecycle
are preserved. Focus changes issue selection and layout operations only. Inbox
read state remains independent of task acknowledgement. Existing durable activity
and notification stores remain authoritative after reconnect and restart.

## New regression coverage

- `packages/web/src/agency/split/pane-inspection.test.mjs`: seven Chromium tests
  exercise the actual workspace component and notification hook. Two running
  terminal instances remain attached; background completion stays pending until
  focus; the other pane's activity remains unchanged. Also covers independent
  display readiness, keyboard focus after a pointer releases outside its pane,
  delayed selection responses, an in-flight acknowledgement, selection and
  acknowledgement failures followed by retry, workspace switching during a
  selection, reconnect snapshots, application reload, and two visible ChatGPT
  panes. Reload tests use a synthetic durable server fixture and real frontend
  notification caching.
- `packages/server/src/agency/tab-coordinator.test.ts`: exercises the real
  coordinator, session runtime, activity manager, and disk stores. Unselected,
  foreign-workspace, and inactive-workspace inspection is rejected. A delayed
  acknowledgement blocks a concurrent selection. Only the inspected completion
  becomes idle; the sibling completion and unread notifications survive fresh
  activity and notification store instances.
- `packages/desktop/pane-inspection.test.mjs`: runs the actual workspace component
  in Electron with two synthetic native ChatGPT pages. Ten pane focus changes
  retain both attached WebContents identities, produce one acknowledgement for
  the inspected completion, and cause no further loading, destruction, or renderer
  loss events. Native pages are served by an isolated protocol fixture; this is
  not a live ChatGPT authentication test.

## Validation

Executed from the branch worktree on Linux, Node 24.22.0, Electron 45.2.0 with
Chromium sandboxing enabled. Native pages use disposable `MAW_DESKTOP_DATA_DIR`
profiles, and backend persistence tests use temporary directories. No production
data changes, merge, or deployment were performed.

| Check | Result |
| --- | --- |
| Frontend: agency, split-pane, notification, terminal lifecycle, WebGL | 35 passed, 0 failed, 0 skipped |
| Backend: all agency, browser-tab, and runtime tests | 167 passed, 0 failed, 0 skipped |
| Desktop policy, native smoke, split smoke, download smoke, pane inspection | 10 passed, 0 failed, 0 skipped |
| `pnpm typecheck` | Passed: shared, server, web |
| `pnpm build` | Passed; existing Vite chunk-size warning |
| `pnpm check` | Passed; internal-guide `check-docs` skipped because the guide is absent |
| `git diff --check` | Passed |

Commands from repository root:

```sh
node --test packages/web/src/agency/*.test.mjs packages/web/src/agency/split/*.test.mjs packages/web/src/terminal-webgl.test.mjs
pnpm --filter @agent-workbench/server exec sh -c 'tsx --test --test-concurrency=1 src/agency/*.test.ts src/agency/browser-tabs/*.test.ts src/agency/runtime/*.test.ts'
node --test --test-concurrency=1 packages/desktop/policy.test.mjs packages/desktop/smoke.test.mjs packages/desktop/split-smoke.test.mjs packages/desktop/download-smoke.test.mjs packages/desktop/pane-inspection.test.mjs
pnpm typecheck
pnpm build
pnpm check
git diff --check
```

The recorded backend run used `pnpm exec tsx` from `packages/server`; the command
above preserves that working directory and expands its globs there.

The first broad backend run used default parallelism while the browser, Electron,
build, and repository checks also ran. It reported 166 passed and one failure in
the unchanged runtime test `mixed CLI profiles, repeated profile conversations and
shell tabs coexist; closing one preserves every other PTY`: after a single
`setImmediate`, its exit-code assertion observed `null` instead of `7`. The full
serial backend rerun passed all 167 tests, including that test. No runtime
implementation or existing timing test was changed for this correction.

Synapse and Jev tools were unavailable in this session. Validation used direct
source/diff review and the executable checks above.

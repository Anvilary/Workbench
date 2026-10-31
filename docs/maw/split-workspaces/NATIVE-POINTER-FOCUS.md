# Native ChatGPT pointer focus correction

PR #24, branch `feat/maw-split-workspaces`, following accepted commit
`363b5c8313e5cb066e6104ec26cc08a0001de8bb`. Validated on 2026-10-31.

## Focus path

The Electron main process observes `before-mouse-event` on each managed
WebContentsView. A mouse-down in an attached, current view reports the logical tab
ID captured when that view was created, through the existing restricted bridge's
`focused` state event. The event does not cancel or alter the native input.

Bare WebContents focus events can also occur during attachment or programmatic
focus. They are not treated as user pointer intent. The native event semantics
are documented in Electron's [WebContents API](https://www.electronjs.org/docs/latest/api/web-contents#event-before-mouse-event).

The trusted React layout coordinator accepts focus only for a connected, visible,
registered view. `NativeChatGptView` forwards it to its owning pane's existing
`onFocusPane` handler. Server selection, failure handling, and completed-activity
acknowledgement continue through the accepted `usePaneInspection` mechanism.

Electron tracks the last renderer-requested tab separately from the last reported
native pointer target. Unchanged focus IDs in geometry or overlay layouts cannot
become new focus requests after a native click. A changed renderer focus request
focuses an attached native view only if it does not already have focus. Opening a
view no longer adds an implicit focus request. Programmatic focus does not emit
the native pointer state event.

No new commands, privileges, page preload, page scripts, or external IPC entry
points were added. The existing sender/main-frame/origin checks, command schema,
sandbox, context isolation, navigation allowlists, permissions, shared partition,
and view/session lifecycle remain in place.

## Real Electron regression evidence

`packages/desktop/pane-inspection.test.mjs` uses the actual workspace component,
native layout coordinator, and notification hook. Native HTTPS pages are synthetic
fixtures in temporary desktop profiles. The pointer test runs in a private Xvfb
display and uses `xdotool` OS mouse clicks inside the WebContentsViews, rather than
calling React focus handlers or a test-only focus command.

Assertions cover:

- Two simultaneously attached native views: direct webpage clicks focus pane B,
  then pane A, and select the matching server tab.
- A running terminal and both web panes: clicking webpage content changes focus
  from the terminal to the completed background web tab, produces exactly one
  acknowledgement, and leaves its sibling's activity unchanged.
- Native keyboard input, text selection, copy/paste, and wheel scrolling continue
  to work. Native interaction sends no input to the terminal, whose frontend
  attachment stays unchanged during pane focus changes.
- Divider geometry changes preserve MAW renderer keyboard focus, with no native
  view detach. Actual New CLI and notifications components retain keyboard focus
  while open and after overlay restoration.
- Both native WebContents identities survive clicks, geometry changes, and
  overlays, with no new loading, destruction, or renderer-loss events. Overlay
  occlusion still uses the existing intentional detach/reattach behavior.
- Header-driven programmatic focus produces no native pointer notification;
  React layout echoes and overlays create no focus feedback loop.
- A retained view from an inactive workspace cannot report pointer focus into the
  active workspace. Switching back restores the original native identities.

The frontend coordinator test additionally rejects focus from unknown/foreign IDs
and covered views. Existing lifecycle, activity, notification, persistence,
workspace-isolation, and security tests were rerun.

## Validation

Linux, Node 24.22.0, Electron 45.2.0, Chromium sandbox enabled. Xvfb and xdotool were
already installed; no production data, merge, or deployment was performed.

| Check | Result |
| --- | --- |
| Frontend agency, split-pane, notification, terminal lifecycle, WebGL | 35 passed, 0 failed, 0 skipped |
| Backend agency, browser-tab, activity, notification, ownership, runtime | 167 passed, 0 failed, 0 skipped |
| Desktop policy, smoke, split smoke, downloads, pane inspection | 11 passed, 0 failed, 0 skipped |
| `pnpm typecheck` | Passed: shared, server, web |
| `pnpm build` | Passed; existing Vite chunk-size warning |
| `pnpm check` | Passed; internal-guide check skipped because the guide is absent |
| `git diff --check` | Passed |

Commands from the repository root:

```sh
node --test packages/web/src/agency/*.test.mjs packages/web/src/agency/split/*.test.mjs packages/web/src/terminal-webgl.test.mjs
pnpm --filter @agent-workbench/server exec sh -c 'tsx --test --test-concurrency=1 src/agency/*.test.ts src/agency/browser-tabs/*.test.ts src/agency/runtime/*.test.ts'
xvfb-run -a node --test --test-concurrency=1 packages/desktop/policy.test.mjs packages/desktop/smoke.test.mjs packages/desktop/split-smoke.test.mjs packages/desktop/download-smoke.test.mjs packages/desktop/pane-inspection.test.mjs
pnpm typecheck
pnpm build
pnpm check
git diff --check
```

The first desktop run exposed a download-test readiness assumption: native
attachment alone does not mean its page has finished loading. The download smoke
test now waits for the synthetic ChatGPT URL and completed loading before starting
the download. The production download implementation is unchanged. The complete
desktop suite passed after that correction.

The Electron tests validate native input and lifecycle using synthetic pages;
they do not claim live ChatGPT authentication coverage.

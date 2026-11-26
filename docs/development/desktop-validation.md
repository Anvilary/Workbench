# Ubuntu feasibility validation — 2026-10-30

Recommendation: **go for the desktop feasibility pilot and final owner acceptance;
no-go for production deployment or Neko data retirement yet.** Core website,
login, shared-session persistence and native interaction passed with user
participation. The final source-removal/shortcut/background-management revision
is ready for the owner's manual test; it has automated regression coverage.

## Environment and scope

Ubuntu 26.04.1 LTS, real GNOME Wayland desktop with Xwayland, Node 24.22.0,
Electron 45.2.0, React frontend and the existing separate Node/PTY server.
The branch starts at `origin/main` commit `da1ad38` in an isolated worktree.
The installed systemd service and running production Neko container were never
modified, stopped or deleted. Browser profiles and credentials were not imported,
exported or removed.

The user tested login and interaction in the real desktop window. Early visual
checks also used the desktop. After the user asked about desktop control, input
automation on that desktop stopped. Remaining GUI checks ran on an isolated
Xvfb display. The committed screenshots show a real native Electron window and
live official HTTPS ChatGPT pages on that separate display, with a disposable,
unauthenticated profile. They do not prove authentication and contain no private
conversation history. No ChatGPT DOM scraping or application page injection was used.

## Authentication results, kept separate from synthetic tests

| Check | Evidence/result |
| --- | --- |
| Normal login on the real desktop | User reported successful Google/Apple/Microsoft provider login; the exact provider was not identified. |
| Complete application cold start | The authenticated prototype main process was stopped, its app/backend exited, and fresh processes reopened the same dedicated on-disk profile. User confirmed both ChatGPT views stayed signed in and interaction worked. |
| Shared authentication | User confirmed both views were signed in after that restart. No cookie values were inspected or copied. |
| Integrated saved tabs | User subsequently confirmed both saved ChatGPT tabs were signed in and clipboard operations worked. |
| Synthetic cookie durability | Separate Electron-process test sets a clearly synthetic cookie in a disposable profile, closes the process and reads that one synthetic cookie after a fresh launch. This proves only Chromium storage durability. |
| OS reboot | Not performed. The full process cold-start test passed; reboot/keyring acceptance remains in the final manual checklist. |
| Other login methods | Email/password, passkeys, each individual provider, enterprise SSO and provider-popup variants were not separately certified. Exact allowed auth hosts are listed in the architecture guide. Rejected flows receive no workaround. |

Sessions can expire or be revoked. Authentication is not guaranteed indefinitely.

## Visual and interaction evidence

* [Official ChatGPT in the whole Workbench content pane](evidence/chatgpt.png): one Workbench tab strip, no address bar or streaming controls.
* [Second selected native ChatGPT tab](evidence/second-tab.png): separate WebContents identity and independent saved URL; both pages remain alive.
* [Existing native terminal selected](evidence/terminal.png): the ChatGPT surface is detached, and its page remains alive.
* [Workbench dropdown](evidence/dropdown.png) and [Workbench dialog](evidence/dialog.png): the native surface is detached so HTML controls remain usable.
* [Fullscreen](evidence/fullscreen.png): native content follows the workspace bounds.
* [Brave compatibility fallback](evidence/brave-fallback.png): existing tabs work with an external ChatGPT link; no iframe or Electron bridge.

Live scripted checks waited for authoritative selected-tab state and native
attachment/detachment before capturing the second tab and terminal. Two retained
ChatGPT WebContents identities were observed across tab switches. The automated
Electron fixture also checks exact resized bounds and fullscreen, view retention,
background closure/pruning, sandbox preferences, no website preload, shared session
storage and invalid IPC rejection. The automated native page is a synthetic protocol fixture, independent of provider/network availability. Browser regressions retain mixed ordering,
rename, CLI input, notification safety, reconnect and independent web closure.

Actual typing, scrolling, selection, shared login and clipboard were confirmed by
the user on the real desktop, rather than inferred from the fixture tests. Sidebar
dragging, long streaming generations, all shortcut combinations, screen-scale
variants and final-revision reboot behavior still need owner acceptance.

## Reproducible checks

From the worktree root:

```sh
pnpm typecheck
pnpm build
pnpm check
pnpm --filter @anvilary/workbench-web test:integration
pnpm --filter @anvilary/workbench-desktop test
xvfb-run -a pnpm --filter @anvilary/workbench-desktop test:electron
```

From `packages/server`:

```sh
pnpm test:unit && pnpm test:integration && pnpm test:security
xvfb-run -a pnpm exec tsx scripts/check-maw-integration.mjs
```

Results: typecheck/build/check passed; 26 frontend tests, 154 focused backend/security
tests, four desktop policy tests and the Electron process suite passed. The full
isolated Workbench acceptance script passed real Bash PTY behavior, authenticated HTTP,
notification safety, browser fallback and server-restart restoration. Tests for the
removed streaming controller/viewer were retired; logical persistence, URL
validation and CLI/session tests remain. `check-docs` reports its existing skip
because the internal guide is absent from this checkout. Vite retains its chunk-size
warning. No production CLI session was used by these fixtures.

## Linux memory observations

[Raw simultaneous samples](evidence/memory-comparison.json) were collected from
`/proc/<pid>/smaps_rollup`, summing each unique process tree. Existing browser and
container state was only read. Three samples were taken one second apart; the
following are medians in MiB:

| Group | Processes | Summed RSS | PSS |
| --- | ---: | ---: | ---: |
| Electron: Workbench frontend plus two anonymous official ChatGPT pages | 10 | 1,130.8 | 425.1 |
| Existing idle production Neko container, including its descendants | 22 | 237.1 | 118.1 |
| Existing Brave browser across its current user workload | 25 | 7,638.5 | 5,502.9 |

These are **not equivalent workloads**. The existing Neko container was idle;
Brave had its existing user workload and extensions, not a controlled Workbench-only
session. No page inventory or private browser content was inspected. The common
Node backend is excluded from these browser/container groups. Summed RSS counts
shared pages more than once; PSS is the more useful resident-memory comparison.
These samples do not measure swapped pages or peak usage.

Electron used more PSS than the idle Neko container by itself. A like-for-like
memory advantage over browser+Neko has **not** been demonstrated. No claim is made
that Electron is more memory-efficient. The benefit verified here is native
composition/input and removal of the runtime dependency. Budget a few hundred
MiB for this small desktop workload and remeasure authenticated, active streaming
sessions before production use. Electron's idle CPU snapshot was near zero, but
there is no sustained CPU or latency benchmark.

The pilot loads unvisited tabs lazily, retains visited pages without automatic
reload/eviction, uses normal Chromium background throttling, and caps live native
pages at eight per window. The sidebar/tab metadata remains lightweight. A safe
memory-pressure eviction policy during generation is intentionally not assumed.

To collect fresh samples, use the read-only helper with known root PIDs:

```sh
python3 packages/desktop/tools/measure-memory.py --group desktop:PID --group baseline:PID --samples 3
```

Run with appropriate read permission if another user's/container processes protect
their smaps. The helper never reads command lines, cookies or page content and does
not start/stop applications. Record the actual workloads alongside every result.

## Final owner test

Close the old prototype window when convenient, then run `pnpm desktop` from the
worktree. It reuses `.native-chatgpt-local/` and starts the updated isolated server.
Do not change the installed service. No automated desktop control is needed.

1. Open two saved ChatGPT tabs, verify login, and navigate them independently.
2. Type/select/copy/paste, scroll, and switch through CLI/terminal tabs during a
   response. Check no reload and independent pages.
3. Exercise Ctrl+Tab/Shift+Ctrl+Tab, Ctrl+PageUp/Down, Ctrl+W, F11, sidebar drag,
   menus/dialogs, native desktop notifications and focus after each transition.
4. Close/reopen the app, then reboot when convenient. Verify saved UUID/order/title/
   selection/URLs and authentication, allowing for normal provider expiry.
5. Test a long background response and memory pressure before accepting production
   use. Confirm browser compatibility and selected upload/download policy.

The dedicated profile stays in place. Production cutover and any data removal are
separate actions in the [retirement plan](NEKO-MIGRATION.md).

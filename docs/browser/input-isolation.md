# MAW Input and Session Isolation: Remediation Report

Branch: `fix/maw-input-isolation`
Baseline: `85dd91c745980a9870eb591dc0936b40ce7da86c`
Code HEAD (last code commit): `d870332`
Final HEAD: see the closing note of this report.

## Summary

The reported symptom is characters typed into an embedded ChatGPT page appearing in a terminal of an
inactive Odysseus workspace. **The exact trigger of that event was not reproduced and is not confirmed.**
Real-Electron validation, which is the only way to exercise native WebContentsView focus and OS-level
input-method routing, could not run in the build environment (see "Runtime validation").

What was confirmed, with tests that fail on the baseline and pass after the fix:

1. **Server: missing authorization at the routing boundary.** The WebSocket `input` handler wrote to any
   existing `terminalId` sent by any socket. A stale view, a second window or a remote client could write
   to a PTY it never attached.
2. **Renderer: keyboard-origin data was forwarded without regard to ownership.** `TerminalView` sent every
   xterm `onData` to the PTY whether or not the tab was active, the textarea focused, or the shell document
   had window focus. Key, composition and paste events delivered to a hidden terminal's textarea, or while
   a native view held window focus, produced real PTY input.

Both are fixed. Both are defense in depth against the reported class of failure. Neither is proven to be
the cause of the specific event the user saw.

## Reproduction

All repro work used disposable fixtures. No production MAW, live session or real ChatGPT page was touched.

| Scenario | Layer | Baseline | After fix |
| --- | --- | --- | --- |
| `input` for a terminal the socket never attached | real WebSocket server, registry, PTY | **PTY received the bytes** | dropped |
| `input` after `terminal.detach` | same | **PTY received the bytes** | dropped |
| Another socket attaching a terminal grants this socket nothing | same | **PTY received the bytes** | dropped |
| Keystrokes while the shell document lacks window focus | real xterm in Chromium | **forwarded to PTY** | dropped |
| Key, IME and paste events at a hidden terminal's textarea | real xterm in Chromium | **forwarded to PTY** | dropped |
| Typing, IME and paste into a non-terminal field (browser stand-in) | real xterm in Chromium | no PTY input | no PTY input |
| 12 rapid workspace switches with typing | real `AgencyWorkspaceView` | no leak | no leak |
| Five reconnects, then one keystroke | real `AgencyWorkspaceView` | one input | one input |
| Background output to an inactive terminal | real xterm in Chromium | no input | no input |

The last four rows pass on the baseline as well. They are kept as regression tests, and they are evidence
that those scenarios were not the leak in a plain browser.

## Delivered or merely rendered?

Not measured directly. Reasoned inference: xterm.js does not echo locally. Text appears in a terminal only
when `terminal.write` is called, which happens for `terminal.output` and `terminal.replay` messages the
server sends for that terminal's PTY. Characters showing up at an Odysseus shell prompt therefore most
likely means that PTY received them and echoed them. This is treated as a release-blocking isolation
defect, as instructed, until shown otherwise.

An unresolved question: only the selected workspace's `AgencyWorkspaceView` is mounted (`key={selected.id}`),
so an inactive workspace has no xterm in this renderer. If the Odysseus terminal was on screen, it was not
inactive. If it was not, the input arrived over a different socket (a second MAW window, a remote client or
the Android app). The fix covers both readings, but the answer would narrow the cause. See "Open questions".

## Actual input-routing architecture

```
physical key / IME / paste
  -> OS focus selects ONE Chromium webContents
       shell renderer (MAW UI, xterm)        native WebContentsView (ChatGPT, GitHub, Perplexity)
         xterm hidden textarea                  provider page; keys never enter the shell renderer
           -> TerminalView.onData
           -> connection.send({type:'input', terminalId, data})   (never queued while offline)
           -> WebSocket -> terminal-socket 'input'
           -> registry.write(terminalId) -> PTY
```

- The Electron main process has no code that forwards typed characters. `desktopShortcut`
  (`packages/desktop/main.mjs`) handles only F11, Ctrl+Tab, Ctrl+PageUp/PageDown and Ctrl+W, and sends
  navigation messages. `webContents.focus()` is called on the native view only when the layout focus changes.
- Senders of `type: 'input'` in the web client: xterm `onData` and the Shift+wheel paging handler in
  `TerminalView.tsx`, the classic-UI virtual keys in `App.tsx`, and the paste and interrupt menu actions in
  `SessionPane.tsx`.
- `connection.send` does not queue `input` or `resize` while the socket is down, so stale keystrokes are
  never replayed after a reconnect. `terminal.attach` and `terminal.detach` are queued and the attach is
  re-sent by `onReopen`.
- Before the fix the server authorized nothing beyond "the terminal exists".

## Changes

### Server (`26298c0`)

`terminal-socket.ts` keeps a per-socket `inputGrants` set.

- Added on a successful `terminal.attach`. Removed on `terminal.detach`, on `terminal.close`, and with the
  socket itself, so a reconnect starts with no grants until the view re-attaches.
- `input` for a terminal outside the set is dropped with a debug log and no error, matching how a sleeping
  tab is treated, so a stale keystroke cannot raise a misleading alert.
- The grant is deliberately independent of the output listener. Output backpressure drops and re-attaches
  the listener; tying input to it would swallow Ctrl+C during an output flood.
- Every existing client and test attaches before sending input, so attach was already the de facto
  precondition. This makes it enforced.

### Renderer (`d870332`)

`terminal-input-gate.ts` is a pure module used by `TerminalView.tsx`.

- Keyboard-origin data is detected by gestures on the xterm textarea (`keydown`, `keypress`, `beforeinput`,
  `input`, composition events, `paste`) within a 100 ms window.
- Keyboard-origin data is forwarded only when the tab is active, the textarea is `document.activeElement`
  and `document.hasFocus()` is true. A native view holds focus in another renderer, so the shell document
  reports no focus while the user types there.
- Terminal protocol replies (cursor position, device attributes) and programmatic input are not keyboard
  input and are never blocked, so background CLIs keep working. A test pins this.
- Shift+wheel alternate-screen paging is limited to the active tab.

## Security implications

- No new capability. No new message type, no broadcast and no generic PTY write. The change only narrows
  what an existing message can do.
- The server check is the authoritative boundary. The renderer gate is advisory defense in depth because
  the renderer can be compromised or replaced; only the server grant constrains a rogue client.
- Electron settings are untouched. MAW's own refusal to start without the Chromium sandbox was respected and
  not bypassed.
- Known gap: the grant is per socket, not per user or per workspace. A socket that legitimately attached a
  terminal may type into it, and a remote device keeps whatever access `remoteRefusal` already allows.

## Files modified

- `packages/server/src/terminal-socket.ts`
- `packages/server/src/terminal-input-isolation.test.ts` (new)
- `packages/web/src/TerminalView.tsx`
- `packages/web/src/terminal-input-gate.ts` (new)
- `packages/web/src/terminal-input-gate.test.mjs` (new)
- `packages/web/src/agency/split/terminal-input-isolation.test.mjs` (new)
- `packages/web/package.json` (registers the two web tests in `test`)
- `docs/maw/input-isolation/REMEDIATION_REPORT.md` (new)

Shared-file conflict risk: `TerminalView.tsx` and `terminal-socket.ts` are also touched by terminal rendering,
clipboard and PTY supervisor lanes. Both edits are small and local (an input callback and an `input` case),
so rebases should be mechanical.

## Regression coverage

- `packages/server/src/terminal-input-isolation.test.ts`: three tests on a real WebSocket server, registry
  and raw-mode PTYs that report exactly the bytes they receive. They cover unattached, detached and
  foreign-attached terminals, re-attach, reconnect, and 25 rounds of attach/detach churn across two PTYs.
  All three fail on the baseline.
- `packages/web/src/agency/split/terminal-input-isolation.test.mjs`: six tests on the real
  `AgencyWorkspaceView` and xterm in Chromium. They cover browser focus, lost window focus, hidden terminals,
  IME, paste, protocol replies, rapid workspace switching, reconnect subscription counts and background
  output. Two fail on the baseline.
- `packages/web/src/terminal-input-gate.test.mjs`: four unit tests for the gate.

## Validation results

| Check | Result |
| --- | --- |
| `pnpm typecheck` (shared, server, web) | pass |
| `pnpm build` | exit 0 |
| `packages/web` `pnpm test` | 63 of 63 pass |
| New server test | 3 of 3 pass (3 of 3 fail on baseline) |
| Existing `terminal-lifecycle.test.mjs` | pass |
| Server suite, per file | no change versus baseline (see below) |

The server suite has pre-existing failures in this environment, identical on a clean baseline worktree at
`85dd91c`:

- `build-bundle.test.ts` (1), `local-no-auth.test.ts` readiness script (1), `maw-host.test.ts` (2),
  `pty-host/task5-process-preservation.test.ts` (2) and `pty-host/task6-failure-injection.test.ts`
  (2 failures plus a timeout). The task5 and task6 failures are `connect ENOENT .../ptyd.sock`: the persistent
  PTY supervisor does not start here.
- `maw-updater-acceptance.test.ts` had test failures on baseline that did not reproduce in my tree, so it is
  environment-sensitive.
- A single monolithic `pnpm test` of the server stalled after those failures, so the suite was run per file
  with a hard timeout instead.

## Runtime validation

- **Real Electron: not executed.** Chromium's setuid sandbox cannot start in the build environment
  (`/opt/maw-electron/45.2.0/chrome-sandbox` is owned by `nobody` inside a user namespace, so the SUID
  helper refuses; the same applied to the repo-local Electron binary). MAW refuses to start without the
  sandbox, and I did not weaken that or modify the production Electron install. An unsandboxed attempt was
  authorized for disposable tests only and failed for the same reason.
- Therefore **not validated at runtime**: WebContentsView OS focus handoff, X11 or Wayland key delivery to
  the native view, real input-method engines (ibus, fcitx), and the `before-input-event` path.
- Validated: the real renderer code paths and real server and PTY paths listed above, using Chromium and
  synthetic key, composition and paste events.
- Backend and PTY supervisor reconnection: the supervisor-based tests do not run here. The new tests cover
  socket reconnects. `deployment-safety-acceptance.test.ts` (attach, then input, after reconnect) passes.

## Remaining limitations

1. Root cause of the reported event is unconfirmed. If it was an OS or IME focus-routing fault, the renderer
   gate should now block it, but that has not been shown under Electron.
2. `agent.submit` (the Composer path) and the `SessionPane` paste and interrupt actions are not covered by the
   server grant or the renderer gate. They are explicit UI actions, but they address a `terminalId` as well.
3. The 100 ms gesture window is a heuristic. A protocol reply produced within 100 ms of a keystroke on a
   terminal that does not own the keyboard would be dropped. This only affects a terminal that is already in
   the fault state.
4. `document.hasFocus()` is assumed reliable in the Electron shell renderer and in remote browsers. Mobile
   WebViews were not tested.
5. The original report mentions an inactive workspace. If that terminal was in another window or a remote
   client, the socket grant is the control that applies, and it cannot tell two windows of the same user apart.

## Open questions for the reporter

- Was a second MAW window, a remote device or the Android app open when it happened?
- Was an input method (ibus, fcitx) active, and which display server (X11 or Wayland)?
- Did the stray characters match what was typed in ChatGPT exactly, or were they escape sequences
  (such as `^[[I`, `^[[O` or `^[[...R`)?
- Re-run the Electron smoke tests on a machine with a working SUID or user-namespace sandbox.

## Environment notes

- A stalled `pnpm test` run of the server suite from this session may still be alive. A request to stop it
  was denied by the permission classifier and was not worked around. It belongs to this worktree
  (`My-Amazing-Workspace-input-isolation`) and can be stopped by hand.

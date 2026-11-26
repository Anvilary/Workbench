# Input and session isolation

How keyboard input is routed between embedded browser views and terminals, so that text typed into a browser page can never reach a terminal of another workspace. Related: [tabs](tabs.md), [security](../security/threat-model.md).

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

## Actual input-routing architecture

```
physical key / IME / paste
  -> OS focus selects ONE Chromium webContents
       shell renderer (Workbench UI, xterm)        native WebContentsView (ChatGPT, GitHub, Perplexity)
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

## Security implications

- No new capability. No new message type, no broadcast and no generic PTY write. The change only narrows
  what an existing message can do.
- The server check is the authoritative boundary. The renderer gate is advisory defense in depth because
  the renderer can be compromised or replaced; only the server grant constrains a rogue client.
- Electron settings are untouched. Workbench's own refusal to start without the Chromium sandbox was respected and
  not bypassed.
- Known gap: the grant is per socket, not per user or per workspace. A socket that legitimately attached a
  terminal may type into it, and a remote device keeps whatever access `remoteRefusal` already allows.

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

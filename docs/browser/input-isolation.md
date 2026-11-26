# Input and session isolation

How keyboard input is routed between embedded browser views and terminals, so that text typed into a browser page can never reach a terminal of another workspace. Related: [tabs](tabs.md), [security](../security/threat-model.md).

## Rules

Two controls keep keyboard input out of terminals that do not own it:

1. **Server: authorization at the routing boundary.** The WebSocket `input` message writes only to a
   terminal that the sending socket has explicitly attached. A stale view, a second window or a remote
   client cannot write to a PTY it never attached.
2. **Renderer: keyboard-origin data is gated by ownership.** `TerminalView` forwards xterm `onData` to the
   PTY only when the tab is active, its textarea is focused and the shell document has window focus. Key,
   composition and paste events delivered to a hidden terminal's textarea, or while a native browser view
   holds window focus, are dropped.

The server check is the authoritative boundary; the renderer gate is defense in depth.

## Input-routing architecture

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

## Security implications

- There is no broadcast and no generic PTY write message.
- The server check is the authoritative boundary. The renderer gate is advisory defense in depth because
  the renderer can be compromised or replaced; only the server grant constrains a rogue client.
- Workbench refuses to start without the Chromium sandbox.
- Known gap: the grant is per socket, not per user or per workspace. A socket that legitimately attached a
  terminal may type into it, and a remote device keeps whatever access `remoteRefusal` already allows.

## Known limitations

1. `agent.submit` (the Composer path) and the `SessionPane` paste and interrupt actions are not covered by the
   server grant or the renderer gate. They are explicit UI actions, but they address a `terminalId` as well.
2. The 100 ms gesture window is a heuristic. A protocol reply produced within 100 ms of a keystroke on a
   terminal that does not own the keyboard would be dropped. This only affects a terminal that is already in
   the fault state.
3. `document.hasFocus()` is assumed reliable in the Electron shell renderer and in remote browsers. Mobile
   WebViews were not tested.
4. The socket grant cannot tell two windows of the same user apart.

# MAW Lane B: Terminal Selection and Clipboard Remediation Report

Starting revision: `85dd91c745980a9870eb591dc0936b40ce7da86c`
Branch: `fix/maw-terminal-clipboard`
Target worktree: `/home/user/Projects/My-Amazing-Workspace-clipboard`

## 1. Confirmed Root Causes

During investigation of terminal selection, copy/paste workflows, and interactive CLI sessions (specifically Codex CLI), multiple distinct root causes were identified and isolated:

1. Chromium Clipboard API Document Focus Failure:
   `navigator.clipboard.writeText()` and `navigator.clipboard.readText()` enforce strict Chromium document focus requirements. When a user right-clicks a terminal pane to open `PaneContextMenu`, or clicks an item in the context menu, or interacts with other UI elements, document focus leaves the active terminal or the main document body. Chromium immediately rejects the clipboard promise with `NotAllowedError: Document is not focused`. Because the previous implementation relied solely on `navigator.clipboard`, clipboard writes failed silently or triggered denial errors.

2. Selection Invalidation on Context Menu Invocation:
   When right-clicking to summon `PaneContextMenu`, mouse and focus transitions could trigger unselection or blur events before the user clicked "Copy Selection". `terminal.current?.getSelection()` returned an empty string at the time of the menu click, resulting in no action or false failure.

3. Corrupted Multi-line and Wrapped Output Extraction:
   In `SessionPane.tsx`, buffer extraction iterated over lines and joined them with `lines.join('\n')`. In xterm.js, lines that wrap across viewport boundaries have `bufferLine.isWrapped === true`. Joining wrapped lines with newline characters broke long URLs, terminal commands, base64 blobs, and multi-line agent outputs by inserting spurious line breaks into the copied text.

4. Alternate-Screen Buffer vs Normal Buffer Confusion in Codex Sessions:
   xterm.js maintains two separate buffers: `normal` (with scrollback up to 20,000 lines) and `alternate` (the active viewport grid used by full-screen TUIs such as Codex, htop, less, and vi). The alternate buffer does not retain historical scrollback (`buffer.length === rows`).
   The previous `copy('all')` implementation attempted to copy `term.buffer.normal` whenever `term.buffer.normal.length > term.rows`. When running Codex CLI, this caused MAW to copy stale shell commands executed prior to launching Codex rather than the user's active session content.

5. Ctrl+C Trapping and Interruption Failure:
   In `TerminalView.tsx`, the custom key event handler intercepted `Ctrl+C` whenever `terminal.hasSelection()` was true, but never cleared the terminal selection after copying. As a result, a user who selected text and subsequently pressed `Ctrl+C` to send an interrupt (`\x03`) to a running process was trapped: repeated `Ctrl+C` presses kept copying and never sent `\x03` to the PTY. Furthermore, in alternate-screen applications like Codex, `Ctrl+C` was intercepted instead of passing the interrupt signal to the interactive application.

6. Missing Standard Terminal Emulator Keyboard Shortcuts:
   Standard terminal shortcuts expected by developers were missing or incomplete:
   - `Ctrl+Shift+C`: Standard Linux/Unix terminal copy shortcut.
   - `Ctrl+Shift+V`: Standard terminal paste shortcut to read clipboard and send to PTY.
   - `Ctrl+Shift+A`: Standard select-all shortcut that does not interfere with shell `Ctrl+A` (beginning-of-line or tmux prefix).

7. Missing or Misleading UX Feedback:
   Feedback toasts lacked appropriate localization keys for "Nothing selected", "Clipboard unavailable", and "Available buffer copied". When copying from an alternate-screen buffer, displaying "Copied" falsely implied full scrollback was captured when only the active screen buffer was accessible.

## 2. Exact Files Modified

### Desktop Layer (Electron Main Process and IPC Policy)
- `packages/desktop/policy.mjs`:
  Added strict validation schemas for `write-clipboard-text` (type and string text payload bounded to 25 MB) and `read-clipboard-text` (type only).
- `packages/desktop/policy.test.mjs`:
  Added policy unit tests verifying valid and invalid payloads for clipboard IPC commands.
- `packages/desktop/main.mjs`:
  Implemented IPC handlers for `write-clipboard-text` via `await clipboard.writeText(command.text)` and `read-clipboard-text` via `await clipboard.readText()`.
- `packages/desktop/package.json`:
  Registered `terminal-clipboard.test.mjs` in desktop test script.
- `packages/desktop/terminal-clipboard.test.mjs`:
  Added automated desktop test verifying policy validation and real Electron OS clipboard integration under X11/xvfb.

### Web Layer (Renderer, Terminal Emulation, and UI)
- `packages/web/src/agency/clipboard.ts`:
  Created unified clipboard abstraction helper (`writeClipboard`, `readClipboard`). Prioritizes Electron native IPC bridge (`window.mawChatGpt.command`) when available in desktop environment, respects `isRemoteClient` flag for remote browser sessions, and falls back to standard `navigator.clipboard`.
- `packages/web/src/agency/split/terminal-buffer.ts`:
  Created buffer extraction utility (`extractBufferText`, `isPromptLine`, `extractLastOutput`). Handles wrapped line reassembly, non-breaking space normalization, ANSI escape sequence removal, trailing empty line trimming, shell prompt identification, OSC 133 semantic command markers, and alternate-screen detection.
- `packages/web/src/agency/split/terminal-buffer.test.mjs`:
  Added unit test suite covering prompt detection, wrapped line reassembly, Unicode/emoji handling, empty line trimming, OSC 133 command markers, prompt boundary fallback, and alternate-screen extraction.
- `packages/web/src/agency/split/SessionPane.tsx`:
  - Captures active selection in state upon right-clicking (`handleContextMenu`) so context menu activation preserves highlighted text.
  - Replaced ad-hoc buffer copying with `extractBufferText()` and `extractLastOutput()`.
  - Distinguishes alternate-screen vs normal buffer for `copy('all')` and displays appropriate feedback.
  - Uses `writeClipboard` and `readClipboard` across all pane actions (Copy Selection, Copy All, Copy Last, Copy Absolute Path, Copy Relative Path, Copy File Contents, Paste).
  - Select All refocuses the terminal after invoking `terminal.selectAll()`.
- `packages/web/src/TerminalView.tsx`:
  - Implemented OSC 133 command (`C`) and prompt (`A`) marker tracking via `terminal.parser.registerOscHandler(133, ...)`.
  - Added scoped keyboard shortcuts in `attachCustomKeyEventHandler`:
    - `Ctrl+Shift+A`: calls `terminal.selectAll()`.
    - `Ctrl+Shift+C`: copies selection to clipboard and displays success feedback.
    - `Ctrl+C`: in alternate buffer, passes through to PTY (`return true`); in normal buffer with selection, copies to clipboard, calls `terminal.clearSelection()`, and prevents `\x03`; without selection, passes `\x03` to PTY.
    - `Ctrl+Shift+V`: reads clipboard via `readClipboard` and sends `{ type: 'input' }` to session PTY.
  - Propagates `onClipboardSuccess` and `isRemoteClient` props.
- `packages/web/src/agency/split/terminal-clipboard-acceptance.test.mjs`:
  Added end-to-end browser acceptance tests covering multi-terminal harness, right-click context menu, feedback toasts, wrapped line reassembly, OSC 133 output extraction, and keyboard shortcuts.
- `packages/web/package.json`:
  Registered new test files in web test runner.
- `packages/web/src/i18n/locales/*.json` (9 locales: `de`, `en`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `ru`, `zh-CN`):
  Added translations for:
  - `agency.ui.availableBufferCopied`: "Available buffer copied"
  - `agency.ui.clipboardUnavailable`: "Clipboard unavailable"
  - `agency.ui.nothingSelected`: "Nothing selected"

## 3. Before-and-After Behavior

| Operation | Before Behavior | After Behavior |
| --- | --- | --- |
| Copy Selection (Context Menu) | Failed frequently with `NotAllowedError` because context menu click diverted document focus; selection was lost on right-click blur. | Captures selection at context menu open time; delegates write to Electron native clipboard; preserves mouse selection; displays localized "Copied" or "Nothing selected". |
| Copy Selection (Keyboard) | `Ctrl+Shift+C` was unhandled; fell through or sent escape sequences to shell. | `Ctrl+Shift+C` copies active terminal selection to OS clipboard and shows toast feedback. |
| Ctrl+C in Normal Shell | Intercepted when selection existed, but did not clear selection. Subsequent `Ctrl+C` could not send `\x03` interrupt to runaway commands. | Copies selection and immediately clears selection. Subsequent `Ctrl+C` immediately sends `\x03` interrupt to the PTY. |
| Ctrl+C in Codex / TUI | Intercepted when selection existed, preventing SIGINT/cancellation in Codex CLI. | Alternate screen detects `buffer.type === 'alternate'` and allows `Ctrl+C` to reach the PTY unhindered. |
| Select All | Handled via menu or `Ctrl+A` (which collided with shell line navigation / tmux). Selection did not refocus terminal. | `Ctrl+Shift+A` selects entire buffer (up to 20,000 lines). `Ctrl+A` without shift passes cleanly to shell. Terminal is refocused. |
| Copy All (Normal Shell) | Joined buffer lines with `\n`, inserting invalid linebreaks into wrapped URLs and commands. Trailing blank lines remained. | Reassembles wrapped lines using `bufferLine.isWrapped`; strips trailing empty lines; strips raw ANSI escape sequences; normalizes non-breaking spaces. |
| Copy All (Codex / TUI) | Attempted to copy `term.buffer.normal`, returning stale shell commands from before Codex was launched. | Accurately extracts `term.buffer.active` and notifies user with "Available buffer copied". |
| Copy Last Output | Sliced arbitrary trailing 60 lines regardless of command boundary or wrapped lines. | Deterministic extraction: uses OSC 133 semantic command markers if supported, falls back to prompt boundary detection, or bounded active window for TUIs. |
| Terminal Paste | Only right-click paste or browser paste; `Ctrl+Shift+V` unhandled. | `Ctrl+Shift+V` reads clipboard via native bridge and dispatches `{ type: 'input' }` directly to the session PTY. |
| Feedback Notifications | Missing toasts for empty selections; false success or generic errors when clipboard access was denied. | Clear localized toasts: "Copied" (success), "Available buffer copied" (alternate buffer), "Nothing selected" (empty), "Clipboard unavailable" (failure). |

## 4. Clipboard Architecture

MAW operates as an Electron multi-process application with isolated renderer contexts and optional remote browser clients. The clipboard architecture implements a clean separation of concerns:

```
[Renderer / SessionPane / TerminalView]
                   │
                   ▼
      writeClipboard(text, isRemote)
                   │
       ┌───────────┴───────────┐
       │                       │
 (Desktop Electron)     (Remote Web Client / Fallback)
       │                       │
       ▼                       ▼
mawChatGpt.command      navigator.clipboard.writeText
       │
       ▼ (IPC: validCommand policy check)
[Desktop Main Process: Electron clipboard.writeText]
```

### Security and Isolation Invariants:
1. Strict IPC Payload Validation:
   The Electron main process validates all commands through `validCommand()` in `policy.mjs`. `write-clipboard-text` requires `exact(value, ['type', 'text'])`, ensures `typeof text === 'string'`, and enforces a hard ceiling of 25,000,000 characters. `read-clipboard-text` requires `exact(value, ['type'])`.
2. Text-Only Operation:
   The bridge only reads and writes plain text. No arbitrary system commands, filesystem paths, or executable buffers are accepted.
3. Separation of Copy and Paste:
   Copy operations never dispatch PTY input. Paste operations explicitly read clipboard text and construct an `{ type: 'input', terminalId, data }` message directed solely to the active session's PTY.
4. Remote Client Safety:
   When running as a remote browser client (`isRemoteClient === true`), the desktop bridge is skipped to prevent attempting IPC on non-Electron hosts.

## 5. Selection Handling

Selection handling in `SessionPane` and `TerminalView` now respects both user ergonomics and terminal emulator lifecycle:
- Selection Persistence across Context Menu:
  When a user right-clicks on a terminal, `handleContextMenu` captures `terminal.current?.getSelection()` and stores it in React component state (`contextMenu.selectedText`). When the user clicks "Copy Selection", the handler checks `term.getSelection() || contextMenu?.selectedText`. If text was highlighted at the moment the context menu was triggered, it is preserved even if the terminal canvas loses focus.
- Select All Buffer Scoping:
  `onSelectAll` invokes `terminal.current?.selectAll()` and then calls `terminal.current?.focus()`, ensuring the terminal retains keyboard focus for immediate copying or scrolling.
- Selection Lifecycle and Interrupt Safety:
  In normal-screen buffers, pressing `Ctrl+C` with active selection copies the text to the clipboard and immediately calls `terminal.clearSelection()`. This resets the selection state so subsequent `Ctrl+C` keystrokes immediately fall through and dispatch `\x03` to the running process.

## 6. Alternate-Screen Limitations

xterm.js implements ANSI alternate screen buffer switching (`\x1b[?1049h` and `\x1b[?1049l`):
- Architecture:
  In xterm.js, the alternate screen buffer does not maintain a scrollback history buffer. The buffer length is strictly clamped to the number of visible rows (`buffer.length === rows`).
- Codex Behavior:
  When Codex CLI or other full-screen terminal tools run in alternate-screen mode, prior turns or prompts that have scrolled off the alternate screen grid are not retained in xterm.js memory.
- MAW Truthfulness Guarantee:
  MAW does not invent non-existent history or silently copy stale data from `term.buffer.normal` (which only contains pre-Codex shell history). When `copy('all')` is invoked in an alternate-screen session, MAW extracts the active buffer and informs the user via the localized notification: "Available buffer copied".

## 7. Automated Tests

The implementation is verified by four automated test suites across the desktop and web packages:

1. `packages/web/src/agency/split/terminal-buffer.test.mjs`:
   - `isPromptLine`: Verifies accurate shell prompt detection across bash, zsh, venv, and powerline formats without false-positive matching on percentages or markdown headers.
   - `extractBufferText`: Verifies reassembly of wrapped lines into single logical lines without spurious newlines.
   - `extractBufferText`: Verifies correct handling of multi-byte Unicode strings and emojis.
   - `extractBufferText`: Verifies trimming of trailing empty lines while preserving internal empty lines.
   - `extractLastOutput`: Verifies deterministic extraction using OSC 133 command start markers.
   - `extractLastOutput`: Verifies prompt boundary fallback extraction.
   - `extractLastOutput`: Verifies alternate-screen active buffer extraction.

2. `packages/desktop/policy.test.mjs`:
   - Verifies validation of `write-clipboard-text` and `read-clipboard-text`.
   - Verifies fail-closed behavior for malformed payloads, non-string text, and extraneous properties.

3. `packages/desktop/terminal-clipboard.test.mjs`:
   - Policy schema fail-closed verification.
   - Real Electron clipboard write and independent `xclip -selection clipboard -o` verification under X11/xvfb.

4. `packages/web/src/agency/split/terminal-clipboard-acceptance.test.mjs`:
   - End-to-end browser acceptance test running Playwright headless Chromium.
   - Tests two simultaneous terminals (Shell A and Codex CLI B).
   - Tests right-click context menu, selection persistence, "Nothing selected" toast, "Copied" toast, "Available buffer copied" toast.
   - Tests wrapped URL extraction without artificial linebreaks.
   - Tests OSC 133 semantic command output extraction.
   - Tests `Ctrl+Shift+C`, `Ctrl+C` interrupt preservation, and `Ctrl+Shift+A` select all.

### Test Results Summary:
- `pnpm --filter @agent-workbench/web test`: 61 passing tests (0 failures).
- `xvfb-run -a pnpm --filter @agent-workbench/desktop test`: 33 passing tests (0 failures).
- `pnpm -r typecheck`: Clean (0 type errors across shared, server, web).
- `pnpm build`: Clean production build completed.

## 8. Real Electron Clipboard Verification

Real Electron clipboard operations were verified directly against the host OS clipboard:
- Execution Environment: Electron 45.2.0 under `xvfb-run -a`.
- Independent Verification:
  1. Test process launched Electron desktop instance with sandboxing and isolated test data directory (`mkdtemp`).
  2. Sent `write-clipboard-text` command with test string `MAW-TERMINAL-SELECTION-REAL-CLIPBOARD-OK`.
  3. Executed `xclip -selection clipboard -o` via `child_process.execFileSync` to inspect actual X11 clipboard contents.
  4. Confirmed `xclip` output matched the written text exactly.
  5. Executed `read-clipboard-text` via IPC and confirmed the returned text matched.

## 9. Workspace Isolation Checks

In accordance with Phase 8 requirements and the external Lane C boundary:
- Session-Scoped Actions:
  All clipboard actions in `SessionPane.tsx` operate exclusively on the `session` prop passed to that pane. Context menu callbacks reference `terminal.current` belonging to the specific pane.
- Zero PTY Input from Copy Operations:
  `copy('selection')`, `copy('all')`, and `copy('last')` write exclusively to the clipboard. They never invoke `sendImmediate` or `connection.send` with `{ type: 'input' }`.
- Scoped Keyboard Event Handlers:
  Keyboard handlers are attached via `terminal.attachCustomKeyEventHandler` on the specific `Terminal` instance. They do not attach listeners to `window` or `document`.
- Webview Isolation:
  Terminal keyboard shortcuts do not listen to or intercept keyboard events originating inside embedded browser views (ChatGPT, Perplexity).
- Workspace Switching:
  Panes belonging to background workspaces are not rendered in the active DOM; unmounting clears terminal instance references, preventing stale clipboard target retention.

## 10. Remaining Limitations

1. xterm.js Alternate Buffer Historical Scrollback:
   As documented in Section 6, alternate screen buffers in xterm.js do not maintain historical scrollback. Full historical turns from long-running Codex sessions that have scrolled out of the TUI viewport cannot be retrieved from xterm.js buffer memory.
2. Remote Web Client Browser Permissions:
   When MAW is accessed from a remote web browser rather than the Electron desktop shell, clipboard operations must fall back to `navigator.clipboard`. In remote browsers, document focus and permission prompt restrictions apply.

## 11. Integration Risks

1. Lane C Cross-Workspace Keystroke Routing:
   During workspace review, a known critical defect was noted where typing into an embedded ChatGPT browser view can route characters into an unrelated terminal workspace.
   Investigation confirmed that Lane B's clipboard implementation is strictly isolated to `TerminalView` instance handlers and `SessionPane` context menus. It does not introduce global event listeners or mutate workspace active terminal identity. However, Lane C's remediation remains an external dependency for complete input isolation across workspaces.
2. Desktop Command Surface:
   The addition of `write-clipboard-text` and `read-clipboard-text` to `policy.mjs` expands the Electron IPC surface. Risk is mitigated by strict schema validation (`exact`), type checking, and length bounding (25 MB limit).

## 12. Final HEAD SHA

- Starting revision: `85dd91c745980a9870eb591dc0936b40ce7da86c`
- Commit 1 (Desktop): `39d5d1e2e42d765fe656fa5f4f0393d256877969` (`feat(desktop): add native clipboard IPC bridge and schema validation`)
- Commit 2 (Web): `c7a3a1835560b4594bb80e1b64ff1b55977baee7` (`fix(web): improve terminal selection, buffer extraction, and clipboard reliability`)
- Final implementation SHA: `c7a3a1835560b4594bb80e1b64ff1b55977baee7`
- Delivery documentation commit: see git log on branch `fix/maw-terminal-clipboard`.

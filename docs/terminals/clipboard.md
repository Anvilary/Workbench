# MAW Lane B: Terminal Selection and Clipboard Remediation Report

Starting revision: `85dd91c745980a9870eb591dc0936b40ce7da86c`
Branch: `fix/maw-terminal-clipboard`
Target worktree: `/home/user/Projects/My-Amazing-Workspace-clipboard`

## 1. Confirmed Root Causes

During investigation of terminal selection, copy/paste workflows, interactive CLI sessions (specifically Codex CLI), and selection highlighting lifecycle, multiple distinct root causes were identified and isolated:

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

8. Sticky Selection Highlights and Full-Width Rectangles on Blank Grid Cells:
   In full-screen TUIs like Codex running in the alternate screen buffer, the interface renders prompts near the middle/lower rows, while rows below the prompt down to the terminal floor consist of blank terminal grid cells.
   When a user drags or selects downward across multiple rows:
   - xterm's renderer (`DomRenderer` / `WebglRenderer`) renders every intermediate row across the full terminal width (`0` to `cols`, width: 100%), creating a large visual block covering both text and empty cells.
   - The selection was not cleared after copying via `copy('selection')` or `Ctrl+Shift+C`.
   - Pressing `Escape` did not clear the selection.
   - Clicking in the container letterbox/margin below the terminal rows did not clear the selection.
   Consequently, the highlighted region remained frozen on screen, leading to the reported issue where a large blue highlighted region appeared at the bottom of the Codex pane and obstructed view of other content.

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
  - Automatically clears terminal selection via `term.clearSelection()` upon successful `copy('selection')` to prevent sticky highlight rectangles.
- `packages/web/src/TerminalView.tsx`:
  - Implemented OSC 133 command (`C`) and prompt (`A`) marker tracking via `terminal.parser.registerOscHandler(133, ...)`.
  - Added scoped keyboard shortcuts in `attachCustomKeyEventHandler`:
    - `Escape`: clears active selection immediately via `terminal.clearSelection()`, preventing accidental escape sequences from reaching the PTY.
    - `Ctrl+Shift+A`: calls `terminal.selectAll()`.
    - `Ctrl+Shift+C`: copies selection to clipboard, clears selection highlight via `terminal.clearSelection()`, and displays success feedback.
    - `Ctrl+C`: in alternate buffer, passes through to PTY (`return true`); in normal buffer with selection, copies to clipboard, calls `terminal.clearSelection()`, and prevents `\x03`; without selection, passes `\x03` to PTY.
    - `Ctrl+Shift+V`: reads clipboard via `readClipboard` and sends `{ type: 'input' }` to session PTY.
  - Added `pointerdown` listener on `.terminal-surface` container to clear active selection when clicking the empty letterbox/margin area outside terminal character rows.
  - Propagates `onClipboardSuccess` and `isRemoteClient` props.
- `packages/web/src/agency/split/terminal-clipboard-acceptance.test.mjs`:
  Added comprehensive end-to-end browser acceptance tests covering multi-terminal harness, right-click context menu, feedback toasts, wrapped line reassembly, OSC 133 output extraction, keyboard shortcuts (`Ctrl+Shift+C`, `Ctrl+Shift+V`, `Ctrl+C`, `Escape`), selection highlight DOM verification (`pointer-events: none`), and selection clearing on copy and letterbox clicks.
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
| Copy Selection (Context Menu) | Failed frequently with `NotAllowedError` because context menu click diverted document focus; selection was lost on right-click blur; highlight remained stuck on screen after copying. | Captures selection at context menu open time; delegates write to Electron native clipboard; preserves mouse selection; displays localized "Copied" or "Nothing selected"; clears selection highlight immediately upon successful copy. |
| Copy Selection (Keyboard) | `Ctrl+Shift+C` was unhandled; fell through or sent escape sequences to shell. | `Ctrl+Shift+C` copies active terminal selection to OS clipboard, clears selection highlight, and shows toast feedback. |
| Ctrl+C in Normal Shell | Intercepted when selection existed, but did not clear selection. Subsequent `Ctrl+C` could not send `\x03` interrupt to runaway commands. | Copies selection and immediately clears selection. Subsequent `Ctrl+C` immediately sends `\x03` interrupt to the PTY. |
| Ctrl+C in Codex / TUI | Intercepted when selection existed, preventing SIGINT/cancellation in Codex CLI. | Alternate screen detects `buffer.type === 'alternate'` and allows `Ctrl+C` to reach the PTY unhindered. |
| Escape Key with Selection | Sent `\x1b` escape byte to PTY, risking canceling ongoing command or exiting editor mode while leaving selection highlight active. | Immediately clears active selection via `terminal.clearSelection()` and consumes the key event (`return false`). |
| Clicking Terminal Margin / Letterbox | Click in letterbox area outside active character grid ignored; selection remained active. | Pointer down on container letterbox calls `terminal.clearSelection()`, clearing the highlight. |
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

## 5. Selection Handling and Large Highlight Diagnosis

To address the reported issue regarding large blue highlighted regions at the bottom of Codex terminal panes, the ten specific inspection targets were analyzed and resolved:

### 1. xterm.js Selection Rendering and Selection Lifecycle
- Selection Model: Managed by `SelectionModel` with `selectionStart` `[col, row]` and `selectionEnd` `[col, row]`.
- Mouse Event Lifecycle: In `SelectionService`, primary button (button 0, detail 1) sets `selectionStart` to mouse coordinates, clears `selectionEnd`, and attaches `mousemove` and `mouseup` listeners to `document`. `mousemove` updates `selectionEnd` and schedules a debounced refresh via `requestAnimationFrame`.
- DOM Rendering: By default, xterm uses `DomRenderer`. The selection is drawn inside `.xterm-selection` (`div`), which contains rectangular child divs with explicit pixel `top`, `left`, `width`, and `height`.
- Keyboard Input Clearing: User keystrokes trigger `onUserInput` in `SelectionService`, which immediately calls `this.clearSelection()`.
- Right-Click Preservation: Right-clicking with an active selection preserves `selectionStart` and `selectionEnd` so the context menu can act on the selection.

### 2. Why the Highlighted Region Extends Across the Terminal Width
In xterm's `DomRenderer`:
```ts
// Draw middle rows
const middleRowsCount = viewportCappedEndRow - viewportCappedStartRow - 1;
documentFragment.appendChild(this._createSelectionElement(viewportCappedStartRow + 1, 0, this._bufferService.cols, middleRowsCount));
```
Every intermediate row between `start[1]` and `end[1]` is drawn from column `0` to column `cols` (`width = cols * cellWidth`, i.e., 100% width of the terminal grid).
When a user drags downward across rows, xterm treats the 2D grid as a sequence of fixed-width lines. Consequently, every intermediate line spans the full width of the terminal, even if it contains few characters or is entirely empty.

### 3. Actual Selected Text, Empty Cells, Wrapped Lines, and Boundaries
- Empty Cells in Codex Alternate Buffer: Codex CLI runs in the alternate screen buffer (`\x1b[?1049h`). In Codex, header and conversation lines occupy upper rows, the input prompt is placed in the lower-middle region, and all rows below the prompt down to the terminal bottom (`rows - 1`) are blank grid cells.
- Visual Highlighting vs Text Extraction: When a selection extends downward into these blank rows, xterm renders full-width highlight rectangles across those empty cells. However, when `getSelection()` extracts text, `translateBufferLineToString(y, true)` strips trailing whitespace (`trimRight = true`). Therefore, empty cells on blank rows contribute only empty strings separated by newlines (`\n\n`), NOT garbled or corrupted text.
- Wrapped Lines: On lines where text wraps (`line.isWrapped === true`), xterm highlights across the entire column width up to column `cols` because the logical text wraps directly onto the next line.

### 4. Selection Overlays and Pointer Events
In `DomRenderer` CSS:
```css
.xterm-selection {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  pointer-events: none;
}
```
`.xterm-selection` has `pointer-events: none`. Its child highlight divs do not set `pointer-events: auto`, so they inherit `pointer-events: none`.
Pointer events (clicks, drags, right-clicks) pass directly through the highlight divs to the underlying `.xterm-screen` and terminal elements. The overlay does not physically block clicks or prevent new selections.
The user sensation of "blocking" was caused by visual occlusion: a massive solid slate-blue (`#2f3542`) block covering the bottom rows, combined with sticky selection retention where copying or pressing Escape did not clear the highlight.

### 5. Replacing and Clearing Selections
- Left-Click Clearing: Clicking with button 0 on any character cell dispatches `mousedown` with `detail: 1`, calling `_handleSingleClick()`. This resets `selectionEnd = undefined`, collapsing the selection (`hasSelection` becomes `false`).
- Letterbox Container Click: When clicking outside the character grid in the `.terminal-surface` letterbox margin, the new pointerdown listener calls `terminal.clearSelection()`.
- Escape Key: Pressing `Escape` when `terminal.hasSelection()` is true now calls `terminal.clearSelection()` and returns `false`, immediately dismissing the highlight.
- Copy Actions: Both `Ctrl+Shift+C` and the context menu `Copy selection` action now call `terminal.clearSelection()` immediately upon copying.

### 6. Resizing, Pane Switching, and Workspace Switching
- Resizing: On window or split-pane resize, `FitAddon` recalculates `cols` and `rows`. `DomRenderer.handleResize` reclamps selection coordinates to the new dimensions and redraws the highlight without overflow.
- Pane Switching: `SessionPane` preserves the mounted terminal instance when hidden/unhidden. Active selection state and scroll position are retained without memory corruption.
- Workspace Switching: Switching workspaces unmounts background panes, clearing terminal instance references and preventing cross-workspace selection retention.

### 7. Accessibility of Text Behind or Adjacent to Selection
- Text remains in `.xterm-rows` behind `.xterm-selection`.
- Because `.xterm-selection` has `pointer-events: none`, right-clicking over selected text successfully captures the target and invokes `handleContextMenu`.
- Path candidate detection (`terminalPathCandidate(selection, cwd)`) inspects highlighted text to enable file operations in the context menu.

### 8. Verification of Copy Selection Content
- Verified that `copy('selection')` retrieves only text between `selectionStart` and `selectionEnd`.
- Trailing whitespace on blank rows is trimmed by `translateBufferLineToString(y, true)`.
- Copy operations never copy content from other terminal sessions or outside the active selection range.

### 9. Independent Testing of Ordinary Shell vs Codex TUI
- Ordinary Shell: Linear scrollback buffer; wrapped lines correctly joined by `extractBufferText`; prompt boundary heuristics detect command start/end for `copy('last')`.
- Codex TUI: Fixed-size alternate screen buffer (`buffer.length === rows`); `copy('all')` extracts the active screen and provides truthful user feedback ("Available buffer copied"); `Ctrl+C` passes directly to PTY for Codex interrupts.

### 10. Preserving Standard xterm.js Selection Semantics
- We preserve xterm.js native selection rendering rather than replacing it with fragile custom DOM overlays.
- Standard terminal semantics (drag-to-select, double-click word, triple-click line, click-to-clear) are preserved intact.

## 6. Alternate-Screen Limitations

xterm.js implements ANSI alternate screen buffer switching (`\x1b[?1049h` and `\x1b[?1049l`):
- Architecture:
  In xterm.js, the alternate screen buffer does not maintain a scrollback history buffer. The buffer length is strictly clamped to the number of visible rows (`buffer.length === rows`).
- Codex Behavior:
  When Codex CLI or other full-screen terminal tools run in alternate-screen mode, prior turns or prompts that have scrolled off the alternate screen grid are not retained in xterm.js memory.
- MAW Truthfulness Guarantee:
  MAW does not invent non-existent history or silently copy stale data from `term.buffer.normal` (which only contains pre-Codex shell history). When `copy('all')` is invoked in an alternate-screen session, MAW extracts the active buffer and informs the user via the localized notification: "Available buffer copied".

## 7. Automated Tests

The implementation is verified by automated test suites across the desktop and web packages:

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
   - Tests two simultaneous terminals (Shell A and Codex CLI B in alternate buffer).
   - Tests right-click context menu, selection persistence, "Nothing selected" toast, "Copied" toast, "Available buffer copied" toast.
   - Tests wrapped URL extraction without artificial linebreaks.
   - Tests OSC 133 semantic command output extraction.
   - Tests `Ctrl+Shift+C`, `Ctrl+C` interrupt preservation, `Ctrl+Shift+V` paste, and `Ctrl+Shift+A` select all.
   - Tests selection highlight DOM properties (`pointer-events: none`).
   - Tests `Escape` key dismissing active selection highlight.
   - Tests `Ctrl+Shift+C` copying selection and clearing selection highlight.
   - Tests Context Menu `Copy selection` copying and clearing selection highlight.
   - Tests clicking container letterbox clearing active selection highlight.

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
- Commit 1 (Desktop IPC): `39d5d1e2e42d765fe656fa5f4f0393d256877969` (`feat(desktop): add native clipboard IPC bridge and schema validation`)
- Commit 2 (Web Clipboard & Buffer): `c7a3a1835560b4594bb80e1b64ff1b55977baee7` (`fix(web): improve terminal selection, buffer extraction, and clipboard reliability`)
- Commit 3 (Selection Lifecycle): `183d2d0b57faee480927956fe026e63286b20fc6` (`fix(web): prevent sticky terminal selection highlights and add dismissal controls`)
- Final implementation SHA: `183d2d0b57faee480927956fe026e63286b20fc6`
- Delivery documentation commit: see git log on branch `fix/maw-terminal-clipboard`.

# Terminal selection and clipboard

How terminal selection, copy and paste work in the web terminal (xterm.js) and the desktop shell, and the security invariants of the clipboard bridge. Related: [history](history.md), [persistent PTY supervisor](ptyd.md).

## Clipboard Architecture

Workbench operates as an Electron multi-process application with isolated renderer contexts and optional remote browser clients. The clipboard architecture implements a clean separation of concerns:

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

## Selection Handling and Large Highlight Diagnosis

To address the reported issue regarding large blue highlighted regions at the bottom of Codex terminal panes, the ten specific inspection targets were analyzed and resolved:

### xterm.js Selection Rendering and Selection Lifecycle
- Selection Model: Managed by `SelectionModel` with `selectionStart` `[col, row]` and `selectionEnd` `[col, row]`.
- Mouse Event Lifecycle: In `SelectionService`, primary button (button 0, detail 1) sets `selectionStart` to mouse coordinates, clears `selectionEnd`, and attaches `mousemove` and `mouseup` listeners to `document`. `mousemove` updates `selectionEnd` and schedules a debounced refresh via `requestAnimationFrame`.
- DOM Rendering: By default, xterm uses `DomRenderer`. The selection is drawn inside `.xterm-selection` (`div`), which contains rectangular child divs with explicit pixel `top`, `left`, `width`, and `height`.
- Keyboard Input Clearing: User keystrokes trigger `onUserInput` in `SelectionService`, which immediately calls `this.clearSelection()`.
- Right-Click Preservation: Right-clicking with an active selection preserves `selectionStart` and `selectionEnd` so the context menu can act on the selection.

### Why the Highlighted Region Extends Across the Terminal Width
In xterm's `DomRenderer`:
```ts
// Draw middle rows
const middleRowsCount = viewportCappedEndRow - viewportCappedStartRow - 1;
documentFragment.appendChild(this._createSelectionElement(viewportCappedStartRow + 1, 0, this._bufferService.cols, middleRowsCount));
```
Every intermediate row between `start[1]` and `end[1]` is drawn from column `0` to column `cols` (`width = cols * cellWidth`, i.e., 100% width of the terminal grid).
When a user drags downward across rows, xterm treats the 2D grid as a sequence of fixed-width lines. Consequently, every intermediate line spans the full width of the terminal, even if it contains few characters or is entirely empty.

### Actual Selected Text, Empty Cells, Wrapped Lines, and Boundaries
- Empty Cells in Codex Alternate Buffer: Codex CLI runs in the alternate screen buffer (`\x1b[?1049h`). In Codex, header and conversation lines occupy upper rows, the input prompt is placed in the lower-middle region, and all rows below the prompt down to the terminal bottom (`rows - 1`) are blank grid cells.
- Visual Highlighting vs Text Extraction: When a selection extends downward into these blank rows, xterm renders full-width highlight rectangles across those empty cells. However, when `getSelection()` extracts text, `translateBufferLineToString(y, true)` strips trailing whitespace (`trimRight = true`). Therefore, empty cells on blank rows contribute only empty strings separated by newlines (`\n\n`), NOT garbled or corrupted text.
- Wrapped Lines: On lines where text wraps (`line.isWrapped === true`), xterm highlights across the entire column width up to column `cols` because the logical text wraps directly onto the next line.

### Selection Overlays and Pointer Events
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

### Replacing and Clearing Selections
- Left-Click Clearing: Clicking with button 0 on any character cell dispatches `mousedown` with `detail: 1`, calling `_handleSingleClick()`. This resets `selectionEnd = undefined`, collapsing the selection (`hasSelection` becomes `false`).
- Letterbox Container Click: When clicking outside the character grid in the `.terminal-surface` letterbox margin, the new pointerdown listener calls `terminal.clearSelection()`.
- Escape Key: Pressing `Escape` when `terminal.hasSelection()` is true now calls `terminal.clearSelection()` and returns `false`, immediately dismissing the highlight.
- Copy Actions: Both `Ctrl+Shift+C` and the context menu `Copy selection` action now call `terminal.clearSelection()` immediately upon copying.

### Resizing, Pane Switching, and Workspace Switching
- Resizing: On window or split-pane resize, `FitAddon` recalculates `cols` and `rows`. `DomRenderer.handleResize` reclamps selection coordinates to the new dimensions and redraws the highlight without overflow.
- Pane Switching: `SessionPane` preserves the mounted terminal instance when hidden/unhidden. Active selection state and scroll position are retained without memory corruption.
- Workspace Switching: Switching workspaces unmounts background panes, clearing terminal instance references and preventing cross-workspace selection retention.

### Accessibility of Text Behind or Adjacent to Selection
- Text remains in `.xterm-rows` behind `.xterm-selection`.
- Because `.xterm-selection` has `pointer-events: none`, right-clicking over selected text successfully captures the target and invokes `handleContextMenu`.
- Path candidate detection (`terminalPathCandidate(selection, cwd)`) inspects highlighted text to enable file operations in the context menu.

### Verification of Copy Selection Content
- Verified that `copy('selection')` retrieves only text between `selectionStart` and `selectionEnd`.
- Trailing whitespace on blank rows is trimmed by `translateBufferLineToString(y, true)`.
- Copy operations never copy content from other terminal sessions or outside the active selection range.

### Independent Testing of Ordinary Shell vs Codex TUI
- Ordinary Shell: Linear scrollback buffer; wrapped lines correctly joined by `extractBufferText`; prompt boundary heuristics detect command start/end for `copy('last')`.
- Codex TUI: Fixed-size alternate screen buffer (`buffer.length === rows`); `copy('all')` extracts the active screen and provides truthful user feedback ("Available buffer copied"); `Ctrl+C` passes directly to PTY for Codex interrupts.

### Preserving Standard xterm.js Selection Semantics
- We preserve xterm.js native selection rendering rather than replacing it with fragile custom DOM overlays.
- Standard terminal semantics (drag-to-select, double-click word, triple-click line, click-to-clear) are preserved intact.

## Alternate-Screen Limitations

xterm.js implements ANSI alternate screen buffer switching (`\x1b[?1049h` and `\x1b[?1049l`):
- Architecture:
  In xterm.js, the alternate screen buffer does not maintain a scrollback history buffer. The buffer length is strictly clamped to the number of visible rows (`buffer.length === rows`).
- Codex Behavior:
  When Codex CLI or other full-screen terminal tools run in alternate-screen mode, prior turns or prompts that have scrolled off the alternate screen grid are not retained in xterm.js memory.
- Workbench Truthfulness Guarantee:
  Workbench does not invent non-existent history or silently copy stale data from `term.buffer.normal` (which only contains pre-Codex shell history). When `copy('all')` is invoked in an alternate-screen session, Workbench extracts the active buffer and informs the user via the localized notification: "Available buffer copied".

## Remaining Limitations

1. xterm.js Alternate Buffer Historical Scrollback:
   As documented in Section 6, alternate screen buffers in xterm.js do not maintain historical scrollback. Full historical turns from long-running Codex sessions that have scrolled out of the TUI viewport cannot be retrieved from xterm.js buffer memory.
2. Remote Web Client Browser Permissions:
   When Workbench is accessed from a remote web browser rather than the Electron desktop shell, clipboard operations must fall back to `navigator.clipboard`. In remote browsers, document focus and permission prompt restrictions apply.

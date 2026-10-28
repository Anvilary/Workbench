# Agency-UI Terminal-First Transformation: QA Handoff Report

## Executive Summary

This handoff documents the implementation of the real-world Ubuntu QA findings on Agency-UI. The platform has been transformed from a hybrid chat+terminal interface into a clean, native-terminal-first development cockpit.

All changes preserve the original installed Codex, Antigravity (`agy`), and Claude Code CLIs, their local authentication, and their underlying PTY processes. The user interacts directly with the native CLI TUI (including slash commands, model selectors, and interactive permission prompts) inside `xterm.js`, with zero artificial chat emulation, no custom inference harnesses, and no interference with real running developer processes on the host machine.

---

## Baseline and Isolation

- **Parent Integration PR:** [PR #5](https://github.com/user/My-Amazing-Workspace/pull/5)
- **Parent Baseline Commit:** `4cd5076a8077b1f455ba9a9f2992887e9f6243f3`
- **Feature Branch:** `feat/agency-terminal-first`
- **Dedicated Worktree:** `/home/user/Projects/Agency-UI-terminal-first`
- **PR Target Base:** `feat/agency-integration` (PR #5 remains open and unmodified)

---

## Ubuntu QA Findings Addressed

### 1. Native CLI Terminal is the Primary Interface
- **Problem:** A duplicated chat composer and model/effort selector competed with the native CLI TUI.
- **Solution:** Removed `AgencyComposer` completely from the visible workspace. Terminal now occupies 100% of the pane height below a minimal pane toolbar.
- **Preserved:** All native CLI interactions (slash commands, permission approvals, model switching, ANSI styling, raw terminal keyboard input, cursor navigation, terminal replay on reconnect). Focus is automatically transferred to the active terminal on workspace activation.

### 2. Terminal Height, Fit, and Status Bar
- **Problem:** Bottom status lines of TUIs (such as Antigravity's status bar) were clipped or pushed out of view due to fixed padding and composer vertical competition.
- **Solution:** Container geometry in `packages/web/src/agency/agency.css` now positions `.agency-xterm-host` and `.terminal-surface` absolutely (`position: absolute; inset: 0; width: 100%; height: 100%;`). `FitAddon.fit()` recalculates exact columns and rows on actual resize events observed by `ResizeObserver`, ensuring the terminal fits flush within the pane boundary with zero clipping and zero app-level scrollbars.

### 3. Resizable Shell / Agent Split
- **Problem:** Agent and shell panes were statically proportioned.
- **Solution:** Added a draggable vertical divider (`.agency-pane-divider`) with pointer drag support, visual hover/active affordances, smooth drag responsiveness, keyboard arrow navigation (`ArrowLeft` / `ArrowRight`), and `localStorage` ratio persistence (`agency-split-ratio`). Minimum pane widths (240px) prevent terminals from collapsing to zero. Narrow viewports automatically stack vertically.

### 4. Resizable and Collapsible Sidebar
- **Problem:** Sidebar was fixed-width with sudden toggle behavior.
- **Solution:** Integrated a draggable boundary (`.agency-sidebar-resizer`) with pointer tracking, min/max width clamping (180px - 500px), and `localStorage` persistence. The sidebar collapse/expand toggle animates smoothly (160ms transition) and respects `prefers-reduced-motion`. When collapsed, the sidebar collapses cleanly to 0px width without leaving transparent overlays blocking terminal interaction.

### 5. Terminal Keyboard Selection and Copy
- **Problem:** Selecting and copying text inside `xterm.js` was clumsy and could conflict with CLI interrupts.
- **Solution:** Implemented intelligent keyboard interception in `packages/web/src/TerminalView.tsx`:
  - `Ctrl+A`: Selects all text in the active terminal buffer (`terminal.selectAll()`).
  - `Ctrl+C`: When terminal text is selected, copies the selection to the system clipboard; when **no** text is selected, preserves native CLI interrupt (`\x03` SIGINT).
  - `Ctrl+Shift+C`: Conventional terminal copy shortcut fallback.
  - An explicit **Interrupt** action button was added to the pane toolbar for guaranteed process interruption.
  - Shortcuts are strictly scoped to the terminal container and do not hijack normal browser inputs or modals.

### 6. Terminal Copy Dropdown
- **Problem:** Lack of targeted copy options from the terminal.
- **Solution:** Added a Copy dropdown to the pane toolbar with:
  - **Copy selection:** Copies current highlighted buffer text.
  - **Copy all:** Copies the full active terminal buffer including scrollback.
  - **Copy last output:** Copies the most recent command output block from prompt boundaries.
  - **Copy last message:** Clarified as disabled/annotated when running on raw PTY without verified structured turn boundaries, preventing misleading turn attributions.

### 7. Truthful Activity Status
- **Problem:** UI displayed "Activity unknown" while native CLIs were healthy, active, and responding.
- **Solution:** Traced the status pipeline (`useAgencyStore.ts` & `agency-labels.ts`). When an active session has an unknown activity state, the label now reports `"Running (activity unavailable)"` or `"Running"`. When working or awaiting input, it reports `"Working"` and `"Needs input"` respectively. Misleading permanent fallback states were eliminated.

### 8. New Workspace Dialog: Mode & Profile Selection
- **Problem:** Workspace creation lacked CLI profile choice and forced agent assumptions.
- **Solution:** Updated `AgencyWorkspaceCreator.tsx` to support:
  - Workspace type selection: **Agent Workspace**, **Terminal-Only Workspace**, or **Empty Workspace**.
  - CLI Profile selector displaying all configured profiles (`codex-0`, `codex-1`, `codex-3`, `agy-0`–`agy-5`, `claude-code`) along with live availability status (`available`, `not-installed`, `needs-authentication`, etc.).
  - Proper modal focus trap preventing keyboard focus from escaping into background views.

### 9. Automatic Native CLI Launch
- **Problem:** After creating an agent or terminal workspace, users had to manually initialize sessions.
- **Solution:** `AgencyApp.tsx` immediately issues `agency.session.create` upon workspace creation with the user's selected mode and profile. If launch encounters an error (e.g., unconfigured executable), the error is surfaced clearly in the pane with a "Retry launch" action.

### 10. Live Search in FolderPicker
- **Problem:** Navigating large directory trees in the directory picker was tedious.
- **Solution:** Added client-side search filtering in `packages/web/src/FolderPicker.tsx`:
  - Instant case-insensitive filtering of listed directories.
  - Match count indicator and dedicated clear button.
  - Pressing `Escape` while searching clears the filter before closing the dialog.
  - Server-owned canonical path validation remains fully enforced.

### 11 & 12. Contextual Actions & Archive/Restore Architecture
- **Problem:** Workspaces and projects could only be completed or deleted, with no soft archive option or protection against deleting non-empty projects.
- **Solution:**
  - Extended shared protocol (`agency-protocol.ts`) with `ProjectStatus`, `archivedAt`, and message pairs: `agency.workspace.archive` / `agency.workspace.archived`, `agency.workspace.unarchive` / `agency.workspace.unarchived`, `agency.project.archive` / `agency.project.archived`, `agency.project.unarchive` / `agency.project.unarchived`.
  - Added 3-dot contextual menus to projects and workspaces in `AgencySidebar.tsx`.
  - Added confirmation modals with blocker checks: deleting a project with active workspaces is blocked with an explicit explanation; workspaces with active PTY processes warn before deletion.
  - Updated `AgencyDoneView.tsx` with dedicated tabs for **Done** and **Archived** workspaces, supporting full restore and permanent deletion.

---

## Component Map

| Component / File | Primary Role & Changes |
| :--- | :--- |
| `packages/web/src/agency/AgencyWorkspaceView.tsx` | Native terminal cockpit view; removed `AgencyComposer`; 100% height terminal layout; minimal pane toolbar; Copy dropdown; Interrupt button; draggable pane split divider. |
| `packages/web/src/TerminalView.tsx` | Terminal instance callbacks; `Ctrl+A` select all, `Ctrl+C` smart copy / interrupt, `Ctrl+Shift+C` fallback copy; clipboard error handling. |
| `packages/web/src/agency/AgencyWorkspaceCreator.tsx` | New workspace creation modal; mode selector (agent, terminal, empty); CLI profile picker with status; focus trap. |
| `packages/web/src/agency/AgencySidebar.tsx` | Collapsible & resizable sidebar; 3-dot dropdown menus for projects and workspaces; archive, rename, done, delete confirmation dialogs; deletion blocker dialog. |
| `packages/web/src/agency/AgencyDoneView.tsx` | Done & Archive view with tabs; restore, unarchive, and delete actions. |
| `packages/web/src/FolderPicker.tsx` | Directory picker with live search filter, match count, clear search button, and server-owned path safety. |
| `packages/web/src/agency/agency-labels.ts` | Truthful activity status labeling (`Running`, `Working`, `Needs input`, `Running (activity unavailable)`). |
| `packages/web/src/agency/agency.css` | Absolute inset layout for xterm; split divider styles; resizer bar styles; dropdown styles; dialog & warning styles; zero horizontal/vertical app overflow. |
| `packages/shared/src/agency-protocol.ts` | Extended schema for workspace/project archiving, unarchiving, timestamps, and validation. |
| `packages/server/src/agency/store.ts` | Backend disk persistence for project/workspace archiving, unarchiving, and migrations. |
| `packages/server/src/agency/domain-handler.ts` | Message handlers and broadcasts for project and workspace archive/unarchive requests. |

---

## Verification Results

### 1. Typecheck
```
$ pnpm -r typecheck
packages/shared: Done in 785ms
packages/server: Done in 3.9s
packages/web: Done in 6.1s
Zero errors.
```

### 2. Internationalization (`check-i18n.mjs`)
- Tested all 9 supported locales: `de`, `en`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `ru`, `zh-CN`.
- All keys strictly sorted by ASCII code point `(a < b ? -1 : a > b ? 1 : 0)`.
- Pruned all obsolete composer translation keys (`C1` check passed).
- Result: **"Todo bien."** (100% pass across checks A1–F7).

### 3. Backend Domain Unit Tests (`domain.test.ts`)
- `11 / 11` unit tests passing, covering project/workspace CRUD, concurrency locks, directory canonicalization, symlink guards, fail-closed deletion locks, and archive/unarchive backwards compatibility.

### 4. Security & Remediation Integration (`check-agency-remediation.mjs`)
- `6 / 6` test suites passing, verifying immutable native home isolation, remote mutation rejection, picker cancellation release, and reconnect integrity without accessing real developer credentials or accounts.

### 5. End-to-End Acceptance Tests (`check-agency-e2e.mjs`)
- `25 / 25` acceptance tests passing, verifying authentication, directory selection, PTY launch, `pwd`, ANSI parsing, `stty size` resizing, `Ctrl+C` interrupt, reconnect process survival, and metadata recovery.

### 6. Visual Quality & Screenshot Suite (`capture-agency-screenshots.mjs`)
- Tested viewports: **390px**, **768px**, **1024px**, **1440px**, and **1920px**.
- Zero browser console errors and zero uncaught page errors.
- Verified terminal dimensions (`metrics.scroll <= metrics.viewport` across all widths).
- 10 distinct screenshots captured in `docs/agency/screenshots/`:
  - `01-empty-workspace.png`
  - `02-shell-only-workspace.png`
  - `03-agent-only-workspace.png`
  - `04-combined-workspace.png`
  - `05a-sidebar-expanded.png`
  - `05b-sidebar-collapsed.png`
  - `06-done-restore-view.png`
  - `07-new-workspace-dialog.png`
  - `08-folder-picker-live-search.png`
  - `09-desktop-1920.png`

---

## Zero-Interference Assurance

At no point during test execution or development were real developer CLI processes (`codex`, `agy`, `claude`), active daemon sessions, or local user configuration directories signaled, terminated, or accessed. All tests execute inside temporary mock directories (`/tmp/aw-agency-*`) using isolated mock fixture processes.

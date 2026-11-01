# Unified Workspace UX Plan

Target branch: `main`.

This document tracks the implementation plan and stabilization status for the MAW unified workspace UX redesign on branch `feat/maw-unified-workspace-ux`. Feature and fix PRs in this repository target `main`. Nothing is committed to `main` directly, and nothing is merged or deployed.

## 1. Architectural Baseline

- Pane swap uses `@dnd-kit`. Tab dragging uses pointer drag in `PaneHeader.tsx` with magnetic neighboring tab shifts.
- Terminals stay mounted in `PersistentSessionPanes`, preserving PTY, scrollback, and xterm instances across pane operations.
- Multi-provider web tabs: ChatGPT uses `WebContentsView` on partition `persist:maw-chatgpt`; GitHub uses partition `persist:maw-github`. Origin checks in `packages/desktop/policy.mjs` and `packages/shared/src/browser-tabs.ts`.
- File read, write, and path checks go through `files.*` and `path-guard.ts`. `DocumentViewer` is the editor.
- Activity states: `idle`, `working`, `needs-input`, `finished`, `unknown`, `failed`. Verified completion notifies once. Working and needs-input do not raise notifications.

## 2. Core Decisions and Requirements

### Decision 1: Split Buttons and Content Picker
- Clicking Split Right or Split Down opens the content picker menu (`PaneMenu`) anchored to the split button.
- Users choose the content type for the new pane: Terminal, Agent CLI profile, ChatGPT web tab, or GitHub web tab.
- Direct splitting without user choice and automatic division of existing tabs are deprecated in the UI.
- `splitPane` supports `emptyNewPane: boolean` to open an empty target pane on split commit.
- On cancel or error, the pane tree remains unmodified; failed creation rolls back without orphaned panes.
- Test fixtures are updated to interact with the picker rather than expecting immediate splitting.
- Regression coverage covers:
  * Both split orientations (row and column).
  * Every supported content type.
  * Cancel without modifying layout.
  * Invalid or unavailable selections.
  * Failed creation without orphaned panes.
  * Existing tab and PTY identities remaining unchanged.
  * Layout persistence after successful creation.

### Decision 2: Completion Notifications
- Notifications reflect verified events only.
- A verified completion always updates:
  * Persisted notification state.
  * Notification inbox.
  * Tab activity state.
- Suppress the transient toast popup ONLY when:
  1. The application window is actively focused (`document.hasFocus()`).
  2. The completed tab is actually visible and active in the layout.
- If focus or visibility cannot be determined reliably, do not suppress the toast.
- No notifications for task started, working, unknown activity, or unverified completion.
- Stored notifications retain `finished` for wire and storage compatibility.
- Reconnects and snapshot replays preserve deduplication.

### Decision 3: Terminal File Clipboard
- Context menu in `SessionPane.tsx` offers file actions when the user right-clicks a terminal selection that is a valid workspace-relative path:
  * Open File in Editor
  * Copy File (native file list clipboard for file manager paste)
  * Copy Absolute Path
  * Copy Relative Path
  * Copy File Contents
- Security requirements:
  * Validate paths using authoritative workspace root and tab cwd.
  * Reject symlinks that resolve outside the workspace, including dangling symlinks.
  * Never pass selected text to a shell or execute it.
  * Restrict `copy-file` IPC to trusted desktop shell frame (`trustedSender`). Remote clients cannot invoke desktop clipboard IPC.
  * Preserve spaces and special characters in valid paths.
  * Handle unsupported desktop clipboard formats gracefully with clear unavailable feedback.

### Decision 4: Plan and Branch Tracking
- `docs/maw/unified-ux/PLAN.md` is force-tracked with `git add -f` because `/docs/` is generally ignored in `.gitignore`.
- Changes are staged and committed in small, focused commits without AI attribution trailers.

## 3. Phase 1 Stabilization Checklist

1. **Build and Type Integrity**:
   - Fix all 19 TypeScript errors in `packages/web`.
   - Add missing localization keys (`agency.tabs.github`, `agency.browser.*`, `agency.tabs.file.*`) across `en.json` and all 8 other locales.
   - Fix dangling symlink unhandled exception in `resolveClipboardTarget` (`file-clipboard.mjs`).
   - Convert `tab-geometry.mjs` to TypeScript (`tab-geometry.ts`) so TypeScript consumers import with strict types.

2. **Test Suite Reconciliation**:
   - Disambiguate top bar `aria-label` to eliminate locator collisions in `browser-tabs.test.mjs`.
   - Reconcile toast suppression in `useNotificationStore.ts` with window focus and update `tab-ux-browser.test.mjs`.
   - Update `terminal-lifecycle.test.mjs` and `pane-inspection.test.mjs` for the new split picker and grip layout.

3. **Wiring Unfinished Features**:
   - Wire `terminal-path` candidate detection and context menu actions into `SessionPane.tsx`.
   - Ensure `packages/desktop/main.mjs` flushes `githubSession` storage and cookies on app shutdown.
   - Dynamic error messaging for GitHub and ChatGPT views.

4. **Validation**:
   - `pnpm typecheck` across all packages.
   - `pnpm check` verifying all scripts and locale consistency.
   - `pnpm build` verifying production web bundle.
   - Run all focused unit and integration test suites.

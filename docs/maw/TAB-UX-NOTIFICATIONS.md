# MAW — Draggable Tabs and GitHub-Style Notification Done

**Repository:** `user/My-Amazing-Workspace`  
**Worktree:** `~/Projects/My-Amazing-Workspace-tab-ux`  
**Branch:** `feat/maw-tab-drag-notification-done`  
**Base Commit:** `25a59c0d786fcabbae712570eed9d518f6f50e9f` on `fix/maw-claude-audit-remediation` (stacked PR target)  

---

## 1. Overview & Objectives

This implementation delivers focused usability improvements to My Amazing Workspace (MAW), eliminating shell command notification spam, enabling browser-like drag-and-drop tab reordering across mixed native and web tabs, and introducing a GitHub-style per-notification "Done" action.

All modifications strictly preserve the existing CLI, PTY, tab-ordering, and notification architectures, maintain process and profile isolation, and protect all 9 supported locales.

---

## 2. Key Architecture & Changes

### Task 1 — Remove Shell-Command Notification Spam

#### Problem
Previously, each interactive shell command (such as `ls`, `git status`, or failed commands like `false`) executed in a terminal tab triggered an inbox notification, a desktop notification, a toast message, and left a persistent green "finished" or red "failed" badge on the terminal tab.

#### Implementation Details
- **Location:** [`packages/server/src/agency/tab-activity-manager.ts`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/server/src/agency/tab-activity-manager.ts)
- **Suppressed Notification Creation:** In `getOrCreateShellParser()`, on shell command completion (`success` or `failure`), the activity manager calls `saveActivity()` with `notification = undefined`. No inbox notification or toast entry is generated for ordinary shell commands.
- **Badge Reset to Idle:** Instead of mapping shell completion to persistent `finished` or `failed` badges, shell completions now map directly to `idle`:
  ```typescript
  const nextState: MawActivityState = (state === 'finished' || state === 'failed') ? 'idle' : state;
  ```
- **Session Restarts:** In `initialize()`, any shell-originated records found in `finished` or `failed` state are sanitized to `idle` to prevent stale badges upon server reboot.
- **Preserved Diagnostics & Integrations:** OSC 133 semantic prompt/command sequences continue parsing command boundaries, updating internal diagnostic counters, and reflecting active execution (`working`) while running. Native coding agent completions (Codex, Antigravity, Claude Code), attention requests, and permission prompts remain fully operational and continue generating notifications.

---

### Task 2 — Draggable Workspace Tabs

#### Problem
Tab reordering was previously limited to keyboard shortcuts (`Alt+Arrow`) without pointer-based drag-and-drop support, visual drop targets, or autoscrolling.

#### Implementation Details
- **Locations:** [`packages/web/src/agency/AgencyWorkspaceView.tsx`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/web/src/agency/AgencyWorkspaceView.tsx), [`packages/web/src/agency/agency.css`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/web/src/agency/agency.css)
- **Pointer Drag Interaction:** Implemented a pointer-based drag engine on the tab strip. A 6px movement threshold prevents accidental dragging when clicking or selecting tabs.
- **Visual Drop Targets:** As tabs are dragged horizontally, the target insertion point is computed from sibling tab bounding rects. Active drop targets receive CSS indicators:
  - `.maw-session-tab.dragging`: Reduced opacity (0.45) with pointer events disabled on the dragged item.
  - `.maw-drop-target-before`: Subtle left border highlight (`inset 3px 0 0 var(--agency-primary)`).
  - `.maw-drop-target-after`: Subtle right border highlight (`inset -3px 0 0 var(--agency-primary)`).
- **Edge Autoscroll:** When dragging near the left or right edges of the scrollable tab strip (< 48px), an animation frame loop smoothly scrolls the container horizontally.
- **Cancellation & Safety:** Drag operations can be aborted at any moment via the `Escape` key or pointer cancellation (`onPointerCancel`). When canceled, original ordering is restored without dispatching backend requests.
- **Click Suppression:** When a drag completes, `onClickCapture` suppresses the subsequent `click` event so the tab is not accidentally selected, renamed, or closed.
- **Preserved Existing Features:** Normal click-to-select, keyboard reordering (`Alt+ArrowLeft`/`Alt+ArrowRight`), inline rename (`F2`), and tab close (`×`) remain fully functional.
- **Persistence & Protocol:** Tab order changes are dispatched using the existing backend message `{ type: 'agency.tabs.order', workspaceId, tabIds }`. Mixed native CLI, shell terminals, and ChatGPT web tabs are serialized through [`packages/server/src/agency/tab-coordinator.ts`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/server/src/agency/tab-coordinator.ts), surviving browser refresh, disconnects, and server restarts.

---

### Task 3 — GitHub-Style "Done" Notifications

#### Problem
While MAW supported notification reading and tab inspection, there was no granular per-notification "Done" action to complete alerts in the inbox. Tab viewing alone could conflate viewing with marking alerts complete.

#### Implementation Details
- **Locations:** 
  - [`packages/shared/src/agency-protocol.ts`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/shared/src/agency-protocol.ts), [`packages/shared/src/notification-protocol.ts`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/shared/src/notification-protocol.ts)
  - [`packages/server/src/terminal-socket.ts`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/server/src/terminal-socket.ts)
  - [`packages/server/src/agency/agency-notification-store.ts`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/server/src/agency/agency-notification-store.ts)
  - [`packages/web/src/agency/useNotificationStore.ts`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/web/src/agency/useNotificationStore.ts)
  - [`packages/web/src/agency/NotificationInbox.tsx`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/web/src/agency/NotificationInbox.tsx)
- **Protocol Extension:** Added client message `{ type: 'agency.notification.done', requestId, notificationId }`.
- **Durable Done State:** In `AgencyNotificationStore.acknowledge()`, marked items set `acknowledgedAt: now`, `read: true`, `readAt: item.readAt ?? now`, and `dismissedAt: item.dismissedAt ?? now`. Unread counts filter out `!item.read && !item.acknowledgedAt`.
- **UI Done Button:** Each notification row in [`NotificationInbox.tsx`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/web/src/agency/NotificationInbox.tsx) includes an accessible button (`.maw-done-button`) displaying a checkmark (`✓`) with localized tooltip `t('agency.notifications.done')`. Unread items retain the separate mark-read action (`●`), keeping Read and Done distinct.
- **Race Condition Prevention:** When `agency.notification.done` is received, the server checks whether the notification matches the tab's current outstanding turn:
  ```typescript
  const isCurrentTurn = !item.metadata?.taskId || (
    activityRecord &&
    activityRecord.taskId === item.metadata.taskId &&
    (item.metadata.turnSequence === undefined || activityRecord.turnSequence === item.metadata.turnSequence)
  );
  if (isCurrentTurn) {
    await agencyActivityManager.acknowledgeTab(item.workspaceId, item.tabId);
  }
  ```
  If a new agent turn completed while the user was marking an old notification Done, the newer turn's `finished` badge is preserved and never cleared.
- **Cache Invalidation & Snapshot Safety:** Completed notifications are tracked in `completedNotificationIds` and stripped from `localStorage` cached items and incoming snapshots, preventing closed alerts from flickering or reappearing.
- **Distinction from Workspace "Mark Done":** The workspace-level "Mark Done" action is strictly preserved and remains untouched.

---

## 3. Supported Locales & i18n

The new localized string `"agency.notifications.done"` was added across all 9 supported locales in strict alphabetical order:
- `en`: `"Done"`
- `de`: `"Erledigt"`
- `es`: `"Listo"`
- `fr`: `"Terminé"`
- `ja`: `"完了"`
- `ko`: `"완료"`
- `pt-BR`: `"Concluído"`
- `ru`: `"Готово"`
- `zh-CN`: `"完成"`

Validated with `pnpm --filter @agent-workbench/server exec tsx scripts/check-i18n.mjs` (all checks passed).

---

## 4. Verification & Test Evidence

### Acceptance Test Suite
Created [`packages/server/src/agency/tab-ux-notifications.test.ts`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/server/src/agency/tab-ux-notifications.test.ts) covering all acceptance requirements:
1. **10 ordinary shell commands:** Confirmed 10 commands (e.g. `ls`, `pwd`, `git status`, `echo`, nonzero exit codes) generate 0 inbox notifications and 0 completion badges.
2. **Native agent completions:** Verified native CLI turn completion properly creates inbox notifications and triggers the `finished` status dot.
3. **Done action isolation:** Verified Done removes exactly one notification, clears only its matching tab completion, and decrements the unread count.
4. **Race condition safety:** Verified that marking an older turn Done does not clear a newer turn's tab completion badge.
5. **Persistence across restart:** Verified that completed notifications remain completed after reload from disk.
6. **Mixed tab drag reordering:** Verified that reordering mixed native CLI, shell, and ChatGPT web tabs persists across restarts, rejects malformed payloads, and handles concurrent reorder requests.

### Browser End-to-End Suite
Created [`packages/web/src/agency/tab-ux-browser.test.mjs`](file:///home/user/Projects/My-Amazing-Workspace-tab-ux/packages/web/src/agency/tab-ux-browser.test.mjs) verifying interactive Playwright browser behavior:
- Click-to-select tab responsiveness.
- Keyboard tab reordering (`Alt+ArrowLeft`).
- Pointer dragging across mixed tabs with 6px threshold and drop target styling.
- `Escape` drag cancellation.
- Notification inbox Done button interaction and immediate inbox item removal.
- Tab completion clearing on matching Done.
- Tab completion badge preservation when a newer turn completes.

### Full Suite Run Results
- `pnpm typecheck`: Passed (all packages clean).
- `pnpm build`: Passed (production Vite bundle built in 4.50s).
- `pnpm --filter @agent-workbench/server exec tsx scripts/check-i18n.mjs`: Passed (all 9 locales valid).
- `pnpm --filter @agent-workbench/server exec tsx --test "src/agency/*.test.ts"`: 79/79 tests passed.
- `node --test packages/web/src/agency/tab-ux-browser.test.mjs`: Passed.
- `node --test packages/web/src/agency/browser-tabs.test.mjs`: Passed.
- `pnpm --filter @agent-workbench/server exec tsx scripts/check-agency-remediation.mjs`: 6/6 groups passed.
- `pnpm --filter @agent-workbench/server exec tsx scripts/check-maw-integration.mjs`: 7/7 checks passed.

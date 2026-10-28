# MAW Lane C — Activity State and Notification System

**Repository:** `user/My-Amazing-Workspace`  
**Branch:** `feat/maw-notifications`  
**Target:** `main`  
**Starting baseline:** `07942a15e5992d7b61e103fffce072969783878e` (main / PR #8 / PR #9 merge)  
**Delivery URL:** [Draft PR](https://github.com/user/My-Amazing-Workspace/pull/new/feat/maw-notifications)

---

## 1. Overview & Mission

MAW Lane C implements a unified, durable notification and activity-state subsystem across CLI, shell terminal, and browser/web tabs. The system guarantees reliable task completion detection without false positives, separates reading inbox messages from acknowledging task results on tabs, maintains state across browser refresh and server restart, reconciles optimistic updates on failure, and provides full keyboard accessibility across all 9 supported locales.

---

## 2. Activity State Model

The subsystem enforces a strict 5-state lifecycle:

- `idle`: Tab is ready and awaiting user command or next prompt.
- `working`: Active execution in progress (CLI turn, shell command, or background browser task).
- `finished`: Task completed successfully upon receipt of a **reliable, verified completion signal**.
- `unknown`: Activity cannot be verified (e.g. shell without integration hooks, browser tab without verified completion bridge, or in-flight task after server restart).
- `failed`: Task ended with an error, exception, or non-zero command exit code.

### Core Lifecycle Invariants:
1. **Reliable Completion Gate**: A task enters `finished` **only** when a verified completion signal exists (native CLI turn completed event from verified providers, shell OSC 133 D 0 sequence with valid numeric exit code, or authenticated browser companion bridge). Silence in output, arbitrary PTY pauses, or generic idle transitions are **never** treated as completion.
2. **Persistence of `finished`**: Once `finished`, the tab retains its finished status (indicated by a distinct green badge in the tab strip) until the user opens/inspects that tab and navigation/selection actually succeeds, returning the state to `idle`.
3. **Decoupled Reading vs. Acknowledging**: Marking a notification as read in the inbox marks that inbox item as read, but does **not** dismiss the `finished` state on the tab. The tab remains `finished` until the user actually opens or inspects the terminal/conversation.
4. **Stable Deduplication**: Deduplication keys use stable event IDs, turn IDs, or command IDs (`cli-turn:...`, `shell-cmd:...`), rather than volatile time buckets, ensuring duplicate alerts are never generated after server restarts.
5. **Durable Restart Guarantees**:
   - Uninspected `finished` states remain `finished` after server restart.
   - In-flight `working` tasks become `unknown` on restart (not falsely `finished`).
   - Closed or deleted tabs are marked closed and never generate stale alerts.

---

## 3. Provider Activity Specifications

### 3.1. Native CLI Activity Audit & Completion Signals
- **Audit Findings**:
  - `claude-code`: Verified turn completion via `CliStatusWatcher` monitoring session PID status files (`~/.claude/sessions/<pid>.json`). Turn transitions `busy -> idle` only upon actual turn completion.
  - `opencode`: Verified turn completion via server SSE event stream (`OpenCodeServeStatus`).
  - `codex`: Uses `statusSource: false`. Rolls out JSONL to disk but does not emit real-time status events. Generic idle or output pause must **never** be treated as completion.
  - `antigravity`: Uses `statusSource: false` unless a statusline script is configured. Generic idle is not completion.
- **Generic Idle vs. Turn Completion**:
  - Generic `idle` status (such as initial startup, reconnect, or idle without a preceding verified `working` turn) is **strictly rejected** as completion.
  - Providers without verified turn completion mechanisms (`codex`, unverified `antigravity`, or generic followers) transition to `idle` (`reliableSignal: false`) without ever entering `finished` or generating completion notifications.

### 3.2. Shell Terminal Activity (OSC 133 & Safe Script Installation)
- **Streaming Parser** (`ShellIntegrationParser`):
  - `OSC 133 ; A ST`: Prompt start (`\x1b]133;A\x07` or `\x1b]133;A\x1b\\`).
  - `OSC 133 ; B ST`: Prompt end / command input ready.
  - `OSC 133 ; C ST`: Command executed / output started -> transitions to `working`.
  - `OSC 133 ; D [; <exitCode>] ST`: Command exited:
    - **Strict Numeric Requirement**: Never interpret missing, empty, malformed, or nonnumeric exit codes as successful exit code `0`. Missing or malformed parameters strictly transition to `unknown` (`reliable: false`).
    - `exitCode === 0`: reliable completion signal -> transitions to `finished`.
    - `exitCode !== 0`: command failed -> transitions to `failed`.
- **Safe Shell Integration Setup**:
  - `installShellIntegrationSafely(targetDir)` writes standalone scripts `maw-bash-integration.sh` and `maw-zsh-integration.zsh`.
  - **Non-destructive**: Does **not** modify or overwrite the user's existing shell configuration (`~/.bashrc`, `~/.zshrc`).
  - Bash: Safely chains with existing `PROMPT_COMMAND` without replacing existing functions.
  - Zsh: Safely appends hooks to `precmd_functions+=` and `preexec_functions+=` without resetting existing user hooks.

### 3.3. ChatGPT & Browser Web Activity
- **Architecture**: Pluggable `BrowserActivityProvider` interface (`packages/server/src/agency/browser-activity-provider.ts`).
- **Background Execution**: Background ChatGPT tabs remain mounted and active in the DOM when navigating between workspace tabs.
- **Authentication & Authorization**:
  - Submitting verified activity events requires registered bridge credentials (`bridgeId` and `authToken`).
  - An arbitrary unauthenticated caller cannot label an event `verified: true` and cannot transition a ChatGPT tab to `finished`.
- **Evidence Restrictions**:
  - **No Private APIs**: Internal reverse-engineered OpenAI endpoints are strictly forbidden.
  - **No Content Scraping**: Reading assistant message bubbles, extracting text deltas, or inspecting transcript tokens is prohibited.
  - **No False Completion Heuristics**: Network-idle and page-load events do not constitute reliable completion signals.
- **Formal Limitation Report**:
  Due to Same-Origin Policy (SOP) boundaries and absence of public completion webhooks, ChatGPT web tabs remain truthfully reported as `unknown` unless an authorized WebExtension companion bridge or user-granted notification hook is active.

---

## 4. UI Components, Inspection & Acknowledgement

### 4.1. UI Components (`packages/web/src/agency/`)
- `NotificationBell.tsx`: Topbar header button with dynamic unread count badge (`1–99`, `99+`), `aria-haspopup="dialog"`, `aria-expanded`, and localized tooltip.
- `NotificationInbox.tsx`: Persistent popover inbox with state badges, titles, descriptions, relative timestamps, and unread dots.
  - Individual "Mark as read" and "Mark all as read" buttons.
  - Clicking an item selects target workspace and tab, and marks the notification as read.
  - Keyboard accessible: `Escape` closes inbox and restores focus.
- `NotificationToast.tsx`: Top-right floating toasts with 6.5s auto-dismiss and manual dismiss button.
  - **Toast dismissal does NOT delete inbox history**.
- `AgencyWorkspaceView.tsx`: Displays visual indicator dots on tabs corresponding to activity states (`finished` green, `working` pulse, `failed` red, `unknown` slate).

### 4.2. Navigation and Inspection Safety
- Opening a tab acknowledges its finished result **only once navigation and selection actually succeed**.
- A tab is **NOT** acknowledged when:
  - The requested workspace is missing or inactive.
  - Tab selection fails on the server.
  - The browser view fails to attach.
  - The user merely marks an inbox notification read.

### 4.3. Optimistic Mutation Reconciliation
- Optimistic UI updates (mark read, mark all read, acknowledge tab) are reconciled with server responses.
- If a server mutation fails or returns an error, the optimistic change is immediately rolled back to the previous state, preventing fake persisted successes.

---

## 5. Wire Protocol Specification

Defined in `packages/shared/src/notification-protocol.ts` and integrated into `packages/shared/src/agency-protocol.ts`:

### Client Messages:
```ts
| { type: 'agency.notifications.list'; requestId: RequestId }
| { type: 'agency.notification.markRead'; requestId: RequestId; notificationId: string }
| { type: 'agency.notification.markAllRead'; requestId: RequestId }
| { type: 'agency.notification.dismiss'; requestId: RequestId; notificationId: string }
| { type: 'agency.tab.acknowledge'; requestId: RequestId; workspaceId: WorkspaceId; tabId: string }
```

### Server Messages:
```ts
| { type: 'agency.notifications.snapshot'; requestId: RequestId; notifications: readonly MawNotificationItem[]; activityStates?: readonly TabActivityRecord[] }
| { type: 'agency.notification.created'; requestId?: RequestId; notification: MawNotificationItem }
| { type: 'agency.notification.changed'; requestId?: RequestId; notification: MawNotificationItem }
| { type: 'agency.tab.activity'; requestId?: RequestId; activity: TabActivityRecord }
| { type: 'agency.error'; requestId: RequestId; code: AgencyErrorCode; message: string }
```

---

## 6. Verification & Test Evidence

All tests pass cleanly:

| Test Suite | Command | Result |
| :--- | :--- | :--- |
| **Server Notifications & Activity** | `pnpm --filter @agent-workbench/server exec tsx --test src/agency/notifications.test.ts` | **4/4 pass** (CLI provider audit & turn completion, OSC 133 strict parsing & safe shell hook setup, Browser bridge token authentication, Durable task states across restart) |
| **Server Full Agency Unit Tests** | `pnpm --filter @agent-workbench/server exec tsx --test src/agency/domain.test.ts src/agency/native-identity.test.ts src/agency/native-context.test.ts src/agency/multi-session-protocol.test.ts src/agency/runtime/agency-session-runtime.test.ts src/agency/notifications.test.ts` | **62/62 pass** |
| **Web Notifications UI** | `node --test packages/web/src/agency/notifications.test.mjs` | **7/7 pass** (Unread counts, mark read, toast dismissal history preservation, tab acknowledgement vs read separation, navigation safety, optimistic rollback on error, tab dot mapping) |
| **Web Agency Model Tests** | `node --test packages/web/src/agency/model.test.mjs` | **9/9 pass** |
| **Monorepo Typecheck** | `pnpm -r typecheck` | **0 errors** across shared, server, and web |
| **9-Locale i18n Compliance** | `pnpm --filter @agent-workbench/server exec tsx scripts/check-i18n.mjs` | **"Todo bien." (100% pass)** across checks A1–F7 |
| **Web Production Build** | `pnpm build` | **0 errors** (production Vite bundle) |

---

## 7. Operational & Safety Boundaries

- **No live systemd units**: Live services (`maw.service`) remain unmerged and unactivated.
- **No real credentials**: No credentials or private APIs are touched.
- **User shell safety**: Dotfiles (`~/.bashrc`, `~/.zshrc`) are untouched.

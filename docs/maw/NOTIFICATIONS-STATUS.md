# MAW Lane C — Activity State and Notification System

**Repository:** `user/My-Amazing-Workspace`  
**Branch:** `feat/maw-notifications`  
**Starting baseline:** `07942a15e5992d7b61e103fffce072969783878e` (main / PR #8 / PR #9 merge)

---

## 1. Overview & Mission

MAW Lane C implements a unified, durable notification and activity-state subsystem across CLI, shell terminal, and browser/web tabs. The system guarantees reliable task completion detection without false positives, separates reading inbox messages from acknowledging task results on tabs, maintains state across browser refresh and server restart, and provides full keyboard accessibility across all 9 supported locales.

---

## 2. Activity State Model

The subsystem enforces a strict 5-state lifecycle:

- `idle`: Tab is ready and awaiting user command or next prompt.
- `working`: Active execution in progress (CLI turn, shell command, or background browser task).
- `finished`: Task completed successfully upon receipt of a **reliable completion signal**.
- `unknown`: Activity cannot be verified (e.g. shell without integration hooks, browser tab without verified completion bridge).
- `failed`: Task ended with an error, exception, or non-zero command exit code.

### Core Lifecycle Invariants:
1. **Reliable Completion Gate**: A task enters `finished` **only** when a verified completion signal exists (native CLI turn completed event, shell OSC 133 D 0 sequence, or verified browser companion bridge). Silence in output or arbitrary PTY pauses are **never** treated as completion.
2. **Persistence of `finished`**: Once `finished`, the tab retains its finished status (indicated by a distinct green badge in the tab strip) until the user opens/inspects that tab and acknowledges its result, returning the state to `idle`.
3. **Decoupled Reading vs. Acknowledging**: Marking a notification as read in the inbox marks that inbox item as read, but does **not** dismiss the `finished` state on the tab. The tab remains `finished` until the user actually opens or inspects the terminal/conversation.
4. **Deduplication**: Repeated completion signals for the same turn/command within a time window are deduplicated, preventing duplicate notifications.

---

## 3. Provider Activity Specifications

### 3.1. Native CLI Activity
- **Architecture**: Integrates with MAW's native session activity follower architecture.
- **Completion Evidence**: Listens to server-verified session events (`working` -> `idle`). A turn transition from `working` to `idle` constitutes verified evidence of turn completion.
- **Failure Evidence**: Session lifecycle entering `failed`, or exiting with a non-zero exit code.
- **Safety Boundary**: Output stream silence is never guessed as completion.

### 3.2. Shell Terminal Activity
- **Architecture**: Streaming `ShellIntegrationParser` inspecting the terminal output stream for standard OSC 133 control sequences (Semantic Prompts / FinalTerm / VS Code / iTerm2):
  - `OSC 133 ; A ST`: Prompt start (`\x1b]133;A\x07` or `\x1b]133;A\x1b\\`).
  - `OSC 133 ; B ST`: Prompt end / command input ready.
  - `OSC 133 ; C ST`: Command executed / output started -> transitions to `working`.
  - `OSC 133 ; D [; <exitCode>] ST`: Command exited ->
    - `exitCode === 0` (or omitted): reliable completion signal -> transitions to `finished`.
    - `exitCode !== 0`: command failed -> transitions to `failed`.
- **Preexec / Precmd Integration**: Helper generators (`ShellSequences`) provide standard integration scripts for Bash and Zsh environments.
- **Explicit Unknown Status**: When a shell session has not emitted OSC 133 sequences, its activity state is strictly reported as `unknown`. Arbitrary PTY output is never treated as proof of command completion.

### 3.3. ChatGPT & Browser Web Activity
- **Architecture**: Pluggable `BrowserActivityProvider` interface (`packages/server/src/agency/browser-activity-provider.ts`).
- **Background Execution**: Background ChatGPT tabs remain running in the DOM when the user switches to other workspace tabs.
- **Evidence Requirements & Restrictions**:
  - **No Private APIs**: Reverse-engineered internal OpenAI endpoints are strictly prohibited.
  - **No Content Scraping**: Reading user prompts, assistant bubbles, or parsing response text is strictly prohibited.
  - **No False Completion Heuristics**: Network-idle and page-load events do not constitute reliable completion signals.
- **Permitted Evidence Signals**:
  - Authorized WebExtension companion bridge (`extension-bridge`).
  - Permitted HTML5 Notification API events (`web-notification`).
  - W3C ARIA accessibility state transitions (e.g. `aria-busy="true"` -> `false` without inspecting text).
- **Formal Limitation Report**:
  In standard cross-origin embedding, the Same-Origin Policy (SOP) prevents direct DOM inspection, and OpenAI publishes no public completion webhook/postMessage SDK. Therefore, without a verified companion extension bridge or user-granted notification hook, ChatGPT web tabs are truthfully reported as `unknown`.

---

## 4. Notification UX & Component Architecture

### 4.1. UI Components (`packages/web/src/agency/`)
- `NotificationBell.tsx`:
  - Positioned in the header topbar (`.agency-topbar`).
  - Accessible button with `aria-haspopup="dialog"`, `aria-expanded`, and localized tooltip.
  - Badged with unread count (`.maw-unread-badge`); formats `1-99` or `99+`.
- `NotificationInbox.tsx`:
  - Persistent popover panel with header ("Notifications", unread count, "Mark all as read" button).
  - List of notifications with state badge (`finished`, `failed`, `working`, `unknown`), title, description, formatted relative timestamp (`formatWhen`), and unread indicator dot.
  - Independent "Mark as read" action per notification.
  - Clicking a notification selects the target project, workspace, and tab, and marks the notification as read.
  - Keyboard accessible: `Escape` dismisses the inbox and restores focus.
- `NotificationToast.tsx`:
  - Top-right fixed container (`.maw-toast-container`).
  - Toast cards displaying state indicator, title, body, and dismiss button (`×`).
  - Auto-dismisses after 6.5 seconds or manual dismiss.
  - **Toast dismissal does NOT delete inbox history**.
- `AgencyWorkspaceView.tsx`:
  - Tab status dot displays 5 states: `finished` (green check/dot), `working` (pulse), `failed` (red), `unknown` (muted slate), `idle` (muted green).
  - Opening/selecting a tab acknowledges completion, returning `finished` to `idle`.

### 4.2. Durable Persistence Across Refresh & Restart
- **Backend Store**: `AgencyNotificationStore` (`packages/server/src/agency/agency-notification-store.ts`) saving to `agency-notifications.json` in `appConfigDir()`.
- **Atomic Writes & Recovery**: Uses atomic file writes with `.bak` recovery copy (matching `AgencySessionStore`).
- **Client Cache**: `useNotificationStore` caches snapshot in `localStorage` under `maw.notifications.cache.v1` for instant paint on refresh before WebSocket connection settles.

---

## 5. Protocol Specification

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
| { type: 'agency.notification.created'; notification: MawNotificationItem }
| { type: 'agency.notification.changed'; notification: MawNotificationItem }
| { type: 'agency.tab.activity'; activity: TabActivityRecord }
```

---

## 6. Internationalization (i18n)

All 12 notification keys are localized across all 9 supported locales:
- `en`, `de`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `ru`, `zh-CN`.
- Keys are strictly sorted by ASCII code point (`a < b ? -1 : a > b ? 1 : 0`).
- Validated with `pnpm --filter @agent-workbench/server exec tsx scripts/check-i18n.mjs` (100% pass across checks A1–F7).

---

## 7. Verification & Test Evidence

### 7.1. Focused Test Commands
| Test Suite | Command | Result |
| :--- | :--- | :--- |
| **Server Notifications & Activity** | `pnpm --filter @agent-workbench/server exec tsx --test src/agency/notifications.test.ts` | 4/4 pass (State model, OSC 133, ChatGPT provider, Persistence & deduplication) |
| **Server Full Agency Unit Tests** | `pnpm --filter @agent-workbench/server exec tsx --test src/agency/domain.test.ts src/agency/native-identity.test.ts src/agency/native-context.test.ts src/agency/multi-session-protocol.test.ts src/agency/runtime/agency-session-runtime.test.ts src/agency/notifications.test.ts` | 62/62 pass |
| **Web Notifications UI** | `node --test packages/web/src/agency/notifications.test.mjs` | 6/6 pass (Unread counts, mark read, toast dismissal, tab acknowledgement, navigation, tab dot mapping) |
| **Web Agency Model Tests** | `node --test packages/web/src/agency/model.test.mjs` | 9/9 pass |
| **Typecheck** | `pnpm -r typecheck` | 0 errors across shared, server, and web |
| **i18n Compliance** | `pnpm --filter @agent-workbench/server exec tsx scripts/check-i18n.mjs` | "Todo bien" (100% pass) |
| **Web Production Build** | `pnpm build` | 0 errors |

---

## 8. Integration Steps

1. **Protocol Dispatch**: The authenticated `/ws` dispatcher in `terminal-socket.ts` routes notification client requests to `AgencyNotificationStore` and `TabActivityManager`, and broadcasts snapshots on connection.
2. **Terminal Output Streaming**: Shell terminals have their PTY output streams attached to `ShellIntegrationParser` via `registry.attach(terminalId, shellOutputListener)`.
3. **Frontend Mounting**: `AgencyApp.tsx` initializes `useNotificationStore(transport, store.request)`, mounting `<NotificationBell />` in the topbar, `<NotificationInbox />` popover, and `<NotificationToastContainer />` at root.
4. **Zero Live Activation**: Live systemd units or external services remain unmerged and unactivated.

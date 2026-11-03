# Lane C: Cross-Lane Integration Contract & Coordinator Specification

## 1. Overview & File Ownership Boundary

Lane C owns all notification and activity management modules under:
- `packages/server/src/agency/tab-activity-manager.ts`
- `packages/server/src/agency/agency-notification-store.ts`
- `packages/web/src/agency/useNotificationStore.ts`
- `packages/web/src/agency/focus-tracker.ts`
- `packages/web/src/agency/NotificationInbox.tsx`
- `packages/web/src/agency/NotificationToast.tsx`
- `packages/web/src/agency/notification-labels.ts`
- `packages/web/src/agency/AgencyApp.tsx`
- Shared notification protocol types and validators
- All notification-focused acceptance test suites

Lane C has strictly respected the ownership boundaries and **did not modify**:
- `packages/server/src/terminal-socket.ts`
- `packages/server/src/terminal-registry.ts`
- `packages/server/src/index.ts`
- `packages/server/src/pty-host/**`
- `packages/desktop/main.mjs`
- `packages/web/src/TerminalView.tsx`
- Native layout or drag components

---

## 2. Integration Contract with Lane A (PTY Supervisor)

### Invariants:
1. **Server Restart Resilience:**
   `TabActivityManager.initialize()` treats in-flight tasks (`working`) upon server boot as `unknown` with `reliableSignal: false`. When Lane A's supervisor restarts the server while PTYs remain alive, the supervisor reconnects to the PTY and re-establishes the native turn follower.
2. **Turn Sequence Monotonicity:**
   `TabActivityManager` stores the highest recorded `turnSequence` per tab. When Lane A reconnects to an existing PTY after a restart, subsequent turns will advance from `turnSequence + 1`, ensuring that turn identities never collide with pre-restart completions.
3. **PTY Disconnect Semantics:**
   A WebSocket or transport disconnect MUST NOT be interpreted as agent process termination. PTY processes remain running in the supervisor.

---

## 3. Integration Contract with Lane B (Electron / Desktop)

### Specification for Native WebContentsView Focus Reporting:
Lane C's `focusTracker` listens to `mawChatGpt.subscribe` for:
```ts
{ type: 'focused', id: string }
```
When `main.mjs` observes pointer interaction or focus inside a native `WebContentsView`, it dispatches this event.

### Recommended Coordinator Hardening for `packages/desktop/main.mjs`:
In `packages/desktop/main.mjs`, when the shell BrowserWindow loses OS focus to another application:
Emit `{ type: 'window-blur' }` or ensure `win.on('blur')` fires cleanly so that notifications while minimized or running in background OS workspaces reliably transition to OS desktop notifications.
Lane C currently handles this by observing `window.onblur` and `document.visibilitychange`.

---

## 4. Integration Verification Suite

Lane C delivers deterministic acceptance test fixtures ready for the coordinator:
- `pnpm --filter @agent-workbench/server exec tsx --test src/agency/notification-acceptance-suite.test.ts`
- `node --test packages/web/src/agency/notifications.test.mjs`
- `node --test packages/web/src/agency/notifications-browser-acceptance.test.mjs` (Headless Chromium Playwright)
- `packages/server/node_modules/.bin/tsx --test packages/web/src/agency/focus-tracker.test.ts`

# Lane C: Reliability Audit & False-Positive Risk Analysis

## 1. Audit Summary

Prior to Lane C, several critical notification defects existed in the codebase:
1. **Unreachable Completion Wiring (N1):**
   Completions for Claude Code, OpenCode, and Antigravity required `completionEvidence === 'status-transition'`, which the server production socket hook omitted.
2. **Missing OS Desktop Alerts for Completions (N2):**
   Completions produced only transient in-app toasts (6.5s) and inbox entries. Users on other OS virtual workspaces or in other applications received zero notification.
3. **Incomplete Focus Suppression (N3):**
   Toasts were suppressed based on `document.hasFocus()`, which broke when clicking into child WebContentsViews (ChatGPT), while failing to verify active workspace and archive status.
4. **Attention Events Bypass (N4):**
   Waiting-for-input notices ran through a fragile client-diff heuristic without deduplication, persistence, or click navigation.
5. **Notification Storm Vulnerability:**
   Multiple concurrent agent completions could spam the user with simultaneous desktop alerts.

---

## 2. Remediations Implemented & Confirmed

| Finding | Remediation | Verification Evidence |
| :--- | :--- | :--- |
| **N1: Unreachable CLI Completions** | Wired `completionEvidence: 'status-transition'` in server socket handler; verified in `TabActivityManager` with table tests. | `cli-completion-wiring.test.ts`, `notification-acceptance-suite.test.ts` (100% pass) |
| **N2: OS Desktop Alerts** | Integrated dual-channel dispatch: when MAW is unfocused or minimized, OS desktop alert is dispatched with interactive `onclick` navigation. | `focus-tracker.test.ts`, `notifications.test.mjs` |
| **N3: Focus Suppression** | Implemented `FocusTracker`: models window focus, native view focus, active workspace selection, active pane, and selected tab. | `focus-tracker.test.ts`, Playwright browser acceptance |
| **N4: Unified Waiting for Input** | Unified `needs-input` lifecycle into `TabActivityManager` and `useNotificationStore`: stable per-turn deduplication, inbox persistence, and focus suppression. | `notification-acceptance-suite.test.ts`, `notifications.test.mjs` |
| **Anti-Storm / Burst Throttling** | Coalesces $\ge 3$ rapid alerts within 2s into a single grouped OS notification; bounds visible toasts to 4. | `notifications.test.mjs`, unit assertions |
| **Store Capacity & Retention** | Bounded inbox capacity to 150 items with FIFO pruning of acknowledged/read items, while permanently preserving deduplication keys. | `notification-acceptance-suite.test.ts` (Acceptance 8) |

---

## 3. Residual False-Positive & Edge-Case Analysis

1. **Unconfigured Antigravity Status Line:**
   If a user runs an Antigravity CLI profile without having generated the statusline JSON script, no status file is written.
   *Residual Risk:* Stays `unknown` / `idle`; never emits false completion.
   *Safety Evaluation:* 100% safe (satisfies "prefer missing uncertain completion over false alert").
2. **Terminal Emulator Silence / Stalls:**
   *Residual Risk:* None. Completion is NEVER inferred from silence, timeouts, or PTY pause.
3. **Wayland Window Focus Edge Cases:**
   Under certain Wayland compositors (GNOME, Sway), `document.hasFocus()` may report true when another window is focused in a multi-monitor setup without a focus grab.
   *Mitigation:* Click-navigation and in-app toasts remain visible; inbox badge persists unread state.
4. **Browser Tab WebRequests:**
   *Residual Risk:* Browser completion remains disabled by default, truthfully reporting `unknown`. Zero false positive risk.

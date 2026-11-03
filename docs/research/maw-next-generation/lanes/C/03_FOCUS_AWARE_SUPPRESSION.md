# Lane C: Focus-Aware Suppression & Notification Channel Policy

## 1. Objective

To make notifications quiet and respectful of developer flow:
- When a user is **actively viewing** a session, do not interrupt them with redundant toasts or OS chimes.
- When a session completes in a **different tab or workspace**, deliver a clear in-app toast and inbox entry.
- When MAW is **minimized, hidden, or another OS application has focus**, deliver an OS desktop notification.
- Clicking any notification immediately focuses MAW and navigates to the target workspace and session.

---

## 2. Formal Actively Viewed Predicate

A session tab $T$ in workspace $W$ is **actively viewed** if and only if all of the following conditions hold:

$$\text{ActivelyViewed}(W, T) \iff \text{WindowFocused} \land \neg \text{WindowMinimizedOrHidden} \land \neg \text{ShowingDone} \land (\text{ActiveWorkspace} = W) \land \text{TabVisibleAndSelected}(T)$$

Where:
- $\text{WindowFocused}$: Either the shell renderer has focus (`document.hasFocus()`) OR an attached native `WebContentsView` has focus (`focusTracker.isWindowFocused()`).
- $\neg \text{WindowMinimizedOrHidden}$: `!document.hidden` and `document.visibilityState === 'visible'`.
- $\neg \text{ShowingDone}$: MAW is not displaying the Done archive view.
- $\text{ActiveWorkspace} = W$: The currently selected workspace matches the session's workspace.
- $\text{TabVisibleAndSelected}(T)$: $T$ is the active tab in the focused pane (`activeTabId === T`) OR tracked by `nativeLayoutCoordinator.isViewing(T)` OR has native focus.

---

## 3. Channel Routing Matrix

| Condition at Event Time | Channel Action | Target Behavior |
| :--- | :--- | :--- |
| **Actively Viewed** (window focused, active workspace, tab selected in pane) | `suppress` | No in-app toast. No OS desktop notification. Inbox item recorded; inspected and acknowledged by active pane inspection. |
| **Focused MAW, Different Tab** (user focused on Tab A in Pane 1; Tab B completes) | `toast` | In-app floating toast displayed (6.5s auto-dismiss). Inbox unread badge incremented. Clicking toast navigates to Tab B. |
| **Focused MAW, Different Workspace** (user in Workspace 1; agent completes in Workspace 2) | `toast` | In-app floating toast displayed. Clicking toast switches workspace and selects tab. |
| **Unfocused MAW** (another OS app focused, e.g. VS Code, browser, terminal) | `os` | OS desktop notification dispatched (`new Notification(...)`). Clicking focuses window (`window.focus()`) and selects tab. |
| **Minimized / Occluded MAW** (`document.hidden === true`) | `os` | OS desktop notification dispatched. Clicking restores window and selects tab. |
| **Rapid Burst** ($\ge 3$ events within 2000 ms) | `os` (batched) | Coalesces into a single grouped OS notification (`"N coding agents completed tasks"`, tag: `maw-burst-summary`). In-app toasts bounded to 4. |

---

## 4. Electron WebContentsView vs. Shell Focus Modeling

In Electron, child `WebContentsView` instances (used by ChatGPT, Perplexity, and GitHub tabs) run in separate WebContents from the shell renderer. When a user clicks inside a native browser view, the shell renderer receives a `window.blur` event, causing `document.hasFocus()` to become `false`.

Lane C's `FocusTracker`:
1. Subscribes to the desktop IPC bridge (`window.mawChatGpt.subscribe`).
2. Listens for `{ type: 'focused', id }` emitted by `main.mjs` when native clicks occur.
3. Debounces window blur transitions: if blur was triggered by native view pointer activation, window focus is preserved.
4. Distinguishes genuine application blur (switching to another OS app) from internal WebContentsView focus shifts.

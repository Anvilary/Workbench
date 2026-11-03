# Lane C: Browser Completion Feasibility & Audit Findings

## 1. Executive Summary

- **Recommendation:** Keep ChatGPT and Perplexity completion detection **disabled** in production (`unknown` state).
- **Core Principle:** Prefer missing an uncertain completion over delivering a false completion notification.
- **Privacy & Security Constraints:** No token/authentication interception, no DOM scraping of conversation bubbles, no reverse-engineered API interception, and no continuous polling of fragile DOM selectors.

---

## 2. Evaluation of Candidate Completion Signals

| Approach | Feasibility | Failure Modes & Risks | Recommendation |
| :--- | :--- | :--- | :--- |
| **Site-issued Web Notifications** | Low | MAW currently denies the `notifications` permission for browser tab partitions (`policy.mjs`). Even if granted, notifications are origin-scoped, uncontrolled by MAW, and do not integrate with workspace/pane focus. | Reject |
| **DOM Scraping** (e.g. observing stop button disappearance, response container mutation) | Unacceptable | Violates security and privacy boundaries. Requires page-world injection into authenticated accounts. Fragile across frontend updates, A/B testing, and model variant interfaces. | Reject |
| **Page Title / Favicon / Audio Polling** | Unreliable | Title updates are coarse, delayed, or absent during multi-turn generation. Favicon manipulation is fragile and not designed as an execution contract. | Reject |
| **Network Request Stream Timing** (`session.webRequest`) | Moderate (Technically Viable for Standalone SSE, Unverified for Production ChatGPT) | Observes only request metadata (URL, method, status, duration). Measured on local SSE stand-in (Electron 45): accurately captures end-of-stream. However, in production: (1) real endpoints change without notice; (2) multi-turn tools/search produce multiple distinct streaming requests; (3) user abort and navigation both map to `net::ERR_FAILED`, making it impossible to separate abort from network failure. | Unverified / Keep Disabled |
| **Companion WebExtension Bridge** | High (Architecturally Sound) | Extension with explicit user-granted permissions provides token-bound, authenticated status bridge (`BrowserActivityProvider`). Truthfully reports state when companion is active. | Supported Architecture, Default Disabled |

---

## 3. Production Behavior

In the absence of a cryptographically verified companion bridge, browser tabs truthfully report activity state as `unknown`.
This guarantees that false completion alerts are NEVER fabricated for browser tabs.

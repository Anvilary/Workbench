IN_PROGRESS

# Recommendations

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: audit initialized; no implementation, tests, browser behavior, or security properties have yet been verified.  
Last completed step: verified clean integration worktree, branch/remote/PR head, created separate audit worktree.


## Provisional engineering priorities — audit incomplete

These are limited to established findings and will need revision after the remaining audit. No implementation has been changed.

### Group A — before manual QA involving named Codex profiles

- SEC-001 (P1): ensure discovery and history reads are bound to a verified effective native home for each launch; when a wrapper's effective home is opaque, report history/discovery unavailable and do not attribute a server-home rollout. Preserve the single native PTY and upstream adapters. Requires dual-home wrong-attribution and history tests and an account-safe wrapper identity strategy. An integration agent must decide how to establish the effective home without exposing or changing credentials. Full browser disclosure and native resume impact remain unverified.

### Group B — before merge

- FUNC-001 (P2): ensure every aborted picker open releases its late server allocation and show initial picker errors even when no listing arrived; test delayed replies and repeated open/cancel, multiple outstanding requests and reconnect. Shared picker is upstream infrastructure, so test its other consumers as well.
- TEST-001 (P2 coverage gap): correct false-positive exit/terminal output/WS rejection assertions and add negative tests; run the real focused/browser suites at the final implementation SHA. Do not count the 25 labels as complete acceptance.
- Resolve the historically cross-profile native resume policy and test enforcement if profiles own sessions; current fake-registry test demonstrates acceptance after exit but does not establish a security exploit.

### Group C — after initial release, conditional on the remaining audit

No performance optimization is recommended solely from current measurements. The 1.13 MB raw / 310 kB gzip main bundle is a measurement, not yet a demonstrated bottleneck. Collect cold/warm parse and startup distributions, output-load and memory evidence before deciding on splitting or other changes.

Dependencies and regression risks: account isolation requires an explicit identity mechanism, not guessing a wrapper's internal environment; profile discovery, history and resume must agree on ownership. Picker cleanup must preserve concurrent consumers and socket scoping. All groups remain provisional pending completion of the audit.

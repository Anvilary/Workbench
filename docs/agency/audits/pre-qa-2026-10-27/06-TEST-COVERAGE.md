IN_PROGRESS

# Test Coverage

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: audit initialized; no implementation, tests, browser behavior, or security properties have yet been verified.  
Last completed step: verified clean integration worktree, branch/remote/PR head, created separate audit worktree.


## Focused suite reruns (independent, 2026-10-27)

- `corepack pnpm --dir packages/server exec tsx --test src/agency/domain.test.ts src/agents/profiles/profiles.test.ts src/agency/runtime/agency-session-runtime.test.ts`: 48 passed, 0 failed/skipped, Node 24.22.0, 3.96 s. Includes disposable node-pty tests; many runtime tests use fake registries. Full assertion and fixture audit remains incomplete.
- `node --experimental-strip-types --test packages/web/src/agency/model.test.mjs`: 9 passed, 0 failed/skipped, 0.11 s; pure model tests, not browser verification.
- Synthetic SEC-001 reproduction: component-level wrong-home attribution confirmed (see 03). These suites do not prove profile-scoped Codex discovery.
- E2E and screenshot suites not rerun yet. Do not equate prior PR claims with independent runs.

## E2E rerun and audit (partial)

25/25 numbered checks reported passed under Node 24.22.0 using frozen offline dependencies and a temporary pnpm shim, real localhost server, a headless Chrome empty-state browser and disposable homes. Check #13 uses a WebSocket test client, not an actual browser reconnect; #21 tests a mocked AgentConnection socket, not an end-to-end browser disconnect. Four empty-state document widths had no document overflow. Actual assertion quality is narrower than labels: see TEST-001. The numbered count is not a count of independent user acceptance scenarios.

Screenshot script rerun passed eight distinct fixture screenshots and scripted checks, with no reported page or console errors. Script asserts page errors are empty but only logs console errors; it uses explicit waits and a one-second sleep. Coverage is partial as detailed in 04, especially real provider behavior, heavy lists/output and accessibility.

## Priority gaps established so far

1. Dual-home Codex discovery, wrong-account history isolation and native resume using synthetic rollouts and a real integrated socket/UI path (SEC-001).
2. Folder picker open/cancel before first reply, eight or more repetitions, reopen, socket reconnect, and visible initial failure (FUNC-001).
3. Negative controls for missing exit code, echo-only output, ANSI and unrelated WebSocket connection errors (TEST-001).
4. Historical session resume across profiles after exit; define ownership policy and test it explicitly.
5. Browser active-output/reconnect, large transcript, 5/20 and long-running 10/50 workloads, focus/accessibility, listeners and resource growth. These remain unverified, not claimed failing.

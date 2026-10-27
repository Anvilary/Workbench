NOT_STARTED

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

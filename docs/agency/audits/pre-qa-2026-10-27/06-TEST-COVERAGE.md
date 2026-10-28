IN_PROGRESS

# Test Coverage

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: major audit phases remain incomplete; conclusions are limited to the evidence documented below and in 00-STATUS.md.  
Last completed step: initialized and pushed audit checkpoints; most recent completed investigation is FUNC-001 browser reproduction (checkpoint 00j).


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

## Continuation 02 — authenticated socket and picker recovery

Disposable production server: actual WS `unexpected-response` HTTP status is 403 for each of bad token, foreign Origin, and foreign Host (three independent attempts; transport errors cannot satisfy these assertions). An Agency workspace.create containing arbitrary cwd is rejected as `Invalid Agency request`. Exhaust eight pickers, observe ninth `picker-failed`, close that socket, connect fresh socket without Origin using valid token, and receive a new picker listing. Reattach existing shell, execute `printf '%s%s\\n' 'EXECUTED_' 'MARKER'`; assert joined EXECUTED_MARKER in actual terminal.output, then `exit 42` and assert the exact runtime row publishes exitCode 42. This extends earlier E2E coverage using non-echo output and real exit code. Fixture `/tmp/agency-audit-boundaries.mjs`, same isolated setup as 05 screenshot harness. FUNC-001 reconnect workaround is now verified at socket level; browser remains responsible for refreshing state.

## Final assertion review additions

Existing focused tests were already independently run (48 server + 9 frontend), so were not repeated wholesale. Reviewed their concurrency, guard, corruption and native registry assertions: many runtime tests use fake registry/store; source labels do not prove browser behavior. `runtime/agency-session-runtime.test.ts:681–728` uses a real PTY but its AFTER_INTERRUPTION literal can also be matched in echoed command; TEST-001 regression scope must include this focused assertion. `domain.test.ts:113–129` spawns a child unrelated to the store/runtime: proves metadata operations leave that child alive but not integrated Done/Restore process ownership. Keep the new strict split-marker/exit42 socket fixture as an acceptance pattern.

Additional independent `corepack pnpm --dir packages/server exec tsx scripts/check-remote-access.mjs` passed (final output Todo bien). Tests use disposable stores, deterministic crypto fixtures and no provider calls; they do not cover Agency profile mutation policy, now reproduced as SEC-002. Existing screenshot focus checks cover Tab trapping and Escape restoration; first-load picker error visibility fails under FUNC-001. Source useAgencyStore.ts:35–65,140–157 demonstrates offline immediate-send and pending cancellation; prior mocked transport test covers no replay. Actual browser reconnect fixture is added separately; do not infer delivery guarantees for an in-flight mutation whose response was lost.

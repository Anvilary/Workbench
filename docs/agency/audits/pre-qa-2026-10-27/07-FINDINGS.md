IN_PROGRESS

# Findings

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: major audit phases remain incomplete; conclusions are limited to the evidence documented below and in 00-STATUS.md.  
Last completed step: initialized and pushed audit checkpoints; most recent completed investigation is FUNC-001 browser reproduction (checkpoint 00j).


## Confirmed defects

### SEC-001 — Codex discovery is not scoped to a profile's actual native home
- Severity: P1; confidence: high for wrong-home discovery and wrong-ID attribution, demonstrated in synthetic discovery fixture. End-to-end disclosure and actual wrapper behavior remain unverified. Category: security and functional reliability.
- Affected: `packages/server/src/agents/codex/paths.ts:82`, `discovery.ts:175`, `index.ts:187`, `history.ts:110`, `find-rollout.ts:150`, `packages/server/src/terminal-registry.ts:742`, `packages/server/src/agency/agency-profile-capabilities.ts:159`.
- Observed: provider discovery/history resolve the server home; a configured wrapper may start its CLI with a different home, unavailable to the hook. Expected: discovery, readers and ownership use a trustworthy, profile-scoped home; otherwise fail closed as unavailable.
- Reproduction: with two synthetic homes, register a pending terminal representing profile B while the server uses A; write fixture rollouts under each. This component-level test does not launch a wrapper, read real histories, or run inference. Observed: after a rollout is written under B, scan reports no ID; after a matching rollout is written under A, scan reports the A ID for B’s pending terminal. Full command and fixture in 03-SECURITY.md.
- Cause/evidence: `codexHome()` reads server process env, and `onSpawned` has no native-home input. Matching only uses cwd/time/text; wrong-account assignment requires an independently matching A rollout; this was demonstrated with synthetic data, not a real account.
- Impact: missing session discovery and history; wrong-account ID assignment is demonstrated at component level; transcript exposure and bad resume are plausible but not yet demonstrated. Scope: medium, cross-cutting adapter/provider boundary. Correction: represent a verified effective native home per profile and thread it through discovery and history; for opaque wrappers whose home cannot be established, disable profile-specific discovery/history rather than guess. Preserve existing Workbench behavior.
- Regression: disposable dual-home rollout fixture; matching cwd/time in both homes, assert only the correct profile is attributed/read and unavailable identity fails closed; test resume ownership.


### FUNC-001 — closing folder picker before first response leaks its server allocation
- Category: confirmed functional defect; severity P2; confidence high in deterministic delayed browser reproduction. Affected: `packages/web/src/FolderPicker.tsx:62-85,145-147,187`, `packages/server/src/directory-picker.ts:43,145-151`, `packages/server/src/terminal-socket.ts:2621-2644`.
- Observed: close picker before first response eight times on the same socket; ninth open is rejected and remains on a loading message without displaying the error. Expected: abandoned open requests release the server picker and initial errors are visible.
- Reproduction: actual browser and server, intercept and delay only `picker.listing` by 500 ms, open and close before it arrives, wait for late delivery, repeat eight times and reopen. Instrumentation recorded 8 listings, 1 `picker-failed`, and stuck loading. Full sanitized fixture in 02.
- Root cause: cleanup can send close only after a picker ID has arrived; late replies have no subscriber. `problem` is rendered only after a non-null listing.
- Impact: workspace folder selection can become unusable for the socket until reconnect; affects slow disk/connection and rapid cancellation. No evidence of data loss. Fix: correlate/cancel open and clean up late allocations, render first-load failures. Scope: small to medium across picker protocol/UI. Regression: delayed replies, rapid close/reopen, repeat beyond limit, prove no server picker leak and visible failures.

## Probable defects

None established.

## Unverified risks

Cross-profile transcript disclosure and bad resume under SEC-001 have not been demonstrated end to end. Potential native-home protection gaps require inspection.

### Unverified risk — historical profile ownership on resume

Synthetic runtime fixture confirms an inactive native ID previously recorded under `codex-0` is accepted under `codex-3` after exit. Actual account exposure is unproven, and the foundation contract does not explicitly settle whether transferring a native ID across named profiles is permitted. Check the intended identity policy and real adapter capability; see 03 for exact reproduction. No severity assigned until the requirement and impact are established.


## Performance opportunities

No optimization supported by measurements yet.

## Test coverage gaps

### TEST-001 — E2E assertions can pass without proving labeled terminal/security behaviors
- Category: test coverage gap; severity P2; confidence high; scope small. `packages/server/scripts/check-agency-e2e.mjs:148-180,490-512,514-551,680-701,728-737`; session schema `packages/shared/src/agency-protocol.ts:82-94`.
- Observed: check #18 accepts `exitSignal !== null`, but AgencySessionBase defines no `exitSignal`, so `undefined !== null` is true even when exitCode is null. The observed passing run printed `Signal: undefined`. Checks #11/#12/#16 accept literal marker text present in the input command, so terminal line echo can satisfy the check without ANSI rendering, interrupt completion or successful command execution. WebSocket rejection checks accept any error, including transport failures, as rejection.
- Expected: assert an actual exit code and/or an explicitly supported signal; distinguish command echo from output using a generated marker not appearing literally in the input; check actual escape sequences and shell execution; require expected HTTP upgrade refusal status.
- Reproduction: inspect check #18 with `{ lifecycle: 'exited', exitCode: null }`: the predicate evaluates true because the absent signal is undefined; the real passing run displays undefined. Inspect marker commands and predicates; potential false positives are source-demonstrable, not proof that the implementation's Ctrl+C actually fails.
- Impact: passing acceptance counts overstate verification, risking missed defects before release. Regression: add negative self-tests with absent exit code, echo-only output, and unrelated socket errors and prove each fails.


## Cosmetic issues

None established.

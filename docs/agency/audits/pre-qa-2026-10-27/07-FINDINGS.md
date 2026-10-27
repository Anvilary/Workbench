NOT_STARTED

# Findings

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: audit initialized; no implementation, tests, browser behavior, or security properties have yet been verified.  
Last completed step: verified clean integration worktree, branch/remote/PR head, created separate audit worktree.


## Confirmed defects

### SEC-001 — Codex discovery is not scoped to a profile's actual native home
- Severity: P1 provisional; confidence: high for source-level home mismatch, unverified for actual wrapper and disclosure scenario. Category: security and functional reliability.
- Affected: `packages/server/src/agents/codex/paths.ts:82`, `discovery.ts:175`, `index.ts:187`, `history.ts:110`, `find-rollout.ts:150`, `packages/server/src/terminal-registry.ts:742`, `packages/server/src/agency/agency-profile-capabilities.ts:159`.
- Observed: provider discovery/history resolve the server home; a configured wrapper may start its CLI with a different home, unavailable to the hook. Expected: discovery, readers and ownership use a trustworthy, profile-scoped home; otherwise fail closed as unavailable.
- Reproduction: using two synthetic homes, launch/configure a safe fixture wrapper which selects home B while the server uses home A; write a valid fixture rollout under B and observe discovery still scans A. Do not read actual histories or run inference. Reproduction has not yet been executed.
- Cause/evidence: `codexHome()` reads server process env, and `onSpawned` has no native-home input. Matching only uses cwd/time/text; wrong-account assignment requires an independently matching A rollout and remains unverified.
- Impact: missing session discovery and history; wrong-account assignment/history exposure and bad resume are plausible but not yet demonstrated. Scope: medium, cross-cutting adapter/provider boundary. Correction: represent a verified effective native home per profile and thread it through discovery and history; for opaque wrappers whose home cannot be established, disable profile-specific discovery/history rather than guess. Preserve existing Workbench behavior.
- Regression: disposable dual-home rollout fixture; matching cwd/time in both homes, assert only the correct profile is attributed/read and unavailable identity fails closed; test resume ownership.

## Probable defects

None established.

## Unverified risks

Cross-profile wrong-home rollout assignment and disclosure under SEC-001 have not been demonstrated. Potential native-home protection gaps require inspection.

## Performance opportunities

Not measured.

## Test coverage gaps

No independent full coverage review yet.

## Cosmetic issues

None established.

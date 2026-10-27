IN_PROGRESS

# Audit status

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: audit initialized; no implementation, tests, browser behavior, or security properties have yet been verified.  
Last completed step: verified clean integration worktree, branch/remote/PR head, created separate audit worktree.

## Checkpoint 00 — initialization

- Audited SHA: `90a74a4fb12364e888e78cd72927f24898ca0950`; PR #5 is open against `dev`, and local integration, remote integration, and PR head match this SHA.
- Audit worktree: `/home/user/Projects/Agency-UI-audit`.
- Original integration worktree: clean, on `feat/agency-integration`. Existing main worktree remains untouched.
- Completed: inventory, isolated worktree, initialize reports. Measurements: none. Verified findings: none. Hypotheses: none.
- Latest checkpoint commit SHA: resolve with `git rev-parse HEAD` at this checkpoint; a commit cannot contain its own SHA.
- Blockers: none known. Push must be verified.
- Next action: verify checkpoint 00 push, read applicable review skill and architecture contract, PRs #1–5 and code, record evidence.

## Checklist

- [x] Phase 0: inspect state and initialize isolated reports (push to verify)
- [ ] Phase 1: architecture and lifecycle
- [ ] Phase 2: functional and reliability
- [ ] Phase 3: security and account isolation
- [ ] Phase 4: browser responsiveness
- [ ] Phase 5: repeated performance benchmarks
- [ ] Phase 6: test quality and coverage
- [ ] Phase 7: prioritized engineering plan
- [ ] Phase 8: final handoff

Resume: `cd /home/user/Projects/Agency-UI-audit && git status --short --branch && git log -1 --oneline` then read all files in this directory. Preserve the source SHA and findings identifiers. Modify only this report directory.

## Checkpoint 00a — preliminary architecture and Codex boundary

- Audited SHA unchanged. Completed: read checkpoint/initial PR #5 evidence, traced core server/store/runtime/registry hook and client state, reviewed source-level Codex home boundary. Phase 1 remains incomplete. Installed frozen dependencies offline in isolated audit worktree (pnpm 11.24.0); no tracked source changes. `jev` tools unavailable in session; no model calls or paid inference made.
- Verified: SEC-001 source-level home mismatch. Measurements: none. Unverified hypotheses: wrong-account attribution, exposure, and resume impact need synthetic reproduction; validate actual wrappers without reading secrets.
- Remaining: all phase checklists above; read foundation contract, complete PR/review inventory, lifecycle and authentication trace; construct disposable dual-home discovery reproduction.
- Exact next action: reproduce SEC-001 with synthetic rollout files, then examine wrappers safely and remaining architecture. Commands: `cd /home/user/Projects/Agency-UI-audit; corepack pnpm --dir packages/server exec tsx --test src/agency/runtime/agency-session-runtime.test.ts`; see findings for synthetic fixture design. Reports in this directory. Blockers: none. Latest checkpoint SHA: `git rev-parse HEAD` after this commit (self-hash cannot be embedded).

## Checkpoint 00b — independent focused tests and synthetic account boundary

- Completed: read tracked foundation contract; reran 48 backend and 9 frontend model tests (all passed); reproduced SEC-001 wrong-home attribution using synthetic rollout files and actual discovery component; built production UI. All major phases remain incomplete.
- Verified finding SEC-001 P1: mismatched home is ignored and a matching server-home ID assigned at discovery component level. The native wrapper entrypoints contain CODEX_HOME text; no real environment values or histories read. Transcript disclosure, real wrapper execution and resume remain unverified. Build output is 1,126.92 kB raw / 310.00 kB gzip; impact unmeasured.
- Exact next action: inspect current wrappers' home-selection code without copying path values, trace history subscription to assess disclosure, and run safe browser/E2E verification. Use a disposable PATH shim for `pnpm` because shell has no global shim. Full fixture command and script: 03-SECURITY.md. Focused test commands and results: 06-TEST-COVERAGE.md. Next checkpoint SHA: resolve `git rev-parse HEAD`; push and verify.
- Remaining: phases 1–8; no performance latency data. Blockers: none; Jev tools unavailable. Keep report-only tracked changes.

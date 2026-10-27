NOT_STARTED

# Security

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: audit initialized; no implementation, tests, browser behavior, or security properties have yet been verified.  
Last completed step: verified clean integration worktree, branch/remote/PR head, created separate audit worktree.


## SEC-001 — profile-scoped Codex discovery/history mismatch (source-confirmed; full impact not yet reproduced)

Profile launch permits a configured executable wrapper (`agency-profile-capabilities.ts:159-185`); allowlisted profile env overrides do not include CODEX_HOME (`agents/profiles/definition.ts:44-68`). A wrapper can change its child environment after spawn, which the server cannot infer from the launch plan. `agents/codex/paths.ts:82-104` uses `process.env.CODEX_HOME` or the server user's default. The shared adapter discovery defaults to this root (`agents/codex/discovery.ts:175-179,316-325`); `history.ts:110-113` and `find-rollout.ts:150-154` similarly use it. Thus a profile writing to another home is not discovered/read from that home. Discovery may assign a separate matching server-home rollout using cwd/timing, with no account field in matching (`discovery.ts:108-140,343-368`). That could attach other account history to this workspace; verify via synthetic fixtures before calling disclosure confirmed. Resume and ownership consequences require independent testing. No real account data has been accessed. See findings register for remediation and test.

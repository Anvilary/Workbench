NOT_STARTED

# Architecture

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: audit initialized; no implementation, tests, browser behavior, or security properties have yet been verified.  
Last completed step: verified clean integration worktree, branch/remote/PR head, created separate audit worktree.


## Preliminary map (not a completed phase)

`index.ts:485-518` loads workspace, profile and session stores, shares a workspace mutex and initializes the runtime before accepting requests. The runtime reconciles previously active rows as exited on restart (`agency-session-runtime.ts:186-208`); process lifetime belongs to TerminalRegistry, not the browser. `terminal-socket.ts:820-827,1028-1064,3200-3240` broadcasts runtime changes and dispatches Agency requests over the Workbench socket. `useAgencyStore.ts:35-65,77-157` correlates immediate requests, applies snapshots/events and refreshes on reconnect. `agency-session-runtime.ts:235-387` reserves the workspace slot, persists a starting row, prepares a provider launch, checks conflicting controllers and calls TerminalRegistry. The registry invokes the original adapter hook (`terminal-registry.ts:617-624,653-655,739-764`). Shutdown disposes runtime and registry (`index.ts:612-617`). Full auth, parser, process/event/terminal recovery trace and PR #1–4 review are incomplete.

Identity boundary: a launch can execute an opaque user-configured wrapper (`agency-profile-capabilities.ts:159-185`); profile env overrides explicitly exclude CODEX_HOME (`agents/profiles/definition.ts:44-68`). The Codex adapter creates one provider-wide discovery object (`agents/codex/index.ts:125-126`), and its hook receives cwd and timing, not an account/home (`index.ts:187-195`, `terminal-registry.ts:742-764`). Discovery and history resolve server-process CODEX_HOME, not any setting made inside a wrapper. See SEC-001.

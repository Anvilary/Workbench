FINAL — BOUNDED AUDIT COMPLETE

Final decision: bounded audit complete; final continuation sections below and 08/09 supersede historical checkpoint limitations. No performance refactoring before QA; Group A/B corrections remain required.

# Architecture

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`
Audit branch: `audit/agency-ui-pre-qa-20261027`
Date: 2026-10-28 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.
Limitations: synthetic/local bounded review; real-provider checks require manual QA. Earlier checkpoint sections are historical; final continuation conclusions supersede their incomplete-state statements.
Last completed step: integrated account isolation, critical boundary review, sustained PTYs, long transcript and browser reconnection; final backlog and handoff.


## Preliminary map (not a completed phase)

`index.ts:485-518` loads workspace, profile and session stores, shares a workspace mutex and initializes the runtime before accepting requests. The runtime reconciles previously active rows as exited on restart (`agency-session-runtime.ts:186-208`); process lifetime belongs to TerminalRegistry, not the browser. `terminal-socket.ts:820-827,1028-1064,3200-3240` broadcasts runtime changes and dispatches Agency requests over the Workbench socket. `useAgencyStore.ts:35-65,77-157` correlates immediate requests, applies snapshots/events and refreshes on reconnect. `agency-session-runtime.ts:235-387` reserves the workspace slot, persists a starting row, prepares a provider launch, checks conflicting controllers and calls TerminalRegistry. The registry invokes the original adapter hook (`terminal-registry.ts:617-624,653-655,739-764`). Shutdown disposes runtime and registry (`index.ts:612-617`). Full auth, parser, process/event/terminal recovery trace and PR #1–4 review are incomplete.

Identity boundary: a launch can execute an opaque user-configured wrapper (`agency-profile-capabilities.ts:159-185`); profile env overrides explicitly exclude CODEX_HOME (`agents/profiles/definition.ts:44-68`). The Codex adapter creates one provider-wide discovery object (`agents/codex/index.ts:125-126`), and its hook receives cwd and timing, not an account/home (`index.ts:187-195`, `terminal-registry.ts:742-764`). Discovery and history resolve server-process CODEX_HOME, not any setting made inside a wrapper. See SEC-001.

## Final architecture assessment

Single authenticated HTTP + /ws, existing TerminalRegistry and original provider adapters remain the process/transport authority. Agency owns project/workspace/profile/session metadata and maps runtime ID to terminal ID and separately to native ID. WorkspaceMutex spans deletion and launch reservation; browser detach preserves PTYs, Done/Restore only change metadata. Client useAgencyStore uses sendImmediate (no offline mutation queue), cancels pending requests on disconnect and refreshes four snapshots on reconnect; useConversation subscribes/unsubscribes by terminal. Registry onSpawned -> shared Codex discovery -> native-ID registry event -> runtime persistence and ConversationHub rebind -> server-home follower -> conversation.reset/append -> useConversation -> AgencyTranscript is the verified SEC-001 route. No per-launch native-home context exists at this boundary. A profile's public discovery capability being unavailable does not disable this upstream follower.

Ownership policy is active-controller exclusivity by provider/native ID, not a documented lifetime profile/account binding (CONTRACT invariants 7/9; runtime claim/release). Do not silently impose permanent named-profile ownership as an audit-proven requirement. The fixing agent must make profile/home trust explicit and ensure all history, discovery, protected-path and resume consumers agree. Opaque wrappers remain native PTYs with unavailable structured history until identity is established safely.

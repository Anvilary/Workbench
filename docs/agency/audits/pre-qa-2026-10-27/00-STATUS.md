IN_PROGRESS

# Audit status

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: major audit phases remain incomplete; conclusions are limited to the evidence documented below and in 00-STATUS.md.  
Last completed step: initialized and pushed audit checkpoints; most recent completed investigation is FUNC-001 browser reproduction (checkpoint 00j).

## Checkpoint 00 — initialization

- Audited SHA: `90a74a4fb12364e888e78cd72927f24898ca0950`; PR #5 is open against `dev`, and local integration, remote integration, and PR head match this SHA.
- Audit worktree: `/home/user/Projects/Agency-UI-audit`.
- Original integration worktree: clean, on `feat/agency-integration`. Existing main worktree remains untouched.
- Completed: inventory, isolated worktree, initialize reports. Measurements: none. Verified findings: none. Hypotheses: none.
- Latest checkpoint commit SHA: resolve with `git rev-parse HEAD` at this checkpoint; a commit cannot contain its own SHA.
- Blockers: none known. Push must be verified.
- Next action: verify checkpoint 00 push, read applicable review skill and architecture contract, PRs #1–5 and code, record evidence.

## Checklist

- [x] Phase 0: inspect state and initialize isolated reports; checkpoint push verified
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

## Checkpoint 00c — E2E and test assertion audit

- Independent E2E rerun: script reported 25/25 pass, using disposable data; actual Chrome was used only for empty-state loading/widths, while session exercises use WebSocket clients. Fixture inputs only. Found TEST-001 P2: exit-status predicate admits missing signal, terminal marker echo can satisfy several checks, and any WS error can masquerade as rejection. See 06/07.
- Further SEC-001 trace: conversation hub rebinds a follower to registry ID; actual rendered disclosure unverified. Three named wrapper files contain CODEX_HOME export assignments; values remain uninspected. No measurements beyond build size. No phases complete.
- Browser screenshot script running with disposable output when this checkpoint was written; inspect result. Next: record its outcome; build a repeated, populated-state browser benchmark and complete source architecture/security trace. Resume command `PATH="/tmp/agency-audit-bin:$PATH" AGENCY_SCREENSHOT_DIR=/tmp/agency-audit-shots corepack pnpm --dir packages/server exec tsx scripts/capture-agency-screenshots.mjs` (create disposable pnpm shim as described in handoff if missing). Avoid reporting token output. Latest SHA: `git rev-parse HEAD`; no known blockers.

## Checkpoint 00d — browser fixture and repeated warm latency

- Completed: screenshot fixture passed eight distinct states; no page/console errors printed, populated combined view and dialog fit four widths under script assertions. Collected 20-sample warm Playwright distributions: switch no PTY p50/p95/max 33.80/36.45/37.57 ms; idle active PTYs 56.19/61.49/64.26 ms; dialog open+close 33.61/44.89/48.80 ms; sidebar cycle 66.74/70.27/70.91 ms; composer fill 3.81/7.10/9.85 ms. Method and limitations in 05. Measurements do not prove behavior under output load.
- Findings unchanged: SEC-001 P1, TEST-001 P2; full application phases still incomplete. Unverified: end-to-end history disclosure, correctness and performance under large/active loads, startup, resource growth.
- Exact next action: independently benchmark cold/warm startup, server CPU/memory and sustained PTY output, then expand populated browser scenarios and complete architecture/security/test review. Fixture details 04/05, 03. Latest commit: `git rev-parse HEAD`; no known blockers. All checklist phases remain open.

## Checkpoint 00e — preliminary startup and resume ownership hypothesis

- Five sequential server launches with disposable state: HTTP-ready 1824.62 ms first empty-config, then 1031.38/1063.00/1065.97/1050.05 ms; OS cache not cleared, cannot claim machine-cold. Across n=5 p50 1063.00 ms, p95/max 1824.62 ms. Browser first navigation 188.71 ms, combined 20 same-context navigations p50 40.00, p95 54.29, max 188.71 ms. Method and complete disposable fixture script in 05.
- New unverified hypothesis: inactive native session resume accepts profile different from prior owner; source checks active-controller exclusivity but no prior-profile check seen. Reproduce and determine intended contract before assigning a finding. SEC-001/TEST-001 remain only confirmed IDs. Resource and output load tests not performed.
- Next: verify cross-profile resume with fake registry, review auth/security and architecture, benchmark CPU/memory and output load. All phases remain incomplete. Latest checkpoint: `git rev-parse HEAD` after commit; report-only tracked changes, no known blockers.

## Checkpoint 00f — cross-profile resume behavior

- Reproduced using a fake registry/provider: after a `codex-0` controller exits, the same native ID is accepted under `codex-3`; previous runtime tests cover only simultaneous exclusivity. No actual CLI/history access. Expected historical profile ownership is not explicit in foundation contract, so this remains an unverified risk, not a confirmed defect. Fixture and reproduction in 03.
- Known confirmed SEC-001 P1 and TEST-001 P2 unchanged. Startup and warm UI measurements are in 05; sustained output/resource benchmarks, populated scale, source security/architecture review and phase completions remain outstanding.
- Exact next: benchmark UI switching during sustained disposable PTY output and process resources; then complete review of security boundaries and lifecycle. See 00 checklist and 09. Latest SHA `git rev-parse HEAD` after commit; no known blockers.

## Checkpoint 00g — short output-load browser trial

- 20 switches during ~64 kB/s synthetic PTY output: p50/p95/max 56.97/66.26/68.75 ms, 1.17 s total. Same-run idle comparison 60.59/68.11/74.24 ms. No measured degradation at this small workload; no bottleneck established. Repro and qualifications in 05. Unmount cleanup source examined in 04, leak counts remain untested.
- Known findings SEC-001 P1, TEST-001 P2; historical profile reassignment remains an unverified risk. Major audit phases incomplete. Next finish idle process resource sampler already running, then sustained multi-PTY memory/fd tests and remaining security/architecture/test review. Latest SHA `git rev-parse HEAD`; no known blockers.

## Checkpoint 00h — idle process-group sample and auth trace

- Idle sample, connected page/no PTYs: 3 launch/server group processes, summed RSS 320,188 KiB for six one-second samples; fds 73 to 72; no CPU ticks over five intervals. This includes launchers, excludes browser, sums shared RSS and is not PSS or a stress test. Full method in 05. Began source tracing Host/Origin/token, socket validation and picker/lock; partial security notes in 03.
- Findings unchanged: SEC-001 P1, TEST-001 P2; cross-profile resume after exit is a behavior with unverified policy/impact. All phases remain incomplete. Exact next: finish auth/remote permission review, multi-PTY resource/load and scale tests, and architecture/security/reliability coverage. Checkpoint commit `git rev-parse HEAD` after commit. No known blockers.

## Checkpoint 00i — 10 projects / 50 workspaces browser fixture

- Expanded disposable fixture to 10 projects, 50 workspaces and 4 active idle synthetic PTYs. Screenshot assertions and four-width combined/dialog checks passed; console/page error counts 0. n=20 no-PTY switch p50/p95/max 41.85/49.35/49.74 ms; active-PTY 59.00/72.37/73.66 ms; other measurements/reproduction in 05. Single warm run; long sessions, output and larger transcript remain unverified.
- First setup hung because the temporary harness did not close pickers and reached the per-socket limit; cleaned up owned server/process and corrected harness. UI sends picker.close on unmount. Hypothesis only: rapid close before picker listing could leak a picker; reproduce before assigning a finding.
- Verified findings unchanged SEC-001 P1, TEST-001 P2; phase completion remains open. Exact next: reproduce rapid picker open/close timing with controllable reply delay; complete architecture/security/functional review and multi-PTY resource tests. `git rev-parse HEAD` for latest checkpoint.

## Checkpoint 00j — confirmed picker cancellation race

- Verified FUNC-001 P2: real browser/server with controlled 500ms delay, eight picker open/close cycles before replies, then ninth gets `picker-failed` while UI displays loading; 8 listings/1 error independently instrumented. No application files changed. Reproduction, root cause and targeted correction in 02/07.
- Other findings SEC-001 P1, TEST-001 P2. Historical cross-profile resume behavior remains unverified as defect. Completed phases: none; all major reviews are incomplete. Exact next: complete architecture/security review, confirm fresh reconnect recovers picker, stress server resources/multiple PTYs, then finish prioritization. Latest commit `git rev-parse HEAD` after commit; no known blockers.

## Checkpoint 00k — provisional priorities and standalone handoff

- Updated 08 with provisional A/B/C recommendations, 06 with focused coverage gaps and 09 with self-contained mission, evidence, metrics and a ready-to-paste resume prompt. Phase 0 complete and all major phases 1–8 remain incomplete. SEC-001 P1, FUNC-001 P2, TEST-001 P2 established. No P0 established. No performance bottleneck yet proven.
- Parent checkpoint before this commit: `6f67abb2c4ccf9fca59b6aa830e833e19af27d3e`; resolve current checkpoint with `git rev-parse HEAD` because a commit cannot encode its own hash. Next: follow exact next actions in 09, starting synthetic end-to-end account isolation and remaining architecture/security. Check origin equality. No blockers known.

## Checkpoint 00l — report consistency

- Corrected stale initialization metadata in all reports and grouped established findings under their proper categories. Clarified SEC-001 synthetic reproduction did not launch a wrapper. No new evidence or phase completions. Source SHA unchanged. Resume at 09 self-contained packet, beginning with end-to-end synthetic account-isolation and architecture/security review. Parent checkpoint `cba799d`; latest SHA is `git rev-parse HEAD` after commit. Push and verify.

## Continuation 01 — integrated synthetic wrong-home transcript (2026-10-28)

Real production server, real Codex adapter/registry/discovery/ConversationHub, headless Chrome and disposable shell wrapper: wrapper exports synthetic CODEX_HOME B and writes its effective value to a disposable sentinel; the harness asserts exact equality to B. Configure codex-0 to that executable and launch in a picker-created workspace. Write eligible session_meta + event_msg/user_message rollouts with matching cwd/current time: B marker stays absent after 1.5 seconds; writing distinct A UUID/marker under server CODEX_HOME A results in the exact A marker visible in AgencyTranscript within 15 seconds. Fixture output: `effectiveWrapperHomeVerified=true, wrapperHomeIgnored=true, serverHomeTranscriptRendered=true, realAccountsAccessed=false`. This confirms integrated synthetic transcript misattribution, **not real-account transcript disclosure**. No authentication files were created/read and no provider was invoked. Fixture `/tmp/agency-audit-account-browser.mjs`; disposable data/process group removed at exit.

Minimal fixture recipe: reuse the screenshot harness setup/request/createWs/launch code (05); replace its fake CLI with a shell script exporting B, writing B to a sentinel and waiting on stdin; assert sentinel equals B. Select Agent Only in Chrome; write B rollout UUID ...0051, wait 1500 ms and assert `.agency-transcript` absent; write A UUID ...0052 and `event_msg` user message `SERVER_A_SYNTHETIC_ONLY 0`; assert exact text visible. Use filename `rollout-YYYY-MM-DDTHH-mm-ss-<UUID>.jsonl` inside local-day sessions/YYYY/MM/DD, metadata `{id,timestamp,cwd,source:'cli'}` and timestamped user event `{type:'user_message',message,images:[],local_images:[],text_elements:[]}`. HOME/XDG/CODEX_HOME all temporary; keep launch token out of output.

Ownership conclusion: CONTRACT.md domain invariants 7 and 9 describe named executable configurations and native CLI resume, not permanent account principals. No historical profile-binding requirement is stated. Existing active-controller exclusion is explicit; do not promote accepted post-exit cross-profile resume into an exploit. Engineering must define ownership semantics before changing this behavior.

Smallest safe correction: carry an immutable verified effective native-home context from profile launch through registry descriptor, discovery registrations, history lookup/follow and resume. A configured wrapper path or literal CODEX_HOME text is not proof of its effective home. Until a trusted integration supplies identity, keep native PTY usable but disable profile history/discovery/resume requiring home identity, with visible unavailable state; never fall back to server home or execute opaque wrappers merely to probe credentials. Explicitly verified home must participate in protected-directory checks. Persist owner context for sessions if historical binding is adopted; legacy unknown ownership fails closed for profile-specific operations.

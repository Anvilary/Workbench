IN_PROGRESS

# Handoff and resume packet

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: major audit phases remain incomplete; conclusions are limited to the evidence documented below and in 00-STATUS.md.  
Last completed step: initialized and pushed audit checkpoints; most recent completed investigation is FUNC-001 browser reproduction (checkpoint 00j).

Mission: independently audit Agency-UI before user QA, without changing implementation, using disposable fixtures and no paid inference or credentials. Repo: `https://github.com/user/My-Amazing-Workspace`; PR #5 remains open and must not be modified. Audit branch/worktree: `audit/agency-ui-pre-qa-20261027`, `/home/user/Projects/Agency-UI-audit`. Source SHA is above. All ten report files were initialized; deeper phases are not started. Tests, metrics, findings and recommendations: none yet. No blockers identified yet.

Checkpoint SHA: resolve using `git rev-parse HEAD` on the pushed audit branch. Exact next action: verify checkpoint 00 pushed, read applicable review skill and start phase 1. Do not redo initial worktree inventory unless state has changed.

Ready-to-paste resume prompt:

> Continue the independent audit of Agency-UI PR #5. Fetch `audit/agency-ui-pre-qa-20261027`, read every report in `docs/agency/audits/pre-qa-2026-10-27/`, verify pinned source `90a74a4fb12364e888e78cd72927f24898ca0950` is the audit branch ancestor, resume the first incomplete phase, preserve stable finding IDs, and commit and push frequent checkpoints. Only modify that report directory. Never change implementation, disturb other worktrees, access credentials, run paid inference, or modify PR #5. See 00-STATUS.md and this handoff for current evidence and exact next action.

## Checkpoint 00a continuation

Architecture/security are partially reviewed, no phase is complete. SEC-001 establishes source-level Codex home mismatch; wrong-account disclosure remains unverified. Offline frozen dependencies installed in audit worktree. No benchmarks or independent test runs yet. Next: reproduce SEC-001 with two temporary synthetic homes and safe fixtures (no CLI inference, secrets or actual histories), inspect wrappers only enough to establish their home selection, continue lifecycle/security. Read 01, 03, 07 and 00 for evidence and task checklist. Do not repeat initial inventory or claim previous PR test reports as independent evidence. Latest checkpoint SHA is `git rev-parse HEAD` on audit branch; compare against remote before resuming. Jev judgment tools were unavailable; do not use paid inference.

## Checkpoint 00b continuation

Source SHA unchanged. Focused backend 48/48 and frontend 9/9 independently passed; production build succeeded (main JS 1,126.92 kB / 310.00 kB gzip). SEC-001: synthetic real-discovery fixture established wrong-home ID attribution; component-level only. Full fixture and command in 03, stable register in 07; do not repeat unless extending to a real server/browser. Browser, E2E and performance remain unmeasured. Root build script needs a `pnpm` shim on PATH here; direct corepack filtered build works. Resume: inspect wrapper home selection without exposing paths or credentials, follow transcript subscriptions, then conduct safe browser/E2E and quantitative benchmarks. Full foundation contract has now been read; do not repeat. Read 00 for full checklist. No phase complete.

## Checkpoint 00c continuation

25/25 E2E script checks passed in independent rerun, but see TEST-001 and 06 for misleading assertions and scope. SEC-001 component reproduction confirmed; further source path leads to conversation follower but actual disclosure not demonstrated. Screenshot script running in a temporary output directory at checkpoint time; verify process/results before rerunning. Recreate PATH shim if needed: `mkdir -p /tmp/agency-audit-bin; printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > /tmp/agency-audit-bin/pnpm; chmod 700 /tmp/agency-audit-bin/pnpm`. Do not publish tokens or screenshots. Next collect repeated browser measurements, verify security and complete phases; all remain partial.

## Checkpoint 00d continuation

Screenshots passed eight fixture states, four widths, no logged page/console errors. 20-sample low-load Playwright switch distributions: no PTY p50/p95/max 33.80/36.45/37.57 ms; idle active PTYs 56.19/61.49/64.26 ms. Dialog, sidebar and composer cycles in 05. Only warm, 5-workspace fixture; no high-volume output, startup or resource measurements. Full methodology and reproducible injection are in 05; screenshot originals in `/tmp/agency-audit-shots` are disposable and must not be committed. Top established: SEC-001 P1 and TEST-001 P2; disclosure unverified. Next perform startup/CPU/memory/output-load measurements, larger browser scenarios, and complete architecture/security review. Do not repeat focused tests or same basic screenshots unless needed to investigate a new issue.

## Checkpoint 00e continuation

Preliminary process startup and navigation results in 05: first empty-config HTTP-ready 1824.62 ms; four subsequent launches 1031.38–1065.97 ms (OS cache not cold); 20 same-context browser navigations p50 40.00, p95 54.29, max/first 188.71 ms. Full reproducible temporary script is embedded in 05. A potential cross-profile resume issue after previous controller exits is an unverified hypothesis, see 03. Exact next action: reproduce with fake provider/registry and determine expected ownership contract, then investigate output-load/resource growth and remaining auth/architecture/coverage. Do not interpret startup or low-load metrics as full phase 5 completion.

## Checkpoint 00f continuation

Fake-runtime test reproduced inactive native session ID acceptance under another profile. This is a verified behavior but an unverified defect/security impact until historical ownership policy and real CLI behavior are established; see 03. Do not repeat the fake test without extending it. Next measure sustained output and server resources, then finish architecture, security and remaining browser scale scenarios. SEC-001 and TEST-001 remain the two established findings. All phase checkboxes remain open.

## Checkpoint 00g continuation

Output-load trial: 20 switches, approximately 64 kB/s, p50/p95/max 56.97/66.26/68.75 ms; 1.17 s only. No optimization conclusion. Idle server process resource sampling is running at checkpoint time, record output or rerun the `/tmp/agency-audit-idle.mjs` disposable fixture if it no longer exists. Then prioritize longer multi-PTY stress and full security/architecture/coverage review. See 05 for reproducing output trial and startup; don't retest the same short scenario without extending it.

## Checkpoint 00h continuation

Idle server launcher process group (not browser) summed RSS 312.68 MiB, 3 processes, 72–73 fds, no CPU tick movement over five one-second intervals, no PTYs; caveats and reproducible sampler in 05. Initial Host/Origin/token and picker review in 03; security is incomplete. Next inspect remote permission policy, then perform multi-PTY resource/load and larger populated-state tests, and continue the complete architecture/security/functional/test audit. All phase boxes remain open. Latest pushed checkpoint SHA: obtain with `git rev-parse HEAD` and compare to origin.

## Checkpoint 00i continuation

10 projects / 50 workspaces and four idle fixture PTYs: eight screenshot states and four-width combined/dialog assertions passed; 20 switches no-PTY p50/p95/max 41.85/49.35/49.74 ms, active-PTY 59.00/72.37/73.66 ms. Repro and limits in 04/05. Setup initially exhausted 8 pickers due to a disposable harness bug, then passed after explicit picker close; this is not a product finding. An independent rapid close before initial picker reply may leak a picker (unverified hypothesis, 04); test deterministically. Next complete source review and multi-PTY load/resources. No phase is complete; SEC-001 and TEST-001 remain only established findings.

## Checkpoint 00j continuation

New confirmed P2 FUNC-001: a controlled 500 ms listing delay and 8 browser picker open/close cycles leak picker allocations; ninth request receives server `picker-failed` while UI shows loading. Exact reproduction and code in 02, full register entry 07. Other established findings SEC-001 P1 and TEST-001 P2; profile resume policy risk unverified. Next complete architecture/security and multi-PTY resource audit, confirm reconnect resets picker state, then prioritize. No major phase complete. Keep implementation unchanged.

## Self-contained mission and next-work packet

**Readiness:** AUDIT INCOMPLETE. The mission is an independent adversarial architecture, security, functional/reliability, browser responsiveness, performance and test-quality review before user QA. Do not change application code, PR #5, source branches, native credentials, provider authentication, or invoke paid inference. Only report files under this directory may be tracked changes. Source is fixed at `90a74a4fb12364e888e78cd72927f24898ca0950`; audit branch `audit/agency-ui-pre-qa-20261027` is a descendant in the separate audit worktree. Check PR head if needed, but do not silently change the pinned source.

**Current established findings (only three; no invented top ten):** SEC-001 P1 synthetic wrong-home Codex attribution; FUNC-001 P2 picker leak/error hiding under delayed response; TEST-001 P2 misleading E2E assertions. Full details and limitations in 07, reproductions in 02/03. A second-profile resume after original exit is demonstrated with fake runtime, but intent and real account impact are unresolved. No P0 confirmed. Actual cross-account transcript disclosure is not established.

**Completed phases:** phase 0 inventory, isolated worktree, report initialization and push checkpoints. All deeper phases are partial, including architecture, functional, security, browser, performance, coverage, recommendations and handoff. Foundation contract and parts of PR history were read; complete PR #1–4 review/previous reviews still needed. Security remains incomplete; no release-readiness conclusion.

**Verified commands/results:** focused server test command in 06: 48/48; frontend model 9/9; E2E script 25/25 subject to TEST-001; screenshot script 8 distinct states and four viewport layout checks, including a 10-project/50-workspace fixture. These use synthetic CLI or shells, never real provider inference. Production build succeeded via `corepack pnpm --filter @agent-workbench/web build`. Independent results apply to pinned source in this environment, not subsequent commits.

**Performance:** 05 contains complete environment, fixtures, repetitions, raw summaries and limits. Main JS 1,126.92 kB / 310.00 kB gzip. First empty-config process HTTP 1824.62 ms, four subsequent 1031.38–1065.97 ms (not machine-cold). 20 low-load switches p50/p95 33.8/36.45 ms no PTY, 56.19/61.49 ms idle PTY; 10/50 fixture 41.85/49.35 and 59.00/72.37 ms; short ~64 kB/s output trial 56.97/66.26 ms. Idle server launcher-group summed RSS 312.68 MiB, with shared pages potentially counted multiple times. No benchmark-backed bottleneck identified.

**Exact next actions:**
1. Trace native profile-to-history ownership end to end with synthetic dual-home sessions, including browser transcript and resume; review wrapper behavior without reading secret values. Resolve profile resume policy and audit protected directories when named wrappers choose homes.
2. Complete architecture/PR review and security/reliability scope from 00, including authenticated /ws, parser, all stores and failure/restart paths, client event races, path/symlink operations and remote permissions. Check reconnect after picker exhaustion.
3. Complete 5-project/20-workspace and remaining viewport scenarios, large synthetic transcripts/drafts, notifications, focus/accessibility and reconnection. Perform longer multiple-PTY throughput and replay tests, render profiling, resource/fd/process/listener growth, persistence latency, proper cold/warm startup and load CPU/memory. Record >=20 samples for small interactions, p50/p95/max/n, and do not invent cold-cache claims.
4. Complete a line-by-line E2E/screenshot/focused test quality review, run appropriate missing checks, then consolidate categorized findings and groups A/B/C. Preserve SEC-001, FUNC-001 and TEST-001 IDs.
5. After each meaningful phase or long investigation, update 00/07/09 and relevant report, commit and push. Do not re-run the focused 48/9, simple screenshot or synthetic proofs without extending them. Keep temporary scripts and screenshots out of Git.

**Resume commands:** `git fetch origin audit/agency-ui-pre-qa-20261027`; create a fresh worktree from `origin/audit/agency-ui-pre-qa-20261027` if the named worktree is unavailable; `git merge-base --is-ancestor 90a74a4fb12364e888e78cd72927f24898ca0950 HEAD`; read every report in this folder; `git rev-parse HEAD` gives the latest checkpoint commit, which cannot be embedded in itself. Verify remote equality before continuing. Offline install command: `corepack pnpm install --offline --frozen-lockfile` (audit worktree only). Temporary pnpm shim instructions and benchmark scripts appear above and in 05.

**Ready-to-paste resume prompt (complete):**

> Resume the independent Agency-UI pre-QA audit of PR #5 from branch `audit/agency-ui-pre-qa-20261027`. Fetch that branch; use a separate worktree; verify pinned source ancestor `90a74a4fb12364e888e78cd72927f24898ca0950`; read all reports in `docs/agency/audits/pre-qa-2026-10-27/`, especially the self-contained packet in 09 and checklist in 00. The audit is incomplete. Preserve SEC-001, FUNC-001 and TEST-001, existing evidence, uncertainty and metrics; start with the first incomplete tasks in 09 and do not repeat completed proofs without extending them. Use real browser and safe temporary fixtures, no provider inference, private histories or credentials. Only change report files; never modify app code, integration/main/dev/source branches, or PR #5. Update status/findings/handoff and commit/push after each substantial step. Deliver evidence-based recommendations and explicit readiness only when supported.

## Checkpoint 00l continuation

Report metadata and findings categories reconciled. SEC-001 synthetic demonstration registers a pending terminal and does not launch a wrapper; it is component-level. First next action remains synthetic end-to-end account isolation, followed by the rest of the self-contained packet. All deeper phases remain incomplete. Find current checkpoint with `git rev-parse HEAD` and compare to origin.

## Continuation 01 — integrated synthetic wrong-home transcript (2026-10-28)

Real production server, real Codex adapter/registry/discovery/ConversationHub, headless Chrome and disposable shell wrapper: wrapper exports synthetic CODEX_HOME B and writes its effective value to a disposable sentinel; the harness asserts exact equality to B. Configure codex-0 to that executable and launch in a picker-created workspace. Write eligible session_meta + event_msg/user_message rollouts with matching cwd/current time: B marker stays absent after 1.5 seconds; writing distinct A UUID/marker under server CODEX_HOME A results in the exact A marker visible in AgencyTranscript within 15 seconds. Fixture output: `effectiveWrapperHomeVerified=true, wrapperHomeIgnored=true, serverHomeTranscriptRendered=true, realAccountsAccessed=false`. This confirms integrated synthetic transcript misattribution, **not real-account transcript disclosure**. No authentication files were created/read and no provider was invoked. Fixture `/tmp/agency-audit-account-browser.mjs`; disposable data/process group removed at exit.

Minimal fixture recipe: reuse the screenshot harness setup/request/createWs/launch code (05); replace its fake CLI with a shell script exporting B, writing B to a sentinel and waiting on stdin; assert sentinel equals B. Select Agent Only in Chrome; write B rollout UUID ...0051, wait 1500 ms and assert `.agency-transcript` absent; write A UUID ...0052 and `event_msg` user message `SERVER_A_SYNTHETIC_ONLY 0`; assert exact text visible. Use filename `rollout-YYYY-MM-DDTHH-mm-ss-<UUID>.jsonl` inside local-day sessions/YYYY/MM/DD, metadata `{id,timestamp,cwd,source:'cli'}` and timestamped user event `{type:'user_message',message,images:[],local_images:[],text_elements:[]}`. HOME/XDG/CODEX_HOME all temporary; keep launch token out of output.

Ownership conclusion: CONTRACT.md domain invariants 7 and 9 describe named executable configurations and native CLI resume, not permanent account principals. No historical profile-binding requirement is stated. Existing active-controller exclusion is explicit; do not promote accepted post-exit cross-profile resume into an exploit. Engineering must define ownership semantics before changing this behavior.

Smallest safe correction: carry an immutable verified effective native-home context from profile launch through registry descriptor, discovery registrations, history lookup/follow and resume. A configured wrapper path or literal CODEX_HOME text is not proof of its effective home. Until a trusted integration supplies identity, keep native PTY usable but disable profile history/discovery/resume requiring home identity, with visible unavailable state; never fall back to server home or execute opaque wrappers merely to probe credentials. Explicitly verified home must participate in protected-directory checks. Persist owner context for sessions if historical binding is adopted; legacy unknown ownership fails closed for profile-specific operations.

## Continuation 02 checkpoint
Sustained eight-shell PTY trial and strict authenticated WS/picker reconnect/real command and exit-code checks completed; methodology/results in 02–06. No performance bottleneck established. Browser listener/heap growth is observed, attribution unverified. Next: finish long-transcript readiness sampling, verify paired-device profile configuration boundary, consolidate security review and final A/B/C handoff. App source remains untouched.

# Standalone fixing-agent handoff

**AUDIT COMPLETE — ENGINEERING HANDOFF READY.** This completes the finite independent audit, not release approval. Fix Group A before native-profile manual QA and Group B before merging PR #5. No implementation fixes were made.

Repository: https://github.com/user/My-Amazing-Workspace
Integration PR: https://github.com/user/My-Amazing-Workspace/pull/5
Exact audited application: `90a74a4fb12364e888e78cd72927f24898ca0950`
Audit branch: `audit/agency-ui-pre-qa-20261027`
Audit worktree: `/home/user/Projects/Agency-UI-audit`
Reports: `docs/agency/audits/pre-qa-2026-10-27/00-STATUS.md` through `09-HANDOFF.md`
Continuation start: clean local/remote `d2caa3fde5c332bed3842c7229013a398b7804bf`
Continuation checkpoints: `2bf0d2e` account/browser, `7b3a263` sustained/socket, `341d5f2` remote policy. Final checkpoint is the commit containing this handoff: `git rev-parse HEAD`, verify equality with `origin/audit/agency-ui-pre-qa-20261027`. A commit cannot contain its own hash.

Environment: Linux x86_64, Ryzen 7 250, 28.7 GiB RAM, Node24.22.0, pnpm11.24.0, Chrome155 headless. All tests used disposable HOME/XDG/CODEX_HOME and no-inference wrappers. No real authentication files, histories or tokens were inspected; no paid inference. Reports alone changed. Audit did not change main/dev/integration/PR#5. Fixing work needs a separate implementation branch/worktree and authorization appropriate to that task; this audit authorizes no deployment or merge.

## Confirmed findings and correction order

| Order / gate | Finding | Evidence, cause and impact | Narrow correction / required regression |
|---|---|---|---|
|1 / A|SEC-001 P1|Named profile wrapper selects B; shared Codex discovery/history select server A. Actual disposable wrapper writes verified effective B to sentinel; valid synthetic B rollout ignored; matching A UUID assigned, A-only transcript marker renders in Agency browser. No real-account data disclosure established.|Represent immutable verified native-home context per launch; thread through registry/discovery/history lookup/follow, protected dirs and resume. Opaque home must be visibly unavailable with no guessed server-home fallback. Keep native PTY usable. Dual-home identical-cwd/time tests must assert B sees only B, A marker/ID never reaches B, unknown identity fails closed; exercise resume and correct-home positive control.|
|2 / B|SEC-002 P2|With remote explicitly enabled on disposable fixed loopback port, pair device, connect with returned device cookie and no startup token. agency.profile.configure persists executable/argv; same device gets remote-refused for valid settings.update. New Agency route bypasses existing host-only CLI configuration policy; affects later host launches, not unauthenticated access.|Add agency.profile.configure to existing device refusal gate; hide host-only UI for device clients. Assert device rejected + stored profile unchanged and host-token configure accepted. Default remote disabled does not remove this supported-feature gap.|
|3 / B|FUNC-001 P2|Delay picker.listing500ms, open/close before first reply8times. Ninth open gets picker-failed and UI stays Reading the disk. Cleanup only knows picker ID after reply; first-load errors hidden under non-null listing. Fresh authenticated socket recovers.|Correlate/cancel outstanding opens and release late allocations, render first-load errors independently. Test >8 cancel cycles, concurrent/reopened dialogs, socket cleanup, injected errors and reconnect, including shared picker consumers.|
|4 / B|TEST-001 P2 coverage gap|Exit predicate accepts undefined exitSignal; terminal markers appear in command echo; WS rejection accepts unrelated transport error. Real focused PTY AFTER_INTERRUPTION assertion has same echo risk. Passing25labels overstates behavior.|Require actual exitCode/supported signal, assert generated/split marker absent literally in input, distinguish ANSI/control behavior from echo, require HTTP403 upgrade response. Negative controls missing code/echo-only/unrelated connection error must fail.|

Every finding's source references and evidence are in07; detailed SEC-001/002 source chain and fixture recipes in03; picker recipe in02. No P0 established. Do not expand the finding count with unverified risks.

SEC-001 source: `packages/server/src/agency/agency-profile-capabilities.ts:159`, `agents/codex/index.ts:125,187`, `paths.ts:82`, `discovery.ts:175,343`, `history.ts:110`, `find-rollout.ts:150`, `terminal-registry.ts:742`, `conversation-hub.ts:565,806`, `packages/web/src/agency/AgencyWorkspaceView.tsx:55`. The hook receives cwd/time/native ID, no effective home; follower and history remain provider-wide. A public discovery capability of unavailable does not prevent the upstream history follower. Do not infer effective home from wrapper text or execute unknown wrappers merely to probe authentication. Until identity is safely established, disable structured profile history/discovery and operations that require verified-home resume; do not alter credentials or native auth homes.

SEC-002 source: `packages/server/src/remote-access.ts:377`, `terminal-socket.ts:1074,3235`. FUNC-001 source: `packages/web/src/FolderPicker.tsx:62,145,187`, `packages/server/src/directory-picker.ts:43,145`, `terminal-socket.ts:2621`. TEST-001 source: `packages/server/scripts/check-agency-e2e.mjs:148,490,514,680,728`, `packages/shared/src/agency-protocol.ts:82`, focused real-PTY assertion `packages/server/src/agency/runtime/agency-session-runtime.test.ts:706`.

## Ownership decision required before merge

Post-exit resume of the same native ID under another named profile is accepted by a fake-provider runtime reproduction; active duplicate controllers are rejected. This is **an unverified account/security risk**, not a proven exploit. CONTRACT domain invariants7/9 define profiles as executable configurations, not permanent account principals, and delegate resume to native CLI. No explicit perpetual named-profile binding requirement was found.

Decide and document whether owner identity is named profile or verified provider/home, whether transfer is supported, and how legacy unknown ownership is handled. If historical binding is required, persist/enforce it before launch, fail closed when unknown, test after exit/restart/profile reconfiguration, and retain active-controller exclusivity. No real CLI cross-account history read/resume was attempted. Protected wrapper homes must join the same verified-home inventory; independent same-user filesystem race exploitation is unverified.

## Measured performance and limits

| Workload / endpoint | p50 ms | p95 ms | max ms | n |
|---|---:|---:|---:|---:|
|50workspaces, no active PTY switching|41.85|49.35|49.74|20|
|50workspaces, idle PTY switching|59.00|72.37|73.66|20|
|Earlier short~64kB/s output switching|56.97|66.26|68.75|20|
|Eight emitting shell PTYs,56workspaces, visible-container switching|59.12|68.79|71.91|60|
|Same load, composer abc typing+value check|9.92|14.53|20.18|60|
|Same run, detach/attach replay delivered|1.72|3.59|4.73|20|
|1000-event source, return waits for300rendered tail rows|179.87|278.71|292.90|60|
|Browser JSON.parse1.09MB synthetic payload only|1.10|1.40|1.90|20|

Eight-shell workload observed5,980,506bytes/~29.24s (~204.5kB/s) with programmed260-char lines/10ms per generator. Server launcher-group RSS360428→367440KiB; fds84→81then stable,13observations; group excludes PTY descendants in separate process groups. Browser CDP GC metrics under long transcript: listeners185/245/305/365 after0/20/40/60switches, heap5.94/6.45/6.51/6.57MB, nodes3012→3015stable. Increase warrants attribution, not a confirmed production leak or performance defect. No long-term soak claims. Browser execution totals and full sampling method in05; replay delivery excludes paint, input measurements include automation overhead. Long transcript initial-tail readiness334.35ms is n1 only. Initial reset tail300 is intentional upstream behavior.

Historical startup n5 mixed empty-config/warm: p50 1063.00ms, p95/max1824.62ms; four reused-config launches1031.38–1065.97ms. OS caches not cleared, so no machine-cold claim. Main JS1126.92kB raw/310kB gzip is a size measurement, not a proven bottleneck.

**No performance refactoring before QA is justified.** Group C: attribute retained listener targets/longer heap slope, optional native soak/isolated render and machine-cold profiling. Optional durability investigation: writeAtomically uses rename but no file/directory fsync; session backup copy is not atomic. Power-loss data loss is not reproduced. Local symlink/executable replacement after validation remains a race limitation, not a new confirmed exploit.

## Completed verification and required implementation checks

Prior independent focused server48/48, frontend9/9, production build, screenshot8states/four widths and E2E25reported labels are preserved; TEST-001 qualifies their scope. Continuation independently tested strict real403WS rejection for bad Host/Origin/token; arbitrary cwd rejected; socket picker exhaustion/reconnect recovery; actual split-marker shell execution and exact exit42. Existing remote access script passed; it omitted Agency mutation authorization.

Actual browser Done/Restore and disconnect preserved original shell ID: split PRESERVED_ + SHELL output executes afterward. Browser offline Done attempt displays alert, sends no mutation and does not replay on reconnect. Prior focus test traps8Tab presses/restores focus on Escape. Concurrent start/stop, deletion locks, duplicate controllers, symlinks, corrupt backup/future schema and restart reconciliation were source/assertion reviewed against existing focused evidence; many use fake registries. These do not prove real provider behavior.

Fixing agent must run regressions at the **corrected application SHA**, including:

1. Dual-home account boundary negative and positive controls, opaque-home unavailable behavior and agreed historical resume policy.
2. Paired device/host-token profile configuration authorization with persistent-state assertions.
3. Delayed picker cancellation/reconnect/first-load visible errors and shared consumer behavior.
4. Negative controls for TEST-001 plus real split-marker command/interrupt/ANSI/exit status tests.
5. Existing concurrent slot/delete/start/stop, native active-controller exclusivity, Done/Restore process preservation, browser reconnect/offline non-replay, canonical/protected symlink, corruption/backup/future-schema suites.
6. Build and actual browser usability/focus checks; performance baseline only if relevant changes affect lifecycle/rendering.

Commands from audit worktree (no provider inference):

```
corepack pnpm --dir packages/server exec tsx --test src/agency/domain.test.ts src/agents/profiles/profiles.test.ts src/agency/runtime/agency-session-runtime.test.ts
node --experimental-strip-types --test packages/web/src/agency/model.test.mjs
corepack pnpm --filter @agent-workbench/web build
corepack pnpm --dir packages/server exec tsx scripts/check-remote-access.mjs
```

Original E2E/screenshot scripts must use disposable HOME/XDG/native homes and no-inference fixture; amend misleading assertions before treating labels as acceptance. This environment needs a PATH pnpm shim delegating to corepack. Do not rerun any script against real provider configuration inadvertently.

Reproduction recipes are preserved in02/03/05; temporary scripts `/tmp/agency-audit-account-browser.mjs`, `agency-audit-boundaries.mjs`, `agency-audit-sustained.mjs`, `agency-audit-remote-profile.mjs`, `agency-audit-long-ready.mjs`, `agency-audit-browser-parse.mjs`, `agency-audit-browser-reconnect.mjs` are conveniences, not durable dependencies. Fixtures clean their owned process groups/data. Long transcript IDs must embed the correct UUIDv7 day; an earlier invalid fixture was corrected and excluded from conclusions.

## MANUAL QA REQUIRED after Group A

Real installed named wrappers' safe effective-home identity; authenticated provider startup and expected native prompts; actual provider history/compressed rollouts and native resume under agreed ownership; permissions, interrupts and stop behavior during real provider work; platform-specific PTY cleanup/daemon descendants; native model/effort availability only where empirically supported. No paid-provider interactions or real secrets were needed for the completed local audit. Longer soak/power-loss behavior are evidence limits, not implied release defects or reasons to keep this audit open.

Group A/B corrections and policy decision above are the fixing agent's exact next actions. Group C optional work must not displace them. See08 for definitive backlog and07 for stable finding register.

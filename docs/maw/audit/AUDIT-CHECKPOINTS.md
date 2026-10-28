# Independent MAW audit checkpoints

## Baseline — 2026-10-28

- Worktree `/home/user/Projects/My-Amazing-Workspace-audit`, branch
  `audit/maw-adversarial-performance`; clean starting HEAD
  `cde654f6a0302a43c10dfc696b264ec8c3aefd05`.
- `git status --short --branch`, `git rev-parse HEAD`, `git remote -v`,
  `git branch -avv`, `gh pr view 12 --json state,mergedAt,mergeCommit,baseRefName,headRefName,url`:
  expected repository; PR #12 MERGED, merge SHA equals HEAD and origin/main.
  Local main remains at 07942a1 in another worktree; do not modify it.
- No applicable AGENTS.md found in worktree or ancestor directories.
- Read integration checkpoints, browser-tabs, notifications, operations and
  production integration guide. Requested `infra/neko/PRODUCTION-INTEGRATION.md`
  is absent; actual guide is `docs/maw/neko/PRODUCTION-INTEGRATION.md`.
- Node 24.22.0, pnpm 12.16.1, Linux. Dependencies initially absent;
  `pnpm install --frozen-lockfile`: PASS, unchanged lockfile.

### Baseline commands/results

Logs under `/tmp/maw-audit-baseline-*.log` (ephemeral; summaries committed here).

| Command | Result |
| --- | --- |
| `pnpm typecheck` | PASS shared/server/web |
| `pnpm --filter @agent-workbench/server exec sh -c 'pnpm exec tsx --test src/agency/*.test.ts src/agency/browser-tabs/*.test.ts src/agency/runtime/*.test.ts'` | 145 PASS, 0 skipped; 4.897 s |
| `node --test packages/web/src/agency/model.test.mjs packages/web/src/agency/notifications.test.mjs packages/web/src/agency/browser-tabs.test.mjs` | 19 PASS, 0 skipped; real Chromium fixture included; 2.291 s |
| `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/neko/controller -p 'test_*.py'` | 19 PASS |
| `pnpm build` | PASS (build: existing large chunk warning; check: internal docs SKIP) |
| `pnpm check` | PASS (build: existing large chunk warning; check: internal docs SKIP) |

### Architecture and risk map (hypotheses, not confirmed defects)

Server index authenticates HTTP/WS and holds Linux abstract-socket store ownership.
Agency runtime owns native PTYs, identity bindings and durable logical tabs.
Tab coordinator serializes native/web selection across separate stores. Browser
adapter uses loopback restricted controller with durable target ownership receipts.
Neko viewer proxies ordinary authenticated control; Chromium is a shared display.
Activity manager persists state and notification outbox; UI inspection and read
state are distinct. React mounts native panes and selected browser viewer.

Review priorities: malformed credential handling on WS upgrades; shared browser
surface ownership; pending mutation failure recovery; persistent tab IDs vs CLI
identity; outbox replay; unbounded event/state retention; repeated snapshots and
terminal listeners. Neko Compose has fixed production container/volume names:
never run its start/stop scripts or Compose directly during this audit.

CI inventory: `.github/workflows/ci.yml` runs Node 22 Ubuntu/Windows typecheck,
domain/runtime/model/profile tests, Windows full checks, build, package smoke on
three OSes and Android. Browser/controller/activity coverage is not all in CI.
Local suites also include real fixture Bash/Zsh PTYs, isolated server integration,
native identity checks and browser ownership/restart tests.

## Sequence and continuation

| Checkpoint | Status | Next evidence |
| --- | --- | --- |
| Baseline | PASS | Completed |
| 0 unified rename | PASS | Separate feature commit |
| 1 security | Bounded audit complete | A01 P1 fixed; remaining limits documented |
| 2 lifecycle | Tested | Real PTY/Neko restart + fault suites |
| 3 notifications | Tested with limits | Codex evidence loss fixed; AGY/ChatGPT unverified |
| 4 responsive UI | Six viewport run PASS; partial feature matrix | Screenshots; mobile streamed desktop limitation |
| 5 performance | Bounded measurements complete | Missing metrics explicitly UNVERIFIED |
| 6 optimization | PASS | O01 write/event reduction verified |
| 7 release gates | Local PASS; CI infrastructure blocked | Draft delivery; not release approval |

Safety: no live MAW/provider processes, credentials, dotfiles, projects, systemd
or production Neko changes. Fixtures use temporary directories and loopback ports.
Only terminate subprocesses created by this audit. No merge/deployment authorized.
Force-add audit documents because the repository ignores `/docs/`.

Next: collect build/check logs; implement checkpoint 0 before other fixes.

## Checkpoint 0 — unified rename

Double-click displayed name or press F2 on a focused tab. The Add tab menu exposes
Rename tab for touch/keyboard use; browser toolbar uses the same inline editor.
Enter saves, Escape **and blur cancel**. IME Enter does not save. Invalid/empty
names remain editable without changing prior title; errors keep the editor open.
Whitespace trimmed, 120-character limit, control characters rejected. Input text
selection is excluded from tab-strip dragging. Successful keyboard operations
restore tab focus. Closing a sibling cannot steal focus from a rename input.

Native `terminal.rename` was inspected: it changes only a live registry label,
not the persisted Agency tab. Added `agency.tab.rename` to reuse existing
`tab.name` in Agency session persistence, with stable workspace/tab ID validation,
workspace serialization and title-only rollback on write failure. No new store.
Existing browser rename protocol retained. CLI identity/CWD/process fields are
unchanged; native restart reuses logical tab metadata.

Validation:
- Focused native runtime/protocol tests: **43 PASS**; new checks cover both CLI
  and shell, disk reload, identity preservation, wrong workspace/invalid titles,
  write failure rollback and retry.
- Actual Chromium UI test: **2 PASS** including web save, shell F2/double-click,
  Escape/focus, blur cancellation, empty title, failed-save retry, stable IDs.
  Initial new test timed out after close/F2 because deferred focus could steal
  the editor focus; guarded close focus restoration, final test passes.
- `pnpm typecheck`, `pnpm build`, server `check-i18n.mjs`: PASS.
- `MAW_INTEGRATION_EVIDENCE=/tmp/maw-audit-rename-integration pnpm --filter
  @agent-workbench/server exec tsx scripts/check-maw-integration.mjs`: PASS real
  isolated Bash, inbox/read/ack, failure toast, explicit offline browser error,
  **rename survives refresh and server restart**, durable notification IDs.
  Fresh HOME/XDG and disposable Chrome; no production state used.
- GitHub baseline run 40777144624 failed before steps. Check-run annotation:
  "The job was not started because recent account payments have failed or your
  spending limit needs to be increased." Infrastructure failure, not test evidence.

Next: reproduce malformed-cookie WS upgrade behavior in a disposable process;
then review persistence failure truthfulness and measure redundant snapshots.

## Checkpoint 1a — confirmed P1 fixed before optimization

A01 reproduced in isolated child (exit 1, URIError), patched cookie decoder,
regression passes, child now exits 0/HTTP 403. Commands and impact in FINDINGS.md.
No live server was targeted. Next: persistence failure reproduction, lifecycle
matrix, provider evidence loss, then isolated responsive/performance fixtures.

## Checkpoints 1b/2/3 — failure truthfulness

A02/A03 red tests reproduced before fixes in `/tmp/maw-audit-faults-before.log`;
focused after suite passes. Runtime/controller suites cover concurrent creates,
close sibling isolation, ownership spoofing, response loss, restart, pending
cleanup, corrupt backup and notification outbox recovery. Real fixture PTYs remain
part of the suite. No speculative security issue promoted to a confirmed finding.

Provider research (official sources, 2026-10-28):
- https://github.com/openai/codex/blob/main/codex-rs/core/src/session/rollout_reconstruction_tests.rs
  confirms explicit TurnStarted/TurnComplete lifecycle events. Existing scoped
  Codex watcher uses these; tests cover independent multiple turns and replay.
- https://www.antigravity.google/docs/hooks documents Stop and invocation hooks.
  PostInvocation is not whole-task completion. Docs alone do not validate installed
  CLI delivery/identity/error semantics. Do not modify user hooks or claim support
  without a disposable authenticated CLI experiment. Antigravity completion stays
  UNVERIFIED; ChatGPT stays Unknown/UNVERIFIED. No private API/content access.

Next: run actual isolated Neko ownership/restart acceptance and six-viewport UI;
measure fixture startup/switch/event counts and Neko resource usage. New fixture
creation script uses a unique container, no production volumes, generated secrets
in private temporary files, loopback-only published ports. Never print env JSON.

## Checkpoints 5/6a — measured native selection optimization

Reproducible before/after benchmark committed under evidence. Duplicate select
writes 300→0; alternating changed events 4500→600. Same-tab latency decreases;
alternating p95 does not improve, so no real-switch latency claim. 42 regression
tests PASS. Details and scope in OPTIMIZATIONS.md. Fix also rolls back failed
selection metadata and excludes historical attempts from selection.

Real Neko driver acceptance PASS (unique audit container): ownership mismatch,
idempotent creation, server reattachment, controller restart receipts, Chromium
restart invalidation and owned cleanup. First UI run verified real media and
keyboard navigation but failed its assumption that ChatGPT preserves an arbitrary
query marker: guest site redirected to /auth/login. Corrected acceptance to match
confirmed inventory URL including allowed redirects; this is fixture sensitivity,
not evidence of a MAW persistence defect. Rerun pending.

## Checkpoint 4a — real responsive test found A05

Actual Neko viewport test reproduced iframe autofocus cancelling rename. Added a
regression to the real Chromium fixture and a focus guard; 2 PASS, build PASS.
Six-viewport script now exercises inline rename and inbox/Escape at every size,
with real Neko keyboard input, native shell completion and server restart. Added
startup/render/switch measurements. Rerun in progress; see /tmp/maw-audit-ui-final.

State transition evidence: native create→starting→running→exited/failed→resume
preserves logical tab; close stops only its PTY, Done preserves running processes,
archival/deletion reservations reject active references. Browser unloaded→attach
→ready or explicit error; receipt ownership survives server/controller restart;
Chromium restart invalidates receipts. Close intent persists before target
teardown, unknown ownership retains cleanup tombstones. Activity Working→Finished
requires explicit lifecycle/OSC evidence; replay dedups, failed shell retains
failure, read and acknowledgement are independent, lost Codex evidence→Unknown.
Sources: runtime, coordinator, browser production/controller, activity/outbox
regressions and actual integration results. Not exhaustive model checking.

## Checkpoints 4–7 — final local evidence

Final real Neko run `/tmp/maw-audit-ui-matrix/results.json`: all six viewports
PASS live video readiness, F2 rename, sidebar open/collapse/keyboard resize,
notifications/inbox/Escape, no document horizontal overflow. Actual PTY/background
completion/failure, mouse+keyboard Neko input, cross-workspace/sibling isolation,
MAW restart reattachment and rename persistence PASS; no page errors. Captures
copied to screenshots/, raw results to evidence/integration.json. Connecting-state
captures from earlier runs are not used as steady-state acceptance. All six
rename captures and representative media/sidebar captures visually inspected.

Final local gates:
- `pnpm --filter @agent-workbench/server exec sh -c 'pnpm exec tsx --test src/security.test.ts src/maw-host.test.ts src/agents/profiles/profiles.test.ts src/agency/*.test.ts src/agency/browser-tabs/*.test.ts src/agency/runtime/*.test.ts'`: **173 PASS**, zero skips.
- Frontend model/notifications/browser suite: **19 PASS** before final CLI/menu
  coverage addition; final rerun is `/tmp/maw-audit-delivery-web.log`.
- Python controller/ownership suite: **19 PASS**.
- `pnpm --filter @agent-workbench/server exec tsx scripts/check-agency-e2e.mjs`:
  **25 PASS**; remediation script **6/6 PASS** (actual disposable native wrappers).
- `pnpm check`: PASS; check-docs explicit SKIP. Includes nine-locale i18n.
- `pnpm typecheck`: PASS; `pnpm build`: PASS, unchanged large-chunk warning.
- Real `verify_managed_runtime.mts <generated config> <audit container>`: PASS.
- No Windows packaging execution on this Linux host; remote CI cannot start due
  billing/spending limit. Added Linux CI gates for security/activity/browser and
  Python tests, plus installed Playwright browser to prevent silent UI skips.

Performance: O01 reproducible before/after; final startup/render/request timing
and real Neko 1/5/10/15 tab CPU/PSS/RSS recorded. See PERFORMANCE-BASELINE.md for
scope, missing metrics, shared-host conditions and rejected invalid memory sample.
No sustained uptime/AI-generation performance claim.

Fixture cleanup: only this audit's two uniquely labelled containers are eligible
for removal. Archive their fresh Chromium profile/controller state first into
private `/tmp/maw-neko-integration-audit-*/fixture-backup.tar.gz`. Existing
production/other integration containers, stores and processes remain untouched.

Next: commit evidence and CI gates, push branch, create draft PR, inspect its CI
annotations, then record final delivery SHA/URL. Release acceptance remains
manual and requires the limitations/next commands in FINAL-REPORT.md.

Final frontend extension: **19 PASS**, zero skips; now explicitly exercises CLI,
shell and browser names plus the menu alternative. Both audit Neko containers
were backed up privately and removed. No fixture process/service is left running.
Final implementation/evidence commit: 11504091b0541e747ed405337892dcdd131e88fe.

## Delivery — draft PR #13

Pushed `audit/maw-adversarial-performance`; draft PR targets main:
https://github.com/user/My-Amazing-Workspace/pull/13
Published candidate SHA 7cc896472bcb0164fc7c330a8e3c43ced44b2d69.
`gh pr view ... --json isDraft,headRefOid,statusCheckRollup`: draft confirmed.
`gh run view 40786237642 --json jobs`: zero executed steps in every job.
`gh api repos/user/My-Amazing-Workspace/check-runs/123160012242/annotations`:
account payments/spending-limit block, same as baseline. No test failure evidence
from hosted CI; downstream package smoke skipped. No merge or deployment.

Next precise action: account owner resolves CI billing, then
`gh run rerun 40786237642` (or latest PR run if this documentation push supersedes
it), inspect all jobs and complete the explicitly partial release acceptance
matrix/soak in FINAL-REPORT.md using fresh isolated state. Do not alter production.
This final checkpoint only updates delivery/CI metadata; no code changes.

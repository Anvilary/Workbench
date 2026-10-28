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
| 1 security | Pending | Reproduce suspected defects before classification |
| 2 lifecycle | Pending | State transitions and disposable isolation |
| 3 notifications | Pending | Provider evidence, replay/restart and inspection |
| 4 responsive UI | Pending | Six viewport browser captures and interaction checks |
| 5 performance | Pending | Reproducible baseline fixture |
| 6 optimization | Pending | Measured change and comparable rerun |
| 7 release gates | Pending | Regression logs, CI, draft PR |

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

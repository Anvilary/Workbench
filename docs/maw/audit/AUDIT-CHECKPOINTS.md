# Independent MAW audit checkpoints

## Baseline — 2026-10-28

- Worktree `/home/alteixeira20/Projects/My-Amazing-Workspace-audit`, branch
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
| `pnpm build` | Running at baseline checkpoint; inspect log before changes |
| `pnpm check` | Running at baseline checkpoint; inspect log before changes |

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
| Baseline | Established; build/full check pending | Record final results |
| 0 unified rename | NEXT | Inline edit, stable-ID protocol, persistence and browser tests |
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

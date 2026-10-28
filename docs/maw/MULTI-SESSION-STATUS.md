# Multi-session implementation

Draft delivery: [PR #9](https://github.com/user/My-Amazing-Workspace/pull/9), branch `feat/maw-multi-session-tabs`, target `feat/maw-persistent-workspace` (unmerged PR #8). Verified implementation commit: `687c22676506cc0ff0e9b31df16ee24acd224ef3`; the following delivery commit records this PR link. All changes are pushed without force.

Checkpoint zero: branch feat/maw-multi-session-tabs in /home/user/Projects/My-Amazing-Workspace-tabs, based on unmerged PR #8 at 5567b53fdac1ee6cd99c86cd87b329244c6a4604. Target feat/maw-persistent-workspace. Original main and dependency worktrees remain untouched. No live service or real providers will be signaled. Jev/delegation tools are not exposed; tests use disposable native fixtures without inference.

Plan: durable logical tab identity separate from runtime attempts/PTYs; migrate session schema without deleting history; remove per-kind slot gates but preserve native ownership and process limits; typed tab operations and idempotent launches; browser tab collection; combined creation; shell/CLI per-tab startup recovery; integration/browser/isolated lifecycle/package validation.

Recovery: continue only in this worktree. Inspect git status and this report before changes. Preserve PR #8's executable, context-binding, ownership and protected-home checks. Do not merge, enable a live service, overwrite real config or force push. Record verified phases here and commit/push each checkpoint.

Core checkpoint: session schema 2 adds a stable logical tab descriptor (ID, order, name, selection, intentional closure, current-attempt flag) and idempotent launch IDs. Version 1 sessions migrate deterministically without deleting runtime or native references. Per-kind workspace slot gates are removed; a global 24-active-attempt limit and TerminalRegistry limits remain. Short workspace metadata reservations preserve concurrency across independent sessions. CLI/shell recovery retains tab identity and creates replacement runtime/PTY IDs. Close waits for confirmed exit and persists no-resurrection intent. New tab protocol operations use the authenticated /ws and strict validation; the additive Agency contract is version 2.

Verified core tests: 30 runtime tests exit 0, including five profiles/two same-profile conversations plus three shells in one workspace, launch deduplication, 24-process bound, close isolation, shell replacement recovery, migration/order/selection, existing native ownership checks. Shared/server/web typecheck exit 0; nine-locale i18n exit 0; frontend model tests exit 0. UI and final regression suites remain in progress. No live data touched.

Amendment applied on the same branch/worktree: every CLI/shell tab is closable; presets remain transient; no permanent CLI tab or split layout exists. Browser verification now includes all four actual creation flows, partial combined-launch failure (missing CLI profile leaves a running shell and durable failed CLI tab), four CLIs plus three independent shells, repeated Claude profile with distinct conversation IDs, separate I/O/resize, confirmed close/cancel, exited status, reconnect, drag scrolling, keyboard order/selection persistence, and active-tab visibility after resizing to 390/768/1024/1440/1920. Screenshots are under multi-session-screenshots/.

Safety refinement: managed Codex discovery no longer assigns ambiguous same-home/CWD rollouts to the most recently launched tab. Ambiguous namespaces remain unassigned for that discovery lifetime, even if one contender closes; native PTYs stay usable and automatic resume requires a verified ID. Different verified homes and explicit known conversation resumes retain PR #8 behavior. The global TerminalRegistry cap is rechecked atomically after its final await; raw and managed concurrent opens cannot exceed it. Real disposable PTY tests cover three independent shells and the 24-process boundary. Closed history no longer blocks workspace metadata deletion once all tabs are intentionally closed, while history/native references remain stored.


## Delivery verification — 2026-10-28

IMPLEMENTED AND VERIFIED: independent native CLI/shell collections, four creation presets, stable closable tabs, per-session PTYs/I/O/resize/activity, no split layout, horizontal drag/wheel overflow, keyboard selection/reordering, durable order/selection, idempotent launch operations, close confirmation and no-resurrection intent, version 1 migration and bounded per-tab restart recovery.

IMPLEMENTED — MANUAL ACTIVATION REQUIRED: deployment, original-wrapper authenticated acceptance and reboot/native-resume acceptance. This branch does not install, enable or restart the live service. Original main and PR #8 worktrees remain untouched. Real credentials, wrappers/helpers and existing native processes were not changed or signaled.

BLOCKED — confirmed safety boundary: unknown/mismatched historical native ownership never authorizes automatic resume. Overlapping fresh Codex controllers in one verified home/CWD cannot safely be attributed by latest-file timing; those tabs remain interactive with manual recovery required until an independently verified native ID is available. This is not a claim that authentication reuse establishes historical ownership. External AGY concurrency observation is not an atomic laptop-wide coordinator. Real keyring helper lifetime and pre-login availability still need PR #8's controlled deployment checks.

### Protocol, persistence and isolation

Agency contract version 2 adds strictly validated `agency.tab.action` and `agency.tabs.order` over the existing authenticated socket; the upstream transport protocol remains unchanged. Optional `launchId` makes a requested creation idempotent, including after reconnect/retry. Session schema 2 stores logical tab ID, type through its runtime kind, optional name/terminal ordinal, order, selected state, closed time and current-attempt flag. It also retains profile, native reference/identity, runtime/PTY IDs, lifecycle/activity, recovery metadata and a non-secret launch definition. Complete environments and credentials are never serialized.

Version 1 rows migrate deterministically without losing any runtime/native references. A current active legacy attempt is preferred for initial selection without guessing from update time; every historical row is retained. A logical tab can have multiple historical runtime attempts but only one current attempt. Restart creates replacement shell/PTY/runtime processes in the same tabs and resumes only eligible, verified native conversations through their exact original profiles. No recovery prompt, alternate profile or fresh-conversation fallback is used. Failed resumes retain their original reference and actionable error. Done, Archived, archived-project, deliberately stopped/exited and closed tabs do not auto-resume.

Each interaction addresses a specific logical tab/runtime/PTY. Short workspace metadata locks protect reservation/order/selection/closure; independent spawn preparation and PTY I/O are not serialized by a workspace-wide interaction lock. Native provider/home/conversation claims stay exclusive. There can be many logical history tabs, with at most 24 active Agency reservations and an atomic Registry limit of 24 entries shared with raw terminals. Completed managed PTYs release registry capacity while their exited tabs and exit codes remain durable. Closing all tabs resolves workspace deletion blockers without erasing provider/native history.

All inactive terminal views remain mounted during ordinary tab switching and continue receiving output while only one pane is visible and accepts focus. Browser refresh attaches existing IDs and never invokes recovery or creates sessions. Reboot cannot restore the original OS process or volatile scrollback; provider-native durable history remains separate.

### Exact validation commands

All commands below ran from this worktree with Node 24.22.0 and the inherited pnpm 12.16.1 pin. Each reported exit code is 0. No real authenticated provider or paid inference was used.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Shared/server/web pass |
| `pnpm check` | Full repository check and nine-locale i18n pass; internal-guide check explicitly SKIP because that guide is absent from this checkout |
| `pnpm build` | Production web pass |
| `pnpm build:npm` | Production web/server distribution pass |
| `pnpm --filter @agent-workbench/server exec tsx --test src/agency/domain.test.ts src/agency/native-identity.test.ts src/agency/native-context.test.ts src/agency/multi-session-protocol.test.ts src/agency/runtime/agency-session-runtime.test.ts src/maw-host.test.ts` | 62/62 pass, including real disposable node-pty isolation and capacity, multi-CLI recovery/races, schema migration and explicit close exclusions |
| `pnpm --filter @agent-workbench/server exec tsx --test src/agents/profiles/profiles.test.ts` | 18/18 native profile/store tests pass; 80 server tests total with the previous row |
| `node --test packages/web/src/agency/model.test.mjs` | 9/9 pass, including explicit collections and per-session notices |
| `pnpm --filter @agent-workbench/server exec tsx scripts/check-native-systemd.mjs` | 5/5 tests under disposable systemd, all ten original-entry-point fixtures in real PTYs |
| `pnpm --filter @agent-workbench/server exec tsx scripts/check-maw-lifecycle.mjs` | Wrapper arbitrary cwd/repeated operations, unit syntax, readiness, duplicate server rejection, durable restart and cleanup pass |
| `pnpm --filter @agent-workbench/server exec tsx scripts/check-agency-remediation.mjs` | 6/6 integration groups pass |
| `pnpm --filter @agent-workbench/server exec tsx scripts/check-agency-e2e.mjs` | 25/25 acceptance cases pass |
| `pnpm --filter @agent-workbench/server exec tsx scripts/check-maw-package.mjs` | Package contents, clean disposable npm install and authenticated startup from arbitrary cwd pass |
| `pnpm --filter @agent-workbench/server exec tsx scripts/capture-agency-screenshots.mjs` | PASS: 19 screenshots; four CLIs + three shells; all presets/partial failure; independent I/O/resize and close; refresh without spawn; persisted order/selection; drag/keyboard overflow; 390/768/1024/1440/1920; no split; zero browser errors |

Evidence logs: `/tmp/maw-tabs-verified-{typecheck,check,build,distribution,server,profiles,model,native-systemd,lifecycle,remediation,e2e,installed,browser}.log`. The initial browser delivery rerun stalled on a host-shell exit fixture. The fixture now chooses a deterministic real `/bin/bash` in disposable HOME and sends the exit through the focused browser terminal. This does not change product shell selection.

### Browser evidence and manual acceptance

Screenshots: [mixed CLI/shell tabs](multi-session-screenshots/03-mixed-seven-tabs.png), [close confirmation](multi-session-screenshots/06-close-confirmation.png), [exited code 7](multi-session-screenshots/05-exited-code-seven.png), [partial combined failure](multi-session-screenshots/creation-combined-partial-failure.png), and responsive captures at [390](multi-session-screenshots/responsive-390.png), [768](multi-session-screenshots/responsive-768.png), [1024](multi-session-screenshots/responsive-1024.png), [1440](multi-session-screenshots/responsive-1440.png), [1920](multi-session-screenshots/responsive-1920.png). The fixture contains no real provider interaction. Tab order can be changed with Alt+Left/Right; normal arrows/Home/End select tabs, and the active tab is kept visible on selection and resize. The + control stays outside the scrolling strip.

After reviewed deployment, manually verify each exact Codex/AGY/Claude wrapper reuses its existing authenticated context; resume an owned prior conversation; reject a different home/profile; run multiple same-profile distinct conversations; inspect native ANSI/TUI bottom rows, clipboard and native permission/input prompts; switch/refresh without spawning; cancel/confirm one close; check shell replacement and native recovery on a controlled restart/reboot; ensure Done/Archived and intentionally closed tabs remain stopped. Validate keyring/helper independence before enabling MAW. ChatGPT web-page tabs are outside this change.

### Activation, rollback and continuation

Follow [OPERATIONS.md](OPERATIONS.md) only after review/deployment; do not enable the live service to review this branch. Before any deployment back up application JSON privately. Schema 2 is a rollback boundary: the older PR #8 reader rejects it. Preserve the complete newer schema 2 store/backup before reverting code, and use an explicitly reviewed schema 1 snapshot only if accepting that an older UI cannot display newer tabs. Never delete newer references or native history to satisfy an older reader.

For interruption recovery: `cd /home/user/Projects/My-Amazing-Workspace-tabs`, inspect `git status --short --branch`, this file, and the latest commits; continue this branch only. Run the commands above for changed areas, checkpoint and push without force. Do not reset the main/dependency worktrees or start a service against real data.

# MAW — Independent Claude Code Audit (bugs, performance, release safety)

- Date: 2026-10-29. Branch `audit/maw-claude-review`. Worktree `My-Amazing-Workspace-claude-review`.
- Audited HEAD: `3109fc924136bd0a93717ef83babee6ee16fe80a`. This matches the expected SHA, and the tree was clean at the start.
- Scope: audit and report only. No application source, service configuration, systemd unit, user state, native CLI or
  credential was modified. Fixtures use throwaway git repos, temp state directories, stub binaries and one
  throwaway transient systemd user unit (`maw-audit-startlimit-<pid>`, not `maw.service`, removed afterwards).
- Evidence scripts: [`evidence/`](evidence/). Each one recreates its own temp fixture.

Markers: **VERIFIED** means reproduced by execution in this audit. **TRACED** means it follows from an exact code path and
was not executed. **UNVERIFIED** means a hypothesis that needs follow-up.

---

## A. Executive conclusion

**Overall: CONDITIONAL.**

- **Daily local use of the MAW application (UI, tabs, native CLI profiles): CONDITIONAL PASS.** All 232 distinct applicable
  local tests, typecheck and the production build pass. Profile isolation holds for the wrappers that are actually
  installed. No P0 was found, and no P1 was found in the application runtime.
- **Self-update (`maw update` / `maw restart` / automatic rollback): NOT ACCEPTED.** The automatic rollback fails in
  the most likely activation failure: a release that crashes on start (P1, verified against real systemd). The
  `previous` rollback pointer can also point at a release that never ran (P1, verified). Do not rely on automatic
  rollback until patches 1–3 in §I land.
- Context, from read-only inspection: the user's live MAW currently runs from a terminal
  (`pnpm --dir packages/server exec tsx src/index.ts --prod` in a different checkout), not from `maw.service`. No
  `maw.service` unit is installed. `~/.local/share/maw/current` points at the developer checkout
  `/home/alteixeira20/Projects/My-Amazing-Workspace`. So the updater defects below are not yet live, but they become
  live as soon as the service is installed per `OPERATIONS.md`.

Confirmed defects: **P0 0 · P1 2 · P2 7 · P3 10**.

## B. Confirmed defects

### B.1 Self-update / release safety

| ID | Sev | Status | Location | Defect |
|---|---|---|---|---|
| U-1 | **P1** | VERIFIED (stub + real systemd) | `scripts/maw/maw-restart-helper.sh:2,60,91`; `scripts/maw/maw.service:4-5,18-19` | Automatic rollback aborts under `set -e` whenever `systemctl --user restart` fails. A crash-on-start release hits systemd's start limit inside the 20 s readiness window, so the rollback restart is refused and the script exits. Rollback never completes, the "Critical" message is never printed, and MAW stays down. |
| U-2 | **P1** | VERIFIED | `scripts/maw/maw-update.sh:295-304` | Every staging run, `--no-restart` included, moves `previous` to whatever `current` points at, even if that release never ran. After two staged updates, `previous` names a never-activated build, and the release actually running loses its rollback eligibility. The helper then calls it the "previous verified release" (`maw-restart-helper.sh:86`). |
| U-3 | P2 | VERIFIED (fixture + live read-only) | `scripts/maw/install.sh:25-27`; `packages/server/src/index.ts:98,268` | The first "release" is the mutable developer checkout. `express.static(webDist, {maxAge:0})` serves `packages/web/dist` from that checkout on every request. A `pnpm build`, branch switch or edit there changes what the running service serves now and what it boots on its next crash or restart. The first rollback target (`previous`) is also that checkout. |
| U-4 | P2 | VERIFIED (isolation part refuted, see §E) | `maw-update.sh:303-304,332-335`; `maw.service:18` | `--no-restart` does not isolate activation. The running process stays pinned to its original release (verified), but **any** unplanned start uses the staged build with no health check or rollback: a `Restart=on-failure` crash restart, a reboot, `maw start`, or an external `systemctl restart`. The message "Running service remains active on previous release" is only true until then. |
| U-5 | P2 | VERIFIED | `maw-update.sh:96-99,236-259` | An interrupted update (SIGHUP when the MAW tab running it is closed, SIGKILL, OOM) leaves a registered detached git worktree and a half-built release dir. The trap only removes the lock, and a rerun never cleans them up. Fixture: `git worktree list` still shows the orphan after a later successful update. |
| U-6 | P2 | VERIFIED | `maw-update.sh:99` | SIGTERM does not stop an update. The trap runs `rm lock` and dash then continues: in the fixture the updater swapped `current` and exited 0 after TERM. Because the lock is removed early, a second updater can start before the pointers are swapped. |
| U-7 | P2 | VERIFIED | `maw-update.sh:143-153` | A plain `maw update` deploys whatever upstream branch the source checkout currently tracks. A developer on a pushed `feature/wip` branch gets that unmerged branch staged as production (fixture: deployed `feature/wip` tip, while `origin/main` was older). This contradicts UPDATE-ROLLBACK.md ("never accidentally deployed"). |
| U-8 | P2 | TRACED | `maw-update.sh:306`; `maw-restart-helper.sh` (no log writes); `docs/maw/UPDATE-ROLLBACK.md` §Automated Rollback step 5 | `update-success` is logged before activation. Activation failure, rollback and rollback failure are never written to `update-log.jsonl`, which contradicts the doc. Restarts launched from inside MAW report only to the journal of the transient `maw-restart-<ts>` unit, and the invoking terminal is killed. |
| U-9 | P3 | VERIFIED (1/10 runs) | `maw-update.sh:86-95` | The update lock is check-then-write (TOCTOU). Two near-simultaneous updaters both proceeded, both checked out into the **same** candidate dir (same second, same commit, so the same `release_id`), and one died on `mv: cannot stat '…/previous.tmp'`. |
| U-10 | P3 | TRACED | `scripts/maw/control.mjs:18-23`; `packages/server/src/maw-host.ts:33` | Readiness and health only prove that "the unit's MainPID answers on its token URL". The readiness file has no release ID or commit, so restart and rollback cannot confirm that the intended release is the one serving. |
| U-11 | P3 | TRACED | `maw-update.sh:339` | `exec … maw restart` skips the EXIT trap, so `update.lock` is left holding a PID that is dead or will be reused. A reused PID makes later updates fail with "already in progress" until the file is removed. |
| U-12 | P3 | TRACED | `maw-update.sh` (no GC) | Releases are never garbage-collected. Each one is a full tree plus `node_modules` and build output. Failed rollbacks and orphans (U-5) also stay. |
| U-13 | P3 | TRACED | `maw.service:10-11`, `maw:5`, `maw-update.sh:4,9`, `maw-restart-helper.sh:5,20`, `install.sh` | User name and `nvm/v24.22.0` are hard-coded. A Node upgrade breaks `ExecStart`, and the delegated helper (`systemd-run`, which drops the caller's environment) silently ignores `MAW_STATE_DIR` and `MAW_RESTART_LOCK` overrides. `grep -q "${unit}"` (`maw:35`) is a regex, not a fixed-string match. |

**U-1 execution trace.** The new release crashes about 1 s after `exec`. With `Restart=on-failure`, `RestartSec=5` and
`StartLimitBurst=3` within 120 s, systemd's auto-restarts hit `start-limit-hit` at roughly t≈13 s. The helper's
20-iteration poll fails, `ln/mv current→previous` runs, and then `systemctl --user restart` at line 91 is refused
("Start request repeated too quickly") and returns 1. `set -e` exits the script before it reads `rollback_ready`.
Result: `current` points at the old release, the unit is in `failed` state, and no further action is taken. Evidence:
`evidence/updater-tD.sh` (D1: the first restart fails, so `current` is never rolled back; D2: the rollback restart
fails, so the script stops silently) and `evidence/systemd-start-limit.sh` (real transient unit: the manual restart
exits 1; the journal shows `Start request repeated too quickly`). An `ExecStartPre` failure in the new release takes
the same path through line 60, so rollback is never attempted. **Fix:** `systemctl --user reset-failed "$unit"` before
each restart. Wrap both `systemctl` calls as `if ! systemctl …; then … fi`, so a failure feeds the rollback path
instead of `set -e`. Log every outcome. **Test to add:** the existing acceptance stub, with `systemctl restart` failing
on attempt N, must print `Rollback succeeded` or `Critical` and write a JSON outcome line.

**U-2 trace.** Starting state: `previous`=R0 and `current`=R1, staged with `--no-restart`. A second staging sets
`previous`=R1 (never run) and `current`=R2. `maw restart` with R2 failing then rolls back to R1, which has never been
health-checked, and R0 (the release actually running) is no longer reachable. On the first update from the
`install.sh` layout, `previous` is the developer checkout (`evidence/updater-tA.sh`). **Fix:** keep an `active`
pointer written only by the restart helper after a successful readiness check. `previous` must only ever be set from
`active`. Staging writes `staged` (or `current`) only. **Test:** stage twice and fail activation; `current` must return
to the release that was actually running before.

### B.2 Application

| ID | Sev | Status | Location | Defect |
|---|---|---|---|---|
| P-1 | P2 | VERIFIED (microbenchmark) | `agency-session-runtime.ts:261-266`; `terminal-socket.ts:1185-1189,3446-3478`; `tab-coordinator.ts:44-52`; `agency-session-store.ts:149-160` | Closed and superseded tab history is never pruned. **Every** full session snapshot (on connect, after every tab select, rename, close or order, and on coordinator broadcast) plus every `save()` serializes all of it. Cost is about 1.06 KB per closed session. With 2,000 closed sessions that is a 2.14 MB WebSocket message per tab action per client, and `save()` takes 14 ms p50 / 20 ms p95. All of this runs on the server event loop, and the client replaces its whole `sessions` state each time. |
| C-1 | P3 | TRACED | `agents/profiles/definition.ts:346-382` | Nothing stops two profiles from sharing an executable. For example, `codex01` mistakenly configured as `codex00` launches the codex00 account under the label "Codex 01". Attestation then fails to match, which disables recovery but **does not block launch**. The installed wrappers themselves are safe; see §F. |
| C-2 | P3 | TRACED | `web/src/agency/AgencyWorkspaceView.tsx:97-103` | A failed agent tab with no native ID offers only "Close session". The server supports relaunching into the same tab (`createAttempt` with `tabId`, `agency-session-runtime.ts:321-323`), but the UI exposes no "Retry" or "Configure profile". The recovery message is shown as raw English server text. |
| F-1 | P3 | TRACED (latent) | `web/src/agency/useAgencyStore.ts:119-121`; protocol `shared/src/agency-protocol.ts:193` | The client applies a workspace-scoped `agency.sessions.snapshot` as global. A `sessions.list` that includes a `workspaceId` would wipe every other workspace's sessions from the UI. There is no caller today; webTabs already handles this case at lines 108-112. |
| F-2 | P3 | TRACED | `useAgencyStore.ts:160-166` | `record()`, which mutates `lastSessions` and may call `setNotice`, runs inside a `setData` updater. If React rebases or replays that updater, a duplicate or missed transition notice is possible. Move it out of the updater. |

## C. Unverified risks (need follow-up tests)

1. **Legacy-root rerender propagation.** In MAW mode `App` still runs `useWorkspace()` and other classic hooks before
   it returns `<AgencyApp/>` (`web/src/App.tsx:171-248`). Every `terminal.list` broadcast (`terminal-socket.ts:454`,
   on any registry change) calls `setAllTerminals`. That re-renders `App` and the entire non-memoized `AgencyApp`
   tree. The mechanism is traced; the cost has not been measured. Measure with the React Profiler while opening and
   closing tabs.
2. **About 50 ms tab-switch latency (Round 2).** The value is quantized (selected-state plus two rAF ≈ 3 frames), so it
   may be a measurement artifact. Before optimizing, re-measure with `PerformanceObserver('event')` or the React
   Profiler.
3. **Server startup in MAW mode** still constructs the classic `SessionIndex` and calls `VaultService.start()`
   (`index.ts:382-384`). The cost against large `~/.claude` and `~/.codex` histories has not been measured. Measure
   cold start against a synthetic history fixture.
4. **`is_inside_maw` false negatives** (`maw:33-50`). A PTY moved out of the cgroup and reparented to PID 1 (for
   example a detached `setsid` launched via `systemd-run --scope`) would make `maw restart` run the helper inside the
   unit it kills. Detection is otherwise sound for direct children and tmux; this case is untested.
5. **Real closed-session growth rate.** The P-1 numbers use synthetic rows. The user's real history was not inspected,
   on purpose. Track the size of `agency-sessions.json` over a week.
6. **Not examined in this audit** (this is not a complete audit): notification read/acknowledge semantics and
   duplication, persistence corruption paths beyond what Round 2 covered, PTY high-volume output and paint, Neko
   viewer reconnect and WebRTC, cross-workspace process isolation under load, and Android/packaging. Prior audits'
   results there were **not** re-verified.

## D. Performance findings

Host: 16 cores, load average about 2.7 (shared desktop). Node v24.22.0. Medians of 40 iterations. Production build
via `pnpm build` (Vite 6).

| Measurement | Result |
|---|---|
| Main JS chunk (Vite) | `index-*.js` **1,180.50 kB** min / **322.81 kB** gzip; confirms the reported ~1.17 MB |
| Main chunk composition (esbuild metafile, same entry: 1,181,269 B) | classic Workbench UI `src/*` 420 KB · `@xterm/xterm` 289 KB · `react-dom` 131 KB · `en.json` + i18n 117 KB · `@xterm/addon-webgl` 101 KB · MAW `src/agency` 85 KB |
| Same bundle with `AgencyApp` as the entry (no classic `App`) | **805,799 B (−375 KB, −32%)** |
| Session snapshot size / stringify / `save()` p50 / p95, by closed history (+12 open) | 0: 12 KB / 0.02 / 0.23 / 0.99 ms · 100: 119 KB / 0.18 / 0.84 / 1.58 ms · 500: 544 KB / 0.76 / 3.6 / 5.2 ms · 2,000: **2.14 MB / 3.9 / 14.3 / 20.2 ms** |

High-ROI improvements, ranked:

| # | Change | Expected benefit | Complexity | Regression risk | Measure |
|---|---|---|---|---|---|
| 1 | Pick the UI in `main.tsx` before any classic hook runs. Render `AgencyApp` directly and `React.lazy` the classic `App` for `?view=workbench`. | −375 KB min (−32%) on the default path. It also removes classic WS subscriptions and the rerenders in §C.1. | Low–medium (one file, plus moving `useLocale`) | Low: the classic view still works behind lazy loading | Vite chunk report; React Profiler commit count when opening and closing tabs |
| 2 | Bound session history: exclude `closedAt`/`current:false` rows from live snapshots (serve them through a paged `history` request) and cap or compact the persisted closed rows. | Snapshot and save stay O(open tabs). At 2,000 closed rows that is 2.1 MB → about 12 KB per tab action. | Medium (protocol plus store migration) | Medium: closed-tab restore and the history UI need tests | `evidence/bench-session-history.ts`; WS bytes per select |
| 3 | Lazy-load `@xterm/addon-webgl` after the first terminal paint. | −101 KB from the critical path | Low | Low: the DOM renderer is the fallback | Chunk report; time to first terminal paint |

No evidence supports a broad rewrite. Chromium/Neko resource overhead and narrow-viewport readability were not
re-measured; Round 2's numbers stand, unverified here.

## E. Release / update safety verdict

**Key question: does `maw update --no-restart` keep the running app on its original release files?
Yes, for the running process. VERIFIED. The concern is refuted for live path resolution.**
Evidence: `evidence/symlink-pinning.sh` launches `node --import <current>/…/tsx/dist/loader.mjs
<current>/…/src/index.ts`, the same shape as `maw.service:11`, with cwd set through the symlink. It then swaps
`current` atomically and afterwards performs a lazy `import()`, an asset read built from `import.meta.url` (the same
expression as `index.ts:76,98`) and a cwd-relative read:

```
serverDir=$FIX/releases/R0/packages/server/src
cwd=$FIX/releases/R0
SWAPPED current -> R1
after-swap lazy=lazy-module-from-R0
after-swap static=asset-from-R0
after-swap cwd-relative=asset-from-R0
```

Node realpaths the entry and the loader at startup, and `chdir` pins the inode, so Express static, Node imports and
Vite bundles all resolve through the original real path. No server code reads the `current` path or `$PWD` at runtime
(grep). Remaining exposure: (a) the next **unplanned** start activates the staged build with no health gate (U-4);
(b) during the first-install layout the "release" is the dev checkout, whose `dist/` the running server reads per
request (U-3).

Answers to the 15 Priority-1 questions:

| # | Question | Answer |
|---|---|---|
| 1 | `--no-restart` keeps the running app on its original release files | Yes for the running process (verified); no for any later restart (U-4) |
| 2 | `current` changes before activation | Yes, by design (`maw-update.sh:303-304`); harmful through U-2 and U-4 |
| 3 | Runtime paths resolve through mutable symlinks | No, they are realpath-pinned (verified) |
| 4 | First installed release is immutable | No: it is the developer checkout (U-3). Later releases are not read-only either, only detached (`.git` removed); the server's default terminal cwd is the release dir (`index.ts:120`) |
| 5 | Source edits during a build can affect the staged release or running instance | They cannot affect the staged build (`git worktree add <commit>` reads from the object DB). They do affect the running instance under the first-install layout (U-3). Fixture test 10 does not check the candidate |
| 6 | Interrupted updates leave broken worktrees | Yes, registered orphans (U-5) |
| 7 | Pointer updates are atomic and concurrency-safe | Each rename is atomic (`mv -T`), but the pair is not, and concurrent runs collide (U-9) |
| 8 | Lock is race-safe and recovers after abrupt death | Not race-safe (U-9) and dropped on TERM (U-6). After a kill it recovers through `kill -0`, but PID reuse can wedge it (U-11) |
| 9 | Symlink and metadata are validated before rollback | Only `-L` and `-d` are checked; no metadata, entry point or verified flag (U-2) |
| 10 | Failed activation reliably restores the previous release | No (U-1) |
| 11 | Service genuinely starts from the selected release | Yes: `ExecStart` resolves `current` at exec time. Not confirmed by the health check (U-10) |
| 12 | Restart detection works for nested PTYs, wrappers and cgroups | Sound for the cgroup and ancestor cases; edge case untested (§C.4) |
| 13 | Self-restart can lose the final outcome | Yes: the outcome is never logged (U-8) |
| 14 | Health checks validate the intended release | No (U-10) |
| 15 | Installation preserves existing services and release data | Yes: it refuses to overwrite an existing `maw.service` and only links `current` if absent. It does overwrite `source_path` unconditionally (`install.sh:28`) |

**Verdicts:** `maw update` (staging): CONDITIONAL. The build is isolated and safe, but U-2, U-5, U-6 and U-7 must be
fixed. `maw restart` from outside MAW: NOT ACCEPTED, because rollback is unreliable (U-1). `maw restart` from inside
MAW: delegation is correct but the outcome is invisible (U-8), and it inherits U-1. Automatic rollback: **FAIL**.
Developing MAW within MAW: **NOT ACCEPTED** until U-3 and U-7 are fixed. Today the service either runs the developer
checkout directly, or `maw update` deploys the developer's tracking branch.

## F. Native agent integration

- **Codex isolation: PASS for the installed wrappers.** Read-only check, nothing executed: `~/.local/bin/codex00`
  runs `export CODEX_HOME="$HOME/.codex"` and `codex01` runs `export CODEX_HOME="$HOME/.codex-ar"`, both
  unconditionally, before `exec`. A `CODEX_HOME` inherited from the server environment (the Codex adapter passes the
  whole environment through, `agents/codex/index.ts:171-177`) is therefore overridden, and codex00 cannot launch the
  codex01 account. The residual hazard is configuration-level only (C-1).
- **AGY: PASS by design.** `resolveConfiguredExecutable` returns the configured entry point, not its realpath
  (`executable.ts:248-251`). That preserves `agy00 → agy` symlink semantics. `agy01` sets
  `HOME`/`XDG_*` to its own profile. v2 attestation checks `launchContext` (HOME/XDG/CLAUDE_CONFIG_DIR), command
  resolution and artifact SHA-256 on every launch (`native-identity.ts:119-147`).
- **Claude Code:** no isolation is configured beyond `CLAUDE_CONFIG_DIR` attestation. Not exercised.
- **Invalid profile:** launch throws and the tab becomes `failed` with a message. Recovery means closing the tab and
  configuring the profile (C-2). That is recoverable but awkward.
- **Session restore:** native resume requires attested ownership (`ownsNativeSession`) and a single controller per
  native conversation (`claimNative`). The logic was reviewed and its 40 runtime tests pass. Authentic native CLIs were
  **not** run, by instruction.

## G. Test coverage

| Command | Result |
|---|---|
| `pnpm typecheck` | PASS |
| `tsx --test src/agency/domain.test.ts` | PASS 11/11 |
| `tsx --test src/agents/profiles/profiles.test.ts` | PASS 18/18 |
| `tsx --test src/agency/runtime/agency-session-runtime.test.ts` | PASS 40/40 |
| `node --test web/src/agency/model.test.mjs` | PASS 10/10 |
| CI MAW regression set (`security`, `maw-host`, `agency/*`, `browser-tabs/*`, `runtime/*`) | PASS 162/162, 0 skip |
| `tsx --test src/maw-updater-acceptance.test.ts` | PASS 14/14 (**not in CI**) |
| `python3 -m unittest` Neko controller | PASS 19/19 |
| `node --test browser-tabs.test.mjs notifications.test.mjs` (real Chromium) | PASS 9/9 |
| `pnpm build` | PASS (chunk > 500 kB warning) |
| `pnpm check` | PASS; `check-docs` **SKIP** (internal guide not in checkout) |
| GitHub CI for PR #15 | **UNVERIFIED**: `gh` is not authenticated here. Round 2 recorded billing-blocked runners, which is an infrastructure failure, not a pass |

Meaningful gaps:
- `maw-updater-acceptance.test.ts` is not in `.github/workflows/ci.yml:58`, so updater regressions are never gated.
- Test 1 asserts that `current` is swapped by `--no-restart`, which encodes the U-4 behaviour. No test checks that the
  running process stays pinned.
- Test 5 is named "Interrupted" but only simulates a non-zero exit, with no signal. Tests 5–7 never assert that the
  candidate dir or the `git worktree` registration was removed.
- The 8 & 9 rollback test uses a `systemctl` stub that always succeeds and a health mock keyed on the symlink. It
  cannot detect U-1, and no start-limit or `ExecStartPre` failure is modelled.
- Test 10 asserts that the developer's file survives, which is trivially true. It does not assert that the
  **candidate** is unaffected.
- Test 11 passes because the test runner's own PID is stubbed as MainPID, so only the "inside" branch is exercised.
- Nothing covers double staging (U-2), TERM/HUP (U-5, U-6), the lock race (U-9), tracking-branch deploy (U-7) or log
  outcomes (U-8).
- No test bounds snapshot size against history (P-1).
- Unsupported documentation claims: UPDATE-ROLLBACK.md says rollback results are logged (U-8), that `current` points
  to an "immutable release directory" (U-3), and that WIP is "never accidentally deployed" (U-7).

## H. Prioritized next actions (max 10)

1. Fix U-1: `reset-failed`, no `set -e` abort around `systemctl`, rollback reached on every failure.
2. Fix U-2: introduce an `active` pointer written only after a successful readiness check; derive `previous` from it.
3. Fix U-7: default the target to `origin/main` (or an explicit `MAW_UPDATE_REF`); deploy a tracking branch only with `--ref`.
4. Fix U-3: make `install.sh` stage a real release (or refuse) rather than link the developer checkout.
5. Add `maw-updater-acceptance.test.ts`, extended with the U-1, U-2, U-5, U-6 and U-7 fixtures from `evidence/`, to CI.
6. Fix U-4: `--no-restart` writes `staged`, not `current`; activation (`maw restart`) promotes it.
7. Fix U-5, U-6 and U-9: `flock`- or `mkdir`-based lock, a cleanup trap covering HUP/TERM that removes the candidate, and pruning of orphans on start.
8. Fix U-8 and U-10: log activation and rollback outcomes; put `releaseId` in `maw-ready.json` and check it in `control.mjs`.
9. Performance #1: select `AgencyApp` before classic hooks run and lazy-load the classic UI (−32% JS).
10. Performance #2 / P-1: exclude closed history from live snapshots and saves.

## I. Proposed implementation plan (small, independently reviewable patches)

| Patch | Files | Acceptance test |
|---|---|---|
| 1. Rollback robustness (U-1) | `maw-restart-helper.sh` | Stub `systemctl` failing on restart #1, then on #2: the helper reaches rollback, prints `Critical` when appropriate, exits 1 and writes a log line. Real-systemd variant: `evidence/systemd-start-limit.sh` plus helper `--unit` on a throwaway unit |
| 2. Active/staged/previous pointers (U-2, U-4) | `maw-update.sh`, `maw-restart-helper.sh`, `maw.service` (ExecStart through `active`) | Double `--no-restart` staging followed by a failed activation restores the release that was actually running before. `evidence/updater-tA.sh` must show `previous` unchanged by staging |
| 3. Explicit target ref (U-7) | `maw-update.sh`, docs | `evidence/updater-tG.sh`: on `feature/wip`, a plain update stages `origin/main` or refuses |
| 4. Real first release (U-3) | `install.sh`, OPERATIONS.md | After install, `readlink current` is under `releases/` and has `.maw-release-meta.json` |
| 5. Lock and interrupt hygiene (U-5, U-6, U-9, U-11) | `maw-update.sh` | `evidence/updater-tB.sh`: TERM aborts with `current` unchanged; HUP leaves no registered worktree after the next run. `evidence/updater-tC.sh`: 0/50 double runs |
| 6. Outcome logging and release identity (U-8, U-10) | helper, `maw-host.ts`, `control.mjs` | Readiness includes `releaseId`; health fails on a mismatch; the log contains `activation-success`, `rollback-success` or `rollback-failure` |
| 7. Updater tests in CI | `ci.yml` | The CI job lists `src/maw-updater-acceptance.test.ts` |
| 8. MAW-first root (performance #1) | `web/src/main.tsx`, `App.tsx` | Main chunk ≤ 830 kB min; `?view=workbench` still loads; Profiler shows no `AgencyApp` commit on a `terminal.list` broadcast |
| 9. History out of live snapshots (P-1) | `agency-session-runtime.ts`, `tab-coordinator.ts`, `terminal-socket.ts`, store | With 2,000 closed rows, the select snapshot is under 20 KB and closed-tab restore still works |
| 10. Profile UX (C-1, C-2) and client fixes (F-1, F-2) | `definition.ts`/store, `AgencyWorkspaceView.tsx`, `useAgencyStore.ts` | A duplicate executable gets a warning or rejection; a failed tab offers Retry/Configure; a scoped snapshot preserves other workspaces |

## Evidence index

- `evidence/symlink-pinning.sh`: running-process pinning after the `current` swap (§E).
- `evidence/updater-fixture-lib.sh` plus `updater-tA.sh` (U-2, U-3), `updater-tB.sh` (U-5, U-6), `updater-tC.sh`
  (U-9), `updater-tD.sh` (U-1), `updater-tG.sh` (U-7). Each uses a throwaway bare origin, source repo, state dir and
  stub `corepack`/`systemctl`.
- `evidence/systemd-start-limit.sh`: real start-limit refusal on a throwaway transient user unit.
- `evidence/bench-session-history.ts`: P-1 microbenchmark.

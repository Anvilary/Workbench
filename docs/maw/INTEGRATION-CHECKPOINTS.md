# MAW integration checkpoints

## Source audit and checkpoint 1 — 2026-10-28

Worktree: `/home/alteixeira20/Projects/My-Amazing-Workspace-integration`.
Branch: `feat/maw-integration`. Initial HEAD: `07942a15e5992d7b61e103fffce072969783878e`, clean.
Remote: `git@github.com:alteixeira20/My-Amazing-Workspace.git`.

Fetched all lanes and verified PR heads with `gh pr view`:

- Neko PR #11: `c0ce9d5c708e0a763812e126c71b1cb735947460`.
  The requested `c0ce9d53f2cfcb466fc4ba69df8b46180371aeaa` does not exist;
  the actual fetched head matches PR #11 and its expected seven-character prefix.
- Web tabs PR #10: `f7dac6e4628c668b819c84949bff60e7d49d6068` (exact match).
- Notifications: `48eb10eb65e95208e94b8567a59f63e354441f7c` (prefix match).

Read the lane architecture/controller/operations, browser-tabs, notifications and
implementation reports, inspected Agency protocol/parsers, native identity,
runtime, terminal persistence, authenticated WebSocket and frontend selection.
Reports describe isolated lane behavior; they are not integration acceptance evidence.

Merged in A/B/C order using merge commits, preserving provenance. Integration
merge HEAD: `31a7df0`. Only textual conflicts were shared index exports and
IMPLEMENTATION-STATUS.md; retained BOTH browser and notification exports/reports.
Other requested shared files had no textual conflict because Lane B left wiring
to this integration. Those semantic gaps remain implementation work.

Validation: `pnpm typecheck` exited 0 for shared/server/web after merges.
No application, native CLI, profile, shell dotfile or production service changed.

### Active implementation assignments

- Browser agent: `infra/neko/**`, server `agency/browser-tabs/**` (driver, trusted
  registry, ownership checks, orphan/cleanup persistence, isolated browser tests).
- Native agent: runtime/shell hooks, activity/notification stores, scoped native
  evidence and terminal registry, disposable PTY tests.
- UI agent: Agency frontend/model/stores, nine locales, browser pane and inbox.
- Viewer agent: new `agency/neko-viewer.ts` and tests; upstream Neko WebRTC
  client authenticated proxy, no privileged browser controls in JavaScript.
- Integration owner: shared parser unions, server startup and socket wiring,
  cross-domain selection and lifecycle serialization, integration acceptance.

All agents share this tree with disjoint files; parent owns staging/commits.

### Findings requiring correction

Browser cleanup tombstones were excluded on store reload. Some adapter mutations
trusted persisted refs; failed activations dropped newly created refs; failed
ownership probes could cause duplicate creations. CLI activity handler read its
"previous" state after runtime mutation. Shell scripts were generated but never
sourced by MAW. Notification stores initialized asynchronously after socket setup.
Legacy frontend completion notices used generic working→idle transitions.

### Next commands / acceptance boundary

Inspect `git diff`, finish shared contracts and startup/socket integration, then
run `pnpm typecheck`, focused browser/activity/native/model tests and production
build before real isolated server/browser acceptance. Inspect agent messages for
exact new APIs. Never run existing compose start/stop scripts against the user's
container/profile: use a uniquely named disposable container, volume and ports.

Live ChatGPT authentication requires manual user interaction; no credentials
will be requested or captured. Synthetic background streaming is distinct from
real ChatGPT response survival, and neither proves response completion detection.
Web activity stays Unknown unless real permitted evidence is demonstrated.

Deployment, original installation, real native account sessions, production
systemd activation and merging are outside authorized automated operations.

## Checkpoints 2–4 — integrated implementation

Based on `fc00a7b`; the following checkpoint commit contains the implementation.
All lane work was applied to the integration branch, not to the installed MAW.

- Production authenticated Neko driver and controller-owned registry: stable
  workspace/tab ownership, browser-instance epoch, durable create/close receipts,
  response-loss lookup, no foreign destructive recovery, pending cleanup restore.
- Unified cross-domain selection/order coordinator and validated shared protocol
  on the existing socket; workspace lifecycle and inspection gates. Browser
  display mutations serialize globally across workspaces. URL inventory refresh
  persists actual ChatGPT conversation addresses without reading page content.
- Genuine Neko client proxy behind MAW authentication, server-only nonadmin Neko
  cookie, ordinary interactive host permissions, exact endpoint restrictions,
  WebSocket authentication/revocation and actual media readiness.
- One streamed browser surface in the workspace tab strip. Reopening a workspace
  reactivates its selected target; native terminals retain their original
  attachment/resize/input path. Browser/terminal/CLI share selection and status.
- Native managed Bash/Zsh startup hooks, explicit scoped Codex rollout turn
  evidence independent of UI subscribers, durable activity/notification outbox,
  closed-tab suppression, permanent event deduplication and read/ack separation.
- Nine-locale UI, translated generated notifications, inbox/toast navigation
  gated by actual pane display, reconnect synchronization across all domains.

### Verification so far

- `pnpm typecheck`: PASS shared/server/web (repeated after final driver/outbox).
- `pnpm build`: PASS; existing Vite large-chunk warning remains.
- `pnpm check > /tmp/maw-integration-full-check.log 2>&1`: PASS;
  internal guide check explicitly SKIP because baseline guide is absent.
- `pnpm exec tsx --test src/agency/*.test.ts src/agency/browser-tabs/*.test.ts
  src/agency/runtime/*.test.ts` from packages/server: PASS; exact final count in
  `/tmp/maw-integration-focused-final.log` (earlier pre-outbox count was 137).
- `node --test packages/web/src/agency/model.test.mjs
  packages/web/src/agency/notifications.test.mjs
  packages/web/src/agency/browser-tabs.test.mjs`: 19 PASS. Two fixtures run the
  real React UI in Playwright; their media is synthetic, not real Neko evidence.
- `python3 -m unittest discover -s infra/neko/controller -p 'test_*.py'`:
  19 PASS, including ownership/response-loss/restart and framing tests.
- Baseline `check-agency-e2e.mjs`: 25/25 PASS; remediation script: 6/6 PASS.
- Real isolated Neko driver acceptance: creation/idempotency, ownership rejection,
  MAW reattachment, controller restart receipts, Chromium restart invalidation,
  inventory URL, cleanup PASS. Synthetic Chromium SSE: 10/10 chunks, 7 while
  occluded. See neko/PRODUCTION-INTEGRATION.md for exact commands and boundaries.
- New `check-maw-integration.mjs` with no Neko: PASS real disposable Bash success
  and failure, background process, inbox/read/ack/toast UI and durable restart.
  Evidence `/tmp/maw-integration-without-neko`.
- With generated config `/tmp/maw-neko-integration-b1d1p0my/maw-env.json`: PASS
  genuine WebRTC media inside MAW, preserved A/B/cross-workspace targets and PTY,
  sibling close safety, MAW restart reattachment and notification persistence.
  Screenshots at 1366×768, 1920×1080, 2560×1440 and 390×844 are real captures in
  `/tmp/maw-integration-neko-evidence` and have been visually inspected.

### Active acceptance finding / next steps

Actual stream displays the guest ChatGPT UI. Attempt to drive the Chromium
omnibox through Neko's transparent input textarea acquired ordinary control but
did not produce the expected URL change. Viewer agent is investigating actual
input; do not call interactive acceptance complete yet. Parent extended script
now captures failure screenshots. No authenticated ChatGPT response or completion
notification is claimed. A guest response will be attempted only through normal
streamed mouse/keyboard UI if input succeeds; screenshots require visual review.

First custom E2E failure used an incorrect bell CSS selector, corrected. Another
used a test init script that reset the workspace to Beta on every reload,
corrected; final basic real-Neko run passed. Initial root zsh test glob and an
early locale format/unused-key failure were corrected, with final checks passing.

Native test isolation refinement: an initial fixture generated six app-owned
shell hook files under the default integration directory. The agent removed only
those newly generated files, added an injectable test directory and reran real
Bash/Zsh tests entirely in temporary directories. No dotfile, CLI credential,
existing state file, native CLI process or production service was changed.

## Checkpoint 5 — Real Neko input verification, complete integration acceptance, and delivery

- Resumed state audit: verified clean working tree at commit `38c085c` ahead of `origin/main`
  by 16 commits, with all Lane A/B/C code integrated and unit test suites passing. Live
  user processes and services remained undisturbed throughout.
- Neko interactive WebRTC input resolution:
  - Root-caused the transient input issue: the transparent input textarea in Neko player
    raced against ChatGPT's initial page rendering / autofocus before the remote DOM settled,
    and keystroke pacing needed adequate delay (20ms) across the WebRTC data channel / X11
    bridge. Furthermore, narrow-viewport testing revealed a Playwright strict mode violation
    on `.maw-add-tab button` when the dropdown menu was expanded.
  - Adjusted `packages/server/scripts/check-maw-integration.mjs` with proper post-media ready
    settling delay (1500ms), overlay dismissal, Control+l pacing, and exact role selector
    `getByRole('button', { name: 'Add tab' })`.
- Comprehensive Verification Results:
  - `pnpm typecheck`: PASS for all packages (`shared`, `server`, `web`).
  - `pnpm build`: PASS (production bundle with all 9 locales).
  - `pnpm check`: PASS (all 32 check scripts passed, check-docs skipped as expected).
  - Server unit & integration tests (`pnpm --filter @agent-workbench/server exec tsx --test src/agency/*.test.ts src/agency/browser-tabs/*.test.ts src/agency/runtime/*.test.ts`): 145/145 PASS.
  - Web model & notification tests (`node --test packages/web/src/agency/*.test.mjs`): 18 PASS, 1 skipped.
  - Python restricted controller unit tests (`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/neko/controller -p 'test_*.py' -v`): 19/19 PASS.
  - `check-maw-integration.mjs` (offline / without Neko): 6/6 PASS.
  - `check-maw-integration.mjs` (isolated real Neko runtime): 10/10 PASS:
    1. Isolated loopback MAW HTTP authentication: PASS
    2. Real Bash background completion, ownership, durable inbox and independent read state: PASS
    3. Real notification inbox click-through selects workspace/tab and acknowledges displayed terminal: PASS
    4. Real failed shell command, top-right toast and dismissal retains inbox: PASS
    5. Genuine authenticated Neko Chromium stream displayed in single MAW surface: PASS
    6. Real Neko keyboard input controls Chromium and live navigation is persisted: PASS
    7. Narrow layout sidebar collapse, add menu and browser tab controls accessible: PASS
    8. Switch A/B/native/across workspaces retains all real targets and PTY identity: PASS
    9. Closing a browser tab preserves sibling browser target: PASS
    10. MAW restart retains notification IDs/read state and verified live browser target: PASS
  - Truthful evidence reporting: Guest ChatGPT response completion remains UNVERIFIED
    as no automated credentials or simulated completion assertions are falsely claimed.
    Browser tab activity states truthfully remain `unknown`.
- Clean disposal:
  - Disposable test container `maw-neko-integration-b1d1p0my`, volumes `maw-neko-integration-b1d1p0my-profile`
    and `maw-neko-integration-b1d1p0my-controller`, matching bridge network, and temporary configuration
    files have been safely stopped and removed. No production volumes or live MAW services were touched.
- Delivery:
  - Pushed `feat/maw-integration` to remote `origin`.
  - Created/updated draft PR against `main` for review. Merging and production deployment remain strictly manual operations.


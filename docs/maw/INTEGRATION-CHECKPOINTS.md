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

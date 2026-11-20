# Migration Plan and Architectural Roadmap

## Architecture v1 (milestones 1 to 6)

Extracted shared foundations, the first frontend feature components, hierarchical test directories and the sharded CI. It left several directories as re-export-only barrels and the three large controllers intact.

## Architecture v2

Finished the migration. See [architecture-v2.md](./architecture-v2.md) for the design, the checkpoint history and the decisions.

- `shared`: `protocol.ts` split by message family; flat files grouped by domain; export surface verified unchanged.
- `server`: flat files and the `agency/` directory dissolved into `features/`; `terminal-socket.ts` replaced by `transport/websocket/` with one handler module per message family; HTTP concerns moved to `transport/http/`; barrels and test shims removed.
- `desktop`: `main.mjs` reduced to a composition entry; one `BrowserViewController` owns native views; loose root files moved under `src/`.
- `web`: feature first layout; legacy `Agency*` and `NativeChatGpt*` internal names replaced; sidebar drag logic extracted into a hook.

## Deliberately left as they are

- `terminal-registry.ts`, `conversation-hub.ts`, `memory-bridge.ts`, `worktrees/service.ts`, `maw-ptyd.mjs`, `resource-monitor.mjs`: large but cohesive single owners.
- `WorkspaceView.tsx` and `WorkbenchApp.tsx`: one component each, tightly coupled to layout and ref state; splitting them risks remounting terminals and native browser panes.
- `agent-input-handler.ts`: the `agent.submit` case body is about 300 lines moved verbatim. Extracting it into a feature service is a behavior sensitive change that needs its own change.

## Optional follow-up

- Directory level coupling between `agents/` and `features/composer`.
- Pre-existing `check-i18n` findings from the native browser commit (unused `agency.browser.*` locale keys and one hand written aria-label).
- CI tier gating for the heavy desktop and browser suites (see the runbook).

# Architecture v2

Status: implemented on `refactor/architecture-v2`. This document is the design record for the restructuring. Sections 1 to 3 record the base and its contracts, 4 to 5 the implemented structure and decisions, 8 the deviations and 9 the checkpoint history.

Architecture v1 (see [README](./README.md), [module-boundaries](./module-boundaries.md), [dependency-rules](./dependency-rules.md)) introduced the right vocabulary but stopped halfway. v2 finishes the move: implementations live in their owning feature directory, and the large closure-style controllers are decomposed along real ownership lines.

## 1. Baseline

| Item | Value |
| --- | --- |
| Base commit | `e3d5066` (`feat(browser): add native spellchecking, simplified context menu, and find in page`), on top of remote `main` `60c4344` |
| Migration branch | `refactor/architecture-v2`, in a separate worktree next to the main checkout |
| Working tree at start | clean |
| Browser improvements | present and committed (`e3d5066`), included in the base |
| Other active work | other worktrees exist (`fix/desktop`, `investigate/gpu-isolation`, detached release trees). None of them is touched |

Pre-existing defect fixed before the migration, in its own commit (`164f497`): the native browser bridge event type in `NativeChatGptView.tsx` lacked the fields the context menu and Find in Page code read, so `packages/web` failed `tsc` with 8 errors on the base commit.

### Test baseline (base + `164f497`, isolated environment)

| Tier | Result |
| --- | --- |
| `tsc` shared / server / web | clean |
| server unit | 147 pass |
| desktop unit | 121 pass |
| web unit | 114 pass |
| server integration | 103 pass |
| server security | 50 pass |
| server runtime | 212 tests, 209 pass, 3 skipped (real systemd, opt-in) |
| desktop integration | 16 pass |

Electron, web integration and web e2e baselines are recorded in the final report. All runs use an isolated `HOME`, `XDG_*` and `WORKBENCH_RUNTIME_DIR` so they cannot touch the live installation or its PTY supervisor.

## 2. Inventory

### Package responsibilities today

* `shared`: 33 flat files, 13.9k lines. `protocol.ts` is 4,016 lines and mixes about 150 message interfaces, two unions, two 650-line parse switches and the encoders. `index.ts` re-exports everything with `export *`.
* `server`: 233 source files. `src/` has about 70 flat files next to `agency/`, `agents/`, `agents-usage/`, `handoff/`, `vault/`, `worktrees/`, `pty-host/`, `shared/`, `features/`.
* `web`: two UIs share one tree. `src/agency/` is the primary interface (`MawRoot` mounts `AgencyApp`). The classic Workbench (`App.tsx` plus about 100 flat files) is loaded lazily for `?view=workbench`. `features/` holds only some extracted pieces.
* `desktop`: `main.mjs` (1,380 lines) holds one `start()` closure that owns the window, all native views, the IPC command handler, navigation guards, eviction and the backend watchdog. Roughly 20 loose files sit at the package root.

### Large or multipurpose modules (confirmed by reading)

| Module | Lines | Finding |
| --- | --- | --- |
| `server/src/terminal-socket.ts` | 4,426 | One function `attachTerminalSocket` (about 4,100 lines). It builds app-wide listeners, then a `connection` closure that owns per-socket state (attach leases, replay, backpressure, batcher, pickers, search slot) and a 3,000 line `switch` over about 190 message types spanning terminals, agent input, conversation, git, files, memory, notes, vault, worktrees, settings, remote access and workspaces. |
| `desktop/main.mjs` | 1,380 | `start()` closure with 20 maps and sets of view state, `guard()` navigation security (about 180 lines), `open()` (160 lines), eviction, and a 400 line `ipcMain.handle` command switch. |
| `shared/src/protocol.ts` | 4,016 | See above. |
| `server/src/terminal-registry.ts` | 1,803 | One state machine (terminal lifecycle, PTY supervisor client, recovery, activity). Cohesive; decomposition only where ownership is unambiguous (see section 5.4). |
| `web/src/agency/AgencySidebar.tsx`, `AgencyWorkspaceView.tsx`, `AgencyApp.tsx` | 1,007 / 963 / 888 | Composition components that also own drag and drop, dialogs and layout persistence logic. |
| `server/src/conversation-hub.ts`, `memory-bridge.ts`, `worktrees/service.ts`, `desktop/resource-monitor.mjs`, `server/src/pty-host/ptyd.mjs` | 1.1k to 1.4k | Cohesive single-responsibility modules. Left intact on purpose. |

### Redundant or misleading organization

* `server/src/features/{agents,sessions,settings,workspaces}/index.ts` are re-export-only barrels over files that live elsewhere. v1 documented these as done; Rule 5 of this migration forbids that as an end state. `web/src/features/{terminals,agents,editor}/index.ts` are bare barrels with no implementation behind them. v2 treats the v1 feature layout as a stalled migration to finish, not as a baseline to build on.
* `terminal-socket.ts` is misleading: it is the whole application protocol, not a terminal socket.
* `agency/` (server and web) is a legacy product name used as a directory for several unrelated responsibilities (workspaces, live sessions, profiles, notifications, browser tabs, editor tabs).
* Two 1-line test shims under `src/` (`agents/profiles/profiles.test.ts`, `agency/native-context.test.ts`) point at tests that were moved in v1. The installed updater (`~/.local/share/workbench/current`) already uses the new `tests/` paths, so no verified consumer remains.
* `Agency*` and `NativeChatGpt*` are legacy internal UI names. The product is a general browser plus terminal workbench; the native view is no longer ChatGPT specific.

### Dependency direction (verified with a static import scan on the base)

* `shared` imports no Node, Electron or React modules.
* `server` imports no React, Electron or `web`/`desktop` code.
* `web` source imports no `server` or `desktop` code. One unit test (`interactive-cli-scroll.test.mjs`) imports server pure helpers on purpose.
* No value-import cycles in any package.

### Runtime and persistence boundaries

* The PTY supervisor `ptyd.mjs` is a separate long-lived process. It survives backend and desktop restarts. Its wire contract with `pty-host-client.ts` and `terminal-state.mjs` must not change.
* Persisted state lives under `$XDG_CONFIG_HOME/workbench` (workspace, layouts, tabs, notes, drafts, profiles). File names, schema versions and the `mawCompatibility` markers in the root `package.json` are compatibility contracts.
* Browser partitions are `persist:` partitions derived by `partitionForBrowserProfile` in `desktop/policy.mjs`. Names must not change.
* Protocol: `PROTOCOL_VERSION = 8`, message types are strings such as `agency.workspace.create`. They stay as they are.

### Tests protecting the boundaries

Server: `tests/{unit,integration,runtime,security}` (terminal ownership, replay revocation, history authorization, input isolation, local no-auth, PTY lifecycle, recovery, concurrency, packaging). Desktop: unit (policy, security modules, resource budget), integration, real-Electron security and e2e. Web: unit, integration (jsdom-free DOM/React harness) and Chromium e2e. Server `scripts/check-*.mjs` are 32 invariant scripts that import `src/` by relative path.

## 3. Frozen paths and compatibility contracts

These paths and names are read by live launchers, updaters, packaging or old installed releases. They do not move, and their externally visible behavior does not change.

| Contract | Reason |
| --- | --- |
| `packages/{shared,server,web,desktop}` locations | `scripts/workbench/*`, install, packaging |
| `packages/server/src/index.ts`, `packages/server/src/workbench-host.ts` | `maw_valid_release` in `scripts/workbench/lib.sh`, `install.sh`, staging tests |
| `packages/server/src/pty-host/ptyd.mjs`, `terminal-state.mjs` | bundled as `dist/ptyd.mjs` and `dist/terminal-state.mjs`; release validators require them |
| `packages/server/scripts/build-bundle.mjs` entry `src/index.ts` | production bundle |
| `packages/desktop/main.mjs`, `preload.cjs`, `policy.mjs` | Electron entry and shell preload; `scripts/workbench/desktop-launch.mjs` launches `packages/desktop` as the app dir. The WebAuthn preload and dialog assets are loaded only by `main.mjs` and moved to `src/security/webauthn/` |
| `packages/desktop/src/gpu/graphics-policy.mjs` | imported by path from the release directory in `scripts/workbench/desktop-launch.mjs` |
| `packages/server/tests/unit/agents/profiles.test.ts` | executed by `scripts/workbench/update.sh` |
| `packages/server/tests/security/filesystem/native-context.test.ts`, `packages/server/scripts/check-native-systemd.mjs` | systemd check scripts |
| `packages/desktop/tests/integration/desktop/production.test.mjs` and the web test files listed in `scripts/workbench/validate-release.mjs` | release validation |
| pnpm script names in every `package.json` | CI, updater, runbooks |
| Protocol message type strings, `PROTOCOL_VERSION`, `WS_PATH`, `TOKEN_QUERY_PARAM` | wire contract with the web client and the Android companion |
| Persisted file names and schema versions, `mawCompatibility` | on-disk compatibility |
| `WORKBENCH_*` environment variables, `CHANNEL` IPC name, `persist:` partition names, systemd unit names | runtime compatibility |
| `window.workbench` bridge name in `preload.cjs` | preload to renderer contract; the TypeScript type is renamed, the exposed global is not |

The `dist-npm` allowlist (`scripts/build-npm.mjs`, `.github/scripts/check-tarball.mjs`) depends on build outputs only.

Internal class and type names that mirror the `agency.*` protocol namespace (for example `AgencyWorkspaceStore`, `AgencyClientMessage`) are kept. They name protocol concepts, and renaming them would only add churn at the contract boundary. File and directory names do not carry the `agency` prefix after the move, except for the protocol messages file `protocol/agency-messages.ts`.

## 4. Target architecture

Rules (unchanged from the assignment): one authoritative owner per resource, explicit dependency direction, cohesion over file size, no speculative abstraction, real feature ownership (no re-export-only directories), behavior preserved, narrow module interfaces.

Naming: directories lowercase and domain oriented; modules kebab-case; React components PascalCase; hooks `useXxx`; tests named after the module they cover.

### 4.1 `packages/shared/src`

```text
index.ts            public API of the package (explicit barrel, the only one)
protocol/           wire contract: constants, one <domain>-messages.ts per message family
                    (types + client/server parsers), unions, parseClientMessage,
                    parseServerMessage, encoders, agency-messages.ts, notification-messages.ts, server-text.ts
validation/         narrowing.ts
agents/             agents, agent controls, permission modes, plan limits, usage, shared memory contract
sessions/           session/tab entity models, conversation events, composer drafts, pasted text
workspaces/         split layout, editor tabs, tab ordering, project key
browser/            browser tabs and URL validation, browser settings, browser profiles
git/                git and worktree contracts
files/              files, search, notes, vault contracts
settings/           settings, remote access, performance, support
```

`protocol/index.ts` assembles `ClientMessage`/`ServerMessage` and dispatches to per-domain parsers. A domain parser returns `undefined` for a type it does not own, `null` for an invalid message of its own type, and the typed message otherwise. Unknown types still resolve to `null`. The old `protocol.ts` disappears; `index.ts` still exports every previous name (checked by an export-surface diff).

### 4.2 `packages/server/src` (as implemented)

```text
index.ts, workbench-host.ts          frozen entry points (composition root)
pty-host/                      frozen: persistent PTY supervisor, client and wire types
transport/
  http/                        auth-middleware.ts, listen.ts, ui-hosting.ts
  websocket/
    socket-server.ts           attachWorkbenchSocket: upgrade authorization and server lifecycle
    connection.ts              the single transport boundary per socket: decode and validate, remote
                               refusal, classic lifecycle gate, agency state barrier, routing, error
                               serialization, per-terminal command order and limits, cleanup
    dispatch.ts                route table built from the handlers' own *MessageTypes lists; a compile
                               time proof that every ClientMessage type has a handler
    services.ts                createWorkbenchServices: injected stores and private defaults
    socket-hub.ts              clients, remote sockets, send, broadcast, sendError
    terminal-history-access.ts the owner of history stores and of who may read a terminal
    terminal-commands.ts       write, interrupt, drop tab, adapter lookups shared by handlers
    terminal-stream.ts         per-connection attach leases, replay, batching, backpressure
    error-reporters.ts, broadcasts.ts, session-events.ts, initial-snapshot.ts, handler-context.ts
    handlers/                  21 handler modules, one per message family
security/                      request-guards.ts (token, Origin, Host, cookies), no-auth-middleware.ts
bootstrap/                     startup banner, config dir migration, browser open, pty helper
shared/                        serial queue, versioned json store, atomic write, validation, errors,
                               app paths, debug, jsonl reader
agents/                        CLI adapters, registry, profiles, usage collectors
features/                      terminals, composer, conversations, history, memory, files, git, worktrees,
                               notes, vault, settings, remote-access, workspaces, sessions, profiles,
                               notifications, browser, editor
```

Deviations from the first recommendation: `security/` is top level because both transports and the remote access feature use it and its header requires one reviewable file; `agency/` was dissolved by responsibility instead of being kept as a directory; `agents-usage` moved under `agents/usage`; the three request handlers that the feature layer itself calls (`workspace-request-handler`, `web-tab-request-handler`, `editor-tab-request-handler`) live in their features, because features must not import the transport.

Ownership rules for the transport:

* `connection.ts` owns authorization-adjacent gating (remote refusal), parse failures, the agency state barrier, error serialization and cleanup. Handlers never repeat these. Upgrade authorization stays in `socket-server.ts`.
* `HandlerContext<'registry' | 'send'>` is how a handler declares the services and per-socket state it uses. The compiler rejects reaching for anything else.
* Domain behavior stays in `features/*`; handlers translate messages into calls and replies.

### 4.3 `packages/desktop` (as implemented)

```text
main.mjs, preload.cjs, policy.mjs        frozen entry points; main.mjs is a 65 line composition
src/
  app/        process-setup, main-window, backend-endpoint, backend-watchdog, shell-shortcuts, lifecycle
  browser/    view-controller (owner), view-state, view-layout, navigation-guard, browser-sessions,
              view-eviction, page-commands, profile-operations, provider-policy, downloads, zoom-controller
  ipc/        command-router, clipboard-commands, file-clipboard, backend-readiness
  security/   session-permissions, browser-profile-storage, oauth-loopback, webauthn-ipc, webauthn/
              (policy, backend, dialog, dialog-position, orchestrator, preload and dialog assets)
  performance/ resource-budget, resource-monitor, performance-channel
  gpu/        graphics-policy.mjs (frozen)
tools/        developer capture and measurement tools
```

`BrowserViewController` creates the view state and its collaborators and is their only public surface. The router validates the sender once (`trustedSender` and `validCommand`) before any command reaches an owner, and only handlers listed in its table are reachable.

### 4.4 `packages/web/src` (as implemented)

See `module-boundaries.md`. `connection/` holds the WebSocket client and the `window.workbench` declaration; `app/classic/` holds the classic shell; `features/navigation/useSidebarDrag.ts` owns the sidebar pointer drag.

## 5. Decomposition decisions

### 5.1 `terminal-socket.ts`
Replaced by `transport/websocket/` (4.2). The 4,426 line file became about 6,100 lines across 35 modules, none above about 900 lines; the largest is `handlers/agent-input-handler.ts`. `attachTerminalSocket` is now `attachWorkbenchSocket`. Wire protocol, close codes and the order of the initial snapshot are unchanged.

### 5.2 `desktop/main.mjs`
1,380 lines became a 65 line composition entry plus 22 modules (4.3).

### 5.3 `protocol.ts`
4,016 lines became 15 family modules plus constants and an index; the largest family module is 669 lines.

### 5.4 `terminal-registry.ts`
Only `RemotePtySession` (a stateless proxy for a supervisor session) was extracted. The registry stays one module of about 1,750 lines: lifecycle, recovery and activity share one entries map and one state machine, so splitting would fragment it.

### 5.5 Frontend composition
The sidebar pointer drag moved into `useSidebarDrag` (it runs inside the same component, so identity and mounting are unchanged). `WorkspaceView` and `WorkbenchApp` were left whole: their layout and ref state is shared across most handlers.

### 5.6 Intentionally left alone
`ptyd.mjs`, `resource-monitor.mjs`, `conversation-hub.ts`, `memory-bridge.ts`, `worktrees/service.ts` and the agent adapters. Large but cohesive.

## 6. Invariants checked at every checkpoint

1. `shared` has no Node, Electron or React imports; `server` has no React or Electron; `web` has no `server`/`desktop` imports; no value-import cycles.
2. Public export surface of `@anvilary/workbench-shared` is unchanged (runtime keys and type names, diffed against the base).
3. Test counts do not drop. Test scripts enumerate directories, so new test directories are added to the package scripts.
4. Frozen paths from section 3 exist and the staging shell tests pass.
5. No test is skipped or weakened to pass.

## 7. Migration sequence

0. Baseline, this document.
1. `shared`: split `protocol.ts`, group flat files, export-surface gate.
2. `server`: relocate flat files into features, decompose the socket, remove barrels and shims.
3. `desktop`: view controller, router, window lifecycle, relocate loose files.
4. `web`: feature layout, rename legacy UI modules, extract interaction hooks.
5. Repository-wide consistency pass and documentation.
6. Full validation and independent diff review.

## 8. Deviations from the initial recommendation

* Server `security/` is a top level directory instead of `transport/http/` (both transports and a feature use it).
* The server `agency/` directory was dissolved by responsibility; `Agency*` class and protocol type names are kept because they name the `agency.*` protocol namespace.
* The v1 `features/*/index.ts` barrels were removed, not completed. No replacement barrel exists.
* Web has `connection/` and `app/classic/` in addition to the recommended directories, because the repository ships two UIs and the WebSocket client is below every feature. Extra feature directories: `conversation`, `files`, `git`, `worktrees`, `notes`, `memory`, `vault`, `remote-access`, `performance`, matching the classic panels that exist.
* Desktop: `webauthn` modules live under `src/security/webauthn/`; developer tools moved to `tools/`.
* Only the sidebar drag logic was extracted from the frontend composition components (5.5).
* Test shims `agents/profiles/profiles.test.ts` and `agency/native-context.test.ts` were removed: the installed updater runs the tests under `packages/server/tests`.

## 9. Implementation status

Updated at each checkpoint.

### Pre-existing failures on the base (not caused by the migration)

`pnpm check` runs 32 scripts in one `&&` chain. On the base commit `check-i18n.mjs` already fails with two findings, both from the browser improvements commit: `C1` (six `agency.browser.*` locale keys no longer used by the simplified context menu) and `L1` (a hand-written `aria-label` in `BrowserContextMenu.tsx`). The chain stops there, so `check-docs.mjs` never runs in that mode. The migration gates on "the same two findings and no others", and runs each check script on its own.

### Checkpoint 1: shared contracts (done)

* `protocol.ts` (4,016 lines) is replaced by `protocol/`: `constants.ts`, 15 `<family>-messages.ts` modules (types, constants and the parsers of one family), `agency-messages.ts`, `notification-messages.ts`, `server-text.ts` and `index.ts` (unions, dispatchers, encoders and the explicit public export list). Largest family module: `conversation-messages.ts` (669 lines).
* The other 30 flat files are grouped into `validation/`, `agents/`, `sessions/`, `workspaces/`, `browser/`, `git/`, `files/`, `settings/`. `index.ts` is the package's only barrel.
* Parsers return `undefined` for a type they do not own, so a type claimed by no family is still `null`. A test asserts that every message type is owned by exactly one family.
* Gates: runtime export keys identical (340), exported type and value names identical (752 with kinds), a structural dump of every exported type identical, 800,000 differential fuzz comparisons of old against new parsers with no difference, and 407 golden cases frozen from the old parser now live in `packages/shared/tests/unit`.
* `shared` has its own unit test tier now (`test:unit`), wired into the root `test:unit`, `test` and CI.

### Checkpoint 2: backend (done)

* 2a: flat files and `agency/` relocated into `features/`, `security/`, `transport/`, `bootstrap/`, `shared/`; barrels and shims removed; `WorkspaceStore` renamed `OpenTabsStore`.
* 2b: `terminal-socket.ts` split into `transport/websocket` (4.2). Source reading `check-*.mjs` scripts now assert the same text patterns on the files that hold the code.
* Extra: `RemotePtySession` extracted; HTTP middleware, listening and UI hosting moved to `transport/http`; the unreferenced agents usage harness moved to `scripts/`.
* New tests: message routing completeness and uniqueness, dispatch behavior, server layering rules.
* Server unit tests: 147 to 161. Integration 103, security 50, runtime 212 (209 pass, 3 skipped) are unchanged from the base. All 32 `check` scripts behave as on the base (only the two known `check-i18n` findings fail).

### Checkpoint 3: desktop (done)

* `main.mjs` decomposed (4.3). Real Electron tiers (runtime 1, security 2, smoke 2, browser 3, panes 11, terminals 3 plus 1 skipped) match the base exactly. Desktop unit tests: 121 to 134 (router, backend endpoint, view layout, layering).

### Checkpoint 4: frontend (done)

* Feature layout, renames and dead barrels removed (see 4.4 and 8). Web unit 114 to 123; integration 42 (41 pass, 1 skipped) and e2e 58 (57 pass, 1 skipped) match the base exactly.

### Checkpoint 5: repository wide consistency (done)

* Live documentation updated (`ARCHITECTURE.md` layout, `docs/architecture/*`, desktop README and validation notes); stale `Run:` headers in web tests corrected; historical reports under `docs/maw`, `docs/research` and `docs/agency` are left as records.

# Architecture v2

Status: migration in progress on `refactor/architecture-v2`. This document is the design record for the restructuring. Section 9 lists what is implemented; sections 1 to 8 describe the contract the implementation follows.

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

Electron, web integration and web e2e baselines are recorded in the final report. All runs use an isolated `HOME`, `XDG_*` and `MAW_RUNTIME_DIR` so they cannot touch the live installation or its PTY supervisor.

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
| `server/src/conversation-hub.ts`, `memory-bridge.ts`, `worktrees/service.ts`, `desktop/resource-monitor.mjs`, `server/src/pty-host/maw-ptyd.mjs` | 1.1k to 1.4k | Cohesive single-responsibility modules. Left intact on purpose. |

### Redundant or misleading organization

* `server/src/features/{agents,sessions,settings,workspaces}/index.ts` are re-export-only barrels over files that live elsewhere. v1 documented these as done; Rule 5 of this migration forbids that as an end state. `web/src/features/{terminals,agents,editor}/index.ts` are bare barrels with no implementation behind them. v2 treats the v1 feature layout as a stalled migration to finish, not as a baseline to build on.
* `terminal-socket.ts` is misleading: it is the whole application protocol, not a terminal socket.
* `agency/` (server and web) is a legacy product name used as a directory for several unrelated responsibilities (workspaces, live sessions, profiles, notifications, browser tabs, editor tabs).
* Two 1-line test shims under `src/` (`agents/profiles/profiles.test.ts`, `agency/native-context.test.ts`) point at tests that were moved in v1. The installed updater (`~/.local/share/maw/current`) already uses the new `tests/` paths, so no verified consumer remains.
* `Agency*` and `NativeChatGpt*` are legacy internal UI names. The product is a general browser plus terminal workbench; the native view is no longer ChatGPT specific.

### Dependency direction (verified with a static import scan on the base)

* `shared` imports no Node, Electron or React modules.
* `server` imports no React, Electron or `web`/`desktop` code.
* `web` source imports no `server` or `desktop` code. One unit test (`interactive-cli-scroll.test.mjs`) imports server pure helpers on purpose.
* No value-import cycles in any package.

### Runtime and persistence boundaries

* The PTY supervisor `maw-ptyd.mjs` is a separate long-lived process. It survives backend and desktop restarts. Its wire contract with `pty-host-client.ts` and `terminal-state.mjs` must not change.
* Persisted state lives under `$XDG_CONFIG_HOME/agent-workbench` (workspace, layouts, tabs, notes, drafts, profiles). File names, schema versions and the `mawCompatibility` markers in the root `package.json` are compatibility contracts.
* Browser partitions are `persist:` partitions derived by `partitionForBrowserProfile` in `desktop/policy.mjs`. Names must not change.
* Protocol: `PROTOCOL_VERSION = 8`, message types are strings such as `agency.workspace.create`. They stay as they are.

### Tests protecting the boundaries

Server: `tests/{unit,integration,runtime,security}` (terminal ownership, replay revocation, history authorization, input isolation, local no-auth, PTY lifecycle, recovery, concurrency, packaging). Desktop: unit (policy, security modules, resource budget), integration, real-Electron security and e2e. Web: unit, integration (jsdom-free DOM/React harness) and Chromium e2e. Server `scripts/check-*.mjs` are 32 invariant scripts that import `src/` by relative path.

## 3. Frozen paths and compatibility contracts

These paths and names are read by live launchers, updaters, packaging or old installed releases. They do not move, and their externally visible behavior does not change.

| Contract | Reason |
| --- | --- |
| `packages/{shared,server,web,desktop}` locations | `scripts/maw/*`, install, packaging |
| `packages/server/src/index.ts`, `packages/server/src/maw-host.ts` | `maw_valid_release` in `scripts/maw/maw-lib.sh`, `install.sh`, staging tests |
| `packages/server/src/pty-host/maw-ptyd.mjs`, `terminal-state.mjs` | bundled as `dist/maw-ptyd.mjs` and `dist/terminal-state.mjs`; release validators require them |
| `packages/server/scripts/build-bundle.mjs` entry `src/index.ts` | production bundle |
| `packages/desktop/main.mjs`, `preload.cjs`, `policy.mjs`, `webauthn-*preload.cjs` | Electron entry and preload paths are launched by `scripts/maw/desktop-launch.mjs` with `packages/desktop` as app dir |
| `packages/desktop/src/gpu/graphics-policy.mjs` | imported by path from the release directory in `scripts/maw/desktop-launch.mjs` |
| `packages/server/tests/unit/agents/profiles.test.ts` | executed by `scripts/maw/maw-update.sh` |
| `packages/server/tests/security/filesystem/native-context.test.ts`, `packages/server/scripts/check-native-systemd.mjs` | systemd check scripts |
| `packages/desktop/tests/integration/desktop/production.test.mjs` and the web test files listed in `scripts/maw/validate-release.mjs` | release validation |
| pnpm script names in every `package.json` | CI, updater, runbooks |
| Protocol message type strings, `PROTOCOL_VERSION`, `WS_PATH`, `TOKEN_QUERY_PARAM` | wire contract with the web client and the Android companion |
| Persisted file names and schema versions, `mawCompatibility` | on-disk compatibility |
| `MAW_*` environment variables, `CHANNEL` IPC name, `persist:` partition names, systemd unit names | runtime compatibility |
| `window.mawChatGpt` bridge name in `preload.cjs` | preload to renderer contract; the TypeScript type is renamed, the exposed global is not |

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

### 4.2 `packages/server/src`

```text
index.ts, maw-host.ts          frozen entry points (composition root)
pty-host/                      frozen: persistent PTY supervisor, client and wire types
transport/
  http/                        request authorization (security.ts), local no-auth middleware
  websocket/
    socket-server.ts           the only place for upgrade authorization, connection
                               lifecycle, parsing and validation, remote refusal,
                               request correlation, error serialization, dispatch, cleanup
    connection.ts              per-connection state and its single owner
    terminal-stream.ts         per-connection attach leases, replay, batching, backpressure
    broadcasts.ts              registry and domain events fanned out to sockets
    handlers/                  one module per message family, each taking a narrow dependency slice
shared/                        concurrency, persistence (atomic write, versioned json), validation, errors,
                               app paths, debug logging
agents/                        CLI adapters (claude-code, codex, opencode, antigravity, pi), registry,
                               profiles, usage collectors
features/
  terminals/                   registry, history, output buffer, write queue, activity, shell location
  composer/                    drafts, queued submits, deliver-when-ready, paste store, attachments, agent keystrokes
  conversations/               conversation hub and live question, plan limits board, rewind
  history/                     session index, archive, global search, handoff, session watcher
  sessions/                    live session runtime and store, native identity and ownership
  workspaces/                  workspace store, layouts, locks, tab coordinator
  profiles/                    agent profile store and capabilities
  notifications/               notification store, tab activity manager
  browser/                     browser tabs, browser profiles
  editor/                      editor tabs
  settings/                    settings store, app settings service
  remote-access/               remote access service, devices, phone pairing
  files/                       file browser and write, path guard, reveal, directory picker
  git/                         git repo, repo hub
  worktrees/                   worktree service and helpers
  memory/                      memory bridge and hub
  notes/                       notes store
  vault/                       vault service and importers
```

Ownership rules for the transport:

* `socket-server.ts` owns authorization of the upgrade, the `remoteRefusal` gate, parse failures, `classicLifecycle` gating, the `await tabReady` barrier for `agency.*`, the try/catch that serializes errors, and cleanup. Handlers never repeat these.
* `connection.ts` is the single owner of per-socket mutable state. Handlers receive that connection plus only the services they use, typed as narrow `Pick` slices of the service set, not one object with every service.
* Domain behavior stays in `features/*`. Handlers translate a message into calls on feature modules and send replies; they do not own durable state.

### 4.3 `packages/desktop`

```text
main.mjs, preload.cjs, policy.mjs        frozen entry points; main.mjs is composition only
src/
  app/                                   window creation, lifecycle, single instance, backend watchdog
  browser/                               BrowserViewController (sole owner of native views and their
                                         maps), navigation guard, eviction, downloads, zoom, favicons
  ipc/                                   privileged command router, backend readiness, file clipboard
  security/                              session permissions, profile storage, OAuth loopback,
                                         WebAuthn policy, backend and orchestrator
  performance/                           resource budget, resource monitor
  gpu/                                   frozen: graphics-policy.mjs
```

`BrowserViewController` is the one authoritative owner of: views, URLs, providers, profile ids, attached views, suspended tabs, popups and their owners, zoom, favicons, download counters, interaction protection. The IPC router and the window module call it; no other module mutates those collections. Sender validation (`trustedSender`) happens once in the router before any command is dispatched.

### 4.4 `packages/web/src`

```text
main.tsx, styles.css, globals.d.ts       entry points
app/                                     root composition: MawRoot, WorkbenchApp (was AgencyApp), classic root
features/
  navigation/                            sidebar, project and workspace tree, drag and drop
  workspaces/                            workspace view, creator, Done view, dialogs, stores and hooks
  panes/                                 split tree, pane header, menus, tab drag, native layout coordinator
  browser/                               native browser view, find bar, context menu, favicons, settings
  terminals/                             terminal view, console, terminal helpers, history
  agents/                                agent UI, profiles, badges, usage, plan meter
  editor/                                editor pane and drafts, document viewer
  conversation/                          classic conversation view, composer, markdown
  notifications/                         bell, inbox, toast, store, sound
  settings/                              settings dialog and sections
  (classic feature panels: files, git, worktrees, memory, notes, vault, remote-access)
shared/                                  ui, hooks, lib (product agnostic)
i18n/                                    localization
```

A feature directory contains its implementations. Cross feature imports go through the other feature's module files, never through a re-export-only barrel.

## 5. Decomposition decisions

### 5.1 `terminal-socket.ts`
Becomes `transport/websocket/` as described in 4.2. `attachTerminalSocket` is renamed `attachWorkbenchSocket`. The wire protocol, close codes, and ordering of the initial snapshot are unchanged.

### 5.2 `desktop/main.mjs`
Becomes the composition entry that creates the window, the view controller, the router and the watchdog. See 4.3.

### 5.3 `protocol.ts`
Split by message family as in 4.1.

### 5.4 `terminal-registry.ts`
Stays one module unless reading shows a part with no shared mutable state with the lifecycle machine. Recovery planning and restoration that only read supervisor snapshots are candidates; the lifecycle state machine itself is not split.

### 5.5 Frontend composition
Drag and drop, dialog coordination and workspace actions are extracted into hooks only where the component keeps the same element identity, so terminals and native browser panes are not remounted.

### 5.6 Intentionally left alone
`maw-ptyd.mjs`, `resource-monitor.mjs`, `conversation-hub.ts`, `memory-bridge.ts`, `worktrees/service.ts` and the agent adapters. They are large but cohesive.

## 6. Invariants checked at every checkpoint

1. `shared` has no Node, Electron or React imports; `server` has no React or Electron; `web` has no `server`/`desktop` imports; no value-import cycles.
2. Public export surface of `@agent-workbench/shared` is unchanged (runtime keys and type names, diffed against the base).
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

Recorded as they are decided (see section 9).

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

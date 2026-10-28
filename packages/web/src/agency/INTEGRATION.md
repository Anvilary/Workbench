# Agency UI integration handoff (Lane D)

Status: **isolated frontend implementation only**. Built on `a784b0b3e176f06911a016d093f1a118f2072bca`. This lane never edits `App.tsx`, `main.tsx`, server files, shared protocol or root manifests.

## Exported integration root

`packages/web/src/agency/AgencyApp.tsx` exports:

```tsx
<AgencyApp connection={workbenchConnection} />
```

`workbenchConnection` must be the existing singleton `AgentConnection` from `packages/web/src/connection.ts`, not a second WebSocket. Its `onMessage`, `onStatus`, `onReopen` and `send` continue owning upstream terminal and conversation behavior.

`AgencyApp` constructs a fail-closed transport adapter with `createAgencyTransport(workbenchConnection)` from `model.ts`. The adapter refuses to mount if the existing connection lacks the exact non-queueing `sendImmediate` patch. The transport interface is:

```ts
interface AgencyTransport {
  sendImmediate(message: AgencyClientMessage | ClientMessage): boolean;
  onMessage(handler: (message: AgencyServerMessage) => void): () => void;
}
```

The **final integration owner** implements `sendImmediate` on the existing authenticated `/ws` and the same `AgentConnection` after merging Agency into both halves of the existing `protocol.ts` runtime encoder/parser and server dispatch. The UI must not be mounted against a parser that silently drops `agency.*` messages. Do not use a second socket or HTTP endpoint and do not bypass `parseServerMessage` validation.

The integration owner MUST add the following narrow method to the reserved `packages/web/src/connection.ts` (do not modify its existing `send` semantics or create a second socket):

```ts
/** This never uses the connection outbox, even when socket status changes mid-send. */
sendImmediate(message: ClientMessage): boolean {
  const socket = this.socket;
  if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(encodeClientMessage(message));
    return true;
  } catch { return false; }
}
```

Extend the existing protocol encoder/parser for Agency messages as part of integration. Implement `AgencyTransport.sendImmediate` by calling only this new `AgentConnection.sendImmediate`, never the original queued `send`. This boundary is used for all Agency create/configure/Done/Restore/session mutations AND upstream `terminal.close`, `agent.submit`, and `agent.interrupt` initiated here. The UI does not retry uncertain requests. A false return must leave the outbox unchanged, including after reconnect. The existing connection may queue other Workbench messages such as attach and picker navigation, which the integration owner must assess separately.

## What is wired

- **Project sidebar**: collapsible project hierarchy, workspace activity indicator (server state, never a locally invented running flag), active navigation, Done list, Restore. No optimistic mutations.
- **Creation**: new logical project; new workspace name + project + existing directory. Uses original `FolderPicker`; on choosing a directory the UI sends only the server-scoped `pickerId`. The server resolves and stores canonical `cwd`. The picker remains mounted until workspace creation is acknowledged by the server. Its socket-scoped ID is not closed while creation is pending.
- **Workspace layouts**: empty, agent-only, shell-only, combined; terminal-only can add an agent later. Activity and lifecycle are read from Agency session snapshots/updates. Active shells and agents are distinct and reuse the real `TerminalView` backed by the registry's `terminalId`.
- **Transcript**: original `useConversation` consumes Workbench conversation events; `AgencyTranscript` uses the existing safe `Markdown`, keeps user messages visually distinct, collapses native command results, and provides a native CLI tab for interactive prompts.
- **Composer**: profile dropdown and model/effort selectors are below the draft. Selection options come exclusively from `AgencyCliProfile.capabilities`. If discovery is unavailable or cannot select an option, the selector is disabled and the original CLI controls settings. Live changes wait for `agency.session.selection`. Starting a CLI uses `agency.session.create` with profile ID, never executable/cwd strings.
- **Prompt delivery**: existing `agent.submit` with `agent.submitted` matching `requestId`; unchanged native approvals. Drafts are scoped to stable workspace IDs and kept on errors, uncertain delivery or tab switches.
- **Native fallback**: real `TerminalView` xterm.js for agent and a separate shell, including upstream attach/replay, resize, keyboard input, ANSI, paste and detach on component unmount. UI navigation and Done never invoke `terminal.close`. Explicit Stop does.
- **Notification**: user-triggered browser permission request; only server-observed `working → idle` or permission/input-needed transitions produce notifications; initial snapshots, repeated states and locally submitted requests do not. Browser notifications are shown when hidden, and a small visible notice is shown while the app is open.

## Integration actions

1. Merge Lane A/B/C into `dev` under the foundation contract, then add Agency message validation to `packages/shared/src/protocol.ts` and dispatch in `packages/server/src/terminal-socket.ts`.
2. Instantiate a **stable** adapter around the existing `AgentConnection`, and pass it plus that same connection to `AgencyApp` from the current frontend entry route. No direct API credentials or additional browser socket.
3. Confirm responses include the same `requestId` and that the client receives `agency.*.snapshot` on startup and reconnect, including lifecycle/terminal IDs.
4. Make `agency.session.create` server-atomic for one active agent and one active shell. It must start the **original** CLI through Lane B's validated profile launcher. Verify server-managed canonical cwd, session-to-terminal mapping and capability confirmation before enabling controls.
5. Validate the optional old Workbench conversation bridge against each native CLI. Unsupported native transcript parsers must fall back to the interactive PTY, not invent history.
6. Run typecheck, build and a real disposable Ubuntu smoke. No local runtime, screenshots or authenticated CLI acceptance were performed by this lane.

## Focused tests and acceptance checklist

Logic tests: `node --experimental-strip-types --test packages/web/src/agency/model.test.mjs` (Node 22+ for TS stripping). Nine cases cover active vs Done filtering, four layouts, independent slots, capability suppression, drafts, notifications, offline non-replay and argv boundaries. These passed in a locally reconstructed, exact-source copy on Node 22.16.0 (9/9). They do **not** test the actual authenticated WebSocket or server persistence.

Run after integration:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm build
node --experimental-strip-types --test packages/web/src/agency/model.test.mjs
```

Manual browser checks, against **real** local server data:

- Create two projects and two workspaces from distinct existing directories; verify canonical cwd on server. Test invalid/reused picker ID.
- Create an empty workspace. Launch a shell without an agent. Launch an agent alongside the shell. Also create agent-only workspace.
- Type different drafts in both workspaces, switch several times and reload: each draft remains in its own workspace.
- With each CLI profile, inspect actual discovered models/efforts. Unknown must stay disabled. Rejected setting must remain unchanged.
- Run a command in the independent shell. Resize; use Ctrl+C, ANSI, bracketed paste. Detach/reconnect and verify same `terminalId`, PTY process and replay.
- Use transcript, collapse command output, open native CLI to handle permissions. Verify native CLI keyboard input still reaches the PTY.
- Mark a workspace Done during `sleep 90`; restore and verify the same process is alive. Explicit Stop must terminate it, then reflect server exit state.
- Verify no notification on initial load, duplicate snapshot or unconfirmed action; one notification per real completion or attention transition.
- Keyboard-only flow: tab through sidebar, dialogs, composer and controls; Escape closes create dialogs and folder picker.
- Capture desktop screenshots at 1440×900, agent-only, terminal-only, combined, empty, sidebar collapsed and Done view. Record server logs, browser console, tests, and tool versions.

## Outstanding gaps

This lane cannot claim real server E2E or screenshots. Other lanes are responsible for persistence, profile discovery, session ownership, protocol/parser dispatch, process concurrency, and authenticated CLI runs. The shared protocol is intentionally **not modified** in this branch. If the integrated server cannot provide reliable conversation events for AGY/Codex/Claude, keep the native terminal usable instead of fabricating chat content.

## Frontend review follow-up

- Original Windows i18n finding: all Agency JSX copy now uses Workbench `t()`, and `agency.*` keys were added and sorted in all nine existing catalogs, without relaxing `check-i18n.mjs`. Lifecycle indicators are localized.
- The `AgencyApp` root uses only the existing `AgentConnection`. It **cannot mount** unless that connection has a true non-queueing `sendImmediate`; integration owner must apply the narrow patch above. The existing `send()` is never used for Agency mutations, `agent.submit`, `agent.interrupt` or explicit `terminal.close`. A refused offline mutation is not queued or retried after reconnect; a timeout is an unknown outcome requiring readback.
- Minimal profile dialog next to the composer supports named CLI selection, user-provided executable and literal JSON argv. Only `agency.profile.configured` closes the dialog. Environment overrides are intentionally omitted rather than exposing arbitrary credential overrides.
- Composer starts a native agent without sending the draft. The prompt remains intact until a separately acknowledged submission. When native structured history is missing, the UI opens the existing PTY and shows a small explicit fallback notice.
- Tests executed on a local exact-source mirror: 9 passed, 0 failed, Node 22.16.0. Full `corepack pnpm typecheck`, `build`, and `check` could not run locally: Corepack could not reach `registry.npmjs.org` (`EAI_AGAIN`), and a full private repository checkout was unavailable. GitHub Actions validation is required; browser screenshots and real PTY acceptance remain unverified.

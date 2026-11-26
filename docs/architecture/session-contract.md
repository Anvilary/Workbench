# Session contract

Domain contract for projects, workspaces, profiles and sessions (the internal `agency` module). Browser tabs follow [browser tabs](../browser/tabs.md); recovery follows [recovery](../operations/recovery.md).

## Source of truth

- Base: `cvelasquez/agent-workbench` at `5d804f5c5151677b03fceb4a7a2dc20b8ac117ef` (MIT, copyright Christian Velasquez 2026). Keep its full `LICENSE` and relevant notices.
- UI inspiration came from an external web UI for Codex; no source was copied.
- Types: `packages/shared/src/agency-protocol.ts`. This is an *additive* domain contract, not a replacement for the existing upstream protocol.
- The actual pinned upstream `PROTOCOL_VERSION` is **8** and WebSocket route is **`/ws`**. Update the existing parser/union in `packages/shared/src/protocol.ts` when wiring the contract, then update the version only if protocol compatibility requires it.

## Domain invariants

1. `AgencyProject.id`, `AgencyWorkspace.id`, `AgencyCliProfile.id` and `AgencyRuntimeSession.id` name different objects. The native provider session ID and the Workbench terminal registry ID are further distinct. Never use an ID as a surrogate for another.
2. A project is a logical grouping with no filesystem root. A workspace references exactly one project and a real, existing, canonical server-validated `cwd`. Workspace directories need not share a parent.
3. A workspace can have zero or more independent agent and shell sessions in any combination. Logical tab IDs, runtime attempt IDs and PTY IDs are distinct. Brief atomic reservations protect tab identity and native conversation ownership; no per-kind singleton slot exists. Logical tab count is separate from the global active-process limit (currently 24).
4. `done` removes a workspace only from the active navigation query; it never removes a directory, deletes sessions, kills a PTY or erases native history. Restore is reversible. Done workspaces remain addressable in historical views. Existing live PTYs remain available through valid terminal IDs.
5. Workspace deletion is metadata-only and must refuse while any attached/live session exists or while there is an unresolved persisted session reference. Project deletion must refuse while workspaces exist. No recursive filesystem operations.
6. `createdAt`, `updatedAt`, `doneAt`, `startedAt`, `stoppedAt` are server UTC ISO-8601 timestamps. UUIDs are server generated. Use a durable atomic store for domain records, with migration and corruption recovery.
7. Profile records are *named configurations* of installed original CLI executables, not separate provider accounts managed by the app. No raw credentials stored or copied. `args` must remain argument arrays. Environment overrides require a narrow non-secret allowlist; do not change native CLI authentication homes without explicit reviewed behavior.
8. Only capabilities empirically supported by an installed CLI are advertised. Unknown model, effort, authentication and session metadata remain null/unavailable. Keep native prompts, permissions and interrupts intact. Never imply native protocol support from an advertised adapter alone.
9. Native session resumes are handled by each original CLI. A browser reattach is not a native CLI resume. Reattach to live PTY by existing Workbench terminal ID without launching another process. Server restart is a different recovery case and does not promise live-process persistence.

## Transport contract

**Use the existing single WebSocket at `/ws` and the existing HTTP server.** All inbound messages are untrusted and pass through the existing runtime validation/parser and authentication/Origin checks. The TS union is not a runtime validator. No second HTTP RPC endpoint or socket.

Agency request/reply pairings (every request contains an opaque `requestId`; errors return `agency.error` with that ID):

| Request | Successful reply | Notes |
| --- | --- | --- |
| `agency.projects.list` | `agency.projects.snapshot` | All logical projects |
| `agency.project.create` | `agency.project.created` | Name validated, server ID |
| `agency.project.update` | `agency.project.updated` | Rename only |
| `agency.project.delete` | `agency.project.deleted` | Refuse if workspaces remain |
| `agency.workspaces.list` | `agency.workspaces.snapshot` | Optional project filter; include done status |
| `agency.workspace.create` | `agency.workspace.created` | `pickerId` bound to socket; server resolves realpath |
| `agency.workspace.update` | `agency.workspace.updated` | Rename only; never silently relocate `cwd` |
| `agency.workspace.done` | `agency.workspace.done` | Metadata change only |
| `agency.workspace.restore` | `agency.workspace.restored` | Metadata change only |
| `agency.workspace.delete` | `agency.workspace.deleted` | Metadata only; refuse if sessions referenced |
| `agency.profiles.list` | `agency.profiles.snapshot` | No secrets or raw environment dump |
| `agency.profile.configure` | `agency.profile.configured` | Validate argv and allowlisted overrides |
| `agency.profile.capabilities.get` | `agency.profile.capabilities` | Provider-native available options |
| `agency.sessions.list` | `agency.sessions.snapshot` | Optional workspace filter; include lifecycle |
| `agency.session.create` | `agency.session.created` | Atomically reserve an independent logical tab/runtime attempt, then invoke original registry |
| `agency.session.selection.set` | `agency.session.selection` | Model/effort validated against native capability |

Broadcast notification types: `agency.project.changed`, `agency.workspace.changed`, `agency.profile.changed`, `agency.session.changed`, `agency.session.activity`. Include stable IDs. Broadcast only after the owning store or registry has committed the change; do not treat request submission as success.

The existing upstream PTY messages are deliberately reused unchanged for the active Workbench `terminalId`: `terminal.attach` (with `cols`, `rows`), `terminal.detach`, `input`, `resize`, and `terminal.close` for explicit stop. The server already replies with `terminal.opened`, `terminal.replay`, and `terminal.activity` as appropriate. The new `agency.session.create` delegates to the upstream open path using the server-side workspace `cwd` and maps its returned registry ID to the Agency session. The client must **not** supply an arbitrary `cwd` or choose an executable in session creation. Do not issue `terminal.open` for an existing attached Agency session.

`agency.session.selection.set` changes future agent messages/settings only where a provider-native mechanism supports it. The server must acknowledge actual native settings application before reporting a new selection. Models and effort belong in the composer; fall back to the installed CLI's default when unsupported. No direct model API calls.

Directory selection starts with the existing server-owned `picker.open` / `picker.enter` flow. Extending that picker to safely resolve the selected current directory by socket-scoped `pickerId` belongs to the project and workspace feature. Do not trust a client-supplied absolute path, symlink escape, or protected authentication directory.

## Security and lifecycle

- Bind **only** to `127.0.0.1`, maintain the server's per-start token and Host/Origin validation for HTTP and WebSocket. Keep remote access disabled for MVP, without weakening these checks.
- The live PTY is owned by `TerminalRegistry`, not the browser socket. Disconnecting and refreshing the browser only detach listeners. Explicit stop invokes `terminal.close` once. Mark Done does not invoke it.
- Preserve the existing `path-guard.ts` and server-backed directory picker checks. Resolve symlinks and check protected CLI homes before storing a canonical workspace path.
- Do not pass user-controlled strings through `sh -c`, `bash -c`, `exec` or `shell: true`; use executable + argv with `node-pty` spawn and the installed adapters.
- Do not read, store or serialize provider auth tokens. Native CLI homes stay where the user installed and authenticated them.
- Do not auto-create/remove worktrees, install cross-agent instructions, activate any shared-memory bridge or add background orchestration. Existing modules may remain in the imported baseline but cannot become automatic MVP behavior.
- `terminal.close` and browser detach are different operations. The server explicitly owns child process shutdown on server exit.

## Multi-session continuation

Agency contract version 2 adds validated agency.tab.action (select/close/resume) and agency.tabs.order messages on the existing socket. Session metadata schema 2 migrates legacy rows without discarding native references. Closing is per tab, confirms termination, and records intent; Done/Archive and browser navigation do not close tabs. Eligible shell recovery creates a new process and runtime attempt in the same logical tab. Existing native wrapper identity and SEC-001/SEC-002 isolation rules remain mandatory. Split mode is removed; one logical tab pane is visible at a time.

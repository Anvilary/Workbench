# Module Boundaries

What each package owns and where the canonical implementation lives. See [architecture-v2.md](./architecture-v2.md) for the rationale.

## `@agent-workbench/shared`

- `protocol/`: `constants.ts` (version history), one `<family>-messages.ts` per message family (types, constants, client and server parsers), `agency-messages.ts` (workspace protocol), `notification-messages.ts`, `server-text.ts`, and `index.ts` (unions, dispatching parsers, encoders, explicit public exports).
- `validation/`, `agents/`, `sessions/`, `workspaces/`, `browser/`, `git/`, `files/`, `settings/`: runtime independent domain types and pure logic.
- Runtime agnostic: no Node `fs`/`child_process`, React or Electron imports.

## `@agent-workbench/server`

- `index.ts`, `maw-host.ts`: composition root. `pty-host/`: persistent PTY supervisor, client and wire types.
- `transport/websocket/`: `socket-server.ts` (upgrade authorization and lifecycle), `connection.ts` (the single boundary per socket), `dispatch.ts` (route table), `services.ts`, `socket-hub.ts`, `terminal-history-access.ts`, `terminal-commands.ts`, `terminal-stream.ts`, `error-reporters.ts`, `broadcasts.ts`, `session-events.ts`, `initial-snapshot.ts`, `handler-context.ts`, and `handlers/` (one module per message family).
- `transport/http/`: authorization middleware, loopback listening, UI hosting. `security/`: request guards and the local no-auth middleware.
- `features/<name>/`: terminals, composer, conversations, history, memory, files, git, worktrees, notes, vault, settings, remote-access, workspaces, sessions, profiles, notifications, browser, editor. Each owns its stores and rules, plus request handlers that do not depend on a socket (`workspaces/workspace-request-handler.ts`, `browser/web-tab-request-handler.ts`, `editor/editor-tab-request-handler.ts`).
- `agents/`: CLI adapters, registry, profiles, usage collectors. `shared/`: serial queue, versioned json store, atomic writes, validation primitives, app paths, debug logging. `bootstrap/`: startup helpers.

## `@agent-workbench/web`

- `app/`: `WorkbenchRoot`, `WorkbenchApp`, and `classic/` (the classic Workbench shell behind `?view=workbench`).
- `features/`: navigation, workspaces, panes, browser, terminals, agents, conversation, files, git, worktrees, notes, memory, vault, remote-access, editor, notifications, performance, settings.
- `connection/`: the WebSocket client and the desktop bridge declaration (`window.mawChatGpt`). `shared/`: `ui/`, `hooks/`, `lib/`. `i18n/`: locales.

## `@agent-workbench/desktop`

- `main.mjs`, `preload.cjs`, `policy.mjs`: entry points. `src/app/`: process setup, window, backend endpoint and watchdog, lifecycle. `src/browser/`: `view-controller.mjs` and its private collaborators, downloads, zoom. `src/ipc/`: `command-router.mjs`, clipboard commands, file clipboard, backend readiness. `src/security/`: session permissions, profile storage, OAuth loopback, WebAuthn (policy, backend, dialog, orchestrator, IPC). `src/performance/`: budget, monitor, channel. `src/gpu/`: graphics policy.

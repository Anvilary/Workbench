# Dependency Rules

Dependencies point one way. The rules below are enforced by tests, not by convention: `packages/shared/tests/unit`, `packages/server/tests/unit/architecture`, `packages/web/tests/unit/architecture` and `packages/desktop/tests/unit/architecture` fail when a new import breaks them.

## Packages

1. `@agent-workbench/shared` imports nothing from the monorepo and no Node, Electron or React module.
2. `@agent-workbench/server` imports `shared` only. Never `web`, `desktop`, React or Electron.
3. `@agent-workbench/web` imports `shared` only. One unit test imports server pure helpers on purpose.
4. `@agent-workbench/desktop` talks to `web` only through the validated IPC channel and to `server` only over loopback HTTP readiness.

## Server (`packages/server/src`)

- `features/*` never import `transport/`. The transport composes features; a feature does not know it is served over a socket.
- `shared/` imports nothing else in the server. `bootstrap/` imports `shared/` only. `security/` imports `features/remote-access` only.
- `pty-host/` imports no feature. It is a separate process with its own wire contract.
- `agents/` reaches `features/composer` and `features/files` only (paste path conventions and the path guard). This is the one deliberate directory level coupling between adapters and features.
- Handlers in `transport/websocket/handlers/` declare the context keys they use (`HandlerContext<'registry' | 'send'>`). Authorization, parsing and error serialization live in `connection.ts` once.
- No value import cycles between files.

## Web (`packages/web/src`)

- `shared/`, `connection/` and `i18n/` never import `features/` or `app/`.
- `features/*` never import `app/`. Cross feature imports name the owning module file; there are no re-export-only barrels.
- `connection/` imports `shared/` and `i18n/` only.
- No value import cycles between files.

## Desktop (`packages/desktop`)

- Privileged capabilities run in trusted main-process modules (`main.mjs`, `src/`). Only `main.mjs` and the PIN dialog import `electron` directly; every other module receives what it needs as an argument.
- `src/browser/view-controller.mjs` is the single owner of native view state. Its collaborators (layout, navigation guard, sessions, eviction, page commands, profile operations) are created by it and not used elsewhere.
- Area direction: `app` may use `ipc`, `gpu`, `security`; `browser` may use `security`, `performance`; the others use only themselves.

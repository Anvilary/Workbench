# Dependency Rules

Anvilary Architecture v1 enforces unidirectional dependencies so changes remain localized and portable utilities can be copied cleanly across Anvilary Tools projects.

## Package-Level Dependencies

1. `@agent-workbench/shared` depends on nothing in the monorepo.
2. `@agent-workbench/server` may depend on `@agent-workbench/shared` only (never `@agent-workbench/web` or `@agent-workbench/desktop`).
3. `@agent-workbench/web` may depend on `@agent-workbench/shared` only (never `@agent-workbench/server` runtime code or `@agent-workbench/desktop` runtime code; one legacy terminal scroll test imports server pure helpers explicitly).
4. `@agent-workbench/desktop` depends on trusted Node/Electron APIs and its local security modules, communicating with `@agent-workbench/web` only through validated IPC channels (`policy.mjs`) and with `@agent-workbench/server` only over verified loopback HTTP readiness (`src/ipc/backend-readiness.mjs`).

## Intra-Package Dependencies

### Frontend (`packages/web`)

- `src/shared/` must remain strictly product-agnostic and never import from `src/features/` or `src/agency/`.
- `src/features/<domain>/` may import from `src/shared/`, `@agent-workbench/shared`, and explicit stable feature interfaces.
- Avoid barrel re-export cycles: components inside `src/features/<domain>/` import siblings or `src/shared/` submodules directly when avoiding circular evaluation.

### Backend (`packages/server`)

- `src/shared/` may import Node standard library modules and package-local atomic I/O primitives (`atomic-write.ts`), never Express routes, WebSocket servers, React, Electron, or specific domain stores.
- Domain stores (`agency-layout-store.ts`, `browser-tab-store.ts`, `editor-tab-store.ts`, etc.) compose `SerialQueue`, `loadWithBackupRecovery`, `writeSnapshotWithBackup`, and `isRecord` from `src/shared/` rather than duplicating atomic backup rotation or queue chaining.
- Infrastructure boundaries (filesystem writes, OS process spawning, systemd/updater scripts) are wrapped behind dedicated modules and never embedded inside React components.

### Desktop (`packages/desktop`)

- Privileged native capabilities (file clipboard resolution, FIDO2/WebAuthn PIN prompting, isolated Chromium partitions, OAuth callback interception, backend readiness verification) execute exclusively inside trusted Electron main-process modules (`main.mjs`, `src/security/`, `src/ipc/`), never inside untrusted web renderers.

## Portability Standard Across Anvilary Projects

Each module under `packages/server/src/shared/` and `packages/web/src/shared/` is intentionally self-contained with minimal external dependencies so it can be copied directly into another Anvilary repository, adapted locally, and maintained without introducing a monolithic shared-UI npm dependency prematurely.

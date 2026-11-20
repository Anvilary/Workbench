# Architecture Overview

Anvilary Workbench is a **modular monolith** in four packages. [Architecture v2](./architecture-v2.md) is the design record of the current structure: feature first inside each package, one owner per resource, explicit dependency direction.

## Workspace Packages

| Package | Role | Key Entry Points |
| --- | --- | --- |
| `@agent-workbench/shared` | Wire protocol (types, validators, codecs by message family), URL policies, pure layout and domain logic | `packages/shared/src/index.ts`, `packages/shared/src/protocol/index.ts` |
| `@agent-workbench/server` | Express/WebSocket backend, feature services and persistence, agent adapters, PTY supervisor | `packages/server/src/index.ts`, `packages/server/src/maw-host.ts`, `packages/server/src/pty-host/maw-ptyd.mjs`, `packages/server/src/transport/websocket/socket-server.ts` |
| `@agent-workbench/web` | React + TypeScript interface organized by feature | `packages/web/src/main.tsx`, `packages/web/src/app/WorkbenchRoot.tsx` |
| `@agent-workbench/desktop` | Trusted Electron shell: native browser views, isolated partitions, privileged IPC, WebAuthn bridge, resource budget | `packages/desktop/main.mjs`, `packages/desktop/policy.mjs`, `packages/desktop/src/browser/view-controller.mjs` |
| Android app (`android/`) | Standalone companion Android project outside the pnpm workspace | `android/` |

## Preserved Operational Invariants

The package locations stay stable because live launcher, updater, packaging and systemd verification scripts validate those exact paths. The complete list is the "Frozen paths" table in [architecture-v2.md](./architecture-v2.md#3-frozen-paths-and-compatibility-contracts).

## Documentation Map

- [Architecture v2 (design record)](./architecture-v2.md)
- [Module Boundaries](./module-boundaries.md)
- [Dependency Rules](./dependency-rules.md)
- [Testing Architecture](./testing.md)
- [Migration Plan and Roadmap](./migration-plan.md)
- [Rebranding & Compatibility Migration](./rebranding-migration.md)

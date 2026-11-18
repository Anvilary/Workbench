# Anvilary Architecture v1 Overview

Anvilary Workbench uses a **modular monolith** layout with explicit frontend/backend/desktop separation, feature-first internal organization, and small portable shared foundations inside each package.

## Workspace Packages

| Package | Role | Key Entry Points |
| --- | --- | --- |
| `@agent-workbench/shared` | Cross-process protocol schemas, URL policies, validation helpers | `packages/shared/src/index.ts` |
| `@agent-workbench/server` | Express/WebSocket backend, persistence stores, agent adapters, PTY supervisor | `packages/server/src/index.ts`, `packages/server/src/maw-host.ts`, `packages/server/src/pty-host/maw-ptyd.mjs` |
| `@agent-workbench/web` | React + TypeScript workbench UI, pane tree, terminal views, settings | `packages/web/src/main.tsx`, `packages/web/src/MawRoot.tsx` |
| `@agent-workbench/desktop` | Trusted Electron shell, isolated web partitions, FIDO2/WebAuthn bridge, resource budget | `packages/desktop/main.mjs`, `packages/desktop/policy.mjs` |
| Android app (`android/`) | Standalone companion Android project outside the pnpm workspace | `android/` |

## Preserved Operational Invariants

The top-level package locations (`packages/shared`, `packages/server`, `packages/web`, `packages/desktop`) remain stable because live launcher, updater, packaging, and systemd verification scripts validate those exact paths:

- `scripts/maw/maw-lib.sh` (`maw_valid_release`) checks `packages/server/src/index.ts`, `packages/server/src/maw-host.ts`, `packages/server/dist/index.mjs`, and `packages/server/dist/maw-ptyd.mjs`.
- `scripts/build-npm.mjs` and `.github/scripts/check-tarball.mjs` stage `dist-npm/` with a strict published file allowlist (`package.json`, `README.md`, `LICENSE`, `dist/server.js`, `dist/web/`).
- Live services (`maw-ptyd.mjs`, backend HTTP/WS server, and desktop runtime) remain compatible across incremental updates.

## Documentation Map

- [Module Boundaries](./module-boundaries.md)
- [Dependency Rules](./dependency-rules.md)
- [Testing Architecture](./testing.md)
- [Migration Plan and Roadmap](./migration-plan.md)

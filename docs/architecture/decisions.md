# Architecture decisions

Short records of decisions that shape the current design. Each entry states the decision and why. Details live in the linked documents.

## Persistent PTY supervisor in its own unit

Terminals run in `workbench-ptyd.service`, a separate systemd user unit and control group, reached over an authenticated Unix socket with a frozen, versioned protocol. Backend restarts and updates no longer kill coding agents. The supervisor does not declare `PartOf=` the backend. See [persistent PTY supervisor](../terminals/ptyd.md) and [PTY protocol](../terminals/pty-protocol.md).

## Bounded replay plus on-disk history

Reconnection uses a bounded in-memory ring with monotonic offsets; long-term output goes to a bounded, segmented, append-only archive with an atomic index. Unbounded scrollback in memory or a database was rejected for memory and complexity reasons. See [terminal history](../terminals/history.md).

## Releases are immutable and staged

The service boots only from built releases (`releases/<id>` with metadata), never from a developer checkout. `update` only stages; activation verifies readiness with the release's own ID and rolls back automatically. Pointers (`staged`, `current`, `healthy`, `previous`) are the only mutable state. See [update and rollback](../operations/update-rollback.md).

## Native Electron views instead of a remote browser

Embedded providers run in native `WebContentsView`s with one persistent partition per profile and provider. The earlier containerized remote-browser path (Neko) was retired: native views give correct input, IME, clipboard and composition, and remove a runtime dependency. See [browser tabs](../browser/tabs.md).

## One owner per browser view

`BrowserViewController` is the only code that creates or mutates native views; layout, navigation guard, sessions, eviction and page commands are its private collaborators. This keeps focus, eviction and security decisions consistent. See [architecture v2](architecture-v2.md).

## Memory budget protects drafts

Background views are suspended by a pressure-tiered budget, but AI provider views and views with typing input are evicted only under critical pressure, and sustained-pressure signals cannot reach critical on their own. Losing an unsent prompt is worse than using memory. See [budget policy](../performance/budget-policy.md).

## Local backend is treated as remote code execution

Loopback-only binding, a per-start token and Host/Origin checks are mandatory. Remote access adds a paired-device credential over an SSH tunnel without relaxing any layer. Token-free mode exists only as an unsafe diagnostic and is never migrated. See [threat model](../security/threat-model.md).

## Explicit profiles, no account inference

Profiles start with empty executables and are configured explicitly with the user's own wrappers. Workbench never infers, copies or imports credentials, and resumes a native conversation only when a verified host binding proves ownership. See [agent profiles](../development/agent-profiles.md) and [recovery](../operations/recovery.md).

## Identity migration copies, never moves

The move from the legacy identity to the canonical one copies state, masks the legacy units and keeps the legacy installation intact until an explicit `clean`, so rollback needs no restore. See [identity migration](identity-migration.md).

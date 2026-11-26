# Anvilary Workbench documentation

Start with the [project README](../README.md). Security reporting: [SECURITY.md](../SECURITY.md). Contributing: [CONTRIBUTING.md](../CONTRIBUTING.md).

## Architecture

- [Overview](architecture/README.md): packages and documentation map.
- [Architecture v2](architecture/architecture-v2.md): design record of the current structure.
- [Module boundaries](architecture/module-boundaries.md): ownership of modules and resources.
- [Dependency rules](architecture/dependency-rules.md): allowed dependency directions.
- [Testing architecture](architecture/testing.md): suite tiers and conventions.
- [Architecture decisions](architecture/decisions.md): short records of key decisions.
- [Session contract](architecture/session-contract.md): projects, workspaces, profiles and sessions.
- [Identity migration](architecture/identity-migration.md): canonical names, paths and the migration tool.

## Operations

- [Install](operations/install.md): systemd user service installation and layout.
- [Launcher and CLI](operations/launcher.md): `anvi-bench` subcommands.
- [Update and rollback](operations/update-rollback.md): release state machine and recovery.
- [Recovery](operations/recovery.md): session restoration and native agent context.
- [Startup acceptance](operations/startup-acceptance.md): post-activation checks.
- [Desktop on Ubuntu](operations/desktop-production.md): desktop launcher, runtime package and rollback.
- [CI and release](operations/ci-and-release.md): CI tiers and the local release checklist.

## Browser

- [Tabs](browser/tabs.md): durable web tabs, ownership and URL policy.
- [Profiles, sessions and downloads](browser/profiles.md): partitions, downloads, DevTools, spellcheck.
- [Input isolation](browser/input-isolation.md): keeping keystrokes out of the wrong terminal.

## Terminals

- [Persistent PTY supervisor](terminals/ptyd.md): `workbench-ptyd.service` design.
- [PTY protocol](terminals/pty-protocol.md): supervisor wire protocol, replay and lifecycle.
- [History](terminals/history.md): on-disk history archive, retention and authorization.
- [Clipboard](terminals/clipboard.md): selection, copy and paste.

## Performance

- [Resource monitor](performance/resource-monitor.md): process attribution and accounting.
- [Budget policy](performance/budget-policy.md): memory tiers and view eviction.
- [Benchmark methodology](performance/benchmark-methodology.md): how to measure and gate regressions.

## Security

- [Threat model](security/threat-model.md): assets, boundaries and non-goals.
- [Local authentication](security/local-auth.md): token mode and the unsafe token-free mode.
- [WebAuthn](security/webauthn.md): hardware security keys in the desktop.
- [Privacy gate](security/privacy-gate.md): keeping personal data out of the repository.

## Development

- [Agent profiles](development/agent-profiles.md): configuring CLI accounts.
- [Desktop validation](development/desktop-validation.md): desktop test suites and manual acceptance.

## Media

- `media/`: demo recording and poster used by the README.

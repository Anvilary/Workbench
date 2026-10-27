# Agency-UI Lane B: native CLI profiles

This package adds ten distinct, explicitly configured profiles, without
installing, reauthenticating or wrapping a provider CLI.

## Owned modules and API

- `AgencyProfileStore(absoluteAppDataFile)` in
  `../../agency/agency-profile-store.ts`: `listDefinitions()`,
  `getDefinition(profileId)`, `configure(profileId, changes)`.
- `listAgencyProfiles(store, nativeRegistry)` and
  `inspectAgencyProfile(definition, nativeRegistry)` in
  `../../agency/agency-profile-capabilities.ts`: snapshots for the existing
  `agency.profiles.list`, `agency.profile.configure`, and
  `agency.profile.capabilities.get` messages. Wire validation and dispatch
  belong to the integration owner, not this lane.
- `buildAgencyProfileLaunch(store, nativeRegistry, request)`: validates the
  explicitly configured executable and native resume UUID, reuses the
  Workbench provider adapter `launch()` method and its `environment()`
  filter, and returns `file`, literal `args[]`, canonical `cwd`, per-process
  `env`, native session ID handling, provider and profile ID. Lane C passes
  these directly into the existing PTY process owner, retains the returned
  Workbench terminal ID separately, and never launches a second process on
  browser reattach.

No provider authentication keys, home overrides, tokens, account identities
or model catalogs are stored. Only reviewed locale/terminal colour environment
overrides are accepted. No global `process.env` mutation, `sh -c`, install,
account fallback or direct model API calls. CLI login and permission prompts
continue inside the original PTY.

## Important integration constraints

The Workbench registry is keyed by provider, while these ten profile IDs are
separate Agency domain IDs. Never pass `codex00` to `AgentRegistry.get()`;
use the stored provider. Never substitute `registry.defaultAgent()` after a
profile lookup fails. The selected profile is authoritative.

An executable can be an explicitly configured absolute path or a literal
command name resolvable from the **supplied environment's** PATH. The initial
profiles deliberately have empty executable paths. Do not automatically assign
all Codex or AGY profiles to a shared default binary, account or CLI home.

The existing Workbench history implementations read their provider-native
paths and may use the server's process environment. They have not been
partitioned by profile or made to follow an arbitrary per-profile auth home.
Do not claim a conversation belongs to a given profile based on provider alone.
Keep native history owned by the existing adapters and correlate to profile
only using the Agency runtime session's recorded ID. Any additional per-profile
history lookup requires a separate audited adapter change.

## Capability boundary

Launch, PTY interrupt, native resume arguments, native permission cycles and
activity are derived from the original Workbench adapter. The installed
executable is checked by filesystem access only, not executed. The app cannot
test account authentication without launching the CLI, so executable
availability **does not prove login**.

Codex TUI model selection is an unacknowledged interactive selector. Claude
and Antigravity expose static adapter model lists, but those are not
per-account, per-profile catalogs. Therefore `models: []`,
`discovery: unavailable`, `canSelectModel: false`, and
`canSelectEffort: false` are correct until safe native discovery and
acknowledged mutation are integrated. `VerifiedNativeCatalog` is a
server-only extension point for evidence from the same native CLI/profile; it
never allows model selection without acknowledgement.

Codex App Server is not enabled by this lane. Native Codex TUI launch remains
the fallback. Unverified CLI protocol handling must not be advertised.

## Validation

Focused tests: `pnpm exec tsx --test packages/server/src/agents/profiles/profiles.test.ts`
from repository root (requires `pnpm install --frozen-lockfile`).
Also run `pnpm typecheck` and `pnpm build`.

Outstanding Ubuntu integration checks: real configured wrapper paths,
account-specific login behavior, AGY actual `models` output,
native prompt/approval and interrupt behavior, per-profile history
correlation, and Codex App Server feature negotiation. None may trigger
paid inference during automated checks.

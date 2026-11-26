# Native CLI profiles

This package provides explicitly configured CLI profiles without installing,
reauthenticating or wrapping a provider CLI: one generic default per supported
CLI (`codex`, `agy`, `claude-code`) plus user-defined profiles. Onboarding
guide: [docs/development/agent-profiles.md](../../../../../docs/development/agent-profiles.md).

## Owned modules and API

- `AgencyProfileStore(absoluteAppDataFile)` in
  `../../features/profiles/profile-store.ts`: `listDefinitions()`,
  `getDefinition(profileId)`, `configure(profileId, changes)`.
- `listAgencyProfiles(store, nativeRegistry)` and
  `inspectAgencyProfile(definition, nativeRegistry)` in
  `../../features/profiles/profile-capabilities.ts`: snapshots for the existing
  `agency.profiles.list`, `agency.profile.configure`, and
  `agency.profile.capabilities.get` messages. Wire validation and dispatch
  belong to the WebSocket transport.
- `buildAgencyProfileLaunch(store, nativeRegistry, request)`: validates the
  explicitly configured executable and native resume UUID, reuses the
  Workbench provider adapter `launch()` method and its `environment()`
  filter, and returns `file`, literal `args[]`, canonical `cwd`, per-process
  `env`, native session ID handling, provider and profile ID. The session runtime passes
  these directly into the existing PTY process owner, retains the returned
  Workbench terminal ID separately, and never launches a second process on
  browser reattach.

No provider authentication keys, home overrides, tokens, account identities
or model catalogs are stored. Only reviewed locale/terminal colour environment
overrides are accepted. No global `process.env` mutation, `sh -c`, install,
account fallback or direct model API calls. CLI login and permission prompts
continue inside the original PTY.

## Important integration constraints

The Workbench registry is keyed by provider, while profile IDs are
separate Agency domain IDs. Never pass a profile ID such as `codex-a` to `AgentRegistry.get()`;
use the stored provider. Never substitute `registry.defaultAgent()` after a
profile lookup fails. The selected profile is authoritative.

An executable can be an explicitly configured absolute path or a literal
command name resolvable from the **supplied environment's** PATH.
The resolver validates the canonical target is an executable file but passes
the selected symlink/alias entry point as the actual PTY `file`. This matters
for native wrappers that select configuration by invocation name (such as
`$0`). A profile whose configured executable is missing fails without trying
another profile or resolving to a provider default. Default
profiles deliberately have empty executable paths. Do not automatically assign
all Codex or AGY profiles to a shared default binary, account or CLI home.
**Separate profile IDs do not prove distinct authenticated accounts.**
Even if two profiles select different names, their symlinks may resolve to the
same binary, and they may use the same provider-managed login. The same
binary invoked twice is *not* evidence of account isolation. Distinct native
auth contexts must be verified per original CLI on Ubuntu using user-reviewed
wrapper/configuration behavior. The app neither selects nor rewrites provider
home directories, and the argument filter is heuristic, not a complete
credential-secret detector.

Profile persistence restores the last valid checkpoint from `.bak` when the
primary is missing or malformed. A newer/unsupported schema version is never
treated as corrupt, quarantined or downgraded. Without a valid backup, malformed
primary data must fail closed instead of resetting profile configuration.

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

Codex App Server is not enabled. Native Codex TUI launch remains
the fallback. Unverified CLI protocol handling must not be advertised.

## Model/effort capability integration seam (future work)

**Unimplemented on all providers**: no editable model or effort
controls may be advertised. Current profile snapshots return
`canSelectModel=false` / `canSelectEffort=false` even if a native catalog is
supplied. A command written to the PTY is not an acknowledgement that the
provider changed a setting. The smallest safe incremental integration is:

1. Add a bounded, read-only, provider-native capability discovery method behind
   the existing adapter, explicitly scoped to the selected executable/profile.
   Verify options actually accepted by the installed CLI without triggering
   chat turns, model requests or login. Keep unknown catalogs empty. Do not
   reuse static provider-wide model lists as account-specific evidence.
2. Only where the **installed Codex binary** demonstrably supports App Server,
   negotiate its protocol using the existing profile invocation and account
   context. Correlate request IDs, native acknowledgements and failures; keep
   TUI fallback unchanged. Do not infer support from a CLI name or version
   alone, and do not silently switch transports/accounts.
3. For Claude/Antigravity, preserve interactive permission prompts. A future
   provider-specific setting path must be verified against the original native
   CLI and must observe explicit native confirmation (or authoritative
   post-change session state), scoped to that profile and live native session.
   A slash command, key press, static model option or speculative status line
   is insufficient proof. No custom Gemini harness or direct API calls.
4. Wire `agency.session.selection.set` only when the same native session
   confirms the applied model/effort. Return an explicit unsupported/error
   result otherwise, without changing stored selection or implying success.
   Keep the capability disabled independently for unsupported providers.

Native resume IDs currently have format validation only. The session runtime
must authorize their ownership using server-side Agency profile/session
mapping before passing one to the original adapter. Provider history readers
are not profile-separated merely because profile IDs exist.

## Validation

Focused tests, executed from repository root after `corepack pnpm install --frozen-lockfile`:

```sh
corepack pnpm --filter @agent-workbench/server exec tsx --test src/agents/profiles/profiles.test.ts
corepack pnpm typecheck
corepack pnpm build
corepack pnpm check
```

The default root CI currently **does not run** the profile test file;
successful CI compilation, packaging or smoke testing alone is not evidence
the new suite passed. Run it explicitly in an Ubuntu checkout, or add a
separately reviewed focused workflow through the integration owner.

Outstanding Ubuntu integration checks: real configured wrapper paths,
account-specific login behavior, AGY actual `models` output,
native prompt/approval and interrupt behavior, per-profile history
correlation, and Codex App Server feature negotiation. None may trigger
paid inference during automated checks.

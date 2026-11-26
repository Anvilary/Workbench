# Recovery and native agent context

How Workbench restores workspaces and agent sessions after a backend restart or reboot, and which guarantees it does not make. Session data model: [session contract](../architecture/session-contract.md). Profiles: [agent profiles](../development/agent-profiles.md).

## Authentication reuse and historical ownership are separate

Workbench runs the configured executable of a profile (for example a named wrapper such as `codex-a`) with an argument array and the adapter-filtered environment. It never replaces a named wrapper with a generic provider binary, launches a login flow, creates accounts, imports terminal secrets into systemd or copies native credentials. The wrapper performs its own HOME, XDG and keyring setup.

Finding an executable proves neither authentication, an unlocked keyring nor ownership of a past conversation. The systemd service environment differs from an interactive shell: its default `PATH` lacks `~/.local/bin` and version-manager paths, so the rendered unit supplies them. Check every wrapper under the service environment before relying on automatic recovery.

## Versioned host bindings

Automatic resume requires a verified binding between a profile and its native state:

- Version 1 attestations cover Codex profiles. Version 2 covers all providers: exact executable, argv and overrides, the provider state root, an allowlisted non-secret launch context, required environment-variable presence (never values), exact command resolution, and SHA-256 hashes of reviewed wrappers, helpers and native executables.
- The identity manifest (`agency-native-identities.json` in the app config directory) must belong to the current user, mode 0600, not writable by others. Missing or changed artifacts, dispatch resolution, HOME/XDG or profile config yield no verified identity. Interactive launch still works, without a trusted history feed.
- Each runtime session records a `bindingId`. Recovery compares it with the current verified binding before spawning. Re-attesting changed code does not silently reassign old sessions. Records without a binding are manual-only. Unknown ownership is never backfilled from a matching filename, path, current authentication or wrapper name.
- Ownership checks use only readable, nonempty, same-user regular files inside the verified root and reject symlink escapes: Codex rollouts in `sessions/` or `archived_sessions/`, AGY `conversations/<id>.db|pb`, Claude `projects/<cwd-slug>/<id>.jsonl`. History bodies and credential files are never opened.

Build and check a manifest with:

```sh
pnpm --filter @anvilary/workbench-server exec tsx scripts/build-native-attestation.mjs <reviewed-spec.json> <new-identities.json>
pnpm --filter @anvilary/workbench-server exec tsx scripts/check-native-context.mjs <agency-profiles.json> <new-identities.json>
```

The builder reads only reviewed executable and helper artifacts and refuses to overwrite its output. The checker never launches native CLIs. Never refresh attestations automatically to bypass a changed-identity refusal; review wrapper changes first.

## Startup policy

- Only backend startup invokes recovery. Browser refresh, reconnect and navigation attach to existing PTYs.
- Recovery is single-flight and sequential, bounded by a global limit of 24 active attempts and the terminal registry limit. One failure does not stop sibling recovery; failed tabs stay visible and retryable.
- Done or archived workspaces, archived projects, stopped or exited agents, missing directories, unknown identities and empty workspaces never auto-launch.
- Native resume never sends a prompt, never picks another profile and never falls back to a new conversation.
- Shell tabs restart with new shell processes; the original process and its volatile scrollback are not restored. Terminal history on disk is described in [terminal history](../terminals/history.md).
- AGY capacity is checked conservatively against same-user processes before each resume and is deferred with a visible explanation when exceeded. This is not a lock shared with external launchers.
- Managed Codex discovery refuses ambiguous same-home, same-directory attribution instead of guessing.

Intentional Stop persists `stoppedByUser` before closing the runtime. Close waits up to five seconds for a confirmed exit before marking the tab closed. Closed tabs never auto-recover.

## Keyring and helper lifetime

Wrappers that start private D-Bus or keyring helpers must not create them for the first time inside `workbench.service`: they would inherit its control group and stop with it. Keep such helpers in an independent user context (for example a reviewed oneshot user unit with `RemainAfterExit=yes`, ordered before Workbench, without `PartOf=`). A locked keyring may require user interaction; Workbench never unlocks or copies it.

API-key environment variables present in an interactive shell are not imported into systemd. An AGY profile in account mode ignores `GEMINI_API_KEY`; version 2 AGY bindings require account mode, and a change of mode fails closed for recovery.

## Rollback of session data

Session store schema upgrades are additive and migrate at startup or next save. Before rolling back to an older build, keep the newer files under private backup names; never overwrite newer metadata with an older backup without reviewing the work in between. Native provider history stays outside Workbench and must not be removed.

## Manual acceptance

After a deployment, validate each configured profile with its own wrapper: authentication is reused without login, the correct prior conversation resumes, a mismatched home is refused, a browser reconnect keeps one controller, and a controlled restart or reboot preserves eligible sessions.

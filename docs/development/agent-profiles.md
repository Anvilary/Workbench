# Agent profiles

A profile binds a workspace tab to one coding-agent CLI and its authenticated account. Workbench ships one generic default per supported CLI and lets you add more. Implementation notes for contributors: [`packages/server/src/agents/profiles/README.md`](../../packages/server/src/agents/profiles/README.md). Recovery rules: [recovery](../operations/recovery.md).

## Defaults

| Profile ID | Provider | Standard command |
|---|---|---|
| `codex` | Codex | `codex` |
| `agy` | Antigravity (AGY) | `agy` |
| `claude-code` | Claude Code | `claude` |

Additional accounts are user-defined profiles (for example `codex-a` and `codex-b`, each running its own wrapper). Workbench can suggest accounts it discovers in standard locations, but never assigns them automatically.

## Why executables start empty

Workbench never guesses which binary or account a profile should use. An empty executable means "not configured": the UI shows a **Profile not configured** banner with a **Configure** button, and the profile dialog shows provider-specific setup notes and placeholder suggestions without persisting them.

Separate profile IDs do not prove separate accounts. Two names can resolve to the same binary and the same provider login. Account isolation comes from the wrapper you configure, not from Workbench.

## Setting up a profile

1. Create a wrapper per account that sets the provider's home and execs the real CLI. For example, for a second Codex account:

   ```sh
   #!/bin/sh
   # ~/.local/bin/codex-a
   export CODEX_HOME="$HOME/.codex-a"
   exec codex "$@"
   ```

   AGY accounts typically use a private HOME/XDG root per account (for example `~/.local/share/agy-a-profile/home`), with any keyring or D-Bus helper started outside Workbench (see [recovery](../operations/recovery.md#keyring-and-helper-lifetime)). Claude Code uses `~/.claude`, or `CLAUDE_CONFIG_DIR` set by its wrapper.
2. Make the wrapper resolvable from the service `PATH` (`~/.local/bin` is included by the rendered unit), or configure an absolute path.
3. Authenticate once in a normal terminal with the wrapper. Workbench never runs a login flow.
4. In Workbench, open the profile dialog, set the executable to the wrapper name, and save.

The resolver validates that the target is an executable file but launches the entry point you selected (symlink or alias), because some wrappers select their configuration by invocation name.

## Rules

- No API keys, tokens, home overrides or account identities are stored in profiles. Only reviewed locale and terminal colour environment overrides are accepted.
- Never pass a profile ID to the provider registry; use its provider. A missing executable fails the launch; there is no fallback to another profile or a provider default.
- Workbench does not create, rewrite or delete provider homes. Never delete a profile home to reset a profile.
- Account-specific directories (`.codex*`, `.gemini`, `.claude`, keyring directories) are refused as workspace directories.

## Verifying and recovering

- Run the wrapper in a normal terminal and confirm it reports the expected account.
- Check the service environment: `systemctl --user show-environment` and the rendered unit's `PATH` must resolve the same wrapper.
- For automatic resume, build and check the host identity manifest as described in [recovery](../operations/recovery.md#versioned-host-bindings).
- A misconfigured profile can be reset by clearing its executable in the dialog. Profile data is restored from the `.bak` checkpoint if the primary file is malformed; a newer schema is never downgraded.

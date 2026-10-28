# Native recovery and authentication context

## Authentication reuse and historical ownership are separate

MAW executes the configured named entry point, with an argument array and the existing adapter-filtered inherited environment. It never replaces a named wrapper with a generic provider binary, launches login, creates an account, imports terminal secrets into systemd, or copies native credentials. The original wrapper performs its own existing HOME/XDG/keyring setup. Finding an executable does not prove authentication, an unlocked keyring, or historical session ownership.

Host inspection on 2026-10-28 found UID 1000, HOME /home/alteixeira20, USER alteixeira20 and SHELL /usr/bin/zsh in both contexts. Systemd's default PATH lacks ~/.local/bin and NVM; maw.service supplies them. Under that PATH, all ten selected paths and the Codex/node/bash/D-Bus/keyring command dependencies match the interactive resolution. XDG_CONFIG_HOME, XDG_DATA_HOME and CLAUDE_CONFIG_DIR are unset in both observed contexts; each AGY wrapper supplies its own XDG values. Interactive CODEX_HOME can be inherited from the agent launching MAW, while systemd has none: codex00/01/03 explicitly replace it with their own root. TERM is a PTY property; lack of a service-manager terminal is not a reason to run an interactive login shell.

No credentials, native authentication files, tokens or conversation contents were inspected for this verification. AGY native conversation state was inspected by filename/stat counts only. A read-only ten-profile context checker passed in both interactive and transient systemd environments without executing any real native CLI.

## Ten-profile matrix

All executables below are selected through /home/alteixeira20/.local/bin/. Internal claude-code maps to claude. A verified state namespace is local storage provenance, not a remote account-ID assertion.

| Profile | Exact executable | Existing authentication context reused | Verified native state root | Native resume | Automated recovery |
| --- | --- | --- | --- | --- | --- |
| codex00 | codex00 | Original wrapper sets CODEX_HOME=~/.codex | ~/.codex | resume ID | Implemented with attestation + original owned ID |
| codex01 | codex01 | Original wrapper sets CODEX_HOME=~/.codex-ar | ~/.codex-ar | resume ID | Implemented with attestation + original owned ID |
| codex03 | codex03 | Original wrapper sets CODEX_HOME=~/.codex03 | ~/.codex03 | resume ID | Implemented with attestation + original owned ID |
| agy00 | agy00 (selected symlink retained) | Real HOME/XDG and existing user Secret Service/D-Bus | ~/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
| agy01 | agy01 | Original private HOME/XDG and agy01-profile-start keyring helper | ~/.local/share/agy01-profile/home/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
| agy02 | agy02 | Original private HOME/XDG and agy02-profile-start keyring helper | ~/.local/share/agy02-profile/home/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
| agy03 | agy03 | Original private HOME/XDG and agy03-profile-start keyring helper | ~/.local/share/agy03-profile/home/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
| agy04 | agy04 | Original private HOME/XDG and agy04-profile-start keyring helper | ~/.local/share/agy04-profile/home/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
| agy05 | agy05 | Original private HOME/XDG and agy05-profile-start keyring helper | ~/.local/share/agy05-profile/home/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
| claude-code | claude | Original HOME/.claude, inherited CLAUDE_CONFIG_DIR if explicitly configured and attested | ~/.claude on this host | --resume ID | Implemented with version 2 binding and original project-session JSONL |

For every row, real authenticated interaction, post-reboot keyring availability and native resume acceptance remain controlled manual tests. All ten contexts and resume argument vectors have been tested with disposable fake CLIs in real PTYs, including under systemd. No paid inference was used. The live service is not enabled, and these statuses do not claim that a real provider successfully authenticated in an automated test.

## Versioned host bindings

Existing version 1 Codex attestations remain supported. Version 2 adds all providers, exact executable/argv/overrides, explicit provider state root, an allowlisted non-secret launch context, required environment-variable presence (never secret values), exact command resolution and SHA-256 hashes of reviewed wrappers/helpers/native executables. The version 2 manifest must belong to the current user and not be writable by other users. Missing/changed artifacts, dispatch resolution, HOME/XDG or profile config yield no verified identity; explicit interactive launch still uses the original wrapper without a trusted history feed.

A bindingId is captured in each new runtime session. Automatic recovery compares it with the current verified binding before spawning. Reattesting modified code does not silently reassign old sessions to the new context. AGY/Claude legacy records without a bindingId are manual-only. Native IDs seen in launch-specific AGY logs may be retained even with unknown ownership, but cannot authorize auto-resume. Unknown historical ownership is never backfilled from a matching filename, realpath, current authentication or wrapper name.

Ownership validation uses only existing readable, nonempty, same-user regular native state within the verified canonical root, rejecting symlink escapes: Codex rollout in sessions/archived_sessions; AGY conversations/ID.db or ID.pb; Claude projects/canonical-cwd-slug/ID.jsonl. It does not open history bodies or credential files. The original persisted provider/home/binding must agree, so a copied same-ID file in another home cannot transfer an existing controller.

Prepared host-specific examples: HOST-CONTEXT-SPEC.example.json and HOST-IDENTITIES.example.json. The spec records reviewed assignments from the actual wrappers; the program never infers accounts from arbitrary shell source. The checker never executes wrappers. These files are not installed into the live configuration because the original main checkout supports only version 1; use OPERATIONS.md after deploying this feature. Review wrapper/helper source before regenerating attestations after upgrades. Never refresh attestations automatically to bypass a changed-identity refusal.

## Startup policy, process ownership and history

Only backend startup invokes recovery. Browser refresh/reconnect/navigation and CLI/Terminal/split views attach existing PTYs. Recovery remains single-flight and sequential, using atomic workspace slots and provider-native conversation claims. Done/Archived workspaces, archived projects, explicitly stopped or naturally exited agents, missing directories, unknown identity/ID and empty workspaces never auto-launch. Stale starting/resuming states reconcile; partial failure retains the original reference and explanation without infinite retries. Native resume never sends a model prompt, chooses another profile or falls back to a new conversation.

Intentional Stop persists stoppedByUser before registry closure. Server shutdown detaches exit listeners before terminating server-owned PTYs, retaining eligible active intent for replacement PTYs next startup. Linux kernel-owned store reservations reject duplicate server owners and release after crash/reboot. Process-local terminal scrollback does not survive reboot; durable provider history remains in the original provider's namespace.

AGY capacity is checked conservatively against same-user /proc process names before each recovery. Four existing agy/agy00–agy05 processes, unreadable process inventory, or unsupported OS defer the resume with a visible explanation. External AGY processes already exceed the limit on the observed host; none were stopped. This observation is not an atomic lock shared by every launcher, so a simultaneous external start can still race. MAW does not claim a guaranteed laptop-wide semaphore. Recovery does not launch all six AGY profiles at once.

History followers receive the verified native root for all providers. Unknown managed identities expose no global history. AGY fallback discovery uses the original account's log root rather than the server home; scoped followers reject cross-root watcher redirects and symlink escapes. Claude managed history is polled because the global watcher does not cover another account's root. Global provider status and Claude's global-history resume-dialog automation are disabled for managed AGY/Claude sessions; native interaction remains in the PTY and activity is reported unknown when not established.

## Manual acceptance still required

After reviewed deployment, validate each matrix row using its original wrapper: existing authentication is reused without login; the correct prior conversation resumes; a mismatched home refuses; browser reconnect keeps one controller; and a controlled restart/reboot preserves eligible intent. Check AGY private D-Bus/keyring helpers after reboot and before graphical login. An encrypted/locked keyring may require user interaction; MAW never unlocks or copies it. Historical records without launch provenance remain manual-only. Do not stop unrelated workflows merely to clear AGY capacity during acceptance.

# Native recovery and authentication context

## Authentication reuse and historical ownership are separate

MAW executes the configured named entry point, with an argument array and the existing adapter-filtered inherited environment. It never replaces a named wrapper with a generic provider binary, launches login, creates an account, imports terminal secrets into systemd, or copies native credentials. The original wrapper performs its own existing HOME/XDG/keyring setup. Finding an executable does not prove authentication, an unlocked keyring, or historical session ownership.

Host inspection on 2026-10-28 found UID 1000, HOME /home/user, USER user and SHELL /usr/bin/zsh in both contexts. Systemd's default PATH lacks ~/.local/bin and NVM; maw.service supplies them. Under that PATH, all ten selected paths and the Codex/node/bash/D-Bus/keyring command dependencies match the interactive resolution. XDG_CONFIG_HOME, XDG_DATA_HOME and CLAUDE_CONFIG_DIR are unset in both observed contexts; each AGY wrapper supplies its own XDG values. Interactive CODEX_HOME can be inherited from the agent launching MAW, while systemd has none: codex-0/01/03 explicitly replace it with their own root. TERM is a PTY property; lack of a service-manager terminal is not a reason to run an interactive login shell.

No credentials, native authentication files, tokens or conversation contents were inspected for this verification. AGY native conversation state was inspected by filename/stat counts only. A read-only ten-profile context checker passed in both interactive and transient systemd environments without executing any real native CLI.

## Ten-profile matrix

All executables below are selected through /home/user/.local/bin/. Internal claude-code maps to claude. A verified state namespace is local storage provenance, not a remote account-ID assertion.

| Profile | Exact executable | Existing authentication context reused | Verified native state root | Native resume | Automated recovery |
| --- | --- | --- | --- | --- | --- |
| codex-0 | codex-0 | Original wrapper sets CODEX_HOME=~/.codex | ~/.codex | resume ID | Implemented with attestation + original owned ID |
| codex-1 | codex-1 | Original wrapper sets CODEX_HOME=~/.codex-ar | ~/.codex-ar | resume ID | Implemented with attestation + original owned ID |
| codex-3 | codex-3 | Original wrapper sets CODEX_HOME=~/.codex-3 | ~/.codex-3 | resume ID | Implemented with attestation + original owned ID |
| agy-0 | agy-0 (selected symlink retained) | Real HOME/XDG and existing user Secret Service/D-Bus | ~/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
| agy-1 | agy-1 | Original private HOME/XDG and agy-1-profile-start keyring helper | ~/.local/share/agy-1-profile/home/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
| agy-2 | agy-2 | Original private HOME/XDG and agy-2-profile-start keyring helper | ~/.local/share/agy-2-profile/home/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
| agy-3 | agy-3 | Original private HOME/XDG and agy-3-profile-start keyring helper | ~/.local/share/agy-3-profile/home/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
| agy-4 | agy-4 | Original private HOME/XDG and agy-4-profile-start keyring helper | ~/.local/share/agy-4-profile/home/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
| agy-5 | agy-5 | Original private HOME/XDG and agy-5-profile-start keyring helper | ~/.local/share/agy-5-profile/home/.gemini/antigravity-cli | --conversation ID | Implemented with version 2 binding and capacity gate |
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

AGY capacity is checked conservatively against same-user /proc process names before each recovery. Four existing agy/agy-0–agy-5 processes, unreadable process inventory, or unsupported OS defer the resume with a visible explanation. External AGY processes already exceed the limit on the observed host; none were stopped. This observation is not an atomic lock shared by every launcher, so a simultaneous external start can still race. MAW does not claim a guaranteed laptop-wide semaphore. Recovery does not launch all six AGY profiles at once.

History followers receive the verified native root for all providers. Unknown managed identities expose no global history. AGY fallback discovery uses the original account's log root rather than the server home; scoped followers reject cross-root watcher redirects and symlink escapes. Claude managed history is polled because the global watcher does not cover another account's root. Global provider status and Claude's global-history resume-dialog automation are disabled for managed AGY/Claude sessions; native interaction remains in the PTY and activity is reported unknown when not established.

## Manual acceptance still required

After reviewed deployment, validate each matrix row using its original wrapper: existing authentication is reused without login; the correct prior conversation resumes; a mismatched home refuses; browser reconnect keeps one controller; and a controlled restart/reboot preserves eligible intent. Check AGY private D-Bus/keyring helpers after reboot and before graphical login. An encrypted/locked keyring may require user interaction; MAW never unlocks or copies it. Historical records without launch provenance remain manual-only. Do not stop unrelated workflows merely to clear AGY capacity during acceptance.

## Authentication-environment finding

A presence-only comparison found ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY and GOOGLE_API_KEY absent in both contexts. GEMINI_API_KEY is present interactively and absent under systemd; its value was never printed, copied or stored. DBUS_SESSION_BUS_ADDRESS is present in both, while GNOME_KEYRING_CONTROL is absent. Only the non-secret modelProvider field was inspected in each AGY settings.json; all six use account mode.

The [official AGY authentication documentation](https://www.antigravity.google/docs/install/) says that GEMINI_API_KEY alone has no effect; API-key operation requires modelProvider=gemini. Thus this observed variable difference does not select API-key authentication for the current six profiles. Version 2 AGY bindings explicitly require account mode and recheck that non-secret setting on each verification. Changed/unrecognized/API-key mode fails closed for recovery, retaining interactive wrapper launch. API-key mode has no verified named-account ownership in this implementation; MAW never imports the key into systemd. Settings symlinks cannot escape the attested native root.

An invalid optional identity manifest disables recovery and trusted historical attribution, while keeping interactive CLI startup available through the original selected wrapper. AGY account-specific .gemini, XDG configuration and keyring directories are protected from workspace selection.

Shared-helper caveat: AGY keyring/D-Bus daemons newly created inside MAW can inherit its service cgroup, unlike already-running helpers created by normal terminal use. Keep required helper contexts independent of MAW before live activation so a server stop cannot tear down a private bus reused by manual workflows. The original helper executables remain unchanged. This requires controlled deployment/lifetime acceptance; fixture PTY success does not establish real keyring lifecycle safety.

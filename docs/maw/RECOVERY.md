# Native recovery contract

Requested policy: automatically resume all eligible previously running ACTIVE agent workspaces at backend startup. Never resume Done/Archived workspaces, archived projects, intentional Stop/exit, missing directories, unknown sessions or unverified accounts. Browser navigation/reconnect never launches a process.

At checkpoint zero automatic recovery is NOT implemented. Existing runtime reconciles orphaned metadata as exited; native identity checks and manual native resume exist. Preserve these boundaries. Each provider requires verified native session ownership before enabling automatic recovery. Unsupported identities must stay visible as manual resume required, retaining the original reference. Never substitute a fresh conversation.

Persist recovery intent before launch and outcome afterward. One owner per native conversation, workspace slot and store. Recovery must be bounded, with no infinite retry. No prompts or paid providers in tests. Distinguish durable provider history from volatile PTY scrollback.

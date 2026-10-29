# MAW operations

## Installation status

Commands installed at /home/alteixeira20/.local/bin/maw and /home/alteixeira20/.local/lib/maw/control.mjs. Source: scripts/maw/. Tested from arbitrary cwd. No live maw.service installed, enabled or started. The original main checkout and existing providers remain untouched.

The verified service template uses the original repository WorkingDirectory and Node /home/alteixeira20/.nvm/versions/node/v24.22.0/bin/node with the package-local tsx loader. It needs installed workspace dependencies and a production web build. PATH explicitly includes the verified NVM directory, ~/.local/bin, and system binary directories; systemd does not load interactive shell files. An ExecStartPre guard rejects the pre-feature checkout.

pnpm: 12.16.1. Corepack 0.36.0 verified; Node 24.22.0 verified. Use the repository pin via `corepack pnpm install --frozen-lockfile`. No global pnpm changes needed. Future removal of this NVM version requires updating the unit and wrapper paths.

## Guarded activation

1. Review and deploy the feature to the original repository through the normal reviewed integration process. This agent does not merge or modify main. Before deployment record the running server PIDs/cwds and which store each owns. The new guard cannot coordinate with pre-feature servers that do not implement it.
2. Back up the existing application JSON configuration (default ~/.config/agent-workbench; honor any prior XDG override) with private permissions. Do not copy native credentials into MAW. Ensure the service environment selects the same intended stores and profiles.
3. Install frozen dependencies and build from the deployed original repository. Verify `packages/server/src/maw-host.ts` exists. Run the full checks recorded in IMPLEMENTATION-STATUS.md.
4. Stop any old/manual server owning those stores deliberately after accounting for its live PTYs. No signal is implied by installation. Live PTYs terminate with the server; native conversation recovery creates replacement processes.
5. Run `scripts/maw/install.sh --service` from the deployed repository. It refuses to overwrite an existing unit. Review `systemctl --user cat maw.service` and `systemd-analyze --user verify ~/.config/systemd/user/maw.service`.
6. Run `systemctl --user enable maw.service`, then `maw start`, `maw status`, `maw open`. Check workspace recovery outcomes. Test one controlled reboot manually only after accepting provider limitations in RECOVERY.md.

Existing Linger=yes was observed; it was not changed. An enabled user unit normally starts at login. With lingering it can run at boot before login and after logout, with this user's file permissions, credentials accessible to native CLIs, and resource usage. Encrypted or unavailable home directories can delay/fail boot startup. No sudo or root unit is used.

## Commands

`maw start`, `maw stop`, `maw restart`, `maw status`, `maw logs`, `maw logs --follow`, `maw open`, `maw help` work from any directory. Stop/restart warn about terminating PTYs, never erase metadata. Restart cannot preserve the original processes or volatile terminal scrollback.

Status checks systemd ActiveState/SubState/MainPID and an authenticated HTTP readiness probe. Open requires a private runtime file whose PID matches systemd MainPID, validates the loopback URL, checks readiness and invokes xdg-open without printing the token. Managed startup output omits the token. Runtime metadata is mode 0600 under a 0700 directory; it contains a per-start token, not persistent provider credentials. Other processes under the same user may inspect argv/runtime files as with the original browser launcher.

Restart=on-failure, 5-second delay, at most 3 starts per 120 seconds; `systemctl --user reset-failed maw.service` clears the limit after fixing a failure. KillMode=control-group clears remaining server children on shutdown. Graceful shutdown flushes Agency stores. Loopback and existing Host/token/Origin checks remain enforced. Logs use the existing journal retention policy; the unit rate-limits messages to 200 per 30 seconds. No global journal settings changed.

## Rollback

Warn about PTYs, then `systemctl --user disable --now maw.service`. Preserve the unit for inspection or remove only that unit and run `systemctl --user daemon-reload`. Leave lingering and unrelated services alone. Restore the previous application deployment through Git review; retain JSON backups and native provider history. Optional command removal affects only ~/.local/bin/maw and ~/.local/lib/maw/control.mjs. Never delete profile homes. Recovery fields are additive and old native references are retained; do not overwrite newer metadata with a backup without reviewing the intervening work.

## Native context continuation (2026-10-28)

The former AGY/Claude implementation blocker is resolved by version 2 host bindings and provider-specific native-state checks. Deployment and real authenticated acceptance remain manual. The original main checkout is unchanged and cannot read version 2; therefore no identity manifest was installed into the live configuration. All existing profiles, wrappers, accounts, credentials and sessions were preserved.

Read RECOVERY.md for the per-profile matrix and the distinction between authentication reuse and historical ownership. The observed interactive and systemd contexts both verify against the prepared host manifest with the MAW PATH. No live CLI was launched to obtain this evidence. AGY named wrappers retain their existing private D-Bus/keyring helper behavior; MAW does not recreate that behavior or import secrets into the user manager.

After deploying this branch, review HOST-CONTEXT-SPEC.example.json against the current wrappers and command paths. Generate a NEW private manifest with:

```
pnpm --filter @agent-workbench/server exec tsx scripts/build-native-attestation.mjs /absolute/reviewed-spec.json /absolute/new-identities.json
pnpm --filter @agent-workbench/server exec tsx scripts/check-native-context.mjs /absolute/agency-profiles.json /absolute/new-identities.json
```

The builder reads only reviewed executable/helper artifacts, not credentials, and refuses to overwrite its output. The checker reads only profile/identity configuration and executable metadata; it never launches native CLIs or changes configuration. Check the same inputs under a transient systemd process with the service PATH before installation. A required variable's presence does not prove authentication or an unlocked keyring.

Install the reviewed manifest as mode 0600 at the existing configuration's agency-native-identities.json only after deploying version 2 support. Preserve any prior manifest privately and do not replace an existing one without reviewing its bindings. Never point a pre-feature checkout at the version 2 file. Future binary/wrapper/helper upgrades fail closed until reviewed; do not automatically rehash changes and assume old sessions are safe to resume.

Before rolling back to the original main version, move the version 2 manifest to a private backup and restore the prior version 1 manifest if one existed. This host originally had no identity manifest. Preserve all newer runtime/native references; do not use manifest rollback to erase session metadata. The live service remains disabled; no wrapper, native keyring helper or credential store was modified by this continuation.

Presence-only auth comparison found GEMINI_API_KEY only in the interactive environment. All six AGY settings use account mode, in which the native CLI ignores that variable unless modelProvider selects gemini (see the official source in RECOVERY.md). No secret was imported into systemd. AGY attestations now require account mode; changing that setting invalidates recovery. If API-key mode is desired later, explicit interactive wrapper launch remains available, but its historical named-account ownership is not verified automatically.

AGY shared-helper lifetime check: an existing private D-Bus/keyring helper is reused without moving it. If the original profile-start helper creates daemons for the first time inside maw.service, those daemons inherit the MAW cgroup and KillMode=control-group may terminate them at MAW shutdown, affecting later manual wrappers that reuse that private bus. Before live activation, keep each required original profile-start helper in an independent persistent user context (for example a reviewed oneshot user unit with RemainAfterExit=yes), ordered before MAW and without PartOf=maw.service. Use the original helper executable; do not replace its authentication setup. Verify its cgroup/lifetime through a controlled native acceptance test. No real helper was executed or relocated during this work. This lifecycle prerequisite remains a manual deployment check; it is not proof of unlocked authentication before login.

## Multi-session tabs deployment and rollback boundary

The multi-session feature is developed separately from PR #8 and targets its branch while #8 is unmerged. No dependency worktree, live service or user configuration was modified. Deploy the reviewed feature code and build before opening the new UI; do not activate a service as part of reviewing the draft PR.

Logical tab count and process count differ: historical/exited/closed attempts remain durable, while at most 24 active Agency attempts are reserved globally and TerminalRegistry independently enforces its 24-entry limit atomically across raw and managed opens. AGY startup recovery retains PR #8's conservative external-process observation, not a shared laptop-wide semaphore. No workspace-level one-agent/one-shell restriction remains. A tab close acts on its exact runtime/PTY; workspace navigation and Done/Archive never imply close.

Back up agency-sessions.json and its validated backup privately before deployment. Schema 1 migrates to schema 2 at startup/next save; all old runtime/native references remain. The prior PR #8 reader rejects schema 2 rather than silently downgrading it. Before rollback, preserve the complete newer schema 2 files under private backup names. Returning to the older reader requires an explicitly reviewed schema 1 snapshot and will not display newer logical tabs; never overwrite or discard the schema 2 history to make an older build start. Native provider history remains outside MAW and must not be removed.

Manual acceptance: create each preset; add mixed/repeated profiles and three shells; verify exact native auth contexts; switch/scroll/reorder/refresh without process creation; cancel and confirm closing only one running session; close an exited tab; restart the managed server only in an approved isolated/deployed environment and inspect shell replacement/native-resume identities; verify Done/Archived and closed tabs stay stopped. Check real native TUI bottom rows, keyboard/clipboard behavior, keyring cgroup prerequisites and reboot with the original profiles. No paid/native authentication smoke was performed automatically.

## feat/maw-launcher-update-onboarding additions (2026-10-29)

### Launcher Enhancements

1. **`maw url`**: Prints the authenticated localhost URL (e.g. `http://127.0.0.1:<port>/?token=<token>`) strictly to standard output for the invoking authorized user. The session token is never emitted into systemd logs or journalctl, preserving loopback credential confinement.
2. **Improved `maw open [browser]`**: Accepts an optional browser binary parameter (e.g., `maw open brave`, `maw open google-chrome`, `maw open firefox`). When omitted, defaults to `xdg-open`. Pre-validates service readiness and URL validity before spawning. Browsers are never automatically spawned on service startup.
3. **`maw update`**: Automated, guarded repository updates supporting `--no-restart` (default for staging without interrupting active work) and `--restart` (immediate reload). It verifies worktree cleanliness (`git status --porcelain`) and branch convergence before attempting a fast-forward merge (`git merge --ff-only`), executes frozen dependency installation (`corepack pnpm install --frozen-lockfile`), validates build artifacts (`pnpm typecheck`, profile tests, `pnpm build`), and records operational history to `~/.local/share/maw/update-log.jsonl`. If build verification fails, it rolls back git and dependency state automatically to leave the running server unaffected.

### Developer-Safe Restart Mechanism

When `maw update --restart` (or `maw restart`) is executed inside a MAW-hosted shell or agent tab, issuing a synchronous `systemctl --user restart maw.service` would trigger `KillMode=control-group` and terminate the invoking shell before completion. 

The launcher detects whether any ancestor process belongs to `maw.service`'s `MainPID`. If detected inside a MAW shell, it hands off the restart to a transient systemd user timer unit:
```sh
systemd-run --user --unit=maw-restart-$ts --no-block --on-active=2 systemctl --user restart maw.service
```
This enables the update process to finish writing audit logs and exit code 0 cleanly, while the transient unit restarts the service out-of-cgroup 2 seconds later.

### Profile Onboarding Improvements

1. **Profile Suggestions (`profile-suggestions.ts`)**: Introduces `suggestedExecutable()` and `providerSetupNote()` helpers to provide provider-specific wrapper recommendations and contextual setup guidance.
2. **First-Time Guidance in `AgencyProfileDialog`**: When a profile's executable field is empty, the dialog displays provider-specific onboarding notes explaining the wrapper requirement (e.g., distinct wrappers `codex00`, `codex01`, `agy00`–`agy05`, `claude`) and placeholder suggestions, without auto-filling or persisting unreviewed executables.
3. **Unconfigured Profile Banners (`AgencyWorkspaceView`)**: Displays a clear, prominent "Profile not configured" banner with an inline "Configure" button whenever an unconfigured profile is viewed or selected in a workspace.

For complete operational details, safety procedures, and onboarding guides, refer to:
- [LAUNCHER.md](file:///home/alteixeira20/Projects/My-Amazing-Workspace/docs/maw/LAUNCHER.md): Complete command reference, security model, and acceptance workflow.
- [UPDATE-ROLLBACK.md](file:///home/alteixeira20/Projects/My-Amazing-Workspace/docs/maw/UPDATE-ROLLBACK.md): Detailed update lifecycle, rollback boundaries, and manual recovery steps.
- [PROFILE-ONBOARDING.md](file:///home/alteixeira20/Projects/My-Amazing-Workspace/docs/maw/PROFILE-ONBOARDING.md): First-run setup, wrapper naming rules, and provider-specific configurations.

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

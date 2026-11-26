# Local authentication

Source: `packages/server/src/security/request-guards.ts` and `packages/server/src/index.ts`.

## Token mode (default)

Three layers are always enforced:

1. The server binds only to `127.0.0.1`.
2. Every HTTP request and WebSocket upgrade must carry a credential: the random token generated at each start, or, with remote access enabled, the credential of a paired device.
3. `Host` and `Origin` must be loopback values for the server's port. This blocks malicious web pages and DNS rebinding.

The token is stored in the private runtime directory (`$XDG_RUNTIME_DIR/workbench`, files 0600) for `anvi-bench open`, `anvi-bench url` and the desktop launcher. It is never logged. Remote access adds a second, persistent credential per paired device (because the remote side cannot see this machine's console) but does not relax any layer: the remote device connects through an SSH tunnel, so requests still arrive on loopback.

## Token-free mode (unsafe, diagnostic only)

`WORKBENCH_UNSAFE_LOCAL_NO_AUTH=1` disables layer 2 only. **It is unsafe. Use it only for short local diagnostics, never as a normal configuration.** With it, any local process or user able to reach the loopback port can run commands as you.

Safeguards that remain:

- Startup fails if remote access is enabled.
- Startup fails unless the server is bound exclusively to `127.0.0.1`.
- `Host` and `Origin` checks remain mandatory.
- The server prints a prominent warning at startup.

The legacy `WORKBENCH_UNSAFE_LOCAL_NO_AUTH` name is not honored, and the [identity migration](../architecture/identity-migration.md) drops it from the environment file, so token-free mode is never carried forward by an upgrade. CI runs with the variable unset.

## Related

- [Threat model](threat-model.md)
- [Launcher and CLI](../operations/launcher.md)

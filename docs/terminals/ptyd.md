# Persistent PTY supervisor

Terminals and coding agents run under a standalone supervisor, `workbench-ptyd.service`, instead of the backend. A backend restart or update therefore does not kill live terminals. The wire protocol between backend and supervisor is specified in [PTY protocol](pty-protocol.md). The unit template lives in `scripts/workbench/pty-host/`.

## Control group separation

- Each user service has its own control group. Every process spawned by the supervisor lives in `workbench-ptyd.service`'s group, not in `workbench.service`'s.
- `systemctl --user restart workbench.service` signals only the backend's group. Agents in the supervisor's group are untouched.
- `workbench-ptyd.service` does **not** declare `PartOf=workbench.service`; that would stop or restart the supervisor with the backend. Instead `workbench.service` declares:

  ```ini
  Wants=workbench-ptyd.service
  After=workbench-ptyd.service
  ```

  Starting the backend starts the supervisor if needed; restarting the backend leaves it alive.
- To stop everything, including all agents: `systemctl --user stop workbench.service workbench-ptyd.service`, or the IPC request `{ op: "shutdown", killAll: true }`.

## Socket and authentication

The supervisor listens on `$XDG_RUNTIME_DIR/workbench-ptyd/ptyd.sock`. The runtime directory is mode 0700 (`RuntimeDirectoryMode=0700`, `UMask=0077`). Clients authenticate with a token stored next to the socket in `ptyd.sock.auth` (mode 0600). Peer credentials are not a substitute for the token; see the protocol specification.

## Execution environment

Integrated terminals must behave like ordinary login shells of the user:

- `PrivateTmp=true` must not be set. In an unprivileged `systemd --user` manager it forces a user namespace that maps only the user's UID, so root-owned system files appear as `nobody:nogroup` and tools that check file ownership (for example the OpenSSH client) break.
- `NoNewPrivileges=true` must not be set. It would be inherited by every spawned process and prevent tools such as `sudo` from working.

Isolation relies on the private runtime directory, the socket token and control-group process management (`KillMode=control-group`).

## Restarting the supervisor

Restarting `workbench-ptyd.service` ends every live terminal. The updater detects when the supervisor bundle (`dist/ptyd.mjs`) changed and refuses to restart it while live sessions exist unless the owner forces it. Plan supervisor updates for a moment with no live work. Output replay after a backend restart is described in [PTY protocol](pty-protocol.md#5-output-replay--monotonic-offset-contract); long-term history in [terminal history](history.md).

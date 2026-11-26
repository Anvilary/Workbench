# Threat model

Workbench runs coding agents and shells. Anyone who can talk to its backend can execute code as the user. The security design therefore treats the backend as a local remote-code-execution service and constrains who can reach it. The user-facing summary and the vulnerability reporting process are in [SECURITY.md](../../SECURITY.md); data handling is in [PRIVACY.md](../../PRIVACY.md).

## Assets

- The ability to spawn processes and write to terminals (agents run with the user's credentials).
- Native agent credentials and conversation history (owned by the provider CLIs, outside Workbench).
- Browser sessions of embedded providers (cookies in the desktop userData directory).
- App state: workspaces, profiles, session metadata, terminal history.

## Trust boundaries and controls

| Boundary | Threat | Control |
|---|---|---|
| Network to backend | remote access to a code-execution service | Bind only to `127.0.0.1`, never `0.0.0.0`. Remote devices reach the backend through an SSH tunnel, so traffic still arrives on loopback. |
| Other local web pages to backend | cross-site requests, DNS rebinding | Mandatory `Host` and `Origin` checks on HTTP and the WebSocket upgrade. Frame protection headers (`X-Frame-Options: DENY`, `frame-ancestors 'none'`). |
| Local processes to backend | unauthenticated use | A random per-start session token (or a paired-device credential with remote access on) on HTTP and WebSocket. See [local authentication](local-auth.md). |
| Backend to PTY supervisor | hijacking terminals | Private runtime directory (0700), socket 0600, per-start token in `ptyd.sock.auth` with constant-time comparison. See [persistent PTY supervisor](../terminals/ptyd.md). |
| Client to terminal | writing to a terminal the client does not own | Per-socket attach grants on input and history reads. See [input isolation](../browser/input-isolation.md) and [terminal history](../terminals/history.md). |
| Embedded pages to desktop shell | privilege escalation from provider pages | Chromium sandbox required, context isolation, narrow validated IPC (`policy.mjs`), per-provider partitions and permission policy, navigation guard. See [browser profiles](../browser/profiles.md). |
| Embedded pages to security keys | phishing with WebAuthn | Origin allowlist and a trusted native dialog. See [WebAuthn](webauthn.md). |
| Repository to the public | leaking personal data | [Privacy gate](privacy-gate.md) in CI. |

## Non-goals

- Isolation between processes of the same OS user. Any process running as the user can read the runtime files, process arguments and the userData directory. Workbench does not defend against malware already running as the user.
- Encrypting browser cookies at rest. Confidentiality relies on directory permissions.
- Multi-user hosts where untrusted users share the account.

## Secrets handling

- Tokens are never written to the journal or logs. `anvi-bench url` prints the authenticated URL only to the invoking terminal.
- Workbench never imports API keys or native credentials into systemd, and never copies or unlocks keyrings.
- Process arguments shown by the resource monitor are stripped of tokens and keys.

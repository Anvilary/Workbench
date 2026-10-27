# Agency-UI implementation handoff

Status: foundation handoff committed on `dev`; implementation and acceptance remain pending.

## Pinned source and existing modules

- `cvelasquez/agent-workbench@5d804f5c5151677b03fceb4a7a2dc20b8ac117ef`: pnpm `11.24.0`, Node `>=20`, workspace packages `server`, `web`, `shared`; original MIT license.
- `packages/server/src/index.ts`: single Node HTTP server, loopback bind, auth middleware, socket registration, startup of registry.
- `packages/server/src/security.ts`: token and Host/Origin checks. Never weaken.
- `packages/server/src/pty-session.ts`: original `node-pty` spawn/write/resize/termination.
- `packages/server/src/terminal-registry.ts`: process ownership and lifecycle beyond a browser socket.
- `packages/server/src/terminal-socket.ts`: one authenticated WebSocket transport.
- `packages/server/src/directory-picker.ts`, `path-guard.ts`: server-side directory selection and constrained access.
- `packages/server/src/agents/registry.ts`, `agents/{codex,claude-code,antigravity}`: original adapter implementations. Antigravity in this source is the native `agy` CLI.
- `packages/shared/src/protocol.ts`: original typed version-8 protocol and runtime parser; `packages/shared/src/index.ts` public exports.
- `packages/web/src/TerminalView.tsx`: existing PTY client presentation.
- Visual-only reference: `user/codex-webui@835348e224157516497738cdcb8bd1049951cc5d` (Codex App Server request/approval correlation patterns in `backend/app/codex_client.py`). This reference has no top-level `LICENSE` at the pinned revision, so do not copy code/assets without checking their provenance/permissions.

## Bootstrap

1. From a networked developer workstation with Git and GitHub credentials, execute `scripts/bootstrap-agency-ui.sh` from this kit. The script refuses an initialized target or existing destination, verifies the private target, clones the pinned Git baseline and tests it **before** publishing main.
2. Main remains exactly the imported upstream commit. The script creates a `dev` branch, copies `docs/agency/{CONTRACT,IMPLEMENTATION}.md` and `packages/shared/src/agency-protocol.ts`, exports the new module from `packages/shared/src/index.ts`, and validates TypeScript/build before committing to dev.
3. Inspect `git ls-remote` reported SHA of `main` and `dev` to confirm remote heads. Do not implement other lanes until this is complete.
4. Run a disposable PTY integration smoke on Ubuntu. No agent account authorization should be required or claimed.

## Four parallel development lanes

1. **Domain persistence + directory selection**: own Agency projects/workspaces durable data, runtime validation for project/workspace messages, list filters and `done`/`restore`. Connect existing directory picker to the server-owned canonical `cwd` without client authority over arbitrary paths. Test concurrent creation, invalid selectors, symlinks, metadata preservation and Done with a live session. Primary new files: `agency-project-store.ts`, `agency-workspace-store.ts` and focused parsers/tests. Keep transport integration as small hooks for integration owner.
2. **CLI profile discovery + model capability**: own named codex-0/01/03, agy-0..05 and Claude Code profile configuration, availability and native model/effort catalog discovery, without importing credentials or duplicating adapters. Preserve original CLI launch/auth/approvals. If native model/effort selection is unsupported, report unsupported. Primary new files under `agents/profiles/`, focused adapter extensions/tests. Avoid editing transport directly.
3. **Runtime sessions + PTY integration**: own Agency runtime-to-Workbench terminal ID mapping, one-agent/one-shell concurrency gate, recovery/reattach, process state and activity events, and bridge to existing `terminal.open`/`terminal.attach`/`input`/`resize`/`terminal.close`. Keep server-side PTY lifetime independent of socket lifetime. Own narrow changes in `terminal-registry.ts` and integration adapter. Route changes in `terminal-socket.ts` through one integration owner to avoid merge conflicts.
4. **Minimal UI + composer**: own project tree, active/done workspaces, zero/one/two-pane workspace experience, native agent chat and terminal view, per-profile model/effort selection, ChatGPT-inspired spacing and typography. Reuse the existing React/xterm UI. Refer to Codex WebUI appearance only, without copying code/assets. No server or shared contract rewrites. Include screenshots/clips and keyboard/reconnect regression coverage.

## Integration ownership and acceptance

- Shared contract is frozen for the first parallel wave; request changes through the integration owner. One owner merges new messages into `packages/shared/src/protocol.ts` parser/encoder and server dispatch, maintaining existing message compatibility and auth checks.
- Avoid concurrent edits to `packages/server/src/index.ts`, `terminal-socket.ts`, `packages/shared/src/protocol.ts` and the root manifest. Lanes contribute isolated modules and integration instructions.
- Integration gate: `corepack pnpm install --frozen-lockfile`, `corepack pnpm typecheck`, `corepack pnpm build`, plus focused existing PTY/server tests and a real disposable terminal smoke. A build by itself does not demonstrate PTY or authentication behavior.

## Disposable manual shell PTY smoke (on Ubuntu)

1. Create two temporary directories (`mktemp -d`) outside CLI auth homes. Launch the server bound to loopback, copy its printed authenticated URL into a browser.
2. Select directory A using the server picker, open a shell session, execute `pwd` and `printf 'AGENCY_PTY_OK\\n'`, confirm output and expected canonical directory.
3. Resize the panel and run `stty size`; confirm reported rows/columns change.
4. Begin `sleep 90` or a similar disposable process. Reload or close/reopen the browser and reattach to the **same** Workbench terminal ID. Confirm no additional shell process is launched and the original PID remains alive.
5. Mark workspace Done while the shell runs: it disappears from active navigation, can be restored, and the shell survives. Explicit stop must stop it. Do not delete any directory contents.
6. Verify malformed Origin/Host or a missing token are refused, and attempt an invalid picker ID/symlink into a protected directory.
7. Capture commands, exit codes and sanitized stdout/stderr in the integration report. Do not claim agent authentication was exercised unless separately tested on that machine.

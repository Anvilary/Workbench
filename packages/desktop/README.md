# Anvilary Workbench Desktop

For installation against the existing service, use [the production Ubuntu guide](PRODUCTION.md). The production command is `anvil-bench desktop` (`maw desktop` remains available as a compatibility alias); `pnpm desktop` below is development only.

An Ubuntu desktop-first Anvilary Workbench shell using the existing local Node service and
React frontend. Neko source and infrastructure are retired in this branch; no
installed service, container, volume, profile or credentials have been removed. See [validation](VALIDATION.md)
and the separate [Neko migration plan](NEKO-MIGRATION.md).

## Run without touching the installed service

From the worktree, with Node >=22.12 and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm desktop
```

The development launcher starts the existing Node server as a separate process
with its own authenticated loopback URL, config, readiness file and Chromium
profile under `.native-chatgpt-local/` (ignored by Git). It does not install or
restart systemd units. Closing the desktop stops this disposable backend. Reuse
the same directory on subsequent launches to retain authentication and workspace
metadata. The directory contains credentials; retain it privately. No Brave or
Neko profile is read or imported.

Create a project/workspace, then use MAW's existing **+ → New ChatGPT tab** action.
Create another tab to verify independent pages. **+ → Open URL** navigates the
selected ChatGPT tab; F2 and the existing tab controls rename, reorder and close
tabs. There is no extra website toolbar. F11 toggles window fullscreen from
either the MAW renderer or the website. Ctrl+Tab / Ctrl+Shift+Tab and
Ctrl+PageDown / Ctrl+PageUp switch existing MAW tabs; Ctrl+W uses the existing
close flow, including confirmation for running CLI/PTY sessions.

For a separately managed development service, run the shell with its token-bearing loopback
startup URL in `MAW_DESKTOP_URL` and an isolated `MAW_DESKTOP_DATA_DIR`.
The shell does not launch or manage a backend itself. Do not change the installed
service for this experiment. All web tabs are managed by the desktop client; ordinary browser clients receive an external-link fallback.

### Ubuntu sandbox prerequisite

Electron 45.2.0 is pinned. On the validation host, AppArmor blocked unprivileged
user namespaces and the downloaded `chrome-sandbox` helper lacked root ownership
and mode 4755. Configure the bundled helper before launching; do not disable
Chromium sandboxing or system AppArmor policy. An administrator configured only
this worktree's helper during validation. A new inode was installed before
replacement so pnpm's shared store was not modified:

```sh
cd packages/desktop/node_modules/electron/dist
sudo install -o root -g root -m 4755 chrome-sandbox chrome-sandbox.maw-install
mv chrome-sandbox.maw-install chrome-sandbox
```

The launcher never elevates privileges. A production package must provide a
supported sandbox installation instead of depending on this manual development
step. The shell refuses `--no-sandbox`.

## Architecture decision

Keep React, the Node service, authenticated WebSocket protocol, workspace stores,
CLI launch ownership, PTYs and the systemd service architecture. Add a thin
`BrowserWindow` for the local MAW frontend and one `WebContentsView` per visited
ChatGPT tab. A single dedicated `persist:maw-chatgpt` session supplies cookies and
website storage to all of those views. The shell has a different session.

The Node service stores existing `WebTab` UUIDs, titles, URLs,
order and selection, with ephemeral `client-managed` runtime status. It has no browser-controller driver, viewer proxy or browser-target polling. Legacy target receipts and
cleanup flags remain inert compatibility data in the store for a separate operational migration. No durable schema
version changes. The existing selection coordinator still arbitrates terminal,
CLI and web tabs.

The local renderer's narrow bridge accepts `open`, `update`, `retain`, `close`
and `layout`. Main validates the exact sender WebContents, main frame, configured
origin, action shape, UUID, URL and bounds. Remote pages receive no preload.
Native navigation events checkpoint committed ChatGPT URLs through MAW's existing
authenticated navigate message; no page DOM is read. OAuth paths and credential
query parameters are excluded. Failed/offline checkpoints retain the last durable
URL and retry on a later focus/reconnect.

React measures the actual pane, viewport and clipping ancestors continuously while
the selected surface is mounted; only changed measurements cause IPC. Scroll and
CSS layout changes need no guessed delay. Main converts CSS bounds using the
shell's zoom factor, rejects stale viewport measurements, and immediately detaches
on resize/minimize/fullscreen transitions until fresh bounds arrive. MAW menus,
dialogs, notification toasts and sidebar dragging detach the surface. Detaching
retains the page; closing/removing the logical tab destroys it, including after a
shell reload. Unvisited restored tabs load lazily. Eight live pages are allowed
per window in this experiment; no background eviction or automatic reload.

Alternatives considered:

| Alternative | Decision |
| --- | --- |
| Neko/WebRTC or VNC | Retired from this branch. The installed production stack and data remain untouched for rollback. |
| iframe | Does not satisfy the direct official-site requirement. |
| Electron `webview` / deprecated `BrowserView` | Avoid additional renderer guest APIs and use the modern native view API. |
| Website proxy, DOM injection, UA changes or browser automation | Excluded; use the real HTTPS site with normal Chromium behavior. |
| Move backend/PTYS into Electron | Unnecessary change to ownership, browser access and service operation. |
| External browser only | Useful fallback for ordinary browser clients, but not the native desktop experience. |

API references: [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view),
[sessions](https://www.electronjs.org/docs/latest/api/session),
[security](https://www.electronjs.org/docs/latest/tutorial/security),
[Ubuntu namespace restrictions](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).

## Security and scope limits

All renderers use `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`
and `webSecurity: true`. No website preload, certificate bypass, UA impersonation,
header rewriting, credential extraction or website instrumentation exists in the
application. The website has no MAW bridge or terminal/filesystem API.

Top-level destinations are exact HTTPS hosts: `chatgpt.com`, the legacy
`chat.openai.com` redirect, `auth.openai.com`, `auth0.openai.com`,
`accounts.google.com`, `appleid.apple.com`, `login.microsoftonline.com`,
`login.live.com`. Unknown HTTPS public destinations require a native browser-open
confirmation; custom protocols, credentials, IP literals, private/local host names
and custom ports are rejected. This is URL validation, not DNS-based network
isolation. Subresources follow normal Chromium web security.

Sign-in navigations stay in the browsing context that started them. A site may
also open one temporary, parented, sandboxed popup, including a blank popup
window aimed at a provider. That popup uses the opener session, has no preload
or browser toolbar, and is not turned into a workspace tab. A second sign-in
window, and a sign-in document that fails to load, ask before opening the system
browser. Ordinary cross-site document links still open as workspace tabs. Nested
popups are not created. Embedded authentication remains provider policy
dependent. All web permission requests/checks are
denied, and downloads are disabled for this pilot. Voice, microphone, screen
capture and download workflows are therefore outside its scope. Native clipboard
keyboard operations and user-selected uploads use normal Chromium facilities.

Browser compatibility clients display a validated saved ChatGPT link
in the same tab pane. They cannot access or share the desktop's cookie database.
There is no promise of indefinite authentication: server expiry, logout, provider
policy and OS credential storage can require login again.

## Files changed

* `packages/desktop/{main.mjs,preload.cjs,policy.mjs,package.json}`: native shell and boundary.
* `packages/desktop/{policy.test.mjs,smoke.test.mjs}`: policy and real Electron process checks.
* `packages/server/src/agency/browser-tabs/{browser-tab-adapter.ts,client-managed.test.ts}`: logical metadata adapter and regression coverage.
* `packages/server/src/index.ts`: logical web-tab startup; removes viewer/controller setup.
* `packages/shared/src/browser/browser-tabs.ts`: ephemeral runtime discriminator.
* `packages/web/src/agency/{NativeChatGptView.tsx,useNativeChatGptTabs.ts,AgencyApp.tsx,AgencyWorkspaceView.tsx}`: native surface, checkpoints and existing tab integration.
* Fallback strings and removal of obsolete streaming strings in each existing `packages/web/src/i18n/locales/*.json` catalog.
* `scripts/desktop-prototype.mjs`, root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.gitignore`: isolated launcher and pinned dependency.
* `.github/workflows/ci.yml`: native policy and sandboxed Electron checks replace the retired controller test.
* This document, validation report, migration plan and `evidence/`: review evidence.

Neko source, controller/viewer adapters, Docker Compose configuration, fixture scripts and obsolete stream tests are removed from the repository in this PR. No running container, volume, profile or credentials are removed. No merge, deployment or production service modification is included.

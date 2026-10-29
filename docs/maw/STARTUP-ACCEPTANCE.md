# Startup, updates and restoration acceptance

The first-install 404 in release `20261029170028-8ddc280` comes from Express `sendFile` applying its dotfile filter to the absolute HTML path under `~/.local`. The compiled HTML exists, is readable, and belongs to the correct release. Read-only checks against the live PID found authenticated HTML **404** and built JavaScript **200**. The fix sends `index.html` relative to the explicit built UI root; it does not enable dotfile serving, weaken authentication, change the timeout, or treat 404 as healthy.

`maw start` now requires authenticated HTTP readiness and matching process/release identity even when systemd reports `active`. An active failed probe exits nonzero without restarting the process or changing pointers. An active successful probe can establish the first verified `healthy` pointer. Activating a repaired release also establishes it through the normal helper. The existing release and app stores need not be deleted.

## Persistence and browser recovery

App stores remain under `$XDG_CONFIG_HOME/agent-workbench` (normally `~/.config/agent-workbench`), independently of `current`, release directories and development worktrees. Project/workspace records, profiles, logical native/shell tabs, ordering, selection, notification read/Done state and saved history retain their existing stores and schemas.

ChatGPT URLs in `agency-web-tabs.json` retain complete validated paths, IDs and query strings. The existing five-second poll covers selected and background targets. Reattachment now commits the verified live URL and checks durable controller ownership receipts when the saved target hint is missing. It never guesses ownership from a title or URL. Failed controller requests preserve the URL and expose a retryable error; polling clears an observed outage once ownership is verified again. Explicit tab selection reactivates an owned target or recreates a lost target at its committed URL. Polling itself never creates or selects pages.

A transient ChatGPT homepage redirect does not erase a committed conversation URL. A different valid conversation URL replaces it; explicit MAW navigation can still deliberately commit the homepage. Shutdown cancels periodic observations, attempts a final capture for at most three seconds of controller I/O, and drains store writes before releasing ownership. This is best effort: a crash, hard kill, or unavailable controller can only restore the most recently committed URL.

Shell tabs restart with replacement PTYs. Original shell processes and volatile scrollback do not survive. Native resume still requires the original profile, verified native home/binding and owned conversation ID. Unknown ownership retains the session with a manual recovery explanation; there is no silent fresh-conversation fallback.

## Persistent Neko settings

Newly rendered units read an optional environment file at `${XDG_CONFIG_HOME:-$HOME/.config}/maw/environment`. `MAW_ENV_FILE` can select a different permanent path when rendering the unit. Keep the containing directory private and the file mode `0600`.

Provision these values through the existing local configuration process, matching the running Neko deployment:

| Setting | Purpose |
| --- | --- |
| `NEKO_CONTROLLER_URL` | Dedicated HTTP loopback controller endpoint; default `http://127.0.0.1:9223` |
| `NEKO_CONTROLLER_TOKEN` or `CONTROLLER_AUTH_TOKEN` | Existing controller secret, at least 32 characters |
| `NEKO_VIEWER_URL` | Loopback viewer endpoint; default `http://127.0.0.1:8085` |
| `NEKO_PASSWORD` | Existing Neko member/viewer password |
| `XDG_CONFIG_HOME` | Preserve this too if the app store uses a custom configuration root |

The inspected installed unit has no Neko connection settings. Replacing executable releases does not rewrite existing unit files or installed launcher scripts: the one-time reviewed deployment must refresh the commands and unit template to adopt those fixes. No live configuration, service, native wrapper or authentication was changed during this development work.

Neko's existing named volumes `maw-neko-chromium-profile` and `maw-neko-controller-state` preserve the browser profile/authentication state and ownership receipts. MAW does not copy, export or change browser cookies. Keep Neko's compose/config/controller bind-mount sources in a permanent location, independent of temporary development worktrees. Do not use `docker compose down -v` during updates or cleanup.

## Production acceptance checklist — after merge and deployment approval

1. **Back up:** snapshot the app configuration directory, release pointers/metadata, installed launcher library and user unit. Back up native histories and the persistent Neko volumes through their existing backup procedures. Record the current PID, release IDs and project/session counts.
2. **Prepare:** update a permanent clean source clone to approved `origin/main`. Refresh launcher commands using `scripts/maw/install.sh --commands-only`. Review the rendered unit from `scripts/maw/maw-render-unit.sh`, including the permanent environment-file path, before replacing the backed-up unit and reloading the user manager. This is a deployment step; it was not performed against the real installation.
3. **Initial activation:** use `maw update --restart` (or stage then `maw restart`) to activate the fixed approved release. Keep the old installed release. Require `maw status` to report the correct PID and release plus successful authenticated HTTP, and require `healthy` to name that verified release. Never create the pointer manually. Use `maw open` for transparent local authentication.
4. **Restore and update again:** compare project order, workspace names/directories/statuses, original profiles/native IDs, tab names/order/selection, read/Done notifications and saved histories. Confirm shells have new PTYs. For every verified authenticated native profile, manually confirm the exact original conversation; accept a visible manual recovery state when verification is unavailable. Navigate selected/background ChatGPT tabs to known conversations, wait for URL commitment, update/restart, and check those exact URLs. Check Neko outage/reconnection without duplicates.
5. **Rollback:** once there is a verified `previous`, exercise `maw rollback` in an agreed maintenance window. Executable rollback does not restore data backups or guarantee compatibility with older data schemas. The first-ever healthy activation may have no verified rollback target.
6. **Clean up:** confirm the running process resolves into `~/.local/share/maw/releases`, app/native data and Neko mounts live outside the temporary worktree, and `source_path` names a retained source clone. Remove only the merged development worktree using Git. Run `maw status`, `maw open` and a controlled restart to confirm independence.

## Reproducible verification

Run from a clean committed checkout. Real-systemd tests use uniquely named `maw-test-*` services and disposable stores; they never control `maw.service`.

```sh
pnpm typecheck
pnpm build
node --import ./packages/server/node_modules/tsx/dist/loader.mjs --test packages/web/src/maw-root.test.mjs packages/web/src/terminal-webgl.test.mjs packages/web/src/agency/*.test.mjs
cd packages/server
pnpm exec tsx --test src/maw-host.test.ts src/maw-updater-acceptance.test.ts src/agency/*.test.ts src/agency/browser-tabs/*.test.ts src/agency/runtime/*.test.ts src/agents/profiles/profiles.test.ts
MAW_REAL_SYSTEMD=1 MAW_REAL_RELEASE=1 pnpm exec tsx --test src/maw-systemd-acceptance.test.ts
pnpm exec tsx scripts/check-native-systemd.mjs
pnpm exec tsx scripts/check-startup-restoration.mjs
```

The last check builds two real releases through the production updater, renders the production unit under a hidden `.local/share/maw` layout, exercises the public launcher and real Chromium through the production ownership controller, and tests update/restart/outage/final-capture/rollback/source-removal behavior. ChatGPT content is locally fulfilled synthetic fixture HTML; providers are disabled. It requires a user systemd manager, Python 3 and Chrome (`PLAYWRIGHT_CHROMIUM_EXECUTABLE` can override the browser path). It does not establish real authenticated provider resume, ChatGPT account validity, or live Neko video availability. Those remain production acceptance checks.

Verified locally on 2026-10-29 with Node 24.22.0:

| Check | Result |
| --- | --- |
| Full workspace typecheck and production build | Passed |
| Agency/profile tests | 104 passed |
| Session runtime tests | 40 passed |
| Browser adapter/controller/persistence/shutdown tests | 57 passed |
| Host ownership/readiness tests | 6 passed |
| Mocked updater/activation tests, including active HTTP 404 rejection | 37 passed |
| Frontend model and Chromium tests | 25 passed |
| Security/backpressure tests | 3 passed |
| Python restricted controller/ownership tests | 19 passed |
| Disposable native profile/context suite under systemd | 5 passed |
| Real-systemd crash/rollback and production-release tests | 2 passed, no skips |
| Full two-release restoration integration | All 7 scenario groups passed |

The real-release test first became healthy about 1.8 seconds after activation began, with the unchanged 20-second readiness budget. The production service remained on its original PID `1343212` and release `20261029170028-8ddc280`; its 404 is expected to remain until an approved deployment. All disposable test units were removed.

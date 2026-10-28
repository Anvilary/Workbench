# Agency web tabs and inspection integration

This implementation extends the existing Agency UI and authenticated AgentConnection. Native sessions continue using TerminalView, its PTY attachment/replay, input shortcuts, copy controls, stop confirmation, and session resume behavior.

## Authoritative selection and restoration

`AgencySnapshot.webTabs` contains durable WebTab rows. The store subscribes to web snapshots and changes and requests web, native, workspace, project, profile, and notification snapshots after reconnect. Inspection remains disabled until all six domains have synchronized. Initial workspace restoration also waits for core snapshots rather than replacing a persisted workspace selection with an incomplete list.

The tab strip combines open native and web tab IDs using their server order. Exactly one selected flag is required across both domains; conflicting or absent flags display a selection prompt. The server must coordinate mixed selections and support `agency.tabs.order` with both native and web IDs. Open/close/select/order mutations must publish authoritative native and web snapshots. The frontend never chooses the first tab as an implicit browser target.

Opening a workspace or reconnecting with a selected web tab explicitly selects that tab on the server before exposing the Neko screen. This reactivates its verified Chromium target, even when another workspace was previously displaying the shared browser. Closing a web tab never sends a native terminal close.

## Neko viewer HTTP contract

All routes use the existing MAW authentication cookie. No Neko credentials or controller tokens are supplied by browser JavaScript.

- `GET /api/agency/browser/viewer/status` returns `{configured, ready, url:'/api/agency/browser/viewer/', reason?}`. `ready` means proxy/upstream availability, not live video.
- `GET /api/agency/browser/viewer?workspaceId=…&tabId=…` verifies the selected tab and returns `{url:'/api/agency/browser/viewer/?workspaceId=…&tabId=…', workspaceId, tabId}`.
- The slash route serves the genuine Neko client and authenticated assets/signaling proxy. Only one iframe is mounted for the active web tab. ChatGPT URLs are never iframe sources.
- The proxy bridge posts `{type:'agency.browser.viewer.ready', workspaceId, tabId}` only for live Neko media, and `agency.browser.viewer.unavailable` when media disappears.

The frontend validates exact same-origin viewer paths and the two expected identity query parameters. Readiness messages must match the iframe window, application origin, workspace ID, and tab ID. It also observes an actual visible, playing video with nonzero dimensions and advancing media time. API health, iframe load, background documents, and messages sent from the parent window cannot acknowledge a result. Reconnect retries target activation and recreates the viewer after success; failed activation leaves the surface gated.

## Notifications and inspection

Notification navigation resolves either native or web tab identity and awaits successful server selection. The notification is marked read only when the corresponding visible pane reports display readiness. Native panes wait for terminal rendering (or a rendered historical placeholder); web panes require live video. Toast navigation uses `notificationId`, never the toast's ephemeral ID.

A finished badge is acknowledged only after the selected pane is displayed, and acknowledgements are deduplicated by tab ID and authoritative activity timestamp. Reading an inbox item explicitly does not acknowledge its tab. Failed requests leave authoritative state intact; no optimistic rollback can overwrite a concurrent completion. Reconnect replaces the activity snapshot. Generic native working-to-idle transitions no longer create completion notices; reliable completion uses the notification protocol.

New UI strings, tab status labels, request errors, and generated notification bodies are localized in all nine dictionaries. Generated notifications use `metadata.kind`, `tabName`, and optional `exitCode`; older native notifications can be recognized by their stable deduplication prefixes. User-authored notification content remains content.

## Validation

- `node --test packages/web/src/agency/model.test.mjs packages/web/src/agency/notifications.test.mjs packages/web/src/agency/browser-tabs.test.mjs`
- `pnpm --filter @agent-workbench/web typecheck`
- `pnpm --filter @agent-workbench/web build`
- `pnpm --filter @agent-workbench/server exec tsx scripts/check-i18n.mjs`

The browser regression bundles the real AgencyApp and uses a local disposable fixture server. It checks native Ctrl+C, failed notification navigation, no inspection on iframe load, rejection of a spoofed parent message, live-media inspection, the correct notification ID, rename, mixed reorder, reconnect snapshots, and independent web closure. The fixture video is synthetic and requires no service or credentials. Production Neko transport and actual server integration are tested separately by the parent integration lane.

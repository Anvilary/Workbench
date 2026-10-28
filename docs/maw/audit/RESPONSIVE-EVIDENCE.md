# Real browser responsive evidence

Actual production MAW UI, disposable Chrome, real pinned Neko/WebRTC with guest
ChatGPT page. No synthetic video in these captures. Original PNGs are preserved.
All six sizes passed live media readiness, inline F2 rename/save, sidebar open /
collapse / keyboard resize, bell/inbox/Escape and no document horizontal overflow.
390px additionally exercises Add menu and A/B browser switching. Script:
`packages/server/scripts/check-maw-integration.mjs` with isolated Neko config.

| Viewport | Inline rename | Inbox | Live browser | Sidebar open |
| --- | --- | --- | --- | --- |
| 390x844 | [Rename](screenshots/rename-390x844.png) | [Inbox](screenshots/inbox-390x844.png) | [Browser](screenshots/neko-390x844.png) | [Sidebar](screenshots/sidebar-390x844.png) |
| 768x1024 | [Rename](screenshots/rename-768x1024.png) | [Inbox](screenshots/inbox-768x1024.png) | [Browser](screenshots/neko-768x1024.png) | [Sidebar](screenshots/sidebar-768x1024.png) |
| 1280x720 | [Rename](screenshots/rename-1280x720.png) | [Inbox](screenshots/inbox-1280x720.png) | [Browser](screenshots/neko-1280x720.png) | [Sidebar](screenshots/sidebar-1280x720.png) |
| 1366x768 | [Rename](screenshots/rename-1366x768.png) | [Inbox](screenshots/inbox-1366x768.png) | [Browser](screenshots/neko-1366x768.png) | [Sidebar](screenshots/sidebar-1366x768.png) |
| 1920x1080 | [Rename](screenshots/rename-1920x1080.png) | [Inbox](screenshots/inbox-1920x1080.png) | [Browser](screenshots/neko-1920x1080.png) | [Sidebar](screenshots/sidebar-1920x1080.png) |
| 2560x1440 | [Rename](screenshots/rename-2560x1440.png) | [Inbox](screenshots/inbox-2560x1440.png) | [Browser](screenshots/neko-2560x1440.png) | [Sidebar](screenshots/sidebar-2560x1440.png) |

Observations: editor remains within scrolling tab strip at 390px; previous tab
label may scroll partly offscreen, as expected. Sidebar overlays the content on
mobile and closes through its visible toggle. Inbox fits inside the viewport;
breadcrumbs truncate. Desktop controls do not overlap; plenty of room remains
in the terminal/browser content region. Neko's fixed 1280×720 desktop is letterboxed
and downscaled severely at 390px; remote page text is too small for comfortable
mobile reading. Desktop/landscape is the preferred ChatGPT interaction surface.
No claim that the remote site itself has a mobile layout.

Real reconnect autofocus cancelled editing in an earlier run (A05); fixed and
covered by explicit iframe-focus regression. Final screenshots were captured
after waiting for live media, and distinguish connecting from ready state.

Additional verified outside the full viewport loop: shell input, failure/success
completion, toast dismissal with inbox retention, click-through navigation,
web sibling close, native identity preservation and server restart. Synthetic
Chromium UI fixture separately covers unavailable/reconnect states, invalid
rename, Escape, blur cancellation, failed save, CLI/shell/browser stable IDs,
menu rename, terminal input and Alt+Arrow tab ordering.

Not exhaustively exercised at **every** size: actual touch hardware/virtual
keyboard, project dialogs, pointer sidebar resize, all tab-creation/close modals,
terminal-output stress, keyboard shortcuts beyond those listed. This is bounded
responsive evidence, not full feature-matrix release acceptance.

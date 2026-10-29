# Responsive interactions and fitting investigation

The production UI and real Neko stream were exercised in disposable Chromium.
No user session or authenticated ChatGPT content was accessed. Full traces remain
in private /tmp/maw-round2-{before,after,gc}/interaction-trace.zip; screenshots
below are committed. A screenshot is supplementary; actual F2/type/Enter rename,
inbox/Escape, sidebar keyboard resize, live video state and no page-overflow
assertions are executed by check-maw-integration.mjs. The shell soak additionally
resizes with live PTYs and sends native terminal input at every size.

| Size | MAW controls | Real Neko media |
| --- | --- | --- |
| 390 × 844 | [Inbox](screenshots/controls-390x844.png) | [Viewer](screenshots/neko-390x844.png) |
| 768 × 1024 | [Inbox](screenshots/controls-768x1024.png) | [Viewer](screenshots/neko-768x1024.png) |
| 1280 × 720 | [Inbox](screenshots/controls-1280x720.png) | [Viewer](screenshots/neko-1280x720.png) |
| 1366 × 768 | [Inbox](screenshots/controls-1366x768.png) | [Viewer](screenshots/neko-1366x768.png) |
| 1920 × 1080 | [Inbox](screenshots/controls-1920x1080.png) | [Viewer](screenshots/neko-1920x1080.png) |
| 2560 × 1440 | [Inbox](screenshots/controls-2560x1440.png) | [Viewer](screenshots/neko-2560x1440.png) |

F2/rename, sidebar collapse/open/keyboard resize, bell/inbox/Escape, live media and
page overflow pass at all six sizes. At 390px the sidebar overlays the native
pane; the inbox covers underlying navigation but its close button remains
accessible. [Populated inbox](screenshots/inbox-390x844.png),
[rename](screenshots/rename-390x844.png) and
[sidebar](screenshots/sidebar-390x844.png) show real browser-tab states.
Desktop [rename](screenshots/rename-1366x768.png) and
[inbox](screenshots/inbox-1366x768.png) are also preserved.
Keyboard through the streamed viewer was verified at desktop size, including
focus/request-control and Chromium URL change; native shell input is exercised
across sizes. Shell-helper-textarea visibility is not a valid readiness check;
the bounded harness waits for the actual terminal screen.

The 1280×720 shared desktop scales to roughly 30% width at 390px, leaving remote
text too small. Both 390px and 1366px screenshots were visually inspected.
The MAW parent only embeds Neko's UI; changing iframe object-fit does not change
the embedded video fitting. A global desktop resize would change all viewers'
active Chromium layout. A local readable-size viewport with panning is a possible
future option, but must retain Neko's mouse-coordinate transforms, touch
scroll/pointer behavior and accessible host controls. No fitting change was
shipped without these interaction tests; no additional browser instance created.

Remaining acceptance: hardware touch/virtual keyboard, browser zoom, pointer
sidebar drag stress, all shortcuts/focus transitions during reconnect, populated
inbox overflow under large notification count, high-output terminal paint,
React commit durations and WebRTC frame latency. No claim of complete responsive
acceptance or improved mobile readability is made. The existing mobile remote
text limitation remains a release condition.

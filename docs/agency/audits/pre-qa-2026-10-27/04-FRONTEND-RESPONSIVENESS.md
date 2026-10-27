IN_PROGRESS

# Frontend Responsiveness

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: audit initialized; no implementation, tests, browser behavior, or security properties have yet been verified.  
Last completed step: verified clean integration worktree, branch/remote/PR head, created separate audit worktree.


## Browser fixture run (partial)

Executed `capture-agency-screenshots.mjs` with disposable homes and a synthetic no-inference CLI, actual headless Chrome 155, production build and temporary screenshot directory. All eight distinct screenshot hashes and associated state assertions passed; zero page errors and zero console errors were printed. Script asserts keyboard focus stays in profile dialog for eight Tab presses, Escape restores focus, draft remains across two switches, Done/Restore succeeds, and terminal panes are visible. It checks a populated combined workspace plus dialog at all four widths, manually collapsing the sidebar at 390px. Viewport/document widths were equal: 390/390, 768/768, 1024/1024, 1440/1440; dialog bounds and terminal minimum sizes passed. These are not exhaustive clipping, accessibility, focus, real provider, large-list, transcript, throughput, reconnection or load tests. Script logs console errors but does not assert the array empty (`capture-agency-screenshots.mjs:387-393`); this run happened to log zero.

Repeated warm interaction measurements are in 05. Active terminals emitted no sustained output; low-load success does not establish responsiveness under load. No browser traces or leak counts collected.

A 20-switch disposable shell-output test at ~64 kB/s reported p50/p95/max 56.97/66.26/68.75 ms including Playwright overhead. It ran for only 1.17 seconds and is not a long-run stress or leak test; methodology in 05. Source review: `TerminalView.tsx:462-480` removes message/reopen listeners, resize observer, DOM handlers and xterm subscriptions and sends detach on unmount. Runtime listener counts and offline navigation behavior remain to be tested.

## Ten projects / fifty workspaces fixture

Expanded the real-server fixture to 10 projects and 50 workspace records, 4 live synthetic agent/shell sessions, and reran the screenshot script on headless Chrome. All eight state assertions and distinct hashes passed; the same combined layout and profile dialog checks passed at 390/768/1024/1440 with the mobile sidebar collapsed. Console/page error counts were reported as zero. Twenty-switch and interaction distributions in 05. The existing selected test workspaces were under the initial project; this does not exhaustively navigate all 50 records, or cover 5/20 as a distinct fixture, long transcripts, high-frequency activity, keyboard/accessibility, live provider sessions, or long-running output.

The first fixture attempt did not close picker instances and hung at the server's limit of eight per socket. The disposable harness was corrected to send `picker.close` after each workspace. The UI's existing FolderPicker sends close on unmount (`FolderPicker.tsx:81-85`); this harness mistake is not itself an application defect. Rapid close before initial listing might leak a picker because the client has no ID at cleanup; this is an unverified timing hypothesis, requiring controlled reproduction.

The previously noted rapid picker-close hypothesis is confirmed as FUNC-001 in a real browser with controlled 500 ms response delay; see 02 and 07. Eight abandoned pickers lead to an initial failure that stays visually loading. Actual incidence without injected delay is unmeasured.

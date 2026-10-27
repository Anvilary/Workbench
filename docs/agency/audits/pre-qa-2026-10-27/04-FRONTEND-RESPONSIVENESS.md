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

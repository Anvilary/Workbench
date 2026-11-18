# Anvilary Workbench pre-release recovery

The recovery started on `feat/anvilary-pre-release` at `d840f0bbc5b650ad13bbaf06552e42eb337c771e`. Architecture v1 and the Anvilary rebrand were already integrated. The two inherited implementation checkpoints added the packaging and fixture repairs, browser-profile contracts, project cascade, and workspace cleanup. The dirty worktree held 64 modified tracked files with 4,501 insertions and 1,880 deletions, plus six untracked implementation and test files. The verified recovery archive at `/var/tmp/anvilary-recovery.yqSalxP9` contains the starting Git bundle, binary-capable patch, untracked file archive, exact status inventory, and SHA-256 manifest.

## Completion matrix

| Track | Status | Validation and scope |
| --- | --- | --- |
| A. Rebranding and CLI | Validated on Linux | Installer and package fixtures exercise the `maw` and `anvil-bench` entry points. The npm package exposes `anvil-bench` and `agent-workbench`. |
| B. CI and packaging | Implemented and validated locally | Clean Node 22 install, build and unit checks, workflow lint, Linux tarball smoke on Node 20 and 22, and Debian package inspection passed. Hosted required checks and Windows, macOS, and Android jobs need a GitHub run. |
| C. Resource lifecycle | Integrated | Runtime tests cover concurrent deletion, refusal, tab cleanup, process ownership and persistent PTY survival. The staged Electron scenario exercises contextual workspace confirmation, direct workspace deletion, a centered pane confirmation, and a project cascade while preserving source directories and neighboring resources. Cascade commits completed workspaces as it proceeds. A retry handles the remaining workspaces. |
| D. Sidebar | Integrated | Persistence, drag cancellation, selection, scroll targeting, and constrained preview are implemented. Chromium covers sidebar controls and keyboard persistence. The staged native scenario exercises pointer ordering, persistence, Escape cancellation, automatic edge scrolling, and workspace selection stability. |
| E. Pane and tab drag | Validated for the exercised native paths | Sandboxed Electron verified a pointer drop in the destination pane body, Escape cancellation, retained WebContents, and an empty source pane. Other native cases covered real PTY identity, resize, scrollback and selection during pane swaps. |
| F. Browser picker | Validated | Chromium covers favorite preview and destination selection, invalid input, and pane targeting. Built Electron opened and restored a browser tab from the inline Other field. |
| G. Settings | Integrated | Unit and Chromium suites exercise Settings search and navigation. Built Electron exercises subsection expansion through Settings search, built-in search-engine removal and fallback, Restore Defaults, and independent profiles. Localization passed for nine locales. |
| H. Profiles and authentication | Profile routing validated in Electron. Hardware authentication unverified. | The staged app checked actual Session storage paths, clone cookie isolation, selected-site clearing, inheritance, override and fallback to Main. Policy and injected FIDO2 cases covered authorization, malformed allow-lists, PIN retries, resident credential matching and required verification. |
| I. Performance | Validated for bounded workloads | The four local regression gates passed. Matched OutputBuffer workloads and bounded PTY flood and soak produced the measurements below. Extended live use, workload-independent claims, and hardware GPU performance remain outside this evidence. |
| J and K. Staging and operational verification | Validated locally | The built Electron app recovered from an isolated backend restart. Release fixtures exercised upgrade and rollback pointers, compatibility preflight, supervisor packaging, and readiness. Three real-systemd tests require an isolated systemd environment. |

## Runtime compatibility

- Production desktop launch passes `$XDG_DATA_HOME/maw-desktop` (default `~/.local/share/maw-desktop`) via `MAW_DESKTOP_DATA_DIR`. Direct Electron launches honor that variable and otherwise use `appData/maw-desktop-prototype`. The prototype wrapper supplies a disposable directory. The staged Electron process reported the same effective `userData` and `sessionData` path under the test profile.
- Main uses the existing `persist:maw-chatgpt`, `persist:maw-github`, `persist:maw-perplexity`, and `persist:maw-browser` partitions. Custom profiles use `persist:maw-profile-<id>-<provider>`. The clone copies cookies through Electron. Site data such as IndexedDB and local storage requires a fresh sign-in when a provider depends on it. Profile deletion clears assignment metadata and leaves the profile directories on disk. Explicit site clearing applies to the selected provider partition. In the general Browser partition, Other Websites covers that entire partition.
- Workspace overrides take precedence over project assignments. Inherited projects fall back to Main. Selecting Main explicitly on a workspace takes precedence over its project assignment.
- The rollback preflight rejects a target that would discard saved profile assignments. Remove assignments through the UI before rolling back to a reader without that capability. The legacy unit names, PTY supervisor identities, CLI names, and environment-variable entry points remain in use.
- Tests used disposable HOME, XDG and desktop profile directories. The live checkout and data were outside the validation environment.

## Automated verification

- Fresh source export with Linux Node 22 and pnpm 12.21.0 passed frozen dependency installation, typecheck, build and unit suites. The current suite passed 83 desktop, 145 server, and 101 web unit tests, 49 server security tests, and 100 server integration tests.
- Chromium passed 39 web integration and 56 E2E tests with Google Chrome in isolated profiles. Sandbox-backed Electron passed 2 security, 16 integration, 1 resource-pool, 20 E2E, and the built staging scenario. The Nautilus case ran inside separate Xvfb and D-Bus sessions.
- Server runtime passed 198 of 201 tests, with three opt-in systemd skips. Shell staging passed 20 cases. Debian production tests passed seven cases. The 34-file npm allowlist and install/start smoke passed on Linux Node 20 and 22.
- `pnpm check` passed shipped invariant, settings and localization checks. The internal documentation check skipped because its private guide is absent. `actionlint` and Git whitespace checks passed.

## Performance evidence

| Measurement | Result |
| --- | --- |
| Matched 4 MiB OutputBuffer workload, three repetitions, 4 KiB chunks | Enqueue throughput 71 to 2,792 MiB/s and checkpoint completion 101.2 to 49.8 ms from `d840f0b` to recovered code |
| Same workload, 64 KiB chunks | Enqueue throughput 68 to 4,003 MiB/s and checkpoint completion 106.1 to 51.2 ms |
| Production tab reorder, six shell tabs, 120 moves per trial | 35.4 ms mean scripting, 0.1 bounding-box reads per move, zero recorded tasks over 50 ms |
| Two simultaneous PTY floods | 180,000 ordered lines per terminal. The 180,000-line slow-consumer phase survived a two-second paused reader with complete ordered output. Peak server RSS was 215.3 MiB in the concurrent phase and 231.3 MiB in the paused phase. |
| 70-second production UI and PTY soak | 20 cycles and reconnects, zero page errors, zero active PTYs after cleanup and restart. Median visible tab switch 50 ms, workspace switch 68.1 ms and settings open 92.6 ms. Server idle measurement was 119.4 MiB PSS and zero CPU ticks over three seconds. |
| Sandboxed Electron fixture | Main and custom browser open-to-ready medians were 23.6 and 24.8 ms over eight warm opens each. The synthetic shell resource sample contained four Electron processes at 152.7 MiB total PSS. Populated 800×600 overlay capture and encoding took 16.2 ms median and 89.0 ms p95 over ten samples on the software-rendered display. |

The matched OutputBuffer run includes both enqueue and checkpoint timing. The previous view evidence remains historical. Native lifecycle primitive timings and the current resource snapshot are single-environment measurements. The soak covers a bounded window, and its idle and transition measurements use different phases.

## Evidence and audit boundary

The validation outputs are under `/var/tmp/anvilary-validation.9kaOL6Qh`. The staged Electron artifacts include the sidebar, browser picker, settings and deletion dialogs. The native tab drag artifacts show the preview and committed drop. The soak directory contains measurements and a browser trace. The CI and administrator steps are in the [release runbook](./ci-and-release-runbook.md).

The local implementation is available for independent audit. Release verification still requires the audits, hosted platform checks and required-check configuration, an isolated real-systemd acceptance run, and hardware-backed validation before claiming YubiKey compatibility. Production OAuth and passkey behavior with real accounts remains unverified.

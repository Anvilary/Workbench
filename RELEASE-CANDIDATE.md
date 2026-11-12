# MaW release candidate

- Baseline: `311c0514b64e4bc64b71dfe4983bdec5069dc6f0` (local and remote `main`, verified again after implementation).
- Candidate branch: `release/maw-reliability-browser`. The code and test revision is `d1d88e18de7ccd9b8c19df6abfe8ba046a9c4798`; the tip of the branch adds this report only.
- The production installation and workspace were left unchanged. The installed current and healthy release is `20261109155324-311c051`, and its SHA can fast-forward to the candidate. Both production units are active but disabled at login.

## Reliability

| Confirmed defect | Root cause and reproduction covered | Candidate behavior |
| --- | --- | --- |
| PTY supervisor crashes under backpressure | Over-quota writes invoked the error response path, which writes to the same over-quota socket. The failure injection exceeds the outgoing quota. | Close the slow client directly; unrelated clients and terminal processes keep running. |
| Duplicate supervisor corrupts credentials | Two starts could publish credentials before either owned the listener. Race two starts against one runtime. | Elect socket ownership first; the loser cannot change the winner's credentials or socket. |
| Backend strands existing terminals after supervisor socket loss | No reconnect and reconciliation path for a lost connection. Disconnect the transport with a real child PTY running, then reconnect. | Bounded reconnect with current credentials, reconciliation by terminal ID, preservation of the PID and output cursor, and unavailable state if recovery fails. No automatic replacement for a lost connection. A persistent backend refuses to start session recovery without an authenticated inventory. |
| Performance panel fails in token-free mode | Local middleware admitted requests without providing the credential expected by the performance endpoint. Fetch the inventory in token-free mode. | Local requests use the local credential; protected mode still requires authentication. |
| Concurrent refresh returns an invalid resource snapshot | A shared in-flight value represented partial collection. Overlap inventory reads. | Concurrent readers await one complete snapshot. Memory pressure uses Linux `MemAvailable`; the monitor distinguishes PSS and proportional swap and computes CPU from counter deltas. |
| Offline browser navigation is lost | The client marked a URL handled before server acknowledgment; changing the backend port also stranded the app shell on its old origin. Navigate while the isolated backend is down and restart it on another port. | Preserve the native page; restore the trusted shell and drafts, then checkpoint the current URL. Retry until acknowledged without letting an older retry overwrite newer navigation. |
| Terminal slot capacity leak ("Too many tabs") | `TerminalRegistry.open()` checked raw map size instead of active processes, causing exited tabs, sleeping tabs, and adopted unowned supervisor sessions to consume capacity against the defensive process limit. Additionally, Agency tab closure on exited sessions did not close the registry terminal, failed launches could leak open terminals, startup did not reconcile dead orphaned Agency terminals, supervisor reconnection exhaustion prematurely marked unconfirmed terminals dead on transport failure, and tests lacking explicit supervisor isolation could connect to the live production supervisor socket. | Raised maximum active terminal capacity to 42 across server and supervisor layers; enforce capacity against active terminals (`alive \|\| launching \|\| supervisorUnconfirmed`) with atomic in-flight open reservations; close registry terminals on Agency tab close regardless of lifecycle; roll back opened terminals on launch failures; clean up dead orphaned entries during startup reconciliation; preserve unconfirmed terminals without emitting premature exit on supervisor reconnection exhaustion until authoritative observation or explicit tab closure; and guard `PtyHostClient` and `TerminalRegistry` to strictly block test runners from connecting to the production supervisor socket without isolated paths. |
| Downloads can prevent safe browser eviction indefinitely | The per-view count included unowned or rejected download events. Exercise duplicate, rejected and completed download events. | One download registration per accepted item and one release when it finishes. Active downloads still protect their owning view. |

The candidate also keeps a failed tab rename open for retry and restores the
old backend if writing the activation pointer fails after quiescing it.

## Browser and resource policy

**Browser** offers ChatGPT, Perplexity, GitHub, and Other in the existing pane
menu. It uses the same Electron WebContentsView pool and one toolbar for back,
forward, reload and URL entry. Tabs keep their IDs and workspace association.
The three existing provider partitions and cookies are retained. Other uses
its own persistent partition, with no MaW preload, Node access, or privileged
permissions. It accepts public HTTP(S) hostnames; local names, literal IP
addresses, credentialed URLs and custom schemes are rejected. The hostname
policy does not promise filtering of DNS answers. Live provider OAuth was not
tested with personal accounts.

Restored tabs load on selection. The existing budget trims eligible background
views without a new polling loop. Attached, loading, downloading, popup-owning,
AI, and interacted pages remain resident when eligible views run out, even
under pressure. Suspended views retain their native history and zoom; durable
URLs and cookies survive reopening, but the native back/forward stack is not
stored across app exits. Quitting or power loss can still discard page input
that the site itself has not saved.

The release removes the continuously animated workspace background and an
unused JSON store helper. Browser creation, navigation checkpointing, and
download ownership have fewer independent paths. It adds no runtime dependency,
browser engine, or resident service.

## Validation and measurements

The release runner uses a separate profile, configuration, socket and
downloads directory. It does not use the installed user's data or accounts.

| Check | Result |
| --- | --- |
| Typecheck and production build | Passed. Vite warns about large chunks. |
| Full server suite | 447 passed, 3 opt-in systemd tests skipped in this run. All 3 systemd tests passed separately in isolated units. |
| Full web suite | 92 passed in sandboxed Chromium. |
| Additional pane and branding acceptance | 22 passed. |
| Desktop unit and production packaging suites | 59 and 7 passed. Ubuntu amd64 package built and inspected, not installed. |
| Native Electron acceptance | 5 passed, including cookie retention, Other input and navigation history, download ownership and view budget. |
| Browser acceptance | 7 passed. |
| Built backend and Electron staging | Passed: create Other through the UI, navigate while disconnected, reconnect on a changed port, keep the same native view and input, persist the new URL and restore cookies. |
| Real systemd | Actual updater built a detached release, both disposable services started from cold, and authenticated readiness reported the correct release in 3.7 s. Separately verified start-limit rollback and private D-Bus delegation. |
| Repository checks | `pnpm check` remains red on two baseline localization rules: 52 apparently unused English keys and 130 hard-coded JSX strings (132 on baseline). Baseline had 11 failed localization checks; candidate has 2. |

Full suites ran before the final small hostname validation alignment. The
final revision was rebuilt and typechecked and ran 27 focused Browser store tests and
browser acceptance tests, plus a repeat of the Electron staging scenario.
Evidence and reproduction commands are in `dist-release-evidence/` and
`scripts/maw/validate-release.mjs` in the worktree.

The benchmark ran the actual workspace root with production React in
sandboxed Chromium, fresh profile per trial, at 1280×860 and DPR 1.5.
Each trial had one second of warmup followed by five seconds of idle
measurement. Baseline and candidate alternated twice.

| Metric, average of two trials | Baseline | Candidate |
| --- | ---: | ---: |
| Renderer task time per five seconds | 590.93 ms | 173.32 ms |
| Renderer script time per five seconds | 37.85 ms | 0.95 ms |
| Animation callbacks per five seconds | 300 | 0 |
| PSS of readable processes only (3 of 6) | 160.95 MiB | 139.60 MiB |

Renderer task time fell **71% in this fixture**. The raw samples are in
`dist-release-evidence/promotion/benchmark.json`. Three sandboxed processes
were unreadable in each run. The partial PSS figures cannot establish a
whole-app RAM saving. This workload did not include live agents, active
external sites, or the installed Electron profile. The 3.7 s systemd
result is a cold-start check, not a before-and-after measurement.

## Promotion and rollback

1. Resolve the pre-existing `pnpm check` localization failures in a reviewed
   change, or obtain explicit approval to accept them under the repository's
   merge policy. Require successful hosted CI for the exact promotion commit
   wherever branch protection requires it. No hosted CI result is claimed.
2. After explicit authorization, promote the reviewed candidate to the
   configured release channel (`origin/main` on this installation). Verify
   that the approved ref resolves to the expected commit and can advance the
   installed release. Keep the previous release and runtime for rollback.
3. Run `sh scripts/maw/install.sh --integrate-desktop` once from the approved
   checkout. Confirm both user units report `enabled`, the searchable entry
   is **MaW** with icon `maw-workspace`, and no service was restarted. The
   pinned runtime (Electron 45.2.0) is already installed on this laptop. No
   new unit files or system package are needed for this upgrade.
4. Run `maw update --no-restart`, check the staged SHA with `maw status`,
   save unsaved work and close all live MAW terminals, then quit the old
   desktop window. Run `maw restart` without `--force`. Check that the
   expected release is healthy and reopen MaW from app search. The installed
   service will refuse supervisor promotion if its live PTYs cannot be
   ruled out. A backend-only restart with a surviving supervisor does not
   require starting new agents.
5. At the next normal restart or poweroff/login, verify that both services
   start and that searching **MaW** opens the same workspace. The isolated
   systemd test verifies startup with both units and an authenticated
   supervisor. Production cold boot and GNOME search have not been tested
   because this release did not change or reboot the laptop.

Use `maw rollback` if the target supports the current tab store. Legacy
provider records can still be saved in v1. Saving Other writes v2; a
v1-only target must not read a v2 primary or backup store. If blocked, choose
a compatible release or archive both JSON files and explicitly migrate the
records. Do not bypass the guard or delete the desktop profile. If stopping
the supervisor is required, drain live terminals first. No executable
rollback preserves processes across a supervisor stop or a laptop poweroff.

The next performance pass should measure working-set PSS and CPU in a normal
authenticated workspace with representative agents and browser tabs. Keep the
soft eviction budget until that data shows a meaningful problem. Profile
startup and bundle cost before spending time splitting bundles further.

# Independent MAW audit — draft delivery

Starting SHA: `cde654f6a0302a43c10dfc696b264ec8c3aefd05` (merged PR #12).
Final implementation/evidence SHA: `11504091b0541e747ed405337892dcdd131e88fe`.
Subsequent delivery commits change audit documentation only; exact delivery HEAD
is recorded in the draft PR and final handoff. Branch:
`audit/maw-adversarial-performance`, targeting main. No merge or deployment.

## Completion matrix

| Checkpoint | Outcome |
| --- | --- |
| Baseline | PASS: clean expected SHA, integration verified, baseline suites green |
| 0 unified rename | PASS: CLI/shell/web inline editor, stable IDs, validation, persistence, keyboard/menu access |
| 1 adversarial security | Bounded audit complete; confirmed P1 fixed; network/power-loss limits remain |
| 2 state/lifecycle | PASS tested scenarios: isolated PTYs, mixed selection, ownership, retry, restart, failure injection |
| 3 notifications | PASS tested shell/Codex/replay/outbox/inspection; Antigravity and ChatGPT completion UNVERIFIED |
| 4 responsive UI | Six real viewports PASS for recorded controls/live media; full feature matrix remains partial |
| 5 profiling | Reproducible selection baseline, final startup/render and browser CPU/PSS/RSS; other metrics UNVERIFIED |
| 6 optimization | PASS measured write/event reductions; no claimed real-switch latency improvement |
| 7 release gates | Local gates PASS; remote CI infrastructure blocked; NOT release approval |

## Defects and corrections

Detailed code locations, reproductions and evidence: [FINDINGS.md](FINDINGS.md).

| ID | Severity | Correction | Evidence |
| --- | --- | --- | --- |
| A01 | P1 | Reject malformed cookie without crashing synchronous WS auth | Isolated child exit 1→0, HTTP 403; malformed session/device cookie regression |
| A02 | P2 | Roll back browser title after failed persistence | Disk-full reproduction fails before, passes after; retry/reload retains target ID |
| A03 | P2 | Lost Codex rollout emits Unknown once | Backed-up/removed fixture evidence: Working→Unknown, no false completion |
| A04 | P2 | Restore rejected native selection; select current attempts only | Failure injection, sibling isolation and changed-tab tests |
| A05 | P2 | Preserve rename text against reconnecting iframe autofocus | Real 768px reproduction, explicit iframe-focus regression, final viewport run |

No confirmed P0 or unresolved confirmed P1. A05 was introduced and corrected
during checkpoint 0 follow-up; it is not counted as an original-baseline defect.

Rename policy: double-click name, F2 on tab, or Add tab menu → Rename tab.
Enter saves; Escape and focus moving to another MAW control cancel. Embedded
viewer autofocus is returned to editor. Empty/control-character/overlong names
are rejected; failed saves preserve prior metadata. Native rename reuses tab.name;
web rename reuses existing protocol. No provider identity, path, target ownership
or process mutation. Persisted names survive actual page and server restart.

## Performance

[Raw measurements and conditions](PERFORMANCE-BASELINE.md),
[before/after results](OPTIMIZATIONS.md).

- 15 tabs, 300 same-tab selections: writes 300→0, changed events 4500→0;
  p50 .181→.0028 ms. Alternating selection events 4500→600 (86.7% fewer),
  bytes 2,635,500→350,700. Alternating p95 .326→.337 ms: no improvement claim.
- Final real fixture startup 470.0 ms, restart 465.3 ms; frontend navigation to
  mounted app 191.2 ms. One startup sample each; OS caches warm.
- Server RSS 117.3 MiB / PSS 65.9 MiB. WS select p50 ~.23 ms, not rendered
  workspace latency; 40 operations, 120 messages including coordinator snapshots.
- Neko Chromium settled PSS at 1/5/10/15 guest tabs: 320.1/580.0/891.5/1202.6 MiB.
  Settled CPU ~1.5–2.5% of one core; loading ~45–206%. Neko process ~22 MiB PSS
  without viewer; encoding CPU is excluded. Shared host, short intervals.

## Responsive evidence and limitations

[Six-viewport screenshots and precise feature coverage](RESPONSIVE-EVIDENCE.md).
All required sizes exercised in real Chrome against isolated MAW and actual Neko.
Sidebar open/collapse/keyboard resize, inline rename, notification inbox/Escape,
live media and horizontal-overflow assertions passed at every size. Additional
native input, notification navigation, browser input, sibling close and restart
acceptance passed. No browser page errors.

390px MAW controls fit, but remote desktop text is severely downscaled and
letterboxed. Touch hardware/virtual keyboard, every modal, pointer resize and
all shortcuts were not exhaustively checked at each size. Do not infer complete
responsive feature acceptance from these captures.

## Regression and CI

- Server/security/profile/native/browser/activity/host: **173 PASS**, 0 skipped.
- Frontend model/notifications/real Chromium UI: **19 PASS**, 0 skipped, including
  final CLI rename and menu coverage (`/tmp/maw-audit-delivery-web.log`).
- Python controller/ownership: **19 PASS**.
- Real native acceptance: **25 PASS**; identity/remediation: **6/6 PASS**.
- Real Neko ownership, controller/Chromium restart and MAW UI integration: PASS.
- Typecheck, full `pnpm check`, nine-locale i18n and production build: PASS.
  Internal guide check SKIP (guide absent); existing bundle-size warning remains.
- Baseline GitHub run 40777144624: jobs never started due account payment/spending
  limit. This is infrastructure failure, not a code failure. Draft PR CI will be
  inspected separately. Windows/macOS package smoke and Android not run locally.
- Linux CI now includes the missing security/activity/browser/Python regressions
  and explicitly installs Chromium before browser tests.

## Remaining boundaries / recommendations

1. Antigravity official Stop hooks warrant a disposable authenticated experiment
   proving session attribution, repeated turns and failure semantics. Docs alone
   are insufficient. Current completion remains UNVERIFIED; no user config changed.
2. ChatGPT completion and authenticated background generation remain UNVERIFIED.
   No private APIs, conversation scraping or user login were used.
3. One Neko desktop is shared globally. Target mutation ownership does not imply
   independent visual confidentiality among simultaneous viewers/workspaces.
4. URL policy is not verified network-egress isolation. Packet-level local-network
   checks, power-loss fsync durability, sustained uptime/leaks, React commit counts,
   frontend PSS and active-output frame latency remain unmeasured.
5. Rank next work: isolated longer reconnect/input soak; mobile stream scaling;
   differential coordinator snapshots (remaining 3 messages per duplicate select);
   bounded retention with durable dedup; bundle splitting after loading traces.
   Do not discard durable receipts or debounce writes without crash tests.
6. A transient upstream Neko display-name login overlay appeared during an early
   retry; final live media/input passed. Longer soak should establish frequency.

## Deployment risk and rollback

No production processes, native profiles/auth, projects, shell dotfiles or systemd
units modified. Only two labelled audit containers were used; both profiles and
controller metadata were archived to private fixture-backup.tar.gz before final
container removal. Existing containers were not touched. Test subprocesses were
stopped only by their owning harnesses.

This draft is reviewable, not release-approved while CI and listed acceptance
limits remain. No persistence schema change. Deploy through reviewed release
procedure only after private backups of intended application JSON stores and
explicit accounting for native PTYs. Never copy credentials into this branch.
Rollback to a reviewed prior revision preserves existing tab metadata; reverting
the security fix reintroduces A01. Service rollback/restart interrupts PTYs and
must be a separate authorized operational action. Do not automate it from audit.

## Exact continuation commands

From this audit worktree:

```sh
git status --short --branch
git log -8 --oneline
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @agent-workbench/server exec sh -c 'pnpm exec tsx --test src/security.test.ts src/maw-host.test.ts src/agents/profiles/profiles.test.ts src/agency/*.test.ts src/agency/browser-tabs/*.test.ts src/agency/runtime/*.test.ts'
node --test packages/web/src/agency/model.test.mjs packages/web/src/agency/notifications.test.mjs packages/web/src/agency/browser-tabs.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/neko/controller -p 'test_*.py'
pnpm check
pnpm build
pnpm --filter @agent-workbench/server exec tsx scripts/check-agency-e2e.mjs
pnpm --filter @agent-workbench/server exec tsx scripts/check-agency-remediation.mjs
pnpm --filter @agent-workbench/server exec tsx scripts/check-maw-integration.mjs
pnpm --filter @agent-workbench/server exec tsx ../../scripts/audit/selection-benchmark.mts
node scripts/audit/security-probe.mjs
gh pr view audit/maw-adversarial-performance --json url,headRefOid,statusCheckRollup
gh run list --branch audit/maw-adversarial-performance --limit 5
```

For a **new** real Neko fixture, `python3 scripts/audit/start-neko-fixture.py`
prints its private config path. Pass that exact path as MAW_INTEGRATION_NEKO_ENV
and a new MAW_INTEGRATION_EVIDENCE directory to check-maw-integration.mjs.
`verify_managed_runtime.mts` takes config path and its parent directory/container
name. `neko-resources.py` takes a separate freshly generated fixture config.
Never use production Compose/scripts or old integrations' config. Back up fresh
fixture state, then remove only the exact name with verified `maw.audit=true` label.
Do not print config contents or commit generated credentials. Wait for account
owner to resolve CI billing, then rerun checks; do not change account settings.

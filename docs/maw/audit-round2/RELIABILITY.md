# Reliability, providers and security boundaries

## Bounded resources

Commands:

```sh
MAW_ROUND2_SECONDS=120 MAW_ROUND2_OUT=/tmp/maw-round2-before node scripts/audit/round2-soak.mjs
# After the coordinator change:
MAW_ROUND2_SECONDS=120 MAW_ROUND2_OUT=/tmp/maw-round2-after node scripts/audit/round2-soak.mjs
python3 scripts/audit/start-neko-fixture.py > /tmp/maw-round2-neko-path
python3 scripts/audit/round2-neko-resources.py "$(cat /tmp/maw-round2-neko-path)"
```

The shell harness uses temporary HOME/XDG, four workspaces in two projects,
15 actual Bash PTYs, 100 repeat and alternating selections, 100 visible tab
switches, 100 inbox toggles, six resize/rename/input viewports and a configurable
120-second workload phase. Each cycle reconnects WS, selects 20 tabs, creates,
attaches, writes to and closes a fresh PTY; every tenth cycle reloads the frontend.
It closes fixture PTYs and restarts only its own server. Maximum configured
workload is one hour. Historical closed sessions are intentionally persisted.
There is no forced GC or assertion that retained history is a leak.

Before run: 34 reconnect cycles, 680 sustained selections, 49 total retained
sessions; FD 32 baseline / 47 with 15 PTYs / 50 during reconnect / 32 cleanup;
PTY child processes 0 / 15 / 0. PSS 81.9 MiB baseline, 90.8 MiB warm, 68.2–94.1
MiB sampled workload, 78.5 MiB cleanup, 69.6 MiB after restart. DOM 384–410.
No evidence of progressive unrecovered resource growth in this bounded run.
JS heap varied 11.6–20.2 MiB, across fresh page reloads without forced GC;
this is not evidence of a frontend leak or its absence over long uptime.
After-run data and limits are recorded in BENCHMARKS.md and evidence/soak-after.json.

Neko resources: real guest ChatGPT pages, **no active viewer/encoding** during
resource sampling. Settled Chromium PSS MiB at 1/5/10/15/30 targets:
456.8 / 715.7 / 1024.8 / 1328.4 / 2167.4. Chromium CPU (% of one core):
1.6 / 2.5 / 2.4 / 2.4 / 54.8. Thirty-tab load had not settled; do not infer
an idle cost from its final 3-second interval. Peak loading CPU 376.2%.
Chromium FD 451 / 676 / 967 / 1259 / 2165; post-close 419. After closing all
created targets, Chromium's automatic blank target remains (one target, not an
owned target leak): PSS 368.2 MiB, 13 processes. Neko PSS ~33 MiB.
RSS is preserved in raw evidence, never substituted for PSS.

## Real browser and restart evidence

`MAW_INTEGRATION_NEKO_ENV=<generated-config> MAW_INTEGRATION_EVIDENCE=/tmp/maw-round2-neko-ui pnpm --filter @agent-workbench/server exec tsx scripts/check-maw-integration.mjs`:
11 acceptance groups PASS, live media at all six sizes. Genuine WebRTC keyboard
input and URL persistence; cross-workspace/browser/native switching preserves
PTY and target identity; sibling close, MAW restart, inbox persistence PASS.
`verify_managed_runtime.mts <generated-config> <owned-container>` separately
passed idempotent creation, foreign-owner rejection, reattach, controller restart
receipts, Chromium restart invalidation and cleanup. See evidence/real-restart.json.
No prolonged active WebRTC encoding/reconnect soak was completed.

## Provider capability matrix

| Provider/mechanism | Started/working | Completed/failed/interrupted | Missing evidence/repeated turns | Authentic account run |
| --- | --- | --- | --- | --- |
| Bash/Zsh scoped OSC integration | PASS | PASS / PASS / Unknown where insufficient | PASS fixtures and real disposable PTYs | No account needed |
| Codex attested native rollout | PASS fixture | PASS / PASS / Unknown on abort | PASS: loss→Unknown once, delayed complete, 100 successive turns, replay dedup, malformed/oversized evidence, disposal | UNVERIFIED |
| Antigravity current integration | Generic activity available; task lifecycle UNVERIFIED | UNVERIFIED | UNVERIFIED for lifecycle Stop attribution | UNVERIFIED |
| ChatGPT shared Chromium | Page/target continuity PASS; task start Unknown | UNVERIFIED; remains Unknown | No completion inference from idle network | UNVERIFIED |

Codex verification command: `pnpm --filter @agent-workbench/server exec tsx --test src/agency/activity-integration.test.ts`: 9 PASS. Fixtures read only generated
rollouts, never the user's Codex home. The new test verifies partial JSON cannot
complete a task, explicit completion after file recovery can, 100 successive
turns deliver once, invalid/oversized lines do not fabricate completion, and late
events after disposal are ignored. This does not validate every installed Codex
version's serialization or compressed evidence. Live rollout disappearance is
Unknown, not completed. Unbounded durable receipts/history remain a retention
and scalability concern; deleting receipts would compromise deduplication.

Official sources checked 2026-10-28:
[Codex hooks](https://developers.openai.com/codex/hooks) documents session/turn
lifecycle hooks and Interrupt; a possible future alternative to rollout polling.
[Antigravity hooks](https://antigravity.google/docs/hooks) documents Stop with
`conversationId`, `executionNum`, `terminationReason`, and `fullyIdle`.
A future isolated integration must bind conversation + execution + native home
and verify normal stop, error, interruption, background work and continued turns.
`fullyIdle=false` and per-invocation events cannot establish full completion.
Docs establish a contract, not successful behavior of a real authenticated CLI.
No hook was installed in an authenticated profile. No ChatGPT extension, private
API, cookies, tokens or conversation contents were retrieved.

## Security and persistence

Actual regression covers malformed credential cookies, Host/Origin, paired
session authorization, viewer non-admin privileges, revoked WS credentials,
controller ownership forgery, redirects and URL validation. Real controller
foreign-owner rejection and restart epoch verification also passed. This is
bounded regression evidence, not an exhaustive new penetration test.

R2-01 prevents corrupt-primary poisoning of notification/activity backups;
R2-02 prevents browser-store schema downgrade. Reproductions and fixes are in
FINDINGS.md. Existing tests exercise disk write failures, atomic file replacement,
corrupt/valid backup, both corrupt, notification replay/outbox and mode 0600.
No actual full disk or power cut was induced. Atomic rename is not fsync-based
power-loss durability. ENOSPC timing at every write stage remains unverified.

MAW host credentials authorize the application, not independent workspace users.
Target workspace/tab ownership protects controller mutations. A single Neko
stream is a shared desktop: simultaneous authorized viewers can see the same
active page. It supplies **no independent visual confidentiality** per workspace
or per MAW viewer. Browser URL allowlisting is navigation policy, **not verified
network egress isolation** of page subresources, DNS or redirects. No unrelated
network probing or live-state failure injection was performed. Packet-level
local-network/metadata egress tests remain UNVERIFIED.

No production process, shell dotfile, native authentication directory, workspace
or history was changed. The fresh audit-labelled Neko uses a writable container
layer and no reused or named volumes. Its loopback TCP/UDP publications are
separate from production. Cleanup ownership must be verified by unique name,
`maw.audit=true` and the generated fixture config before removal.

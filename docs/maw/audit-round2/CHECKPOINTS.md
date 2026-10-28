# Round 2 checkpoints and continuation

## CP0 — baseline (2026-10-28)

Verified cwd `/home/alteixeira20/Projects/My-Amazing-Workspace-deep-soak`, branch
`audit/maw-deep-soak`, clean HEAD `e2dc81217490199e16683ce08653860171d912ad`.
Read all five Round 1 audit reports, integration checkpoints and actual production
integration document `docs/maw/neko/PRODUCTION-INTEGRATION.md` (requested infra path
is absent). No production process, profile, state or service accessed for tests.

Environment: Linux, Node 24.22.0, pnpm 12.16.1, Python 3.14.4, Docker 29.8.2.
Shared host: 29 GiB RAM, ~13.5 GiB available, substantial existing swap usage;
/tmp tmpfs ~7.4 GiB free, repository filesystem ~31 GiB free. Results are subject
to host contention. Dependencies installed with `pnpm install --frozen-lockfile`.
No application source changed before baseline.

Baseline commands (logs `/tmp/maw-round2-baseline-*.log`):

- `pnpm --filter @agent-workbench/server exec sh -c 'tsx --test src/agency/*.test.ts src/agency/browser-tabs/*.test.ts src/agency/runtime/*.test.ts src/security.test.ts src/maw-host.test.ts src/agents/profiles/profiles.test.ts'`: 173/173 PASS, zero skips, 5.13 s.
- `node --test packages/web/src/agency/*.test.mjs`: 19/19 PASS, zero skips, 3.23 s (real Chromium UI fixture included).
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/neko/controller -p 'test_*.py'`: 19/19 PASS.
- `pnpm typecheck`: PASS all packages.
- `pnpm build`: PASS, 2.00 s; main bundle 1173.27 kB / gzip 320.94 kB, existing chunk-size warning.

## Risk map and execution plan

1. Coordinator unconditional global snapshots after no-op and failed mutations:
measure actual WebSocket bytes and visible tab switches; retain correct recovery
snapshots and catch-up behavior while eliminating proven redundant work.
2. Bounded soak: temporary HOME/XDG, fresh shell PTYs, repeated attach/reconnect,
select/close, process-owned cleanup; sample /proc RSS/PSS, fd/process counts,
post-cleanup recovery. Label fresh Neko container and measure 1/5/10/15/30 targets
if memory headroom permits. Report short duration honestly; no uptime claim.
3. Deterministic failure tests: primary/backup corruption, concurrent operations,
controller ownership, Codex missing/delayed/truncated lifecycle evidence. A caught
exception alone is not proof of rollback. Fix only reproduced defects.
4. Real browser UI at six requested sizes with trace and paint-bound timing;
100 inexpensive interaction samples; separate UI/render timing from WS response.
Investigate mobile fitting without global desktop resizing or new browser instances.
5. Inspect native provider official sources (no authenticated production experiments),
security boundaries, CI and broad applicable local regression. Produce capability
matrix and explicit unverified evidence, push and create draft PR; no merge/deploy.

## Continuation discipline

Update this file after each coherent checkpoint, commit evidence plus fixes, and
leave executable commands in the topic documents. Never signal pre-existing
processes or reuse a Neko resource. Release verdict remains UNVERIFIED until final
assessment. Current next action: build bounded isolated soak and coordinator
baseline, then failure-inject persistence/provider transitions.

## CP3a — persistence failure injection

R2-01 and R2-02 reproduced before fixes and covered by executable regressions.
`pnpm --filter @agent-workbench/server exec sh -c 'tsx --test src/agency/browser-tabs/*.test.ts src/agency/recovery-round2.test.ts'`: 56 PASS, zero skips.
Notification/activity suite: 20 PASS. Server typecheck PASS after R2-01; full
regression scheduled after remaining changes. No schema changes or deployment.
Next: finish bounded baseline, snapshot optimization, provider evidence tests.

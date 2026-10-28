# Confirmed Round 2 findings

## R2-01 — P2 — notification/activity recovery poisons the backup (FIXED)

`AgencyNotificationStore.load` and `TabActivityManager.load` returned validated
backup records while leaving a corrupt primary on disk. Their next `persist`
copied the corrupt primary over the good backup. A second interrupted/damaged
primary then prevented startup and recovery of notification/activity receipts.
Reproduce: `pnpm --filter @agent-workbench/server exec tsx --test src/agency/recovery-round2.test.ts`.
Both cases failed before with AggregateError; both pass after quarantining the
primary only after backup validation. Quarantine failures refuse initialization;
neither file is deleted. Evidence `/tmp/maw-round2-recovery-{before,after}.log`.
This fixes a recovery chain, not sudden-power-loss durability.

## R2-02 — P2 — future browser schema silently downgraded through backup (FIXED)

`BrowserTabStore.load` interpreted unsupported schema as corruption, quarantined
the newer primary and returned older backup records. The next write could erase
newer metadata. New regression writes version 999 primary + v1 backup and asserts
rejection, unloaded state and both files byte-identical with no quarantine.
Before: missing expected rejection; after: PASS. An explicit unsupported-schema
error now bypasses fallback for both primary and backup, preserving the existing
BrowserTabStoreError interface. Evidence `/tmp/maw-round2-schema-before.log` and
`/tmp/maw-round2-persistence-after.log` (56 focused tests PASS).

## R2-03 — P3 — duplicate selection broadcasts global state (IMPROVED)

Coordinator `snapshot()` unconditionally broadcasts both domains even for no-op
native selection. A real server with 15 PTYs sends 300 messages / 1,929,300 bytes
for 100 repeated selects. Domain comparison reduces that to 100 / 963,500.
Direct responses/reconnect snapshots remain unconditional. Focused coordinator
regression, 120-second before/after soak and native/Neko acceptance pass.
This is an efficiency defect; no visible latency improvement is claimed.
See BENCHMARKS.md and OPTIMIZATIONS.md, including changed-selection tail cost.

## Pending hypotheses

Resource growth from retained history is distinct from a leak; no confirmed leak.

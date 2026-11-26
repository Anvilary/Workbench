# Resource budget policy

The desktop keeps a bounded pool of resident native browser views. Views beyond the budget are suspended (their page is unloaded and restored from the durable URL when shown again). Source: `packages/desktop/src/performance/resource-budget.mjs` and `packages/desktop/src/browser/view-eviction.mjs`. Inputs come from the [resource monitor](resource-monitor.md).

## Memory pressure tiers

The tier is computed from `/proc/meminfo` (available memory and its ratio to total RAM) and the working set of browser tabs:

| Tier | Entered when (any condition) | Standby budget |
|---|---|---|
| critical | available < 1 GiB, or available ratio < 8%, or tab working set >= 4 GiB without ample memory | visible views only (at least 1) |
| high | available < 2 GiB, or ratio < 15%, or tab working set >= 2.5 GiB | visible views only (at least 1) |
| moderate | available < 4 GiB, or ratio < 25%, or tab working set >= 1.5 GiB | visible views + 1 |
| normal | otherwise | visible views + 2 (at least 2) |

"Ample memory" means at least 8 GiB and 30% available: a large tab working set alone does not reach critical on a machine with plenty of free memory.

Sustained pressure can only raise the tier, never above high:

- Linux PSI memory stalls (`/proc/pressure/memory`, 60 second average): `some` >= 5 raises to moderate, `some` >= 12 or `full` >= 2 raises to high. The 60 second average is deliberate: a short compile spike must not evict browser sessions.
- Swap nearly exhausted (< 10% free) while available memory is below 30% raises to high.
- CPU pressure is not used: hidden views are already throttled, so evicting them would not relieve CPU.

A raised tier is held for two minutes after its signal last justified it (hysteresis), so readings near a threshold do not make the budget flap. Escalation is immediate.

`WORKBENCH_MAX_RESIDENT_VIEWS` (legacy `WORKBENCH_MAX_RESIDENT_VIEWS`) overrides the standby budget, clamped to at least the visible views. It never overrides the memory tier.

## Eviction rules

Workbench retains attached or focused views, loading pages, active downloads, popup owners,
open DevTools and pages without a restorable URL. ChatGPT and Perplexity stay resident
because their background work cannot be inferred from the page's visibility. Keyboard
or pointer interaction protects a page for the life of its document, including in-page
navigation. Navigating to a new document ends the old document's protection.

The same protections apply at critical pressure. Workbench may remain over its resident
budget and reports which protections prevented eviction. The previous experimental
AI-unloading preference no longer controls eviction.

Eligible views are selected by least recent use, with preference for views that have
been resident for at least 15 seconds.

## Benchmarks

Budget changes must be measured with the [benchmark methodology](benchmark-methodology.md).

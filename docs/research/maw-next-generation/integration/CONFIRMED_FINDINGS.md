# Confirmed Integration Findings

**Base Revision:** `502181f`
**Audit Date:** 2026-11-03

Each finding is graded **blocking** (must be resolved before integration can proceed) or **non-blocking** (should be tracked; does not gate integration).

---

## Blocking Findings

### A-002 · systemd `KillMode=control-group` defeats supervisor purpose

**Severity:** Blocking  
**Lane:** A  
**File:** [`scripts/maw/pty-host/maw-ptyd.service`](file:///home/user/Projects/MAW-pty-supervisor/scripts/maw/pty-host/maw-ptyd.service)  
**Line:** `KillMode=control-group`

**Description:**  
The systemd unit uses `KillMode=control-group`. When systemd stops or restarts the unit (including on `Restart=on-failure` after a daemon crash), it sends SIGTERM/SIGKILL to every process in the daemon's cgroup — which includes all spawned PTY children. This defeats the core architectural guarantee of Lane A: that PTY child processes survive backend restarts. Under systemd management, a daemon crash kills all terminals.

**Evidence:**  
From `maw-ptyd.service`:
```ini
KillMode=control-group
Restart=on-failure
```

The supervisor's design depends on `KillMode=process` so only the supervisor process is signaled; child PTYs (in their own cgroups or as descendants) survive until their natural exit.

**Repair:**  
Change `KillMode=control-group` to `KillMode=process` in the systemd unit template. Also add `KillSignal=SIGTERM` and `FinalKillSignal=SIGKILL` for explicit termination semantics.

```ini
KillMode=process
KillSignal=SIGTERM
FinalKillSignal=SIGKILL
TimeoutStopSec=10
```

Also consider whether `Restart=on-failure` is appropriate. If the daemon is restarted, a new daemon will start (new auth token, new socket). Any reconnection logic (Lane B) must handle the case where the daemon crashed AND all children were lost — this is a different recovery path from "daemon restarted cleanly."

**Additional note:** Even with `KillMode=process`, child PTYs spawned by node-pty are in the same session group as the daemon by default. Verify that node-pty uses `setsid()` or that the service uses `Delegate=yes` to give children their own cgroup subtree.

---

### C-002 · `deduplicationIndex` grows without bound under inbox pruning

**Severity:** Blocking  
**Lane:** C  
**File:** [`packages/server/src/agency/agency-notification-store.ts`](file:///home/user/Projects/MAW-notifications/packages/server/src/agency/agency-notification-store.ts)  
**Line:** ~200 (pruning block) and ~55 (index declaration)

**Description:**  
When `this.notifications.size > MAX_NOTIFICATIONS (150)`, the store prunes oldest acknowledged-and-read notifications from `this.notifications`. However, the corresponding `deduplicationIndex` entries are **never deleted** during pruning. 

Over time, in a system with high notification volume (busy agent, many completions acknowledged over weeks), the `deduplicationIndex` accumulates stale entries indefinitely. Since the notification is gone from the store, but its dedup key persists, any future notification with the same `deduplicationKey` (e.g., a new run of the same task identity) will be silently deduplicated and dropped — a **functional silent deduplication failure** for recurring tasks.

**Evidence:**

```typescript
// Pruning block (lines ~200-208): prunes from this.notifications but NOT from this.deduplicationIndex
if (this.notifications.size > MAX_NOTIFICATIONS) {
  const candidates = [...this.notifications.values()]
    .filter((n) => n.read && n.acknowledgedAt && n.id !== id)
    .sort(...);
  for (let i = 0; i < Math.min(excess, candidates.length); i++) {
    const victim = candidates[i];
    if (victim) this.notifications.delete(victim.id);
    // BUG: this.deduplicationIndex.delete(victim.deduplicationKey) missing
  }
}
```

The on-persist-failure path does call `this.deduplicationIndex.delete(input.deduplicationKey)` (line ~208), but this only covers creation failure, not pruning.

**Repair:**  
In the pruning block, after `this.notifications.delete(victim.id)`, add:
```typescript
if (victim.deduplicationKey) {
  this.deduplicationIndex.delete(victim.deduplicationKey);
}
```

Since `MawNotificationItem` may or may not expose `deduplicationKey`, verify the stored item type preserves it. If not stored on the item, store it or skip dedup cleanup (documenting the functional gap).

---

## Non-Blocking Findings

### A-001 · Dual independent ring buffer implementations create drift risk

**Severity:** Non-blocking (track)  
**Lane:** A  
**Files:**  
- [`packages/server/src/output-buffer.ts`](file:///home/user/Projects/MAW-pty-supervisor/packages/server/src/output-buffer.ts) — TypeScript `OutputBuffer`  
- [`packages/server/src/pty-host/maw-ptyd.mjs`](file:///home/user/Projects/MAW-pty-supervisor/packages/server/src/pty-host/maw-ptyd.mjs) — JS `SupervisorOutputBuffer` (inline)

**Description:**  
Two independent implementations of the ring buffer exist. At the current revision they are functionally identical. However, any future bug fix or enhancement to one requires a manual matching change to the other. This is a maintenance liability. The TypeScript version is used by the integration and tests; the daemon's JS version is the one that runs in production.

**Repair:**  
The daemon (`maw-ptyd.mjs`) could import the buffer logic from a shared module, or the integration could always run the TypeScript version via a tsx wrapper. Alternatively, document the dual-implementation invariant explicitly in `PTY_PROTOCOL_CONTRACT.md` and add a comment in both files referencing the other.

---

### A-003 · `attach` operation defined in protocol but not implemented

**Severity:** Non-blocking (must implement before GA)  
**Lane:** A, B  
**Files:**  
- [`packages/server/src/pty-host/pty-host-types.ts`](file:///home/user/Projects/MAW-pty-supervisor/packages/server/src/pty-host/pty-host-types.ts) — `PtyAttachRequest` type defined  
- `packages/server/src/pty-host/maw-ptyd.mjs` — `_dispatch()` does not handle `op: 'attach'`  
- `packages/server/src/pty-host/pty-host-client.ts` — no `attach()` method

**Description:**  
`PtyAttachRequest` and `PtyDetachRequest` are declared in the protocol types but neither the daemon nor the client implements them. The `_dispatch()` function in the daemon silently ignores unknown operations. A client that sends `{op: 'attach', id: 'term-1'}` receives no response, causing a pending request timeout.

**Repair:**  
Either implement `attach`/`detach` semantics in both daemon and client, or remove the types and document the decision. Lane B (terminal reattachment) is the natural owner of this implementation.

---

### A-004 · Replay/snapshot race window for concurrent late subscribers

**Severity:** Non-blocking (design acknowledged)  
**Lane:** A  
**File:** [`packages/server/src/pty-host/maw-ptyd.mjs`](file:///home/user/Projects/MAW-pty-supervisor/packages/server/src/pty-host/maw-ptyd.mjs)

**Description:**  
On `hello` with `subscribe: true`, the daemon responds with a `snapshot` that includes current `startOffset`/`endOffset`. The client then requests `replay(id, sinceOffset=snapshotEndOffset)` to get deltas. Between the snapshot and the replay request, new `data` broadcast events may arrive. The client receives these live events but has not yet received the replay confirmation. If the client processes live events (with offsets > `snapshotEndOffset`) before processing the replay response, it may briefly render data out of order.

**Assessment:** The daemon sends the snapshot synchronously after authentication. Because Node.js runs on a single thread and the socket is a stream, no `data` events are queued between the snapshot send and the client's replay request in the same event loop tick. In practice, the window only opens across network RTTs, which is acceptable for a loopback Unix socket. The risk is real but low severity for same-host IPC.

**Repair:** Clients should buffer live `data` events received before replay confirmation is processed, then apply them after the replay delta. Lane B's frontend reattachment logic should implement this ordering.

---

### C-001 · Codex excluded from `VERIFIED_TURN_PROVIDERS` despite acceptance test header claim

**Severity:** Non-blocking (documentation inaccuracy)  
**Lane:** C  
**File:** [`packages/server/src/agency/tab-activity-manager.ts`](file:///home/user/Projects/MAW-notifications/packages/server/src/agency/tab-activity-manager.ts)  
**Line:** ~25

**Description:**  
```typescript
const VERIFIED_TURN_PROVIDERS = new Set<string>(['claude-code', 'opencode', 'antigravity'])
```

`codex` is NOT in this set. The acceptance test file header mentions "Codex" as a verified provider but the test body likely tests Codex with different evidence signals (exit code, non-idle transition) rather than the `status-transition` completionEvidence path.

From Lane B's audit evidence: "Codex fixture lifecycle/repeated turns/loss and delayed recovery PASS; authentic Codex behavior UNVERIFIED."

**Impact:** Codex completions will not generate desktop notifications unless Codex is added to the verified set. This is a known intentional design decision (Codex authentic completion is unverified) but the documentation discrepancy should be clarified.

**Repair:** Update the acceptance test header comment to accurately reflect that Codex is tested with alternative evidence signals, not `status-transition`. Consider documenting when Codex will be promoted to the verified set.

---

### C-003 · Inbox pruning is silent — no user-visible truncation indicator

**Severity:** Non-blocking (UX concern)  
**Lane:** C  
**File:** [`packages/server/src/agency/agency-notification-store.ts`](file:///home/user/Projects/MAW-notifications/packages/server/src/agency/agency-notification-store.ts)

**Description:**  
When the inbox is pruned beyond `MAX_NOTIFICATIONS=150`, acknowledged-and-read items are silently removed. There is no UI indicator that items were removed from the inbox. Users have no way to know that old notification history was purged.

**Repair:** Add a `truncated: boolean` or `truncatedCount: number` field to the store's public API. The `NotificationInbox.tsx` component should render a subtle "Older notifications were removed" message when this flag is set.

---

### D-001 · `ClassicWorkbenchLifecycle.dispose()` does not await in-flight `ensureStarted()`

**Severity:** Non-blocking  
**Lane:** D  
**File:** [`packages/server/src/classic-workbench-lifecycle.ts`](file:///home/user/Projects/MAW-performance/packages/server/src/classic-workbench-lifecycle.ts)  
**Line:** ~80 (`dispose()`)

**Description:**  
`dispose()` synchronously sets `this.disposed = true`, clears `stopWatching` and `onHistoryGrew` to `null`, and sets `this.started = false`. If `ensureStarted()` is in-flight, the `if (this.disposed) return` guard inside the async block fires correctly — but only if evaluated before `started = true` is reached. If the start completes after dispose (e.g., slow `SessionIndex.start()`), `this.started` is set to `true` but `stopWatching` is already `null`, leaving filesystem watchers dangling until server exit.

**Repair:**  
`dispose()` should await the in-flight `startPromise` before returning, or cancel it:
```typescript
async dispose(): Promise<void> {
  this.disposed = true;
  if (this.startPromise !== null) {
    await this.startPromise.catch(() => {}); // Wait for in-flight start to complete/fail
  }
  // then cleanup...
}
```

---

### D-002 · Build bundle test requires pre-built artifact — undocumented CI ordering dependency

**Severity:** Non-blocking (CI configuration gap)  
**Lane:** D  
**File:** [`packages/server/src/build-bundle.test.ts`](file:///home/user/Projects/MAW-performance/packages/server/src/build-bundle.test.ts)  
**Line:** 22

**Description:**  
```typescript
assert.ok(existsSync(bundlePath), 'dist/index.mjs should exist');
```
The test fails immediately on a fresh checkout if `dist/index.mjs` doesn't exist. The build step must precede the test run. This is not enforced in `package.json` scripts.

**Repair:**  
Add `"pretest": "node scripts/build-bundle.mjs"` to `packages/server/package.json`, or make the test conditionally skip (with `test.skip`) when the bundle is absent with an informative message.

---

### D-003 · Soak test imports TypeScript source directly from docs/

**Severity:** Non-blocking (test-only, docs-scoped)  
**Lane:** D  
**File:** [`docs/research/maw-next-generation/lanes/D/bench/lane-d-soak.test.mjs`](file:///home/user/Projects/MAW-performance/docs/research/maw-next-generation/lanes/D/bench/lane-d-soak.test.mjs)  
**Line:** ~10

**Description:**  
```js
const { TerminalOutputBatcher } = await import(path.join(serverRoot, 'src/terminal-output-batcher.ts'));
```
Node.js cannot import `.ts` files without a TypeScript loader. This file would fail at runtime. Since it lives in `docs/` (not in the main test suite), it may be intended as documentation/reference only. If it's ever run as a CI test, it will fail.

**Repair:**  
Either run this file exclusively via `tsx` (document in the file header) or update the import to point to the compiled `.js` output.

---

### D-004 · `dispose()` on `CoalescedJsonStore` does not guard in-flight write

**Severity:** Non-blocking (edge case)  
**Lane:** D  
**File:** [`packages/server/src/coalesced-json-store.ts`](file:///home/user/Projects/MAW-performance/packages/server/src/coalesced-json-store.ts)  
**Line:** ~130 (`dispose()`)

**Description:**  
`dispose()` calls `flush()` which awaits any in-flight write. However, `executeWrite()` itself has no `disposed` guard. If `dispose()` resolves but a deferred `scheduleSave()` timer fires after disposal (due to Node.js event loop ordering), it calls `executeWrite()` on a disposed store. The `if (this.disposed)` check in `scheduleSave()` prevents new saves, but the timer callback already captured the `executeWrite` invocation before disposal.

In practice, `dispose()` cancels the debounce timer via `flush()` → `clearTimeout(this.debounceTimer)`, so the timer cannot fire after `dispose()` completes synchronously. The risk is theoretical (TOCTOU between timer check and clearTimeout in non-linear async scenarios).

**Repair:** Add `if (this.disposed) return;` as the first line of `executeWrite()` for defensive hardening.

---

## Summary

| ID | Severity | Lane | Title |
|----|----------|------|-------|
| A-002 | **Blocking** | A | systemd `KillMode=control-group` defeats supervisor persistence |
| C-002 | **Blocking** | C | `deduplicationIndex` unbounded growth under inbox pruning |
| A-001 | Non-blocking | A | Dual independent ring buffer implementations |
| A-003 | Non-blocking | A/B | `attach` operation defined but not implemented |
| A-004 | Non-blocking | A/B | Replay/snapshot race window for late subscribers |
| C-001 | Non-blocking | C | Codex excluded from verified providers despite doc claim |
| C-003 | Non-blocking | C | Inbox pruning silent — no user-visible truncation indicator |
| D-001 | Non-blocking | D | `dispose()` does not await in-flight `ensureStarted()` |
| D-002 | Non-blocking | D | Build bundle test requires pre-built artifact |
| D-003 | Non-blocking | D | Soak test imports TypeScript source directly |
| D-004 | Non-blocking | D | `CoalescedJsonStore.dispose()` theoretical TOCTOU |

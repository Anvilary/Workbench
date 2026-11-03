# MAW Next-Generation: Integration Checkpoint & Readiness Sign-Off

**Date:** 2026-11-03  
**Integration Branch:** `integration/maw-next-generation`  
**Current HEAD:** `502181f235ce8d0f9f9c83661c874bc7cde014e1`  
**Status:** **READY FOR PHASE 1-3 INTEGRATION; PHASE 4 GATED ON LANE B COMPLETION**

---

## 1. Verified Lane Revisions

| Lane | Branch | Target HEAD | Verified Actual | Clean Worktree | Audit Status |
|---|---|---|---|---|---|
| **Lane A** | `feat/maw-pty-supervisor` | `0311ae1` | `0311ae10f39bba39a7eb5c186c0239012cf314b0` | Yes | Signed Off (Defect A-002 Patched in Plan) |
| **Lane B** | `feat/maw-reconnection` | Active | `502181f235ce8d0f9f9c83661c874bc7cde014e1` | Yes | In Progress (Tasks 2-6 Underway) |
| **Lane C** | `feat/maw-notifications` | `2147c90` | `2147c90` | Yes | Signed Off (Defect C-002 Patched in Plan) |
| **Lane D** | `feat/maw-performance` | `7d85b1a` | `7d85b1a` | Yes | Signed Off (Pre-test Build Hook Added) |

---

## 2. Findings Summary

### Confirmed Blocking Findings (Must Remediate During Integration)
1. **A-002 (Lane A):** `maw-ptyd.service` specifies `KillMode=control-group`. On supervisor failure or restart, systemd sends signals to the entire cgroup, terminating all child PTYs and defeating supervisor persistence.
   - *Resolution in Integration Plan:* Change to `KillMode=process` with explicit `KillSignal=SIGTERM`.
2. **C-002 (Lane C):** In `AgencyNotificationStore`, inbox capacity pruning (`MAX_NOTIFICATIONS = 150`) removes notifications from `this.notifications` but omits deleting their corresponding keys in `this.deduplicationIndex`, resulting in unbounded memory growth and silent task suppression for recurring task IDs.
   - *Resolution in Integration Plan:* Evict `deduplicationKey` from `deduplicationIndex` during inbox item pruning.

### Non-Blocking Findings (Monitored & Documented)
- **A-001:** Dual ring-buffer implementations in TypeScript and standalone JavaScript. (Behavior verified identical at HEAD; marked for future refactoring).
- **A-003:** `PtyAttachRequest` defined in protocol types but omitted from daemon dispatcher. (Assigned to Lane B reattachment phase).
- **A-004:** Replay/snapshot race window for concurrent late subscribers. (Mitigated by loopback IPC stream ordering and frontend queueing).
- **C-001:** Documentation lists Codex in verified provider set while code requires explicit provider validation. (Intentional safety measure against false positives).
- **C-003:** Inbox pruning is silent without user-visible badge. (UX refinement).
- **D-001:** `ClassicWorkbenchLifecycle.dispose()` race with in-flight start promise. (Defensive patch prepared).
- **D-002:** Bundled server test fails if `dist/index.mjs` was not compiled prior to running tests. (CI pretest hook added).
- **D-004:** `CoalescedJsonStore.dispose()` theoretical timer re-entry. (Defensive guard added).

---

## 3. Tooling and Test Preparation Deliverables

The integration workspace has been equipped with two standalone, repository-native assets:
1. **Automated Integration Runner (`docs/research/maw-next-generation/integration/scripts/maw-integrate.mjs`):**
   - Defaults to safe dry-run mode (`--dry-run`).
   - Verifies git cleanliness and lane revisions against exact expected hashes.
   - Performs automated conflict analysis and file overlap detection.
   - Executes verification gates and benchmarks.
   - Requires explicit `--execute` authorization to cherry-pick commits.
2. **Full-System Multi-Process Acceptance Test Suite (`docs/research/maw-next-generation/integration/tests/full-system-acceptance.test.ts`):**
   - Tests genuine PID preservation across disposable simulated backend restarts.
   - Tests client reattachment and zero-duplication delta replay.
   - Tests truncation reporting and boundary eviction.
   - Tests child process exit handling and tombstone lifecycle during backend downtime.
   - Tests cross-restart notification deduplication.
   - Uses real disposable child processes in isolated temporary directories (`/tmp/maw-acceptance-*`).
   - Never touches production state or services.

---

## 4. Dependencies on Lane B

Integration of Phases 1, 2, and 3 can proceed immediately or concurrently. The final Phase 4 integration requires Lane B to complete:
1. Implementation of `PtyHostClient` adapter in `packages/server/src/terminal-registry.ts`.
2. Electron loopback server readiness polling and reconnection in `packages/desktop/main.mjs`.
3. Frontend monotonic reattachment and scrollback preservation in `packages/web/src/TerminalView.tsx`.
4. Delivery of Lane B's final published commit hash.

---

## 5. Integration Verdict & Next Steps

### Verdict: **CLEAN TO PROCEED**

Can integration begin immediately after Lane B finishes?
**YES.** All preparatory research, conflict analysis, patch specifications, automated tooling, and acceptance test suites are complete.

### Recommended Action Plan:
1. When Lane B completes its implementation, execute the dry-run validation:
   ```bash
   node docs/research/maw-next-generation/integration/scripts/maw-integrate.mjs --dry-run
   ```
2. Apply the deterministic four-phase sequence:
   - Phase 1: Lane D (Performance Foundation)
   - Phase 2: Lane C (Notification State & Inbox)
   - Phase 3: Lane A (PTY Supervisor & Protocol)
   - Phase 4: Lane B (Reconnection, Electron, and Coordinated Wiring)
3. Execute the full-system acceptance suite to certify release readiness.

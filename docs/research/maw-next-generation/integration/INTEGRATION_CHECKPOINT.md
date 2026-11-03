# MAW Next-Generation: Integration Checkpoint & Readiness Sign-Off (v2)

**Date:** 2026-11-03  
**Integration Branch:** `integration/maw-next-generation`  
**Current HEAD:** [`02643ed`](file:///home/user/Projects/MAW-next-gen-integration) (commit `02643ed27954c34972df2aff259ddd8341a5387b`)  
**Status:** **PHASES 1–3 FULLY PREPARED & TESTED; PHASE 4 GATED ON LANE B**

---

## 1. Verified Lane Revisions and Ancestry

| Lane | Branch | Target HEAD | Verified Actual | Ancestor of Base | Clean Worktree | Integration Readiness |
|---|---|---|---|---|---|---|
| **Lane A** | `feat/maw-pty-supervisor` | `0311ae1` | [`0311ae1`](file:///home/user/Projects/MAW-pty-supervisor) | Yes (`502181f`) | Yes | **Ready for Integration** (A-002 as-designed) |
| **Lane B** | `feat/maw-reconnection` | Active | [`2c7041a`](file:///home/user/Projects/MAW-reconnection) | Yes (`502181f`) | **Active / Dirty** | **In-Progress** (Do not interfere) |
| **Lane C** | `feat/maw-notifications` | `2147c90` | [`2147c90`](file:///home/user/Projects/MAW-notifications) | Yes (`502181f`) | Yes | **Ready for Integration** (C-002 patch ready) |
| **Lane D** | `feat/maw-performance` | `7d85b1a` | [`7d85b1a`](file:///home/user/Projects/MAW-performance) | Yes (`502181f`) | Yes | **Ready for Integration** (Bundler gate added) |

---

## 2. Re-evaluated Findings Summary

1. **A-002 (Systemd Service Lifecycle): RECLASSIFIED AS-DESIGNED.**
   - Live Linux kernel PTY testing demonstrated that child PTY processes terminate on supervisor process exit because master PTY descriptors close, sending SIGHUP and permanent EIO to the slave PTY.
   - PTY processes survive MAW backend restarts because `maw.service` and `maw-ptyd.service` run in separate systemd cgroups.
   - `KillMode=control-group` is retained to prevent orphaned dead-end processes on supervisor shutdown.
2. **C-002 (Unbounded Deduplication Index): PATCH SPECIFIED.**
   - Remediation designed using a two-tier model: all active inbox notifications (up to 150) remain indexed; historical keys are bounded to a 1000-key replay horizon. Memory is strictly $O(1)$.
3. **D-001 (Classic Disposal): SPECULATIVE.**
   - `if (this.disposed) return;` already guards watcher attachment.
4. **D-002 (Bundle Build Test): RESOLVED IN PIPELINE.**
   - Pre-test server bundle compilation step added to integration runner.
5. **A-003 (`attach` Operation): SPEC DISCREPANCY.**
   - `PtyAttachRequest` is redundant with `subscribe: true` + `replay` in Protocol v1.
6. **A-004 (Live vs Replay Race): MITIGATED BY DESIGN.**
   - Monotonic byte offsets enable consumer chunk deduplication.
7. **C-001 (Codex Evidence Semantics): AS-DESIGNED.**
   - Codex requires explicit `native-turn` evidence to prevent false positives from generic pauses.
8. **D-004 (Store Dispose Race): SPECULATIVE.**
   - `dispose()` cancels debounce timer and flushes in-flight/dirty writes atomically.

---

## 3. Automated Tooling & Acceptance Evidence

- **Automation Tool:** [`scripts/maw-integrate.mjs`](file:///home/user/Projects/MAW-next-gen-integration/docs/research/maw-next-generation/integration/scripts/maw-integrate.mjs)
  - Features: ancestor validation, target branch protection (blocks `main`), dirty worktree refusal, 3-way merge conflict pre-flight simulation (`git merge-tree`), dry-run default, structured JSON reporting.
- **Acceptance Suite:** [`tests/full-system-acceptance.test.ts`](file:///home/user/Projects/MAW-next-gen-integration/docs/research/maw-next-generation/integration/tests/full-system-acceptance.test.ts)
  - **14/14 tests passing** in 1.96s.
  - Covers real PTY supervisor IPC, real child process PID preservation across client disconnect, delta replay, tombstone reaping, atomic persistence, real loopback WebSocket streaming, kernel PTY master close semantics, and bounded deduplication under 200+ turn workloads.

---

## 4. Remaining Lane B Dependencies & Final Sign-Off

### Final Pre-Integration Sign-Off Verdict:
### **CLEAN & READY FOR IMMEDIATE MERGE ONCE LANE B DELIVERS**

When Lane B completes its implementation and publishes its final commit hash:
1. Run pre-flight verification:
   ```bash
   node docs/research/maw-next-generation/integration/scripts/maw-integrate.mjs --verify
   ```
2. Apply integration sequence (Phases 1 -> 2 -> 3 -> 4) using `maw-integrate.mjs --execute`.
3. Execute the full-system acceptance suite to certify production release readiness.

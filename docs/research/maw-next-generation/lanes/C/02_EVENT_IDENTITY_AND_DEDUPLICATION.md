# Lane C: Event Identity & Deduplication Rules

## 1. Overview & Problem

In distributed event-driven systems with polling status adapters (e.g. 700ms PID status pollers), WebSocket transports, and client reconnections, duplicate alerts can occur from:
- Repeated native status events from fast pollers (e.g. 700ms polling while an agent is waiting or finishing)
- Backend restarts while sessions are active
- Frontend reloads and snapshot reconciliations
- Multiple open client windows receiving broadcasts
- Event replay from PTY buffers

Lane C enforces strictly scoped, deterministic event identifiers and idempotent persistence.

---

## 2. Event Identifier Schema

All events and notifications are keyed by stable, monotonically advanced identities:

| Event Type | Key Pattern | Identifier Components |
| :--- | :--- | :--- |
| **CLI Turn Completion** | `cli-turn:<workspaceId>:<tabId>:<taskId>` | `taskId` is provider turn ID (Codex: `<sessionId>:<turnId>`) or per-tab turn sequence (Claude/OpenCode/AGY: `turn-<N>`). |
| **CLI Turn Failure** | `cli-fail:<workspaceId>:<tabId>:<taskId>` | Scoped to the failing task and session. |
| **CLI Awaiting Input** | `cli-input:<workspaceId>:<tabId>:<taskId>` | Generated when agent enters `needs-input`. Deduplicated across status watcher polls. |
| **Shell Command** | `shell-cmd:<workspaceId>:<tabId>:<cmdId>` | Monotonic command sequence counter (`cmd-1`, `cmd-2`). |

---

## 3. Deduplication Architecture

```
Provider Poller (700ms) / Rollout Watcher
               │
               ▼
TabActivityManager.handleCliActivity
               │ (Checks pendingNotifications & notificationStore deduplicationIndex)
               ▼
AgencyNotificationStore.createItem
               │
    ┌──────────┴──────────┐
    ▼                     ▼
Has Key?                New Key?
  │                       │
  ▼                       ▼
Drop Event              1. Insert item & index deduplicationKey
(Return null)           2. Prune oldest read/acknowledged items (> 150)
                        3. Persist atomically with .bak backup
                        4. Emit 'created' & 'changed' broadcasts
```

### Invariants:
1. **Deduplication Index Invariant:**
   `deduplicationIndex` in `AgencyNotificationStore` maps `deduplicationKey -> { id, createdAt }`. Even when old read/acknowledged items are pruned from the visible inbox list to bound memory, the `deduplicationIndex` retains the keys, ensuring replayed events for old turns never re-alert.
2. **Replay Invariant:**
   Replayed terminal chunks or status events matching an already completed turn cannot overwrite the current tab result or revive an acknowledged task.
3. **Optimistic Rollback Invariant:**
   If a client optimistically marks an item Done or Read and the backend rejects or transport fails, the client rolls back the change immediately and reconciles cleanly on subsequent snapshots.

# Lane F focused correction report

Date: 2026-11-05

Worktree: `/home/user/Projects/My-Amazing-Workspace-terminal-history`

Branch: `feat/maw-terminal-history`

Starting HEAD: `97279e25c68eb994ecbee58cfd0c85bcb54669f1` (verified clean).

Original release baseline: `85dd91c745980a9870eb591dc0936b40ce7da86c`.

Implementation revisions are recorded in the delivery section below. This report
supersedes conflicting claims in the earlier implementation report. In particular,
history is a bounded line-oriented archive, and an attached socket is a binding
within MAW's shared authenticated owner account, not an independent user identity.

## Completed corrections

### Retention and data integrity

- Default retention is finite: 64 MiB of indexed segment payload per terminal,
  1,000,000 retained lines, and seven days of segment age. Partial policy overrides
  retain the other defaults. Invalid, fractional, infinite and negative limits
  are rejected. Explicit zero retention limits are supported.
- Segments rotate at 10,000 lines or 1 MiB by default. A single line exceeding
  the segment byte limit is dropped with loss accounting. Quotas can remove the
  final historical segment because the live PTY ring and rendering state are
  independent of these files.
- Pending partial text and queued chunks share a 1 MiB default byte budget.
  Overflow removes the oldest complete UTF-8 code points and records lost bytes.
  Flush requests coalesce during slow disk operations.
- Segment numbering survives pruning and reopening. The filename counter is
  independent of the number of retained segments.
- Flush, reads, export, pruning, disposal and deletion serialize. Disposal and
  deletion stop accepting output immediately. Deletion cannot be undone by a
  previously queued flush or by leftover loss metadata.
- Pruning commits the new index before unlinking retired segments. Failed appends
  roll back file sizes and index state. Uncommitted crash tails are removed before
  a subsequent append, with explicit loss accounting, so they cannot conceal new
  output.
- A store that fails closed drains pending output with loss accounting. It cannot
  spin indefinitely while shutdown waits for a flush.
- Index identity, segment basenames, counters and ranges are validated. Malformed
  indexes fail closed and existing files are preserved. Reads respect committed
  byte ranges and flag missing, truncated or invalid UTF-8 data.
- New history directories and files use owner-only permissions. A writable legacy
  terminal directory is tightened before appending.

### Store lifecycle and shutdown

- Early PTY output and the completion of `terminal.open` share one store instance.
  Opening a terminal no longer replaces a store created by early output.
- Registry removal retires the store exactly once. Ordinary socket disconnection
  does not stop history collection for the persistent terminal identity.
- Socket teardown returns a promise for outstanding store disposals. The normal
  backend shutdown path waits for that promise with its other persistence work.
- Tests inject a temporary history store factory. The authorization fixture also
  isolates ancillary stores through a temporary XDG configuration directory.

### Session authorization and revocation

The user explicitly selected MAW's existing shared-owner model. A second authorized
window or paired device may attach to the same persistent workspace/session.
Authentication does not create a history attachment or authorize an arbitrary UUID.

- Only successful explicit `terminal.attach` creates a history grant. Terminal
  creation and Agency session creation do not grant history access implicitly.
- Attachment checks terminal existence and the owning Agency session/workspace.
  Missing, inactive, stopping, closed, superseded or unresolved managed sessions
  cannot gain a history attachment. Existing WebSocket credential and remote-device
  authorization remain the account boundary.
- Grants are unique leases per socket and attachment. Detach, disconnect, registry
  removal, session/workspace invalidation and device revocation invalidate them.
  Reconnection requires fresh authorization and attachment.
- A page read rechecks both its exact lease and current authorization after disk
  I/O. Detach followed by reattach, permission restoration, close or revocation
  cannot revive a pending request's old grant.
- One page read per terminal per socket may be active at a time. The protocol parser
  validates identifiers, direction and integer bounds: at most 1,000 lines per page
  and a page number no larger than 1,000,000.
- Filesystem exceptions become a stable `History read failed` response rather than
  exposing private paths or exception details to the client.

### Observable loss

- `terminal.history.data` carries optional `droppedBytes` and `incomplete` fields.
  Loss state persists in the index where storage is writable. Read failures mark
  history incomplete without repeatedly inventing a dropped-byte count.
- The drawer displays an explicit incomplete-history warning, known lost bytes,
  retained-history pruning, and request errors. Reset clears all counters.
- Requests use unique IDs and an immediate in-flight guard to prevent duplicate
  requests or stale replies from matching a later load.

## Files changed

| Area | Files |
| --- | --- |
| Storage and quota regressions | `packages/server/src/terminal-history-store.ts`, `terminal-history-retention.test.ts`, `terminal-history-loss.test.ts` |
| Backend lifecycle | `packages/server/src/terminal-socket.ts`, `packages/server/src/index.ts` |
| Authorization and protocol regressions | `packages/server/src/terminal-history-authorization.test.ts`, `terminal-history-protocol.test.ts` |
| Shared wire contract | `packages/shared/src/protocol.ts` |
| Renderer and browser regression | `packages/web/src/TerminalView.tsx`, `useTerminalHistory.ts`, `useTerminalHistory.test.mjs` |
| Documentation | This report and `IMPLEMENTATION_REPORT.md` in this directory |

## Validation

All fixtures used disposable directories and local test servers. No full MAW desktop
installation or production supervisor was started.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass for shared, server and web |
| `pnpm build` | Pass: server production bundle and web production assets |
| Focused server, persistence, recovery, output ordering, history and security tests | 75 passed, zero failed/skipped |
| Store, retention, loss and ANSI subset | 32 passed, included in the 75 |
| `pnpm --filter @agent-workbench/web test` | 53 passed, zero failed/skipped |
| `useTerminalHistory.test.mjs` under sandboxed system Chrome | One browser integration test passed, zero skipped |
| `pnpm --filter @agent-workbench/desktop test` | 31 passed, zero failed/skipped |
| `git diff --check` | Pass |

The server command included these files from `packages/server/src`:

```text
security.test.ts
output-buffer.test.ts
output-backpressure.test.ts
terminal-output-batcher.test.ts
terminal-history-protocol.test.ts
terminal-history-authorization.test.ts
terminal-history-store.test.ts
terminal-history-retention.test.ts
terminal-history-loss.test.ts
terminal-ansi-fidelity.test.ts
agency/persistence-integrity.test.ts
agency/recovery-integration.test.ts
agency/recovery-round2.test.ts
agency/cross-workspace-isolation.test.ts
agency/session-history.test.ts
agency/agency-layout-store.test.ts
```

The authorization integration test uses the real WebSocket handler and temporary
registry. It checks missing credentials, attachment requirements, shared access,
fresh connections, detach/reattach, close during a read, transient permission
revocation, paired-device credential dispatch/revocation, loss metadata and
sanitized errors. Device verification and the revocation trigger are deterministic
fixtures; this does not claim a real remote-device pairing exercise.

The browser fixture checks pagination, cache bounds, reset, errors, and the visible
loss warning. The cached Playwright Chromium could not start its sandbox in this
environment. System Chrome succeeded with `chromiumSandbox: true`; no sandbox was
disabled or production Electron changed. The web suite used the temporary preload
shown below to enforce the same sandboxed system Chrome launch.

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome \
  node --test packages/web/src/useTerminalHistory.test.mjs
NODE_OPTIONS='--import=/tmp/maw-history-sandbox-preload.mjs' \
  pnpm --filter @agent-workbench/web test
```

The temporary preload wraps Playwright's `chromium.launch` with
`executablePath: '/usr/bin/google-chrome'` and `chromiumSandbox: true`.

Logs from this session:

```text
/tmp/maw-history-corrections-typecheck.log
/tmp/maw-history-corrections-build.log
/tmp/maw-history-final-server.log
/tmp/maw-history-store-final.log
/tmp/maw-history-web-suite.log
/tmp/maw-history-web-system-chrome.log
/tmp/maw-history-desktop-unit.log
```

These logs are local session artifacts, not packaged release files. Fault-injection
tests intentionally log write/read failures in temporary paths. Vite's existing
large-chunk advisory remains. No unresolved failure occurred in the final checks
listed above; the entire server/supervisor acceptance suite was not run.

Synapse initialization and an exact context/read hit were verified for this
worktree. No approved development test profiles were available, so edits and
runtime validation used normal filesystem tools and the explicit commands above.
No Synapse source write, provider enrichment or export was enabled.

## Production safety

Read-only inspection found both `maw.service` and `maw-ptyd.service` loaded but
inactive/dead with `MainPID=0` and no control group. No Electron process was present.
No production stop was necessary or performed. Existing Codex, Claude and unrelated
Node processes were left alone. The only terminated processes were this session's
identified disposable browser test processes after an initial sandbox launch failed
before fixture cleanup was registered; fixture cleanup is now registered earlier.

No production installation, workspace persistence, browser profile, supervisor
state or service configuration was modified. There was no push, merge, rebase,
installation, deployment or source edit in another worktree during these corrections.

## Limits and integration handoff

- Quotas bound indexed segment payload per terminal, with additional index and
  atomic-write overhead. There is no global disk budget or automatic scavenger
  across indefinitely many retired terminal directories. Age pruning runs on
  writes, reads and explicit pruning, rather than a background sweep.
- This remains a line-oriented archive, not a byte-for-byte terminal journal or a
  full TUI checkpoint. It can force partial text into archive lines. Keep Lane D's
  ordered live rendering, UTF-8 offsets and checkpoint recovery independent.
- An abrupt process or machine failure can lose unflushed output. Atomic rename
  alone is not an fsync durability guarantee. Loss cannot always be detected after
  a crash, especially while the filesystem cannot persist loss metadata.
- Output produced while the backend is disconnected from a persistent supervisor
  is not proven to be completely archived. No supervisor restart or production-like
  lifecycle acceptance was attempted here.
- Real Electron focus, OS IME routing, native clipboard and native browser-view
  handoff remain unverified in this lane. The history browser fixture proves only
  its isolated renderer behavior.
- Keep all Lane C input checks and per-socket input grants when reconciling
  `terminal-socket.ts`. Lane D makes replay asynchronous: preserve the exact
  attachment lease across any await and never recreate a revoked grant on replay
  completion. History authorization is separate from output backpressure.
- Reconcile `TerminalView.tsx` by retaining Lane B clipboard shortcuts, Lane C focus
  and IME gates, Lane D ordered replay/rendering and scrollbar fixes, and this lane's
  history drawer and loss feedback. Do not replace handlers from either baseline.
- Preserve Lane A's administrative endpoint and its authorization while adding the
  awaited history teardown in `index.ts`. Shared protocol changes are additive.
- The coordinator must integrate the final Lane F HEAD supplied with this report,
  resolve cross-lane conflicts, and rerun combined tests. This branch did not absorb
  the unstable integration branch or any other lane.

## Delivery revisions

- `f939bcb60d90160651f95f170470c7a7fcb79775`: bounded retention and serialized
  persistent store operations, including the new fault and lifecycle regressions.
- `1f339a7b481a2bf12173c73d61edd583f8a74c4e`: explicit attachment leases, awaited
  teardown, validated protocol and visible incomplete-history reporting.

Corrected implementation HEAD: `1f339a7b481a2bf12173c73d61edd583f8a74c4e`.
The final documentation-only descendant is supplied as the full final HEAD in the
handoff response. This report does not claim to contain its own commit hash.

No confirmed correctness finding remained open after the focused independent
review and the final tests. The explicit limits above remain integration and
release-validation considerations, rather than claims of complete production
acceptance.

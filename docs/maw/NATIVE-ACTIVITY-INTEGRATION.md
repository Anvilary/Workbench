# Native activity integration evidence

Audit and fixture validation: 2026-10-28. No authenticated CLI was launched,
no native credentials were read, and no live services were changed.

## Reliable completion contract

`TabActivityManager.handleCliActivity` accepts successful completion only from
explicit `completionEvidence`. A `native-turn` event must include its stable
native task ID and `nextActivity: 'finished'`. A `status-transition` must be
explicitly scoped to the correct provider identity and follow known work.
Ordinary idle, offline, stream pauses, terminal repaint, and process exit zero
are not native turn completion signals.

`AgencySessionRuntime` emits `nativeTurn` with `{sessionId, workspaceId,
provider, taskId, phase}`. The socket integration resolves that exact runtime,
checks that its workspace/tab is active and open, and forwards the explicit
evidence to the manager. The native watcher runs independently of conversation
view subscriptions.

Results remain finished until inspection acknowledgement. Replayed completed
native turns cannot replace a newer result or revive acknowledged results.
Closed-tab tombstones reject delayed events. Shell command sequence counters
survive restart, and `ensureTab` durably registers unknown activity without
discarding finished results.

Verified activity and its notification receipt are persisted atomically in the
activity file. The additive `pendingNotifications` array is compatible with
existing version 1 files that have no receipts. Native and shell state mutations
are serialized. Only committed activity is exposed to snapshots and broadcasts.
The notification store's stable deduplication key makes retry safe if the server
stops after creating the notification but before removing its receipt.
Acknowledging a result retains pending delivery. Closing a tab removes its
receipts atomically; a startup/current-tab predicate suppresses deleted tabs.
`flushPendingNotifications` retries after tab reconciliation and periodically.
Recoverable delivery errors retain receipts and log deferred delivery without
rejecting startup; corrupt persistence still fails initialization closed.

## Provider evidence and limits

| Provider | Evidence available | Integration behavior |
| --- | --- | --- |
| Codex | Native rollout `event_msg/task_started` and `task_complete`, with `turn_id`; `turn_started` and `turn_complete` are accepted aliases. Completion can carry `error`. | `CodexTurnWatcher` reads only the attested profile home's active `sessions` rollout for the exact native session. Matching session metadata and cwd, timestamps after this PTY launch, and a matching live start are required. Errors fail; `turn_aborted` becomes unknown. No text or silence inference. |
| Claude Code | Existing upstream `CliStatusWatcher` observes session PID state files; official `Stop` and `StopFailure` hooks distinguish a finished response from API failure. `Stop` does not run on user interrupt and other stop hooks can continue work. | Named Agency accounts deliberately remain unknown: `TerminalRegistry.watchActivity` rejects the global watcher for Agency-managed Claude. The watcher still reads the server user's global `.claude/sessions`, so enabling it for an isolated profile would misattribute evidence. No profile-scoped hook collector is configured here. |
| Antigravity | Official statusline JSON documents `conversation_id`, `agent_state`, and `tool_confirmation_pending`; configured native statusline can report idle/working/error. | Named Agency accounts remain unknown. The baseline configured watcher is global and is deliberately bypassed by the registry for managed profiles. No scoped verified completion bridge is enabled. |
| OpenCode | Official plugin events include `session.status`, `session.idle`, and `session.error`; upstream `OpenCodeServeStatus` already consumes the server SSE stream with reconnect snapshots. | Existing upstream status support remains. Agency native profile launch validation currently supports Codex/Claude/Antigravity, so the allowlist alone does not make OpenCode an Agency launch/completion integration. Reconnect idle snapshots must not create a new task completion. |

Codex also officially supports the `notify` callback, with `thread-id` and
`turn-id`, and App Server `turn/completed` with completed/interrupted/failed
statuses. Those are separate transports; this integration does not start an App
Server, change user configuration, or install a notify hook.

The rollout reader is intentionally conservative: absent/unrecognized events,
compressed-only histories, mismatched metadata, missing IDs, or tasks without a
live matching start cannot prove success. A supported file schema does not
prove that every installed CLI version emits it. Real authenticated account
behavior has not been exercised in this integration session.

## Shell integration

`TerminalRegistry.spawn` prepares hooks only for managed Bash/Zsh POSIX shells.
Unsupported shell types or startup arguments remain without completion proof.
Generated Bash startup sources the user's `.bashrc` before the integration;
Zsh uses an app-owned startup directory and sources the existing user startup
files. No user startup file is rewritten. Existing Bash `PROMPT_COMMAND` arrays
and Zsh hooks are preserved.

`ShellIntegrationParser` requires OSC 133 C before D, and a strictly numeric,
safe-integer exit status. Startup D, repeated D, empty status, malformed status,
and output silence cannot produce a successful completion. Exit zero finishes;
nonzero fails, and subsequent prompt markers preserve the result. The socket
feeds the initial registry replay once so startup sequences emitted before
listener attachment are observed.

## Validation

`pnpm --filter @agent-workbench/server exec tsx --test
src/agency/runtime/agency-session-runtime.test.ts src/agency/notifications.test.ts
src/agency/activity-integration.test.ts src/agency/notification-outbox.test.ts`
passed 55 tests at implementation time.

The added tests cover actual disposable Bash and Zsh PTYs created through the
Agency runtime; config preservation; zero and nonzero exits; no startup alert;
durable shell IDs and acknowledgements; close tombstones; native replay and
history rejection; errors and aborts; a live Codex rollout fixture through the
runtime with no conversation subscriber; and notification write-failure retry.
Outbox fault injection covers interruption before notification creation,
interruption after creation, restart deduplication, acknowledgement before
delivery, closed/deleted targets, and activity persistence failure without a
verified broadcast.
The PTY integration directory, shell homes, native rollouts, and persisted state
are disposable fixtures. Real provider authentication and live systemd
deployment were not part of this validation.

## Official sources

- [Codex native protocol source](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs): `TurnStartedEvent`, `TurnCompleteEvent`, `TurnAbortedEvent`, and task/turn wire aliases.
- [Codex notifications configuration](https://developers.openai.com/codex/config-advanced/#notifications): documented external completion callback and stable identifiers.
- [Codex App Server](https://developers.openai.com/codex/app-server/): explicit turn lifecycle/status notifications.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks#stop): `Stop`, `StopFailure`, and continuation behavior.
- [Antigravity CLI statusline](https://antigravity.google/docs/cli/statusline): documented identity/state payload.
- [OpenCode plugin events](https://opencode.ai/docs/plugins/#events): session events and completion notification example.

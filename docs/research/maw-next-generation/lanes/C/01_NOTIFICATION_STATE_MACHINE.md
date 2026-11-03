# Lane C: Notification State Machine & Lifecycle Semantics

## 1. Overview & Objective

The mission of Lane C is to make coding-agent completion notifications reliable, useful, and quiet.
This document establishes the formal semantics, evidence gates, and state transition invariants of the unified 5-state lifecycle across CLI, shell terminal, and browser web sessions.

---

## 2. Core State Definitions

| State | Semantic Meaning | Evidence Required | Never Inferred From |
| :--- | :--- | :--- | :--- |
| `working` | Agent actively executing a prompt, task, tool execution, or interactive shell command. | Explicit native provider busy signal (Claude Code `status === 'busy'`; Codex `task_started` / `turn_started`; OpenCode busy stream; Antigravity configured `agent_state != 'idle'`) or Shell OSC 133 `C`. | Output stream data volume, PTY write rate, or initial session spawn. |
| `needs-input` | Session is blocked awaiting user authorization, tool permission, question response, or confirmation. | Native waiting state: Claude `status === 'waiting'` with `waitingFor: 'permission prompt' \| 'input needed' \| ...`; Antigravity `tool_confirmation_pending: true`; OpenCode interactive question stream. | Escape code parsing on terminal screen text, terminal output silence, or arbitrary pause heuristics. |
| `finished` | Turn or task completed successfully. | Provider-native completion evidence: Claude Code / OpenCode / Antigravity observed `working -> idle` transition with `status-transition` evidence; Codex `task_complete` / `turn_complete` without error; Shell OSC 133 `D;0` sequence. | Process exit code 0 alone, terminal output silence, or elapsed time. |
| `failed` | Turn ended with an explicit error, exception, or non-zero exit code. | Native turn error (Codex `turn_complete` with `error`), process exit code $\neq 0$, or Shell OSC 133 `D;<code != 0>`. | Arbitrary stderr output text (compilers/linters often emit to stderr without failing). |
| `interrupted` / `unknown` | Execution stopped by user cancellation (`stopping`, Ctrl+C), aborted turn, unverified provider, lost evidence, or server restart mid-turn. | Native abort marker (Codex `turn_aborted`), session lifecycle `stopping`, watcher disconnection, or unverified provider without completion hooks. | Speculated success or guessed failure. Missing evidence strictly transitions to `unknown` with `reliableSignal: false`. |
| `idle` | Session is ready and awaiting user input or next task. | Native idle status with no pending turn, or shell prompt sequence OSC 133 `A`. | Output silence. |

---

## 3. Invariants & Lifecycle Rules

1. **Process Lifetime vs. Individual Turn:**
   An agent CLI process (e.g. `claude`, `codex`, `opencode`) is long-lived and remains running in a PTY across many turns. An idle prompt is NOT process termination. Completions are scoped to individual turns (`turnSequence`, `taskId`), not PTY exit.
2. **Persistence of `finished`:**
   Once entering `finished`, the session tab displays a persistent green completion badge until the user actively navigates to and inspects that tab. Merely reading an inbox item does NOT dismiss the tab completion badge.
3. **Shell Terminal Silence:**
   Ordinary interactive shell commands (e.g. `ls`, `git status`, `echo`, `cd`, and ordinary failed shell commands) transition the terminal tab to `idle` upon completion and generate ZERO outbox notifications, toasts, or OS desktop alerts.
4. **Restart Recovery:**
   - Uninspected `finished` turns remain `finished` after server restart.
   - In-flight `working` tasks become `unknown` on restart rather than falsely `finished`.
   - Highest recorded `turnSequence` is restored from disk, preventing turn ID reuse across restarts.
   - Closed or deleted tabs are marked closed and never generate stale alerts.

# Resource monitor

The desktop resource monitor attributes CPU, memory and GPU use to terminals, browser views and Workbench processes, and feeds the [budget policy](budget-policy.md). Source: `packages/desktop/src/performance/resource-monitor.mjs`.

## Architecture

The Workbench Native Resource Performance Monitor is an integrated, low-overhead diagnostic subsystem designed to inspect and attribute resource consumption across the entire Anvilary Workbench application stack on Linux.

The architecture follows a strict separation of concerns across three primary execution layers:

```
+-------------------------------------------------------------------------------+
| Workbench Frontend UI (React 18 + Vite)                                            |
|                                                                               |
| - PerformancePanel.tsx: Overlay panel accessible via top-right application     |
|   menu or Alt+P shortcut.                                                     |
| - PerformanceSparkline.tsx: Zero-dependency SVG sparkline renderer (60s       |
|   in-memory ring buffer).                                                     |
| - Shared allocation estimation labels: Values for shared renderers are        |
|   explicitly tagged with ~ and informative tooltips.                          |
| - Internationalization: 43 keys translated across all 9 supported locales    |
|   (en, es, de, fr, pt-BR, ru, ja, ko, zh-CN).                                 |
+-------------------------------------------------------------------------------+
                                      |
                         workbench:chatgpt Desktop IPC Bridge
                         (Command / State Push via Preload)
                                      v
+-------------------------------------------------------------------------------+
| Electron Desktop Host (Node.js + Electron 45.2.0)                             |
|                                                                               |
| - resource-monitor.mjs: Linux /proc collector managing sampling lifecycle.    |
| - Policy-gated IPC: performance-subscribe, performance-pause,                |
|   performance-resume, performance-refresh, performance-unsubscribe.           |
| - Process Tree Scanner: Traverses /proc/[pid]/stat, /proc/[pid]/smaps_rollup,  |
|   /proc/[pid]/cmdline, and /proc/[pid]/exe.                                   |
| - Electron Metrics Adapter: Reads app.getAppMetrics() for GPU, Utility,       |
|   and Renderer processes.                                                     |
| - Browser Tab Mapping: Correlates WebContentsViews with renderer PIDs,        |
|   detecting and apportioning shared Chromium renderer processes.              |
+-------------------------------------------------------------------------------+
                                      |
                         Loopback HTTP (/api/performance/terminals)
                         (127.0.0.1 / ::1 strict check, session token auth)
                                      v
+-------------------------------------------------------------------------------+
| Workbench Server & PTY Supervisor (Node.js + pty-host)                              |
|                                                                               |
| - TerminalRegistry: Tracks active terminal sessions, root PTY child PIDs,    |
|   and supervisor daemon state.                                                |
| - Performance Administrative Endpoint: Enforces session-level authentication, |
|   rejecting unauthenticated requests (401) and paired devices (403).          |
| - Metadata Sanitization: Exposes only terminalId, title, kind, pid, and       |
|   provider. Strips environment variables, command arguments, and buffers.    |
+-------------------------------------------------------------------------------+
```

Key Architectural Principles:
- On-Demand Execution: The performance sampling timer (2-second interval) runs exclusively while the Performance panel is open and visible. When the panel is closed, the collector unsubscribes, stops all timers, and consumes zero background CPU cycles.
- Single Shared Collector: Multiple components or view events share a single reference-counted collector instance. Duplicate polling loops per terminal or browser pane are prohibited.
- Zero External Process Executions: The collector never spawns subprocesses such as `ps`, `top`, or `nvidia-smi` in the sampling path. All metrics are gathered via direct synchronous filesystem reads of kernel `/proc` interfaces (`smaps_rollup` and `stat`), guaranteeing sub-20ms collection latency.
- Strict Security Isolation: Remote paired devices and non-loopback requests are unconditionally rejected. Process command-line scanning sanitizes potential credentials and avoids exposing environment variables.

---

## Process Ownership Model

Every process discovered during collection is attributed according to an unambiguous single-ownership hierarchy. No process can ever belong to more than one accounting bucket.

The hierarchy is evaluated in strict order:

1. AI Coding Agent Subtrees (Highest Precedence):
   - Any process tree rooted at a Workbench terminal shell that contains an identified AI coding agent binary (Codex CLI, Claude Code, Gemini CLI, OpenCode, Antigravity CLI) is attributed entirely to that agent group.
   - All child processes, language servers, tool runners, and compilers spawned by the agent are claimed by the agent instance.

2. Plain Terminal Subtrees:
   - Terminal processes and their descendant processes that do not contain an active coding agent are attributed to "Other Terminals".

3. Embedded Browser Views:
   - Renderer processes hosting `WebContentsView` instances are attributed to "Embedded Browser Views".
   - If multiple browser tabs share a single Chromium renderer process, the process is accounted once, and its CPU and PSS memory are apportioned proportionally among the sharing tabs as marked estimates.

4. Workbench Infrastructure:
   - Electron Main process.
   - Workbench UI Window Renderer process.
   - Electron GPU process.
   - Electron Utility processes (NetworkService, StorageService).
   - Workbench Node.js backend server.
   - Workbench PTY supervisor (`workbench-ptyd` or standalone daemon).

5. Unattributed Bucket (Lowest Precedence):
   - Any process that cannot be verified as belonging to Workbench is ignored. Unrelated system processes are never attributed to Workbench.

A global `claimedPids` set is maintained throughout every sampling tick. Once a PID is added to `claimedPids`, subsequent group traversals skip that PID. This prevents double-counting across the entire application.

## Resource Accounting Methodology

### Memory: Proportional Set Size (PSS)
Summing Resident Set Size (RSS) across multiple Electron and Chromium processes leads to severe double-counting because shared code libraries, V8 snapshots, and mapped fonts are reported in full by each process.

To reflect true physical memory consumption:
- The collector reads `/proc/[pid]/smaps_rollup`.
- Proportional Set Size (`Pss:`) is extracted along with `Rss:`, `Private_Clean:`, `Private_Dirty:`, `Shared_Clean:`, and `Shared_Dirty:`.
- PSS divides the cost of shared pages proportionally among all processes mapping them.
- If `/proc/[pid]/smaps_rollup` is unavailable or permission-denied, the collector falls back to `/proc/[pid]/status` (`VmRSS`) while flagging the metric as estimated.

### CPU: High-Resolution Sampled Deltas
CPU utilization is computed by comparing tick deltas across sampling intervals:
- The collector reads `utime` (user ticks) and `stime` (kernel ticks) from `/proc/[pid]/stat`.
- Monotonic timestamps are recorded using `process.hrtime.bigint()` to eliminate clock jitter.
- Elapsed time between consecutive samples is calculated precisely:
  `elapsedSeconds = Number(timeNowNs - timePrevNs) / 1e9`
- CPU core usage:
  `cpuCorePercent = (deltaTicks / (CLK_TCK * elapsedSeconds)) * 100`
- Normalized total system capacity:
  `cpuPercent = cpuCorePercent / numCores`
- PID reuse protection: The collector compares `starttime` from field 22 of `/proc/[pid]/stat`. If the process creation timestamp changes between samples for the same PID, the collector invalidates the previous baseline and reports 0% for the first sample, preventing artificial spikes.

### GPU: Telemetry and VRAM Isolation
- Electron GPU process memory (PSS and RSS) is gathered from the process tree and `app.getAppMetrics()`.
- Dedicated GPU hardware engine load and physical VRAM usage are checked. Because querying hardware drivers (NVIDIA NVML, Intel GPU Top, AMD ROCm) directly introduces external tool dependencies and significant latency, dedicated hardware load is set to `null` with an explicit status note:
  "Hardware VRAM & GPU engine telemetry unavailable without external driver polling".
- GPU-process host RAM is never misrepresented as dedicated video memory.

---

## Provider Classification Rules

Coding agents running inside Workbench terminals are classified dynamically based on actual process inspection, never by terminal window titles or screen text buffers.

A terminal initially opened with a standard shell (e.g., `zsh` or `bash`) transitions to the corresponding AI Provider as soon as the user or runner executes an agent binary. When the agent terminates, the terminal reverts to a plain terminal.

Detection rules inspect `/proc/[pid]/exe`, `/proc/[pid]/comm`, and `/proc/[pid]/cmdline`:

1. Codex CLI:
   - Executable path or basename matches `codex` or `codex-cli`.
   - Command-line arguments contain `codex exec` or `codex run`.

2. Claude Code:
   - Executable path or basename matches `claude` or `claude-code`.
   - Node process script arguments contain `@anthropic-ai/claude-code`.

3. Gemini CLI:
   - Executable path matches `gemini` or `gemini-cli`.
   - Node process script arguments contain `@google/gemini-cli`.

4. OpenCode:
   - Executable path or script matches `opencode` or `open-code`.

5. Antigravity CLI:
   - Executable path or symlink resolves to `agy` or `antigravity`.

6. Pi Coding Agent:
   - Executable path or script matches `pi-coding-agent` or `@mariozechner/pi-coding-agent`.

Command-line Inspection Safety:
Arguments are parsed to identify the binary entry point only. Sensitive parameters such as `--api-key`, `--token`, authorization headers, and environment blocks are stripped and never exposed in IPC payloads or logs.

---

## Browser Attribution Methodology

Workbench hosts embedded browser views for services such as ChatGPT and Perplexity using Electron `WebContentsView`.

### Lifecycle States
Each browser view is classified into one of three states:
- Active: Currently visible and attached to the main window (`win.contentView.children`).
- Background: Retained in memory but detached or covered by another tab.
- Hibernated / Suspended: WebContents destroyed to conserve RAM under memory pressure; state preserved in memory for instant restoration upon reactivation.

### Shared Chromium Renderer Accounting & Estimation Labeling
Chromium often runs multiple web tabs in the same renderer process when they share an origin, session partition, or process allocation limit:
- The collector queries `webContents.getOSProcessId()` for each view.
- When $N$ tabs share renderer PID $P$, that process is measured once. Its PSS and CPU are apportioned proportionally among the $N$ sharing tabs (`pssBytes / N`, `cpuPercent / N`).
- Individual tab metrics are explicitly flagged with `isSharedRenderer: true` and labeled in the UI with a `~` prefix (e.g., `~12.4 MiB`, `~0.5%`) to denote an estimated shared allocation.
- A descriptive tooltip informs the user: "Shares renderer process PID P among N tabs (estimated allocation)".
- A notice hint below the browser views table clarifies: "Values marked with ~ are shared allocations (estimates). Chromium does not expose per-tab metrics for shared renderers; aggregate usage is counted once."
- In the global overview and group totals, renderer process $P$ is counted **exactly once**, guaranteeing zero aggregate double-counting.

---

## Security Verification & Access Control

An inspection of the administrative endpoint `GET /api/performance/terminals` identified and resolved access-control considerations:

1. Loopback Address Binding:
   - The endpoint strictly verifies `request.socket.remoteAddress` matches `127.0.0.1`, `::1`, or IPv4-mapped loopback `::ffff:127.0.0.1`. Non-loopback requests receive 403 Forbidden.
2. Mandatory Local Session Authentication:
   - Loopback access alone is not considered sufficient authorization.
   - The endpoint now verifies `(request as any).mawCredential`. Requests without a valid session credential (`kind === 'session'` or `kind === 'local'`) are rejected with 401 Unauthorized.
   - Paired remote devices (`kind === 'device'`) are explicitly rejected with 403 Forbidden, preventing remote paired clients from discovering host processes.
3. DNS Rebinding & Cross-Origin Protection:
   - `createAuthMiddleware` enforces `hasValidHost(request, port)` and `hasValidOrigin(request, port)`. Malicious browser pages on other origins attempting to fetch the endpoint receive 403.
4. Process Metadata Sanitization:
   - The endpoint returns only `terminalId`, `title`, `kind`, `agent`, `pid`, `cwd`, and `provider`.
   - Raw command arguments (`argv`), environment blocks (`env`), credentials, tokens, and terminal screen output buffers are strictly excluded from the response payload.
5. Scope Containment:
   - The endpoint is not a general process-inspection API. It enumerates only terminals registered within Workbench's own `TerminalRegistry`.

---

## Known Attribution Limitations & Remaining Risks

1. Chromium Shared Renderer Processes:
   - Multiple tabs hosted under identical origins or partitions share a single Chromium renderer process. Per-tab values are proportionally apportioned estimates marked with `~`. Aggregate usage is counted once.
2. Direct Dedicated GPU Telemetry:
   - Dedicated VRAM and GPU 3D engine utilization require third-party driver binaries or elevated privileges (e.g., NVML, sysfs GPU top). Dedicated VRAM is explicitly designated as unavailable to avoid heavy polling utilities.
3. Transient Short-Lived Commands:
   - Subprocesses that execute and terminate within a single 2-second sampling interval (e.g., `git status` or `ls`) will not be recorded in that sample's point-in-time snapshot.
4. Restricted Container Sandboxes:
   - In containerized environments with strict AppArmor user namespace restrictions, certain deeper process mappings may fall back to `/proc/[pid]/status` RSS estimations if `smaps_rollup` read permissions are restricted.

---

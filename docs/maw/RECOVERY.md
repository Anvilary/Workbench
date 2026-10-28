# Native recovery

## Implemented policy and boundaries

The startup controller runs only on backend startup. Browser reconnect, page reload, workspace navigation and tab changes attach existing terminal IDs and never invoke recovery. A Linux abstract socket keyed by canonical store path provides one kernel-owned server reservation, automatically released after process exit/crash/reboot. Non-Linux single-owner enforcement is outside this Ubuntu implementation.

Startup reconciles orphaned starting/running sessions to exited with unknown exit status and durable pending recovery. Stopping sessions are excluded. Stale resuming attempts reconcile on the next startup. Recovery is single-flight and sequential, with atomic workspace slot and native conversation claims. Only Active workspaces in active projects qualify. Directory realpath/protected-home safety is checked again before launch. Done, Archived, archived projects, exited/failed sessions and deliberate Stop do not auto-launch. No new empty workspaces launch at boot.

Intentional Stop persists stopping/stoppedByUser before closing the registry terminal. Server shutdown detaches runtime exit listeners before registry disposal, preserving running intent for replacement PTYs at next startup. Ordinary native exits persist exited and do not recover. A process killed independently while the server cannot persist the exit remains inherently indistinguishable from an interrupted server; recovery then uses the last durable state.

## Provider matrix

| Provider/profile | Startup recovery | Validation |
| --- | --- | --- |
| codex-0, codex-1, codex-3 | Conditional native `resume` | Existing trusted host identity manifest must match exact profile executable, args, overrides and canonical home; native ID must exist under that verified home's sessions/archived_sessions; cross-home/unknown/opaque identities refuse before PTY spawn. Prior runtime native identity must match. Existing dual-home isolation is preserved. |
| agy-0–agy-5 | BLOCKED — manual resume required | Native adapter has `--conversation`, but named account/home/session ownership is not attested by the current manifest. It is unsafe to treat flag support as verified identity. No automatic launch or cross-account fallback. |
| claude-code → claude | BLOCKED — manual resume required | Native adapter has `--resume`; account/home and historical session ownership validation are absent in the current manifest. No automatic launch. |

No native authenticated provider was invoked to consume inference. Tests use fake CLIs and disposable homes. No new provider conversation or model prompt is sent during recovery. A provider authentication status is never inferred from executable availability.

Failures persist a manual-resume explanation and preserve the original native reference. There is no automatic retry loop. The UI offers native resume only when the original profile advertises verified safe resume; Start new CLI session is a separate explicit action. A retry of a failed native resume retains resume intent. Provider-specific automatic recovery is NOT declared implemented for AGY or Claude. Completing that work requires a verified ownership format and negative isolation tests for each named account; this is a correctness blocker, not an activation toggle.

## Concurrency and history

Recovery launches are sequential. AGY and Claude are never auto-launched, so recovery adds zero processes to their existing workflows. No trustworthy external concurrency coordinator was established: several external AGY processes already existed during inventory. MAW cannot guarantee a laptop-wide four-process limit for other launchers. Do not enable unverified AGY recovery until coordination and identity validation are resolved.

Durable data: atomic project/workspace archive/directory records, named profile configurations, session/native identity and ID references, recovery status, user stop intent. Selected CLI/Terminal/split view, selected workspace, sidebar state/width and split ratio use existing localStorage conventions and survive browser restart on the same browser profile. Native history lives with the original provider. PTY scrollback belongs to the previous server process and is not promised across reboot. New PTYs are replacement processes, never the original process restored.

## Remaining validation

A real reboot and real-account manual smoke remain manual and were not performed. Comprehensive crash timing/fault injection, laptop-wide controller detection, all-provider automatic recovery, and genuine authentication classification remain outstanding. Do not activate with an expectation of complete all-provider recovery.

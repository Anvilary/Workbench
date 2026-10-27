# Lane C integration contract

Base: `a784b0b3e176f06911a016d093f1a118f2072bca`. Lane C branch: `feat/agency-runtime`.

## Lane B launch handoff

The integration owner injects an `AgencyProfileLaunchProvider` whose `resolveLaunch(input)` calls Lane B's
`buildAgencyProfileLaunch(profileStore, agentRegistry, input)` exactly once. Lane B returns
`ValidatedProfileLaunch`. Lane C's `ValidatedNativeLaunch` is structurally compatible with it:

- Input: `{profileId, cwd, resumeNativeSessionId, proposedSessionId, launchToken, model?, effort?}`
- Result: `{profileId, provider, file, args, cwd, env, session, launchToken, proposedSessionId}`
- Lane B currently returns `session: LaunchSession` but does **not** echo the two correlation values.
  The adapter should add `launchToken: input.launchToken` and `proposedSessionId: input.proposedSessionId`
  in the integration owner's thin wrapper, not by modifying Lane B PR #2.
- Do not call `adapter.launch()` in the wrapper or in TerminalRegistry again. Lane B already called it,
  and the resulting `LaunchSession` plus file/args/env is the complete prepared launch.
- The same generated `launchToken` is passed to Lane B adapter.launch and subsequently
  to the same native adapter.onSpawned. This is essential for Antigravity log path discovery.
- `session.kind === 'known'` means use `session.sessionId` for the Workbench descriptor and Agency
  metadata. On explicit resume this MUST equal `resumeNativeSessionId`. Never manufacture a native ID
  for a `discover` launch. The descriptor remains `sessionId: ''` until `reportSessionId`.
- Explicit named profile executable and environment override native adapters' legacy installed-binary
  locator **only at spawn**; original adapter.onSpawned/exit/input/submit hooks remain connected.

### Recommended integration wrapper

```ts
const profiles: AgencyProfileLaunchProvider = {
  async resolveLaunch(input) {
    const plan = await buildAgencyProfileLaunch(profileStore, agents, input);
    return {
      ...plan,
      launchToken: input.launchToken,
      proposedSessionId: input.proposedSessionId,
    };
  },
};
```

The returned profile ID must equal the requested ID. Never fall back to another named account.
Do not pass `model`/`effort` keys with undefined values: Lane B rejects the presence of unverified
model/effort options. The runtime omits them unless requested.

## Lane A delete-vs-launch serialization

`AgencyWorkspaceSource.withSessionReservation(id, callback)` is **required**, not optional.
Its implementation and Lane A's guarded deletion must use the **same per-workspace mutex**:

1. Acquire the workspace key lock.
2. Read Lane A's persisted workspace row, including status and server-canonical cwd.
3. Invoke the provided async callback **under the lock**. The callback validates row/status/path,
   checks active slots, synchronously inserts a new Agency session, and awaits durable persistence
   of its `starting` state.
4. Release the lock only after that persistence succeeds or the callback fails.
5. Deletion also acquires the same lock, checks the row and
   `runtime.hasWorkspaceReferences(id)` under it, then commits deletion or fails.
6. When runtime store load/initialize has failed, deletion MUST fail closed.
   Never allow deletion based on an uninitialized/unknown session registry.

After a launch reservation is durably persisted, asynchronous profile validation and PTY creation
do not require the workspace lock. Deletion is blocked by the persisted session reference.
A Done operation updates navigation only and never closes a live process.

The final integration owner must supply this gate alongside Lane A's metadata store. No Lane A
changes were made on Lane C's branch. A mutex solely inside Lane C is insufficient.

## Transport and lifecycle

Create once after Workbench TerminalRegistry setup, call `await runtime.initialize()` before exposing
any Agency messages. Existing socket `/ws` handles validated `agency.session.create`,
`agency.sessions.list`, `agency.session.selection.set` and Agency replies, and reuses upstream
`terminal.attach`, `terminal.detach`, `input`, `resize`, `terminal.close`. There is no
additional WebSocket or HTTP listener. Never issue `terminal.open` on reattach.

On creation, return the Agency record's `terminalId`. Reattach via `runtime.liveTerminal(sessionId)`.
Call `runtime.stop(sessionId)` for explicit Stop; browser disconnect only detaches socket listeners.
Exit and native discovery use registry events; the launch callback also synchronously claims IDs
reported before `open()` resolves and the runtime reconciles the final registry descriptor.
Emit `agency.session.changed` and `agency.session.activity` only after the store has committed.

### Ownership of native conversations

The runtime reserves `provider:nativeSessionId`, not `profileId:nativeSessionId`, once the
provider is known, and TerminalRegistry also blocks duplicate live descriptors. Two different named
profiles must never control one provider-native conversation. Discovery collisions close the losing
PTY. Native resumes retain the original ID. Native process exit releases the ownership claim.

## Verification prerequisites

From a full clone with dependencies:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --dir packages/server exec tsx --test src/agency/runtime/agency-session-runtime.test.ts
corepack pnpm typecheck
corepack pnpm check
corepack pnpm build
```

Ubuntu PTY acceptance must test two directories, `pwd`, `stty size`, interactive shell output,
Ctrl+C, bracketed paste, socket disconnect and reattach to identical terminalId/PID, Stop and
terminal exit codes. No paid model inference or real account mutations.

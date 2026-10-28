IN_PROGRESS

# Security

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: major audit phases remain incomplete; conclusions are limited to the evidence documented below and in 00-STATUS.md.  
Last completed step: initialized and pushed audit checkpoints; most recent completed investigation is FUNC-001 browser reproduction (checkpoint 00j).


## SEC-001 — profile-scoped Codex discovery/history mismatch (source-confirmed; full impact not yet reproduced)

Profile launch permits a configured executable wrapper (`agency-profile-capabilities.ts:159-185`); allowlisted profile env overrides do not include CODEX_HOME (`agents/profiles/definition.ts:44-68`). A wrapper can change its child environment after spawn, which the server cannot infer from the launch plan. `agents/codex/paths.ts:82-104` uses `process.env.CODEX_HOME` or the server user's default. The shared adapter discovery defaults to this root (`agents/codex/discovery.ts:175-179,316-325`); `history.ts:110-113` and `find-rollout.ts:150-154` similarly use it. Thus a profile writing to another home is not discovered/read from that home. Discovery may assign a separate matching server-home rollout using cwd/timing, with no account field in matching (`discovery.ts:108-140,343-368`). That could attach other account history to this workspace; verify via synthetic fixtures before calling disclosure confirmed. Resume and ownership consequences require independent testing. No real account data has been accessed. See findings register for remediation and test.

### Independent synthetic reproduction, 2026-10-27

PASS: with server CODEX_HOME A and a pending terminal representing profile B, writing a valid B rollout yields no discovery; writing an unrelated matching A rollout causes discovery to report A's ID for B. This executes real `CodexSessionDiscovery`, not real PTYs, server event persistence, UI transcript, wrappers or paid inference. Conditions include matching cwd and eligible timestamps. The installed `codex-0`, `codex-1`, `codex-3` entrypoint files each contain a literal CODEX_HOME reference; exact effective values and actual launch were not inspected, so this is not proof of current wrapper configuration. No real history or auth file was read. To reproduce, save the following fixture as `/tmp/agency-audit-codex-homes.mts` and run `corepack pnpm --dir packages/server exec tsx /tmp/agency-audit-codex-homes.mts` from the audit worktree. Change the two absolute source imports if the worktree lives elsewhere.

```typescript
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CodexSessionDiscovery } from '/home/user/Projects/Agency-UI-audit/packages/server/src/agents/codex/discovery.ts';
import { localDayFolder } from '/home/user/Projects/Agency-UI-audit/packages/server/src/agents/codex/paths.ts';
const root = await mkdtemp(path.join(tmpdir(), 'agency-two-homes-'));
try {
 const a=path.join(root,'server-home'), b=path.join(root,'wrapper-home'), cwd=path.join(root,'workspace');
 await mkdir(cwd); process.env.CODEX_HOME=a;
 const t=Date.now()-10000, at=t+1000, pad=(n:number)=>String(n).padStart(2,'0');
 const make=async(home:string,id:string)=>{const d=new Date(at);const folder=localDayFolder(path.join(home,'sessions'),at);await mkdir(folder,{recursive:true});const file=`rollout-${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${id}.jsonl`;await writeFile(path.join(folder,file),JSON.stringify({type:'session_meta',payload:{id,timestamp:new Date(at).toISOString(),cwd,source:'cli'}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'synthetic fixture',images:[],local_images:[],text_elements:[]}})+'\n');};
 const own='019f0000-0000-7000-8000-000000000001', other='019f0000-0000-7000-8000-000000000002';
 let observed:string|null=null; const discovery=new CodexSessionDiscovery({pollMs:2000000000});
 discovery.register({terminalId:'synthetic-profile-b',cwd,launchedAt:t,reportSessionId:id=>{observed=id}});
 await make(b,own); await discovery.scanOnce(); assert.equal(observed,null);
 await make(a,other); await discovery.scanOnce(); assert.equal(observed,other);
 discovery.dispose(); console.log('PASS synthetic B rollout ignored; unrelated matching A rollout assigned to B pending terminal');
} finally {await rm(root,{recursive:true,force:true});}

```

Additional source trace: `conversation-hub.ts:565-577,806-825,840` rebinds the terminal's follower to the registry native ID; that adapter uses the server-home reader. `AgencyWorkspaceView.tsx:55` subscribes by the terminal. This establishes a credible source path from misattribution to wrong-home content, but actual rendered cross-profile disclosure has not been tested. Sanitized wrapper inspection: each of the three named entrypoints includes an `export CODEX_HOME=...` assignment. Their actual values and any real conversations were not examined.

## Resume ownership hypothesis (not yet a finding)

`agency-session-runtime.ts:256-293,315-345,585-597` accepts a client-supplied native resume ID, verifies identity is preserved by the adapter and enforces active-controller exclusivity, but the inspected path does not compare the requested profile to prior persisted session ownership. `runtime/agency-session-runtime.test.ts:545-570` checks simultaneous different-profile controllers only; it does not check a later resume after the first controller exits. This could permit unintended profile reassignment, depending on whether cross-profile native resume is an intended supported behavior and what the original CLI permits. Reproduce safely with fake registry/provider and clarify contract; do not claim actual cross-account access.

### Resume ownership synthetic test

Executed a disposable copy of the existing runtime-test fixture, replacing its imports with absolute source paths and adding one test: create native UUID under `codex-0`, emit fake PTY exit, then resume the same UUID under `codex-3` in a second workspace. Result: accepted, both launches recorded, new row identifies `codex-3`. The test uses a fake registry and fake provider and does not show that a real CLI opens a different account's history. Active concurrent controllers are rejected by existing test. Whether historical cross-profile resume should be forbidden is not explicitly resolved by the foundation contract; classify as **unverified risk**, not confirmed vulnerability. If ownership is a required boundary, persist/enforce verified owner (or fail closed) before launch. Reproduction: copy the fixture header/classes through `MemoryStore` from `packages/server/src/agency/runtime/agency-session-runtime.test.ts` to a temporary test, resolve its relative JS imports to the source TS files, append the following, and run `corepack pnpm --dir packages/server exec tsx --test /tmp/agency-audit-resume.test.ts`:

```typescript
test('inactive native ID may be resumed under another profile', async () => {
 const cwd=await mkdtemp(path.join(tmpdir(),'agency-profile-resume-')); const f=fixture(cwd);
 try {await f.runtime.initialize();const id=randomUUID();
 const first=await f.runtime.create({workspaceId:f.one.id,kind:'agent',profileId:'codex-0' as CliProfileId,cols:80,rows:24,resumeNativeSessionId:id});
 f.terminals.exit(first.terminalId!,0);await new Promise<void>(done=>setImmediate(done));
 assert.equal(f.runtime.get(first.id)?.lifecycle,'exited');
 const next=await f.runtime.create({workspaceId:f.two.id,kind:'agent',profileId:'codex-3' as CliProfileId,cols:80,rows:24,resumeNativeSessionId:id});
 assert.equal(next.profileId,'codex-3');assert.equal(next.nativeSessionId,id);assert.equal(f.terminals.opens.length,2);
 } finally {f.runtime.dispose();await rm(cwd,{recursive:true,force:true});}
});
```

## Authentication boundary, preliminary

`security.ts:189-198,209-222,239-248` checks loopback Host, loopback Origin when present and credential on HTTP/WS authorization; absent Origin is allowed and depends on token. E2E observed HTTP bad-token 401 and foreign Origin 403. WS assertions accept generic errors (TEST-001), so independently verify actual upgrade statuses. `terminal-socket.ts:1054-1065,1073-1077` parses socket messages and invokes `remoteRefusal` before dispatch. Workspaces require socket-bound picker selection (`domain-handler.ts:130-135`) and shared reservation/deletion lock (`domain-handler.ts:152-161`). These are source observations, not a complete threat review. Existing remote-access capability, message size, rendering, file races and executable/credential boundaries need further audit.

## Continuation 01 — integrated synthetic wrong-home transcript (2026-10-28)

Real production server, real Codex adapter/registry/discovery/ConversationHub, headless Chrome and disposable shell wrapper: wrapper exports synthetic CODEX_HOME B and writes its effective value to a disposable sentinel; the harness asserts exact equality to B. Configure codex-0 to that executable and launch in a picker-created workspace. Write eligible session_meta + event_msg/user_message rollouts with matching cwd/current time: B marker stays absent after 1.5 seconds; writing distinct A UUID/marker under server CODEX_HOME A results in the exact A marker visible in AgencyTranscript within 15 seconds. Fixture output: `effectiveWrapperHomeVerified=true, wrapperHomeIgnored=true, serverHomeTranscriptRendered=true, realAccountsAccessed=false`. This confirms integrated synthetic transcript misattribution, **not real-account transcript disclosure**. No authentication files were created/read and no provider was invoked. Fixture `/tmp/agency-audit-account-browser.mjs`; disposable data/process group removed at exit.

Minimal fixture recipe: reuse the screenshot harness setup/request/createWs/launch code (05); replace its fake CLI with a shell script exporting B, writing B to a sentinel and waiting on stdin; assert sentinel equals B. Select Agent Only in Chrome; write B rollout UUID ...0051, wait 1500 ms and assert `.agency-transcript` absent; write A UUID ...0052 and `event_msg` user message `SERVER_A_SYNTHETIC_ONLY 0`; assert exact text visible. Use filename `rollout-YYYY-MM-DDTHH-mm-ss-<UUID>.jsonl` inside local-day sessions/YYYY/MM/DD, metadata `{id,timestamp,cwd,source:'cli'}` and timestamped user event `{type:'user_message',message,images:[],local_images:[],text_elements:[]}`. HOME/XDG/CODEX_HOME all temporary; keep launch token out of output.

Ownership conclusion: CONTRACT.md domain invariants 7 and 9 describe named executable configurations and native CLI resume, not permanent account principals. No historical profile-binding requirement is stated. Existing active-controller exclusion is explicit; do not promote accepted post-exit cross-profile resume into an exploit. Engineering must define ownership semantics before changing this behavior.

Smallest safe correction: carry an immutable verified effective native-home context from profile launch through registry descriptor, discovery registrations, history lookup/follow and resume. A configured wrapper path or literal CODEX_HOME text is not proof of its effective home. Until a trusted integration supplies identity, keep native PTY usable but disable profile history/discovery/resume requiring home identity, with visible unavailable state; never fall back to server home or execute opaque wrappers merely to probe credentials. Explicitly verified home must participate in protected-directory checks. Persist owner context for sessions if historical binding is adopted; legacy unknown ownership fails closed for profile-specific operations.

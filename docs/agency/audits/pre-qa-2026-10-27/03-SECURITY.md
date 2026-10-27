NOT_STARTED

# Security

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`  
Audit branch: `audit/agency-ui-pre-qa-20261027`  
Date: 2026-10-27 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.  
Limitations: audit initialized; no implementation, tests, browser behavior, or security properties have yet been verified.  
Last completed step: verified clean integration worktree, branch/remote/PR head, created separate audit worktree.


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

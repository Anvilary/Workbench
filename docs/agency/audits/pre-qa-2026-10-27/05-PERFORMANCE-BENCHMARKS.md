FINAL — BOUNDED AUDIT COMPLETE

Final decision: bounded audit complete; final continuation sections below and 08/09 supersede historical checkpoint limitations. No performance refactoring before QA; Group A/B corrections remain required.

# Performance Benchmarks

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`
Audit branch: `audit/agency-ui-pre-qa-20261027`
Date: 2026-10-28 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.
Limitations: synthetic/local bounded review; real-provider checks require manual QA. Earlier checkpoint sections are historical; final continuation conclusions supersede their incomplete-state statements.
Last completed step: integrated account isolation, critical boundary review, sustained PTYs, long transcript and browser reconnection; final backlog and handoff.


## Preliminary build output (not a startup benchmark)

Production Vite build, offline installed dependencies, Node 24.22.0, pnpm 11.24.0: 238 modules, main JS 1,126.92 kB raw / 310.00 kB gzip, CSS 99.80 kB / 19.09 kB gzip; Vite reported build duration 2.69 s. Main bundle size agrees with prior report. No browser parse cost, network, startup or interaction measurements collected; bundle impact remains unverified. The root `corepack pnpm build` script fails in this environment because `pnpm` executable is absent from PATH; direct `corepack pnpm --filter @agent-workbench/web build` succeeded. Do not classify missing shell shim as an application defect without verifying normal setup.

## Repeated warm browser interactions, low-load fixture

Hardware: Linux x86_64, AMD Ryzen 7 250 (8 cores / 16 logical), 28.7 GiB RAM; Chrome 155.0.8059.39 headless, Node 24.22.0, pnpm 11.24.0. One production server; synthetic no-inference agent, shell, 5 small workspaces, 1440x900. No sustained terminal output. No competing build was running. Each row n=20; p95 is nearest-rank 19th; p50 averages 10th/11th. Playwright wall-clock includes client protocol/action overhead and waiting for visible workspace/aria-current, not isolated React render or input-to-paint. Dialog and sidebar values are complete open+close cycles; composer uses `fill` of ~518 characters rather than human typing latency.

| Action | p50 ms | p95 ms | max ms | n |
|---|---:|---:|---:|---:|
| Switch between two workspaces without active PTYs | 33.80 | 36.45 | 37.57 | 20 |
| Switch between agent-only and combined workspaces with idle PTYs | 56.19 | 61.49 | 64.26 | 20 |
| Profile dialog open and close | 33.61 | 44.89 | 48.80 | 20 |
| Sidebar collapse and expand | 66.74 | 70.27 | 70.91 | 20 |
| Composer fill | 3.81 | 7.10 | 9.85 | 20 |

Single run; warm cache and low load; no statistical comparison across machines, cold launches or UI under output. No basis yet for a specific optimization recommendation.

Reproduction: copy `packages/server/scripts/capture-agency-screenshots.mjs` to a temporary `.mjs`, rewrite its `playwright` and `ws` imports to the audit worktree's installed packages and `serverDir` to the audit worktree's `packages/server`, then insert the following before `await browser.close()`. Run with `PATH=/tmp/agency-audit-bin:$PATH AGENCY_SCREENSHOT_DIR=/tmp/agency-audit-shots node /tmp/agency-audit-browser-bench.mjs`; pnpm shim setup in 09. The temporary copy `/tmp/agency-audit-browser-bench.mjs` currently contains the full reproducible fixture, but may not survive a reboot.

```javascript
const results = {};
async function bench(label, count, action) {
 const values=[];
 for(let i=0;i<count;i++){const start=performance.now(); await action(i); values.push(performance.now()-start);}
 values.sort((a,b)=>a-b); const round=x=>Math.round(x*100)/100;
 results[label]={n:values.length,p50:round((values[9]+values[10])/2),p95:round(values[18]),max:round(values[19])};
}
await page.setViewportSize({width:1440,height:900});
await selectWorkspace('Empty Workspace');
await bench('switch_no_active_pty_ms',20,async i=>selectWorkspace(i%2?'Empty Workspace':'Completed Task'));
await selectWorkspace('Agent Only');
await bench('switch_active_pty_ms',20,async i=>selectWorkspace(i%2?'Agent Only':'Combined Workspace'));
await selectWorkspace('Empty Workspace');
await bench('profile_dialog_cycle_ms',20,async()=>{await page.getByRole('button',{name:'Configure profile'}).click();await page.locator('[role="dialog"]').waitFor({state:'visible'});await page.keyboard.press('Escape');await page.locator('[role="dialog"]').waitFor({state:'hidden'});});
await bench('sidebar_toggle_cycle_ms',20,async()=>{await sidebarToggle.click();await page.locator('.agency-sidebar-nav').waitFor({state:'hidden'});await sidebarToggle.click();await page.locator('.agency-sidebar-nav').waitFor({state:'visible'});});
const composer=page.locator('.agency-composer textarea');
await bench('composer_fill_ms',20,async i=>{await composer.fill('Synthetic draft '+i+' '+'.'.repeat(500));});
console.log('AUDIT_BENCHMARKS',JSON.stringify(results));
```

Still required: cold/warm startup distributions, browser parse/render, load and large transcript, sustained PTY output/reattach/resize, CPU/memory/fd/listener growth and persistence/restart distributions.

## Preliminary startup and browser navigation

Five sequential server processes, same disposable HOME/config, existing production build, no provider inference; wall time from spawning a `pnpm` shim (including Corepack/pnpm/tsx launcher overhead) to URL announcement and successful HTTP 200 body fetch. The first process used an empty disposable config; four later processes reused it. The OS, executable and filesystem caches were not flushed: these are **not** true machine-cold samples. Server startup HTTP times, in order: 1824.62, 1031.38, 1063.00, 1065.97, 1050.05 ms. URL announcement: 1804.31, 1022.62, 1054.41, 1056.76, 1040.81 ms. All five returned HTTP 200. Across all five HTTP samples: p50 1063.00 ms, nearest-rank p95 and max 1824.62 ms, n=5. First empty-config startup is separated above; n=4 repeats are insufficient for tail conclusions.

For the fifth server, one headless Chrome page navigated 20 times to the authenticated URL with the same browser context. Wall clock through DOM content loaded, visible `.agency-app`, and connected indicator: first 188.71 ms; combined n=20 p50 40.00 ms, p95 54.29 ms, max 188.71 ms. First navigation is the max; remaining navigations use the same browser context/cache and are not independent cold navigations. A single final Navigation Timing DOMContentLoaded was 14.3 ms; this is not parse/compile or fully interactive measurement. Different tokens are never printed or stored.

Reproduce by saving this sanitized fixture in `/tmp/agency-audit-startup.mjs`, ensuring the pnpm shim exists as described in 09, then `node /tmp/agency-audit-startup.mjs`. The temporary script disposes its test config and process group; do not run against real HOME or log launch URLs.

```javascript
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {chromium} from '/home/user/Projects/Agency-UI-audit/node_modules/playwright/index.mjs';
const repo='/home/user/Projects/Agency-UI-audit';
const temp=await mkdtemp(path.join(os.tmpdir(),'agency-startup-audit-'));
const home=path.join(temp,'home'); await mkdir(home); await writeFile(path.join(home,'.zshrc'),'# fixture\n');
const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(temp,'appdata'),XDG_CONFIG_HOME:path.join(temp,'config'),XDG_DATA_HOME:path.join(temp,'data'),XDG_CACHE_HOME:path.join(temp,'cache'),XDG_STATE_HOME:path.join(temp,'state'),CODEX_HOME:path.join(temp,'codex'),PI_CODING_AGENT_DIR:path.join(temp,'pi'),PI_CODING_AGENT_SESSION_DIR:path.join(temp,'pi-sessions'),AGENT_WORKBENCH_NO_OPEN:'1',AGENT_WORKBENCH_NO_RESTORE:'1',PATH:'/tmp/agency-audit-bin:'+process.env.PATH};
let child; const stop=async()=>{if(!child)return; try{process.kill(-child.pid,'SIGTERM')}catch{} await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2500))]);try{process.kill(-child.pid,'SIGKILL')}catch{} child=null};
const launch=async()=>{const start=performance.now();child=spawn('pnpm',['--dir','packages/server','exec','tsx','src/index.ts','--prod'],{cwd:repo,env,detached:true,stdio:['ignore','pipe','pipe']});const url=await new Promise((resolve,reject)=>{let buf='';let timer=setTimeout(()=>reject(Error('startup timeout')),30000);let onData=b=>{buf+=b;const match=buf.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);if(match){clearTimeout(timer);resolve(match[0]);}};child.stdout.on('data',onData);child.stderr.on('data',onData);child.once('exit',()=>reject(Error('early exit')))});const announced=performance.now();const res=await fetch(url);await res.arrayBuffer();return {url,announce:announced-start,http:performance.now()-start,status:res.status};};
let browser;try {const starts=[];for(let i=0;i<5;i++){const x=await launch();starts.push(x);if(i<4)await stop();}browser=await chromium.launch({channel:'chrome',headless:true});const ctx=await browser.newContext({viewport:{width:1440,height:900}});const page=await ctx.newPage();let navigations=[];for(let i=0;i<20;i++){const t=performance.now();await page.goto(starts[4].url,{waitUntil:'domcontentloaded'});await page.locator('.agency-app').waitFor({state:'visible'});await page.locator('.agency-connection-state.connected').waitFor({state:'visible'});navigations.push(performance.now()-t);}const navTiming=await page.evaluate(()=>{const nav=performance.getEntriesByType('navigation')[0];return {domContentLoaded:nav.domContentLoadedEventEnd,duration:nav.duration};});const sort=[...navigations].sort((a,b)=>a-b),r=x=>Math.round(x*100)/100;console.log(JSON.stringify({server:starts.map(x=>({announce_ms:r(x.announce),http_ms:r(x.http),status:x.status})),browser_first_ms:r(navigations[0]),browser_all:{n:20,p50:r((sort[9]+sort[10])/2),p95:r(sort[18]),max:r(sort[19])},navigation_timing_ms:navTiming}));}finally{if(browser)await browser.close();await stop();await rm(temp,{recursive:true,force:true});}

```

## Browser switches during synthetic PTY output

Same Chrome/fixture machine and 1440px viewport as warm interaction tests. A disposable shell in the combined workspace generated 260-character lines at a programmed 4 ms interval. A separate attached WebSocket observed 74,932 output bytes during the 1,169 ms timed switching period (~64,121 bytes/s); the browser alternated between the combined workspace and agent-only workspace. Twenty Playwright switch operations: p50 56.97 ms, p95 66.26 ms, max 68.75 ms. The same run's idle-PTY p50/p95/max was 60.59/68.11/74.24 ms. This short, single workload suggests no demonstrated slowdown at this rate; it does not establish sustained behavior, paint latency, CPU, throughput ceilings, large transcripts or leaks. The extra socket receives the output even while the browser view is detached. Test ends the synthetic generator with Ctrl+C and tears down the server process group.

Reproduction: apply this insertion before `await browser.close()` in the disposable benchmark copy described above. The complete copy currently exists at `/tmp/agency-audit-output-bench.mjs`; it may be ephemeral.

```javascript
const loadSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {headers:{Origin:`http://127.0.0.1:${port}`}});
await new Promise((resolve,reject)=>{loadSocket.once('open',resolve);loadSocket.once('error',reject)});
let received=0;
loadSocket.on('message',raw=>{const msg=JSON.parse(raw.toString());if(msg.type==='terminal.output' && msg.terminalId===combinedShell.session.terminalId)received+=Buffer.byteLength(msg.data);});
loadSocket.send(JSON.stringify({type:'terminal.attach',terminalId:combinedShell.session.terminalId,cols:80,rows:24}));
await selectWorkspace('Combined Workspace');
const command = `python3 -u -c 'import sys,time; [(sys.stdout.write("LOAD"+"x"*256+"\\n"),sys.stdout.flush(),time.sleep(0.004)) for _ in range(2500)]'\n`;
loadSocket.send(JSON.stringify({type:'input',terminalId:combinedShell.session.terminalId,data:command}));
await new Promise(r=>setTimeout(r,500));
const beginBytes=received, loadStart=performance.now();
await bench('switch_sustained_output_ms',20,async i=>selectWorkspace(i%2?'Combined Workspace':'Agent Only'));
const duration=performance.now()-loadStart, bytes=received-beginBytes;
loadSocket.send(JSON.stringify({type:'input',terminalId:combinedShell.session.terminalId,data:'\x03'}));
loadSocket.close();
assert.ok(bytes>10000,'fixture did not generate enough output during timed switches');
console.log('AUDIT_OUTPUT_LOAD',JSON.stringify({duration_ms:Math.round(duration),observed_ws_output_bytes:bytes,approx_bytes_per_second:Math.round(bytes*1000/duration),switching:results.switch_sustained_output_ms}));
```

## Preliminary idle process-group resources

After five sequential process starts and 20 page navigations with one connected Chrome page and no fixture PTYs, sampled the server launcher's Linux process group six times at approximately one-second intervals. Sum of per-process RSS: 320,188 KiB (312.68 MiB) at all six observations; 3 processes, total open fd counts 73, 73, 72, 72, 72, 72. CPU ticks changed by zero across each of five nominal one-second intervals (rounded tick resolution, approximately 0% of one logical CPU); this does not imply exact zero. The group includes the Corepack/pnpm/tsx launcher chain, excludes Chrome, may omit descendants in other process groups and sums shared RSS multiple times; it is not a standalone server heap, PSS, peak or sustained memory measurement. No PTYs and only six seconds; growth, load CPU, leaks and listener counts remain unmeasured. Another run's startup/browser results varied, reinforcing single-run noise.

Reproduction: copy the startup fixture in this report, add `import {execFileSync} from 'node:child_process'; import {readFileSync,readdirSync} from 'node:fs';` and insert this immediately before its `finally`. The generated disposable `/tmp/agency-audit-idle.mjs` also contains the full code while it exists.

```javascript
const sample=()=>{const lines=execFileSync('ps',['-eo','pid=,pgid='],{encoding:'utf8'}).trim().split('\n');let rss=0,ticks=0,fds=0,pids=[];for(const line of lines){const [pid,pgid]=line.trim().split(/\s+/).map(Number);if(pgid!==child.pid)continue;try{const stat=readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ');ticks+=Number(stat[11])+Number(stat[12]);const st=readFileSync('/proc/'+pid+'/status','utf8').match(/^VmRSS:\s+(\d+)/m);rss+=st?Number(st[1]):0;fds+=readdirSync('/proc/'+pid+'/fd').length;pids.push(pid)}catch{}}return {rss_kib:rss,ticks,fds,processes:pids.length}};
const snapshots=[sample()];for(let i=0;i<5;i++){await new Promise(r=>setTimeout(r,1000));snapshots.push(sample())};const hz=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim());const cpu=snapshots.slice(1).map((x,i)=>Math.round((x.ticks-snapshots[i].ticks)*10000/hz)/100);console.log('AUDIT_IDLE_GROUP',JSON.stringify({rss_kib:snapshots.map(x=>x.rss_kib),fds:snapshots.map(x=>x.fds),processes:snapshots.map(x=>x.processes),cpu_percent_approx:cpu,interval_ms:1000}));

```

## Ten projects / fifty workspaces: warm fixture

Using the same method as above at 1440px, headless Chrome with 4 active idle fixture processes, 10 projects / 50 workspaces, 20 repetitions per action:

| Action | p50 ms | p95 ms | max ms | n |
|---|---:|---:|---:|---:|
| Switch between workspaces without active PTYs | 41.85 | 49.35 | 49.74 | 20 |
| Switch between workspaces with idle active PTYs | 59.00 | 72.37 | 73.66 | 20 |
| Profile dialog open and close | 49.28 | 65.12 | 67.15 | 20 |
| Sidebar collapse and expand | 66.93 | 81.34 | 107.01 | 20 |
| Composer fill | 5.43 | 11.87 | 20.04 | 20 |

Single runs, different fixture setups and Playwright overhead; not a controlled causal comparison or proof of an optimization target. No user-provider inference. The fixture generation below is inserted before the setup socket's `ws.close()` in the temporary browser benchmark; additionally send `picker.close` after each original `createWs` and after the extra initial picker, to stay below the eight-open-picker limit. Full generated file `/tmp/agency-audit-scale.mjs` may be ephemeral.

```javascript
for(let p=0;p<8;p++) {
 const pr=await request({type:'agency.project.create',requestId:`scale-p-${p}`,name:`Scale Project ${p}`});
 const count=p<4?6:5;
 for(let w=0;w<count;w++) {
  const picker=await pickerListing({type:'picker.open'});
  await pickerListing({type:'picker.create',pickerId:picker.pickerId,name:`scale-${p}-${w}`});
  await request({type:'agency.workspace.create',requestId:`scale-w-${p}-${w}`,projectId:pr.project.id,name:`Scale Workspace ${p}-${w}`,pickerId:picker.pickerId});
  ws.send(JSON.stringify({type:'picker.close',pickerId:picker.pickerId}));
 }
}
```

## Continuation 02 — sustained eight-PTY workload (2026-10-28)

Real production server / Chrome 155, same hardware and pinned source; ten projects / **56** workspaces (50 plus six load fixtures), eight concurrent shell PTYs plus two idle agent fixtures. Eight Python generators each emit 260-character lines with 10 ms sleep for a maximum 60 seconds. An independent attached socket counts all eight streams. During 60 browser switches, alternate Combined Workspace and Agent Only; focus composer, type `abc`, assert its value ends with abc, then wait 400 ms. Send Ctrl+C to generators, perform 20 detach/attach cycles and await actual terminal.replay. Tear down owned processes and temp directories. Observed 5,980,506 output bytes across 29,238 ms (~204.5 kB/s overall). This is a bounded ~29-second trial, not a soak or throughput ceiling.

| Measurement | p50 ms | p95 ms | max ms | n |
|---|---:|---:|---:|---:|
| Loaded navigation, visible workspace + aria-current | 59.12 | 68.79 | 71.91 | 60 |
| Composer type abc + value check | 9.92 | 14.53 | 20.18 | 60 |
| Socket terminal replay delivery | 1.72 | 3.59 | 4.73 | 20 |

Nearest-rank p95; median averages central pair; wall clock includes Playwright/WS polling overhead. Replay delivery does not measure completion of xterm painting. Resources sampled before load and every fifth switch (13 observations): server launcher process-group summed RSS 360428..367440 KiB (first/last), fd count 84 initially, 83 then 81 stable; three launcher/server group processes (PTY children in other process groups are excluded). Summed RSS is not PSS or server heap. Browser CDP metrics after forced GC, before/after: JS heap 4,998,296 / 7,844,004 bytes; DOM nodes 902 / 989; event listeners 373 / 553. ScriptDuration delta 1.801 s; TaskDuration delta 6.525 s. These are cumulative main-thread execution costs including parsing/dispatch/rendering, not isolated parser costs. Listener growth requires attribution/longer investigation; do not call this proof of a production leak or a material bottleneck. No fd growth observed; no latency degradation established. Do not refactor performance before QA on this evidence.

Runnable ephemeral fixture `/tmp/agency-audit-sustained.mjs`, derived from 05 scale harness: add six picker-created shell workspaces, attach all eight shell IDs on one observer socket, send the Python command from the short-output fixture with sleep(0.01)/6000 iterations, run the 60 switch/type/sleep cycles above, sample /proc as earlier, and use CDP Performance.getMetrics plus HeapProfiler.collectGarbage. Original workload design and metrics remain preserved above.

## Continuation 04 — long transcript and browser costs

Disposable real server/wrapper/browser, 1,000 timestamped synthetic user events of ~1,000 chars each, in a valid UUIDv7 rollout whose embedded creation day matches its directory. Initial append-to-visible tail: 334.35 ms (n=1, p50=p95=max for that single observation; not a tail estimate). After switching away, re-subscription intentionally uses ConversationHub INITIAL_EVENT_LIMIT=300; wait for `.agency-turn` index 299 before declaring Agent Only ready. Three blocks of 20 alternating switches between Agent Only and Combined: p50 179.87, nearest-rank p95 278.71, max 292.90 ms, n=60. This measures restored transcript readiness, unlike earlier visible-container-only switching numbers; do not infer a causal slowdown ratio from different endpoints. Final rendered count 300; full older history browsing is not benchmarked. No multi-second stall or lost stored transcript established.

CDP metrics after 1.2s settle and forced GC, baseline/after each 20-switch block, identical final workspace and 300 rows: Nodes 3012/3015/3015/3015; JSHeapUsedSize bytes 5944468/6447888/6514384/6571824; JSEventListeners 185/245/305/365. Last cumulative ScriptDuration 2.441541s and TaskDuration 9.105725s after enabling CDP; scripting + layout/paint etc cannot be separated into React cost from these totals. Listener increase repeats, but retained targets/root cause and long-term slope/impact are unverified. Record as an investigation opportunity, not a confirmed memory-leak finding. Fixture `/tmp/agency-audit-long-ready.mjs`: reuse account-browser recipe, derive UUIDv7 first 48 bits from current epoch milliseconds, generate 1000 user events, wait for at least300 visible events on each return; three20-switch blocks, collect CDP Performance metrics after HeapProfiler GC. Earlier temporary attempt used a fixed old UUIDv7 in today's directory and could not reload; this was a **fixture error**, not a product finding. Its 57/68ms container-only timings and timeout are excluded from long-transcript conclusions.

Separate browser microbenchmark (Chrome155 fresh blank page): serialize `{type:'conversation.reset',events:[1000 synthetic user events, each 1000-char text]}` once, warm JSON.parse once, then20 JSON.parse calls inside page.evaluate, assert1000 events each time, measure performance.now. 1,086,930-byte payload: p50 1.10ms, nearest-rank p95 1.40ms, max1.90ms, n20. `/tmp/agency-audit-browser-parse.mjs`. Excludes network, dispatch and rendering; no claim this exact payload is sent as an initial snapshot (initial tail is300). This bounds a representative parse workload and does not identify a parser bottleneck.

**Decision:** no performance refactoring before QA. Retain existing implementation pending native/manual QA; separately profile listener retention if a longer run or user-visible degradation establishes material impact. Current finite trials do not establish soak stability, machine-cold startup, peak provider workloads, or zero leaks.

Resource distribution clarification for continuation02 (13 equally scheduled observations): summed server-group RSS p50/p95/max364028/367440/367440KiB; fd p50/p95/max81/84/84. These are resource levels, not per-interaction cost; see trajectory and exclusion caveats above.

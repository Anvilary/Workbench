import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {AgencySessionRuntime} from '../../packages/server/src/agency/agency-session-runtime.ts';
import {AgencySessionStore} from '../../packages/server/src/agency/agency-session-store.ts';
const root=await mkdtemp(path.join(tmpdir(),'maw-select-bench-'));
const ws={id:randomUUID(),projectId:randomUUID(),name:'Fixture',cwd:root,status:'active',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
const terms=new Map();const registry=Object.assign(new EventEmitter(),{open:async()=>{const row={terminalId:randomUUID(),kind:'shell',alive:true,exitCode:null};terms.set(row.terminalId,row);return row;},get:id=>terms.get(id),list:()=>[...terms.values()],activityOf:()=> 'unknown',close:()=>{throw Error('No closes allowed');}});
const store=new AgencySessionStore(path.join(root,'sessions.json'));let writes=0,events=0,bytes=0;
const save=store.save.bind(store);store.save=rows=>{writes++;return save(rows);};
const runtime=new AgencySessionRuntime({registry,store,workspaces:{protectedDirectories:()=>[],withSessionReservation:async(_id,fn)=>fn(ws)},profiles:{resolveLaunch:async()=>{throw Error('No providers');}}});
runtime.on('changed',row=>{events++;bytes+=Buffer.byteLength(JSON.stringify(row));});
const results=[];
try{
 await runtime.initialize();
 for(let i=0;i<15;i++)await runtime.create({kind:'terminal',workspaceId:ws.id,cols:80,rows:24});
 const tabs=runtime.list(ws.id).map(s=>s.tab.id);
 for(const mode of ['repeat','alternate']){
  await runtime.tabAction(ws.id,tabs[0],'select'); writes=0;events=0;bytes=0;
  const cpu=process.cpuUsage(),samples=[];
  for(let i=0;i<300;i++){const t=performance.now();await runtime.tabAction(ws.id,tabs[mode==='repeat'?0:(i+1)%2],'select');samples.push(performance.now()-t);}
  const elapsedCpu=process.cpuUsage(cpu);samples.sort((a,b)=>a-b);
  results.push({mode,n:samples.length,p50Ms:samples[150],p95Ms:samples[285],p99Ms:samples[297],writes,events,bytes,cpuMs:(elapsedCpu.user+elapsedCpu.system)/1000,rssBytes:process.memoryUsage().rss});
 }
 console.log(JSON.stringify({node:process.version,platform:process.platform,tabs:15,fixture:'real JSON persistence, fake PTYs, no network',results},null,2));
}finally{runtime.dispose();await rm(root,{recursive:true,force:true});}

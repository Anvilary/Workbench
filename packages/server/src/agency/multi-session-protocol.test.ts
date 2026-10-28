import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseAgencyClientMessage, isAgencyTab } from '@agent-workbench/shared';

test('tab operations validate explicit workspace/tab IDs, duplicate orders and forbidden cwd/profile fields', () => {
  const workspaceId=randomUUID(),tabId=randomUUID();
  for(const action of ['select','close','resume']) {
    const message={type:'agency.tab.action',requestId:'tab-test',workspaceId,tabId,action};
    assert.deepEqual(parseAgencyClientMessage(message),message);
    assert.equal(parseAgencyClientMessage({...message,cwd:'/arbitrary'}),null);
    assert.equal(parseAgencyClientMessage({...message,profileId:'another-account'}),null);
    assert.equal(parseAgencyClientMessage({...message,tabId:'../../elsewhere'}),null);
  }
  assert.equal(parseAgencyClientMessage({type:'agency.tabs.order',requestId:'order',workspaceId,tabIds:[tabId,tabId]}),null);
  assert.ok(parseAgencyClientMessage({type:'agency.tabs.order',requestId:'order',workspaceId,tabIds:[tabId,randomUUID()]}));
  const legacy={type:'agency.session.create',requestId:'old',workspaceId,kind:'terminal',cols:80,rows:24};
  assert.deepEqual(parseAgencyClientMessage(legacy),legacy);
  const current={...legacy,launchId:randomUUID()};assert.deepEqual(parseAgencyClientMessage(current),current);
  assert.equal(parseAgencyClientMessage({...current,tabId}),null);
  assert.equal(isAgencyTab({id:tabId,name:null,order:-1,selected:true,current:true,closedAt:null}),false);
});

test('managed Codex discovery does not attribute same-home/CWD native conversations to the latest launched tab', async t => {
  const { mkdtemp,mkdir,writeFile,rm }=await import('node:fs/promises');
  const { tmpdir }=await import('node:os');const path=await import('node:path');
  const { CodexSessionDiscovery }=await import('../agents/codex/discovery.js');
  const root=await mkdtemp(path.join(tmpdir(),'maw-codex-multiple-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const now=Date.now(),date=new Date(now),pad=(value:number)=>String(value).padStart(2,'0');
  const folder=path.join(root,String(date.getFullYear()),pad(date.getMonth()+1),pad(date.getDate()));await mkdir(folder,{recursive:true});
  const seen:string[]=[];const discovery=new CodexSessionDiscovery({strictAttribution:true,sessionsRoot:()=>root,pollMs:60000,now:()=>now+500});
  t.after(()=>discovery.dispose());
  const a=discovery.register({terminalId:'a',cwd:root,launchedAt:now,reportSessionId:id=>seen.push('a:'+id)});
  discovery.register({terminalId:'b',cwd:root,launchedAt:now+10,reportSessionId:id=>seen.push('b:'+id)});
  const id=randomUUID();
  await writeFile(path.join(folder,`rollout-${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${id}.jsonl`),[
    {type:'session_meta',payload:{id,timestamp:new Date(now+100).toISOString(),cwd:root,source:'cli'}},
    {type:'event_msg',timestamp:new Date(now+100).toISOString(),payload:{type:'user_message',message:'synthetic prompt',images:[],local_images:[],text_elements:[]}},
  ].map(value=>JSON.stringify(value)).join('\n')+'\n');
  await discovery.scanOnce();assert.deepEqual(seen,[]);
  a.cancel();await discovery.scanOnce();assert.deepEqual(seen,[],'Closing one tab cannot retroactively authorize an ambiguous assignment');
});

test('legacy selection prefers an active current attempt without guessing from update time', async () => {
  const { migrateSessionTabs }=await import('./agency-session-store.js');
  const workspaceId=randomUUID() as import('@agent-workbench/shared').WorkspaceId;
  const now=new Date().toISOString();
  const row=(lifecycle:'running'|'exited')=>({id:randomUUID() as import('@agent-workbench/shared').RuntimeSessionId,workspaceId,kind:'terminal' as const,profileId:null,nativeSessionId:null,selectedModel:null,selectedEffort:null,terminalId:null,lifecycle,activity:'unknown' as const,createdAt:now,updatedAt:now,startedAt:now,stoppedAt:null,exitCode:null});
  const past=row('exited'),live=row('running');const migrated=migrateSessionTabs([past,live]);
  assert.equal(migrated[0]!.tab?.selected,false);assert.equal(migrated[1]!.tab?.selected,true);
});


test('rename validates stable IDs, title and forbids process identity fields', () => {
  const message = { type: 'agency.tab.rename', requestId: 'rename', workspaceId: randomUUID(), tabId: randomUUID(), name: 'Title' };
  assert.deepEqual(parseAgencyClientMessage(message), message);
  for (const name of ['', '  ', 'x'.repeat(121), 'bad\u0000title', 'bad\ntitle']) assert.equal(parseAgencyClientMessage({ ...message, name }), null);
  for (const change of [{tabId:'../tab'}, {workspaceId:'wrong'}, {profileId:'codex-1'}, {cwd:'/tmp'}, {terminalId:randomUUID()}]) assert.equal(parseAgencyClientMessage({...message,...change}),null);
});

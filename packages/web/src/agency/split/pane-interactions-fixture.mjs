// Real MAW components and CSS. Session records and ChatGPT pages are synthetic.
export const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal} from '@xterm/xterm';
import {useDropdownDismissal} from './src/agency/useDropdownDismissal.ts';
import {AgencyWorkspaceView} from './src/agency/AgencyWorkspaceView.tsx';
import './src/agency/agency.css';
import '@xterm/xterm/css/xterm.css';
const ws='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const now='2026-10-31T10:00:00.000Z';
const query=new URLSearchParams(location.search);
const mode=query.get('mode') || 'terminal';
const shape=query.get('shape') || 'row';
const count=shape==='single'?1:shape==='three'?3:shape.includes('four')?4:2;
const id=n=>String(n).repeat(8)+'-'+String(n).repeat(4)+'-4'+String(n).repeat(3)+'-8'+String(n).repeat(3)+'-'+String(n).repeat(12);
const session=(n,kind='terminal',launchId)=>({id:'session-'+n,workspaceId:ws,kind,launchId,profileId:kind==='agent'?'fixture-profile':null,terminalId:'term-'+n,lifecycle:'running',activity:'working',exitCode:null,nativeSessionId:null,selectedModel:null,selectedEffort:null,createdAt:now,updatedAt:now,tab:{id:id(n),name:(kind==='agent'?'CLI ':'Terminal ')+n,selected:n===1,current:true,closedAt:null,order:n-1,terminalNumber:n}});
const web=(n,launchId,title)=>({id:id(n),workspaceId:ws,kind:'web',launchId,title:title||'ChatGPT '+n,url:'https://chatgpt.com/',selected:n===1,closedAt:null,order:n-1,runtimeState:'client-managed',createdAt:now,updatedAt:now});
const editor=(n,filePath)=>({id:id(n),workspaceId:ws,kind:'editor',title:filePath.split('/').pop()||filePath,filePath,selected:n===1,closedAt:null,order:n-1,createdAt:now,updatedAt:now});
const initialSessions=[], initialWeb=[], initialEditor=[];
for(let n=1;n<=count;n++) {
  if(mode==='web'||mode==='mixed'&&n%2===0||mode==='cli-web'&&n===2) initialWeb.push(web(n));
  else initialSessions.push(session(n,mode==='cli-web'?'agent':'terminal'));
}
const pane=n=>({type:'pane',id:'pane-'+n,tabIds:[id(n)],selectedTabId:id(n)});
const split=(a,b,direction='row',ratio=.5)=>({type:'split',id:'split-'+a.id+'-'+b.id,direction,ratio,first:a,second:b});
let tree=count===1?pane(1):count===2?split(pane(1),pane(2),shape):count===3?split(pane(1),split(pane(2),pane(3),'column'), 'row',.4):shape==='four-grid'?split(split(pane(1),pane(2),'column'),split(pane(3),pane(4),'column')):split(pane(1),split(pane(2),split(pane(3),pane(4),'column'),'row',.4),'row',.3);
const initial={workspaceId:ws,version:1,updatedAt:now,focusedPaneId:'pane-1',tree,maximizedPaneId:null};
const state=JSON.parse(localStorage.getItem('pane-interactions')||'null')||{layout:initial,sessions:initialSessions,webTabs:initialWeb,editorTabs:initialEditor};
if(!state.editorTabs) state.editorTabs=[];
const persist=()=>localStorage.setItem('pane-interactions',JSON.stringify(state));
const requests=[],listeners=new Set(),pending=[],snapshots=[];
let fail=false, failPlacement=false, delay=false, lag=false, render=()=>{};
const emit=m=>listeners.forEach(fn=>fn(m));
const connection={getStatus:()=> 'open',onStatus:()=>()=>{},onReopen:()=>()=>{},onMessage(fn){listeners.add(fn);return()=>listeners.delete(fn)},send(m){requests.push(m);window.terminalSend?.(m);return true},sendImmediate(m){requests.push(m);window.terminalSend?.(m);return true}};
const open=Terminal.prototype.open,dispose=Terminal.prototype.dispose;
window.terminals=[];window.disposed=0;
Terminal.prototype.open=function(element){window.terminals.push(this);return open.call(this,element)};
Terminal.prototype.dispose=function(){window.disposed++;return dispose.call(this)};
if(!window.mawChatGpt){let onState;window.fixtureBridgeSend=(s)=>onState?.(s);window.mawChatGpt={subscribe(fn){onState=fn;return()=>{}},async command(m){if(m.type==='open')setTimeout(()=>onState?.({type:'ready',id:m.id}),0);return {ok:true}}}}
async function request(m){
 requests.push(m);
 if(m.type==='agency.session.create'||m.type==='agency.webTab.create'||m.type==='agency.editorTab.open'){
  if(delay)await new Promise(resolve=>pending.push(resolve));
  if(fail){fail=false;throw new Error('Fixture launch failed. Check profile settings and retry.');}
  const n=state.sessions.length+state.webTabs.length+(state.editorTabs?.length||0)+1;
  const row=m.type==='agency.session.create'?session(n,m.kind,m.launchId):m.type==='agency.webTab.create'?web(n,m.launchId,m.title):editor(n,m.filePath);
  const response=m.type==='agency.session.create'?{type:'agency.session.created',session:row}:m.type==='agency.webTab.create'?{type:'agency.webTab.created',tab:row}:{type:'agency.editorTab.opened',tab:row};
  const publish=()=>{
    if(!state.editorTabs) state.editorTabs=[];
    (m.type==='agency.session.create'?state.sessions:m.type==='agency.webTab.create'?state.webTabs:state.editorTabs).push(row);
    persist();render();
  };
  if(failPlacement){
    failPlacement=false;
    const label=m.type==='agency.webTab.create'?(m.title||'ChatGPT '+n):m.type==='agency.editorTab.open'?(row.title):(m.kind==='agent'?'CLI '+n:'Terminal '+n);
    state.placementWarning='Layout placement persistence failure for tab "' + label + '". Safe layout reconciliation will restore placement on reconnect or refresh.';
    persist();
    render();
  }
  if(lag)snapshots.push(publish);else publish();
  return response;
 }
 if(m.type==='agency.tab.action'&&m.action==='select'||m.type==='agency.webTab.select'||m.type==='agency.editorTab.select'){
  state.sessions=state.sessions.map(s=>({...s,tab:{...s.tab,selected:s.tab.id===m.tabId}}));
  state.webTabs=state.webTabs.map(t=>({...t,selected:t.id===m.tabId}));
  if(state.editorTabs) state.editorTabs=state.editorTabs.map(e=>({...e,selected:e.id===m.tabId}));
  persist();render();
 }
 if(m.type==='agency.tab.acknowledge')throw new Error('Background completion must not be inspected');
 return {};
}
function Harness(){
 useDropdownDismissal();
 const [,update]=useState(0);const [mounted,setMounted]=useState(false);const [away,setAway]=useState(false);
 render=()=>update(n=>n+1);
 window.fixture={state,requests,pending,snapshots,emit,delay:v=>delay=v,lag:v=>lag=v,fail:()=>fail=true,failPlacement:()=>failPlacement=true,clearWarning:()=>{state.placementWarning=null;persist();render();},resolve:()=>pending.shift()?.(),snapshot:()=>snapshots.shift()?.(),listeners:()=>listeners.size,
 switchWorkspace:()=>setAway(v=>!v),setLayout(value){state.layout=value;persist();render()},
 finish(tabId){window.finished=tabId;render()},
 };
 const profile={id:'fixture-profile',label:'Fixture CLI',configurationStatus:'available',capabilities:{canLaunch:true},configured:true,available:true,command:'sh'};
 return <><button id="start" onClick={()=>setMounted(true)}>Start isolated fixture</button>
 {mounted&&!away&&<AgencyWorkspaceView workspace={{id:ws,projectId:other,name:'Pane interactions · synthetic data',status:'active',cwd:'/fixture',createdAt:now,updatedAt:now}}
 profiles={[profile]} sessions={state.sessions} webTabs={state.webTabs} editorTabs={state.editorTabs || []} connection={connection} request={request} sendImmediate={connection.sendImmediate} online={true} onDone={()=>{}}
 savedLayout={state.layout} onSaveLayout={async(id,value)=>{state.layout=value;persist()}}
 placementWarning={state.placementWarning} onClearPlacementWarning={()=>{state.placementWarning=null;persist();render();}}
 getTabActivity={(ws,tab)=>tab===window.finished?'finished':'working'} getTabActivityVersion={()=>'turn-1'} onAcknowledgeTab={(ws,tab)=>request({type:'agency.tab.acknowledge',tabId:tab})}/>}</>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
`;
export const html=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>
:root{color-scheme:dark;font-family:system-ui;--agency-raised:#181b24;--agency-line:#ffffff20;--agency-muted:#94a3b8;--agency-text:#e2e8f0;--agency-bg:#12141a}
html,body,#root{height:100%;margin:0;background:#0f1117;color:#e2e8f0}*{box-sizing:border-box}#root{display:flex;flex-direction:column}#start{flex-shrink:0;height:26px;background:#181b24;color:#94a3b8;border:0;text-align:left}
.agency-workspace-view{flex:1;min-height:0;display:flex;flex-direction:column}.maw-workspace-topbar{min-height:32px}.maw-terminal-park{display:none}
</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`;

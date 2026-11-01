// Local-only browser regression. Run: node --test packages/web/src/agency/browser-tabs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgencyApp} from './src/agency/AgencyApp.tsx';
const ws='11111111-1111-4111-8111-111111111111', p='22222222-2222-4222-8222-222222222222';
const native='33333333-3333-4333-8333-333333333333', web='44444444-4444-4444-8444-444444444444';
const now=new Date().toISOString();
const project={id:p,name:'Project',status:'active',createdAt:now,updatedAt:now};
const profile={id:'codex-0',label:'Codex 00',provider:'codex',executable:'/fixture/codex-0',args:[],environmentOverrides:{},configurationStatus:'available',configurationMessage:null,capabilities:{canLaunch:true,canResumeNativeSession:false,canInterrupt:true,canReportActivity:false,canSelectModel:false,canSelectEffort:false,canRequestPermissions:false,models:[],discovery:'unavailable'}};
const workspace={id:ws,projectId:p,name:'Workspace',status:'active',cwd:'/fixture',createdAt:now,updatedAt:now};
let sessions=[{id:'session',workspaceId:ws,kind:'terminal',terminalId:'term',lifecycle:'running',activity:'idle',exitCode:null,tab:{id:native,order:0,selected:true,current:true,closedAt:null,name:'Native shell',terminalNumber:1}}];
sessions.push({...sessions[0],id:'cli-session',kind:'agent',profileId:'codex-0',terminalId:null,lifecycle:'exited',tab:{...sessions[0].tab,id:'66666666-6666-4666-8666-666666666666',order:2,selected:false,name:'Native CLI'}});
let tabs=[{id:web,workspaceId:ws,kind:'web',title:'Research',url:'https://chatgpt.com/',order:1,selected:false,closedAt:null,createdAt:now,updatedAt:now,targetRef:'target',runtimeState:'ready'}];
let activities=[{workspaceId:ws,tabId:web,state:'finished',updatedAt:now,reliableSignal:true,source:'browser'}];
let notifications=[{id:'55555555-5555-4555-8555-555555555555',workspaceId:ws,tabId:web,title:'Research',body:'Browser finished',state:'finished',read:false,createdAt:now,metadata:{kind:'browser',tabName:'Research'}}];
const listeners=new Set(),statuses=new Set(),reopens=new Set(),requests=[];
let status='open';
function emit(m){for(const fn of listeners)fn(m);}
function snapshots(){emit({type:'agency.sessions.snapshot',requestId:'',sessions:structuredClone(sessions)});emit({type:'agency.webTabs.snapshot',requestId:'',tabs:structuredClone(tabs)});}
const api={requests,failRename:false,failSelect:false,failActivationOnce:false,setStatus(next){status=next; for(const fn of statuses)fn(next); if(next==='open')for(const fn of reopens)fn();},emit,finish(){activities=activities.map(a=>({...a,state:'finished',updatedAt:new Date().toISOString()}));emit({type:'agency.tab.activity',activity:activities[0]});}};
const connection={getStatus:()=>status,onStatus:fn=>(statuses.add(fn),()=>statuses.delete(fn)),onReopen:fn=>(reopens.add(fn),()=>reopens.delete(fn)),onMessage:fn=>(listeners.add(fn),()=>listeners.delete(fn)),send(m){return this.sendImmediate(m);},sendImmediate(m){
if(status!=='open')return false; requests.push(m);
queueMicrotask(()=>{
const reply=(type,extra={})=>emit({type,requestId:m.requestId,...extra});
switch(m.type){
case 'agency.projects.list':reply('agency.projects.snapshot',{projects:[project]});break;
case 'agency.workspaces.list':reply('agency.workspaces.snapshot',{workspaces:[workspace]});break;
case 'agency.profiles.list':reply('agency.profiles.snapshot',{profiles:[profile]});break;
case 'agency.session.create':{const id=crypto.randomUUID();const created={...sessions[1],id,launchId:m.launchId,lifecycle:'starting',profileId:m.profileId,tab:{...sessions[1].tab,id:crypto.randomUUID(),closedAt:null,current:true,selected:true,name:null,order:9}};sessions=[...sessions.map(s=>({...s,tab:{...s.tab,selected:false}})),created];snapshots();reply('agency.session.created',{session:created});break;}
case 'agency.sessions.list':reply('agency.sessions.snapshot',{sessions:structuredClone(sessions)});break;
case 'agency.webTabs.list':reply('agency.webTabs.snapshot',{tabs:structuredClone(tabs)});break;
case 'agency.notifications.list':reply('agency.notifications.snapshot',{notifications:structuredClone(notifications),activityStates:structuredClone(activities)});break;
case 'terminal.attach':emit({type:'terminal.replay',terminalId:'term',data:'native prompt\\r\\n',truncated:false});break;
case 'agency.tab.action':
 if(m.action==='close'){sessions=sessions.map(s=>s.tab.id===m.tabId?{...s,tab:{...s.tab,closedAt:now,selected:false}}:s);snapshots();reply('agency.sessions.snapshot',{sessions:structuredClone(sessions)});break;}
case 'agency.webTab.select':
 if(api.failSelect || (m.type==='agency.webTab.select' && api.failActivationOnce && tabs.find(t=>t.id===m.tabId)?.selected)){api.failActivationOnce=false;reply('agency.error',{message:'Selection failed',code:'session-unavailable'});break;}
 sessions=sessions.map(s=>({...s,tab:{...s.tab,selected:s.tab.id===m.tabId}}));tabs=tabs.map(t=>({...t,selected:t.id===m.tabId}));snapshots();
 if(m.type==='agency.webTab.select')reply('agency.webTab.updated',{tab:tabs.find(t=>t.id===m.tabId)});else reply('agency.session.changed',{session:sessions[0]});break;
case 'agency.notification.markRead':notifications=notifications.map(n=>n.id===m.notificationId?{...n,read:true,readAt:new Date().toISOString()}:n);reply('agency.notification.changed',{notification:notifications[0]});break;
case 'agency.tab.acknowledge':activities=activities.map(a=>({...a,state:'idle'}));reply('agency.tab.activity',{activity:activities[0]});break;
case 'agency.webTab.close':tabs=tabs.map(t=>t.id===m.tabId?{...t,closedAt:now,selected:false}:t);sessions=sessions.map(s=>({...s,tab:{...s.tab,selected:s.tab.id===native}}));snapshots();reply('agency.webTab.closed',{tab:tabs.find(t=>t.id===m.tabId)});break;
case 'agency.tabs.order':sessions=sessions.map(s=>({...s,tab:{...s.tab,order:m.tabIds.indexOf(s.tab.id)}}));tabs=tabs.map(t=>({...t,order:m.tabIds.indexOf(t.id)}));snapshots();reply('agency.sessions.snapshot',{sessions:structuredClone(sessions)});break;
case 'agency.tab.rename':
 if(api.failRename){reply('agency.error',{message:'Rename failed',code:'internal-error'});break;}
 sessions=sessions.map(s=>s.tab.id===m.tabId?{...s,tab:{...s.tab,name:m.name}}:s);reply('agency.sessions.snapshot',{sessions:structuredClone(sessions)});break;
case 'agency.webTab.rename':tabs=tabs.map(t=>t.id===m.tabId?{...t,title:m.title}:t);reply('agency.webTab.updated',{tab:tabs.find(t=>t.id===m.tabId)});break;
case 'agency.webTab.navigate':tabs=tabs.map(t=>t.id===m.tabId?{...t,url:m.url}:t);reply('agency.webTab.updated',{tab:tabs.find(t=>t.id===m.tabId)});break;
}
});return true;}};
window.agencyTest=api;
localStorage.setItem('agency-ui.selected-workspace.v1',ws);
createRoot(document.getElementById('root')).render(<AgencyApp connection={connection}/>);
`;

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = homedir() + '/.cache/ms-playwright';
  for (const folder of existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse() : []) {
    const path = cache + '/' + folder + '/chrome-headless-shell-linux64/chrome-headless-shell';
    if (existsSync(path)) return path;
  }
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

test('Browser compatibility preserves CLI input, mixed tabs and external ChatGPT fallback', { timeout: 60000 }, async t => {
  const executablePath = browserExecutable();
  if (!executablePath) { t.skip('Chromium is not installed; set PLAYWRIGHT_CHROMIUM_EXECUTABLE'); return; }
  const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: process.cwd() + '/packages/web' }, bundle: true, write: false, format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<html lang="en"><style>html,body,#root{height:100%;margin:0}.agency-app{display:flex;height:100%}.agency-main{flex:1;min-width:0}.agency-sidebar{width:240px}.maw-session-content{height:600px}.maw-session-pane{height:100%}.maw-session-pane[hidden]{display:none}.agency-agent-body,.agency-xterm-host,.terminal{height:500px}.maw-browser-viewer{height:450px}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless:true, executablePath });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport:{width:1280,height:1000} });
  page.setDefaultTimeout(8000);
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('tab', {name:'Native shell'}).waitFor();
  await page.locator('.xterm-helper-textarea').press('Control+c');
  await page.waitForFunction(() => window.agencyTest.requests.some(m=>m.type==='input' && m.data==='\x03'));
  await page.getByRole('button', {name:'Notifications',exact:true}).click();
  await page.evaluate(() => window.agencyTest.failSelect=true);
  await page.getByRole('article').filter({hasText:'Research'}).click();
  await page.getByRole('alert').filter({hasText:'Session is unavailable'}).waitFor();
  assert.equal(await page.evaluate(() => window.agencyTest.requests.filter(m=>m.type==='agency.tab.acknowledge'||m.type==='agency.notification.markRead').length),0);
  await page.evaluate(() => {window.agencyTest.failSelect=false;});
  await page.getByRole('article').filter({hasText:'Research'}).click();
  await page.getByRole('link',{name:'Open ChatGPT',exact:true}).waitFor();
  assert.equal(await page.locator('iframe').count(),0);
  assert.equal(await page.evaluate(() => window.agencyTest.requests.filter(m=>m.type==='agency.tab.acknowledge'||m.type==='agency.notification.markRead').length),0,'an external link is not evidence of viewing a conversation');
  await page.getByRole('tab',{name:'Research'}).press('F2');
  await page.getByLabel('Tab title',{exact:true}).fill('Renamed research');
  await page.getByLabel('Tab title',{exact:true}).press('Enter');
  await page.getByRole('tab',{name:'Renamed research'}).waitFor();
  await page.getByRole('tab',{name:'Renamed research'}).press('Alt+ArrowLeft');
  await page.waitForFunction(()=>window.agencyTest.requests.some(m=>m.type==='agency.tabs.order' && m.tabIds[0]==='44444444-4444-4444-8444-444444444444'));
  const before=await page.evaluate(()=>window.agencyTest.requests.filter(m=>m.type==='agency.webTabs.list').length);
  await page.evaluate(()=>{window.agencyTest.setStatus('closed');window.agencyTest.setStatus('open');});
  await page.waitForFunction(before=>window.agencyTest.requests.filter(m=>m.type==='agency.webTabs.list').length>before,before);
  await page.getByRole('button',{name:'Close Renamed research',exact:true}).click();
  await page.getByRole('tab',{name:'Renamed research'}).waitFor({state:'detached'});
  const shell = page.getByRole('tab', {name:'Native shell'});
  await shell.waitFor();
  assert.equal(await page.locator('iframe').count(),0);
  assert.equal(await shell.getAttribute('aria-selected'),'true');
  assert.equal(await page.evaluate(()=>window.agencyTest.requests.filter(m=>m.type==='terminal.close').length),0);
  await shell.focus();
  await shell.press('F2');
  const input = page.getByLabel('Tab title',{exact:true});
  await input.fill('Cancelled'); await input.press('Escape');
  await shell.waitFor(); await page.waitForFunction(()=>document.activeElement?.id==='tab-33333333-3333-4333-8333-333333333333');
  await shell.locator('.agency-truncate').dblclick();
  await input.fill('Blur cancels'); await page.getByRole('button',{name:'Workspace options',exact:true}).focus();
  await shell.waitFor();
  await shell.press('F2'); await input.fill('   '); await input.press('Enter');
  assert.equal(await input.getAttribute('aria-invalid'),'true');
  await input.fill('Shell renamed');
  await page.evaluate(()=>window.agencyTest.failRename=true); await input.press('Enter');
  await page.waitForFunction(()=>window.agencyTest.requests.some(m=>m.type==='agency.tab.rename'));
  await page.getByRole('alert').filter({hasText:/error|failed/i}).first().waitFor();
  assert.equal(await input.count(),1,'failed save retains edit and old title');
  await page.evaluate(()=>window.agencyTest.failRename=false); await input.press('Enter');
  await page.getByRole('tab',{name:'Shell renamed'}).waitFor();
  assert.equal(await page.evaluate(()=>window.agencyTest.requests.filter(m=>m.type==='agency.tab.rename').every(m=>m.tabId==='33333333-3333-4333-8333-333333333333')),true);
  await page.getByRole('tab',{name:'Native CLI'}).press('F2');
  await input.fill('CLI renamed'); await input.press('Enter');
  await page.getByRole('tab',{name:'CLI renamed'}).waitFor();
  assert.equal(await page.evaluate(()=>window.agencyTest.requests.filter(m=>m.type==='agency.tab.rename').at(-1).tabId),'66666666-6666-4666-8666-666666666666');
  await page.getByRole('button',{name:'Add tab',exact:true}).click();
  await page.getByRole('menuitem',{name:'Rename tab',exact:true}).click();
  await input.waitFor(); await input.press('Escape');
  // C-2: an exited agent tab without a native conversation offers Configure profile and Start again.
  await page.getByRole('tab',{name:'CLI renamed'}).click();
  await page.getByRole('button',{name:'Configure profile',exact:true}).click();
  await page.getByRole('dialog',{name:'Configure profile'}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog',{name:'Configure profile'}).waitFor({state:'detached'});
  await page.getByRole('button',{name:'Start again',exact:true}).click();
  await page.waitForFunction(()=>window.agencyTest.requests.some(m=>m.type==='agency.session.create'));
  const replaced=await page.evaluate(()=>window.agencyTest.requests.filter(m=>(m.type==='agency.tab.action'&&m.action==='close')||m.type==='agency.session.create').map(m=>m.type+':'+(m.tabId??m.profileId)));
  assert.deepEqual(replaced,['agency.tab.action:66666666-6666-4666-8666-666666666666','agency.session.create:codex-0']);
  assert.deepEqual(errors,[]);
});

// Browser tab reconnect and recovery regression test
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
let tabs=[{id:web,workspaceId:ws,kind:'web',title:'ChatGPT Restored',url:'https://chatgpt.com/c/chat-restored',order:1,selected:false,closedAt:null,createdAt:now,updatedAt:now,targetRef:'target',runtimeState:'ready'}];
const listeners=new Set(),statuses=new Set(),reopens=new Set(),requests=[];
let status='open';
function emit(m){for(const fn of listeners)fn(m);}
function snapshots(){emit({type:'agency.sessions.snapshot',requestId:'',sessions:structuredClone(sessions)});emit({type:'agency.webTabs.snapshot',requestId:'',tabs:structuredClone(tabs)});}
const api={requests,failSelect:false,setStatus(next){status=next; for(const fn of statuses)fn(next); if(next==='open')for(const fn of reopens)fn();},emit};
const connection={getStatus:()=>status,onStatus:fn=>(statuses.add(fn),()=>statuses.delete(fn)),onReopen:fn=>(reopens.add(fn),()=>reopens.delete(fn)),onMessage:fn=>(listeners.add(fn),()=>listeners.delete(fn)),send(m){return this.sendImmediate(m);},sendImmediate(m){
if(status!=='open')return false; requests.push(m);
queueMicrotask(()=>{
const reply=(type,extra={})=>emit({type,requestId:m.requestId,...extra});
switch(m.type){
case 'agency.projects.list':reply('agency.projects.snapshot',{projects:[project]});break;
case 'agency.workspaces.list':reply('agency.workspaces.snapshot',{workspaces:[workspace]});break;
case 'agency.profiles.list':reply('agency.profiles.snapshot',{profiles:[profile]});break;
case 'agency.sessions.list':reply('agency.sessions.snapshot',{sessions:structuredClone(sessions)});break;
case 'agency.webTabs.list':reply('agency.webTabs.snapshot',{tabs:structuredClone(tabs)});break;
case 'agency.notifications.list':reply('agency.notifications.snapshot',{notifications:[],activityStates:[]});break;
case 'terminal.attach':emit({type:'terminal.replay',terminalId:'term',data:'native prompt\\r\\n',truncated:false});break;
case 'agency.webTab.select':
 if(api.failSelect){reply('agency.error',{message:'Browser engine is not configured or unavailable',code:'session-unavailable'});break;}
 sessions=sessions.map(s=>({...s,tab:{...s.tab,selected:s.tab.id===m.tabId}}));tabs=tabs.map(t=>({...t,selected:t.id===m.tabId}));snapshots();
 reply('agency.webTab.updated',{tab:tabs.find(t=>t.id===m.tabId)});break;
}
});return true;}};
window.agencyTest=api;
localStorage.setItem('agency-ui.selected-workspace.v1',ws);
createRoot(document.getElementById('root')).render(<AgencyApp connection={connection}/>);
`;

const mediaPage = `<!doctype html><video autoplay muted playsinline></video><script>
window.startMedia=async()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const context=canvas.getContext('2d');let i=0;setInterval(()=>{context.fillStyle=i++%2?'blue':'red';context.fillRect(0,0,640,480)},80);const video=document.querySelector('video');video.srcObject=canvas.captureStream(10);await video.play();const params=new URLSearchParams(location.search);parent.postMessage({type:'agency.browser.viewer.ready',workspaceId:params.get('workspaceId'),tabId:params.get('tabId')},location.origin);};
</script>`;

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

test('Persisted ChatGPT tab with unconfigured browser engine displays clear guidance and recovers when available', { timeout: 60000 }, async t => {
  const executablePath = browserExecutable();
  if (!executablePath) { t.skip('Chromium is not installed; set PLAYWRIGHT_CHROMIUM_EXECUTABLE'); return; }
  let configured = false;
  const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: process.cwd() + '/packages/web' }, bundle: true, write: false, format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); }
    else if (url.pathname === '/api/agency/browser/viewer/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(configured ? { configured: true, ready: true, url: '/api/agency/browser/viewer/' } : { configured: false, ready: false }));
    }
    else if (url.pathname === '/api/agency/browser/viewer') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: '/api/agency/browser/viewer/' + url.search, workspaceId: url.searchParams.get('workspaceId'), tabId: url.searchParams.get('tabId') })); }
    else if (url.pathname === '/api/agency/browser/viewer/') { res.setHeader('Content-Type', 'text/html'); res.end(mediaPage); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<html lang="en"><style>html,body,#root{height:100%;margin:0}.agency-app{display:flex;height:100%}.agency-main{flex:1;min-width:0}.agency-sidebar{width:240px}.maw-session-content{height:600px}.maw-session-pane{height:100%}.maw-session-pane[hidden]{display:none}.agency-agent-body,.agency-xterm-host,.terminal{height:500px}.maw-neko-frame{height:400px;width:100%}.maw-browser-viewer{height:450px}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(8000);

  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('tab', { name: 'Native shell' }).waitFor();

  // Select the ChatGPT web tab
  await page.getByRole('tab', { name: 'ChatGPT Restored' }).click();

  // Verify the saved URL remains intact in the toolbar
  await page.locator('.maw-browser-toolbar').filter({ hasText: 'https://chatgpt.com/c/chat-restored' }).waitFor();

  // Verify that the not-configured message is displayed rather than vague targetUnavailable
  await page.getByText('Browser viewer is not configured.').first().waitFor();
  assert.equal(await page.getByText('Browser target is unavailable. Select the tab again to reconnect.').count(), 0);

  // Click Reconnect viewer while still unconfigured - should remain clearly reported as not configured
  await page.getByRole('button', { name: 'Reconnect viewer', exact: true }).click();
  await page.getByText('Browser viewer is not configured.').first().waitFor();
  assert.equal(await page.locator('iframe').count(), 0);

  // When engine becomes configured and available, reconnect recovers the viewer
  configured = true;
  await page.getByRole('button', { name: 'Reconnect viewer', exact: true }).click();
  await page.locator('iframe').waitFor();
  assert.equal(await page.locator('iframe').count(), 1);
});

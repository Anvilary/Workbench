// Linux Electron, production MAW components/CSS and actual OS mouse input.
// Every native page and all profile/session records here are synthetic.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {_electron as electron} from 'playwright';
import {serveFixture,start,frames,pane,order,root} from '../web/src/agency/split/pane-interactions-harness.mjs';
const require=createRequire(import.meta.url),exec=promisify(execFile);
const here=path.dirname(new URL(import.meta.url).pathname);
const artifactDir=process.env.MAW_PANE_EVIDENCE_DIR;

async function eventually(check,message='native pane state'){
 for(let n=0;n<200;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,40))}
 assert.fail('Timed out waiting for '+message);
}
async function setup(t,query){
 const url=await serveFixture(t),data=await mkdtemp(path.join(tmpdir(),'maw-pane-interactions-'));
 const env={...process.env,MAW_DESKTOP_URL:url+'/?'+query,MAW_DESKTOP_DATA_DIR:data,MAW_DOWNLOAD_AUTO_SAVE:'1'};
 let desktop;
 t.after(async()=>{if(desktop)await desktop.close();await rm(data,{recursive:true,force:true})});
 const launch=async()=>{
  desktop=await electron.launch({chromiumSandbox:true,executablePath:require('electron'),args:[here,'--ozone-platform=x11'],env});
  await desktop.evaluate(({session,app,BrowserWindow},data)=>{
   BrowserWindow.getAllWindows()[0].setPosition(0,0);
   app.setPath('downloads',data);
   const chat=session.fromPartition('persist:maw-chatgpt');
   chat.protocol.handle('https',req=>{
    if(new URL(req.url).pathname==='/sample.txt')return new Response('Synthetic download after pane swap',{headers:{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="swap.txt"'}});
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Synthetic ChatGPT</title><style>body{margin:0;background:#202123;color:#ececf1;font:15px system-ui}header{padding:18px;border-bottom:1px solid #444}main{padding:24px}textarea{display:block;width:90%;height:60px;margin:10px 0;background:#303136;color:white;border:1px solid #666;padding:10px}a{color:#81c2b5}p{line-height:1.8}</style></head><body><header>◎ ChatGPT · synthetic acceptance page</header><main><label>Message<textarea>Native page state survives pane swaps</textarea></label><a href="https://chatgpt.com/sample.txt" download>Download fixture</a><p>Existing WebContentsView · isolated temporary profile</p><p>No authenticated owner data is used.</p><div style="height:1400px;background:linear-gradient(#202123,#242934)"></div></main></body></html>`,{headers:{'Content-Type':'text/html'}});
   });
   globalThis.paneLifecycle=[];
   app.on('web-contents-created',(_event,contents)=>{
    if(contents.session!==chat)return;
    for(const event of ['did-start-loading','destroyed','render-process-gone'])contents.on(event,()=>globalThis.paneLifecycle.push({id:contents.id,event}));
   });
  },data);
  const page=await desktop.firstWindow();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.locator('#start').click();await page.waitForSelector('.maw-split-pane');await frames(page);
  return page;
 };
 const page=await launch();
 const identities=()=>desktop.evaluate(({webContents,session})=>webContents.getAllWebContents().filter(c=>c.session===session.fromPartition('persist:maw-chatgpt')).map(c=>c.id).sort((a,b)=>a-b));
 const attached=()=>desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.filter(v=>v.webContents).map(v=>v.webContents.id).sort((a,b)=>a-b));
 const nativeCount=query.includes('mode=web')?(query.includes('four')?4:2):query.includes('four')?2:1;
 await eventually(async()=> (await attached()).length===nativeCount);
 await eventually(()=>desktop.evaluate(({webContents,session})=>webContents.getAllWebContents().filter(c=>c.session===session.fromPartition('persist:maw-chatgpt')).every(c=>!c.isLoading())));
 const point=async locator=>{
  const box=await locator.boundingBox(),origin=await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getContentBounds());
  return {x:Math.round(origin.x+box.x+box.width/2),y:Math.round(origin.y+box.y+box.height/2)};
 };
 const mouse=async(x,y,...commands)=>exec('xdotool',['mousemove','--sync',String(Math.round(x)),String(Math.round(y)),...commands]);
 const osDrag=async(from,to,{cancel=false,outside=false,record=false}={})=>{
  const source=await point(pane(page,from).locator('.maw-pane-grip')),target=await point(pane(page,to));
  await mouse(source.x,source.y,'mousedown','1');await mouse(source.x+12,source.y);
  await page.waitForSelector('.maw-pane-drag-shield');
  await eventually(async()=> (await attached()).length===0,'temporary shield captures and conceals native surfaces');
  assert.equal(await page.locator('.maw-capture-backdrop').count(),nativeCount);
  assert.equal(await page.locator('.maw-pane-drag-preview textarea,.maw-pane-drag-preview canvas').count(),0);
  for(let n=1;n<=12;n++)await mouse(source.x+(target.x-source.x)*n/12,source.y+(target.y-source.y)*n/12);
  if(!cancel&&!outside&&from!==to){await page.waitForFunction(n=>document.getElementById('pane-container-pane-'+n)?.classList.contains('is-pane-drop-target'),to)}
  if(record&&artifactDir)await screenshot('03-pane-landing.png');
  if(cancel)await exec('xdotool',['key','Escape']);
  if(outside)await mouse(5,5);
  await exec('xdotool',['mouseup','1']);
  await page.waitForSelector('.maw-pane-drag-shield',{state:'detached'});
  await eventually(async()=> (await attached()).length===nativeCount,'native surfaces restored after drag');await frames(page,16);
 };
 const screenshot=async name=>{
  if(!artifactDir)return;await mkdir(artifactDir,{recursive:true});
  // This display contains only our synthetic, temporary Electron instance.
  await exec('ffmpeg',['-y','-loglevel','error','-f','x11grab','-video_size','1280x860','-i',process.env.DISPLAY+'+0,0','-frames:v','1',path.join(artifactDir,name)]);
 };
 return {page,desktop:()=>desktop,identities,attached,osDrag,mouse,point,screenshot,data,restart:async()=>{await desktop.close();return launch()}};
}

for(const query of ['mode=mixed','mode=cli-web','mode=web','mode=mixed&shape=four-grid','mode=web&shape=four-grid','mode=web&shape=four-asymmetric'])test('OS pane drag over native surfaces: '+query,{timeout:90000},async t=>{
 const app=await setup(t,query),{page,identities,attached,osDrag}=app;
 const original=await identities(),lifecycle=await app.desktop().evaluate(()=>globalThis.paneLifecycle);
 assert.equal(await app.desktop().evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox),true);
 const listeners=await page.evaluate(()=>window.fixture.listeners());
 const before=await order(page);const target=query.includes('four')?4:2;
 await page.evaluate(()=>window.fixture.finish('22222222-2222-4222-8222-222222222222'));
 await osDrag(1,target,{record:true});
 const expected=[...before];[expected[0],expected[target-1]]=[expected[target-1],expected[0]];assert.deepEqual(await order(page),expected);
 assert.deepEqual(await identities(),original);assert.deepEqual(await attached(),original);
 assert.equal(await page.evaluate(()=>window.fixture.state.layout.focusedPaneId),'pane-1');
 assert.equal(await page.evaluate(()=>window.fixture.requests.some(m=>m.type==='agency.tab.acknowledge')),false);
 await app.screenshot(query.includes('four-asymmetric')?'04-asymmetric-swapped.png':query.includes('four')?'04-grid-swapped.png':'04-panes-swapped.png');
 for(let n=0;n<3;n++)await osDrag(1,target);
 assert.deepEqual(await identities(),original);assert.deepEqual(await attached(),original);
 assert.deepEqual(await app.desktop().evaluate(()=>globalThis.paneLifecycle),lifecycle,'drag cannot reload, navigate or recreate native pages');
 assert.equal(await page.evaluate(()=>window.fixture.listeners()),listeners);
 assert.equal(await page.evaluate(()=>window.disposed),0);
 assert.equal(await page.evaluate(()=>window.fixture.requests.filter(m=>m.type==='terminal.attach').length),query.includes('mode=web')?0:query.includes('four')?2:1);
 assert.equal(await page.evaluate(()=>window.fixture.requests.some(m=>m.type==='input'||m.type==='terminal.detach')),false);
});

test('native menu, creation, cancellation, clipboard, download and cold restart',{timeout:90000},async t=>{
 const app=await setup(t,'mode=web'),{page,osDrag}=app;
 let recording;
 if(artifactDir){await mkdir(artifactDir,{recursive:true});recording=spawn('ffmpeg',['-y','-loglevel','error','-f','x11grab','-framerate','12','-video_size','1280x860','-i',process.env.DISPLAY+'+0,0','-c:v','libvpx-vp9','-crf','38','-b:v','0',path.join(artifactDir,'pane-interactions.webm')],{stdio:['pipe','ignore','pipe']});t.after(async()=>{if(recording?.exitCode===null){recording.stdin.write('q');await new Promise(resolve=>recording.on('exit',resolve))}})}
 await pane(page,2).locator('.maw-pane-add-tab').click();
 await eventually(async()=> (await app.attached()).length<2);await frames(page);await app.screenshot('01-add-menu.png');
 await page.getByRole('menuitem',{name:'New CLI',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await eventually(async()=> (await app.attached()).length===2);
 await pane(page,2).locator('.maw-pane-add-tab').click();await page.getByRole('menuitem',{name:'New Terminal',exact:true}).click();
 await page.waitForFunction(()=>window.fixture.state.layout.tree.second.tabIds.length===2);await frames(page,16);
 assert.equal(await pane(page,2).getByRole('tab').count(),2);
 await page.evaluate(async()=>{const term=window.terminals[0];await new Promise(resolve=>term.write('MAW isolated acceptance terminal\r\nExisting sessions remain alive during pane swaps.\r\n$ ',resolve))});
 await app.screenshot('02-terminal-in-right-pane.png');
 // Select the existing page, preserving its identity, then cancel a drag.
 await pane(page,2).getByRole('tab',{name:/ChatGPT 2/}).click();await eventually(async()=> (await app.attached()).length===2);
 const before=await order(page);await osDrag(1,2,{cancel:true});assert.deepEqual(await order(page),before);
 await osDrag(1,2,{outside:true});assert.deepEqual(await order(page),before);
 await osDrag(1,2,{record:true});assert.deepEqual(await order(page),['pane-2','pane-1']);
 const ids=await app.identities();
 // OS input now goes to the moved native page, proving the shield has been removed.
 const bounds=await app.desktop().evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];const view=win.contentView.children.find(v=>v.webContents);return {outer:win.getContentBounds(),inner:view.getBounds()}});
 await app.mouse(bounds.outer.x+bounds.inner.x+80,bounds.outer.y+bounds.inner.y+140,'click','1');
 await exec('xdotool',['key','ctrl+a']);await exec('xdotool',['key','ctrl+c']);
 await eventually(()=>app.desktop().evaluate(async({clipboard})=>(await clipboard.readText())==='Native page state survives pane swaps'),'native clipboard after swap');
 await app.desktop().evaluate(({webContents},id)=>webContents.fromId(id).downloadURL('https://chatgpt.com/sample.txt'),ids[0]);
 await eventually(async()=>{try{return (await readFile(path.join(app.data,'swap.txt'),'utf8')).includes('Synthetic download')}catch{return false}},'native download after swap');
 const divider=await page.locator('.maw-split-divider').boundingBox();await page.mouse.move(divider.x+2,divider.y+40);await page.mouse.down();await page.mouse.move(divider.x+70,divider.y+40,{steps:10});await page.mouse.up();await page.waitForTimeout(250);
 assert.deepEqual(await app.identities(),ids);
 await app.screenshot('05-native-content-restored.png');
 if(recording){recording.stdin.write('q');await new Promise(resolve=>recording.on('exit',resolve));recording=undefined}
 const reopened=await app.restart();await frames(reopened,16);assert.deepEqual(await order(reopened),['pane-2','pane-1']);
});

test('real Linux PTY PID, scrollback, selection and viewport survive native pane swaps',{timeout:60000},async t=>{
 const app=await setup(t,'mode=mixed'),{page,osDrag}=app;
 const serverRequire=createRequire(path.join(root,'packages/server/package.json'));
 const {spawn:spawnPty}=serverRequire('node-pty');
 const terminal=spawnPty('/bin/sh',['-i'],{name:'xterm-256color',cwd:app.data,cols:100,rows:30,env:{PATH:process.env.PATH,TERM:'xterm-256color'}});
 const pid=terminal.pid;
 t.after(()=>{try{terminal.kill()}catch{}});
 await page.exposeFunction('terminalSend',message=>{
  if(message.terminalId!=='term-1')return;
  if(message.type==='input')terminal.write(message.data);
  if(message.type==='resize')terminal.resize(message.cols,message.rows);
 });
 const subscription=terminal.onData(data=>void page.evaluate(data=>window.fixture.emit({type:'terminal.output',terminalId:'term-1',data}),data).catch(()=>{}));
 t.after(()=>subscription.dispose());
 terminal.write("printf 'MAW_PID=%s\\n' $$; seq 1 180 | sed 's/^/PTY-LINE-/'\r");
 await page.waitForFunction(()=>window.terminals[0]?.buffer.active.getLine(window.terminals[0].buffer.active.length-2)?.translateToString(true).includes('#')||Array.from({length:window.terminals[0]?.buffer.active.length||0},(_,n)=>window.terminals[0].buffer.active.getLine(n)?.translateToString(true)).some(line=>line?.includes('PTY-LINE-180')));
 const initial=await page.evaluate(()=>{
  const term=window.terminals[0];term.scrollToLine(3);term.select(0,4,10);
  return {selection:term.getSelection(),viewport:term.buffer.active.viewportY,buffer:Array.from({length:term.buffer.active.length},(_,n)=>term.buffer.active.getLine(n)?.translateToString(true)).join('\n')};
 });
 assert.match(initial.buffer,new RegExp('MAW_PID='+pid));assert.match(initial.buffer,/PTY-LINE-180/);
 for(let n=0;n<4;n++)await osDrag(1,2);
 assert.equal(terminal.pid,pid);assert.doesNotThrow(()=>process.kill(pid,0));
 const after=await page.evaluate(()=>({selection:window.terminals[0].getSelection(),viewport:window.terminals[0].buffer.active.viewportY,disposed:window.disposed,attaches:window.fixture.requests.filter(m=>m.type==='terminal.attach').length,inputs:window.fixture.requests.filter(m=>m.type==='input')}));
 assert.equal(after.selection,initial.selection);assert.equal(after.viewport,initial.viewport);assert.equal(after.disposed,0);assert.equal(after.attaches,1);assert.deepEqual(after.inputs,[]);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,frames,pane,order,drag} from '../../fixtures/pane-interactions-harness.mjs';

const layout=page=>page.evaluate(()=>window.fixture.state.layout);
const menu=(page,n)=>pane(page,n).locator('.maw-pane-add-tab');
const paneAction=(page,n)=>pane(page,n).locator('.maw-pane-menu-toggle');
const create=async(page,n,kind)=>{
 await menu(page,n).click();
 await page.getByRole('menuitem',{name:kind==='terminal'?'New Terminal':kind==='web'?'Web Page':'Open File...',exact:true}).click();
 if(kind==='web'){await page.getByRole('dialog').getByRole('menuitem',{name:'ChatGPT',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Open',exact:true}).click();}
 if(kind==='file'){
   await page.getByRole('dialog').locator('input').fill('src/index.ts');
   await page.getByRole('dialog').getByRole('button',{name:'Open',exact:true}).click();
 }
};

test('add menu escapes overflow, clamps at edges, navigates with keys, closes outside/Escape and is exclusive',async t=>{
 const page=await setup(t,'shape=four-grid');
 for(let n=1;n<=4;n++){
  await menu(page,n).click();
  assert.equal(await page.getByRole('menu').count(),1);
  assert.equal(await page.getByRole('menu').evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+12))&&r.x>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}),true);
  assert.equal(await page.getByRole('menuitem').first().evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('ArrowDown');assert.equal(await page.getByRole('menuitem').nth(1).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('End');await page.keyboard.press('Home');
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('menu').count(),0);assert.equal(await menu(page,n).evaluate(el=>el===document.activeElement),true);
 }
 await menu(page,1).click();await menu(page,2).click();assert.equal(await page.getByRole('menu').count(),1);
 await page.locator('#start').click();assert.equal(await page.getByRole('menu').count(),0);
 await page.setViewportSize({width:620,height:400});
 for(let n=1;n<=4;n++){
  await menu(page,n).click();const r=await page.getByRole('menu').boundingBox();assert.ok(r.x>=0&&r.x+r.width<=620&&r.y+r.height<=400);await page.keyboard.press('Escape');
 }
 // Position a real anchor near the bottom edge; popup must flip above it.
 await menu(page,4).evaluate(el=>{el.style.position='fixed';el.style.bottom='4px';el.style.right='4px';el.style.zIndex='140'});
 await menu(page,4).click();const box=await page.getByRole('menu').boundingBox();assert.ok(box.y+box.height<370);
});

for(const kind of ['terminal','web'])test(`create ${kind} in its initiating pane, preserving its neighbor`,async t=>{
 const page=await setup(t);const before=await layout(page);
 await create(page,2,kind);await page.waitForFunction(()=>window.fixture.state.layout.tree.second.tabIds.length===2);
 const after=await layout(page);assert.deepEqual(after.tree.first,before.tree.first);assert.equal(after.focusedPaneId,'pane-2');assert.equal(after.tree.second.selectedTabId,after.tree.second.tabIds[1]);
 assert.equal(await page.evaluate(kind=>window.fixture.requests.filter(m=>m.type===(kind==='web'?'agency.webTab.create':kind==='file'?'agency.editorTab.open':'agency.session.create')).length,kind),1);
 assert.equal(await page.evaluate(()=>window.fixture.requests.find(m=>m.type==='agency.webTab.create'||m.type==='agency.session.create'||m.type==='agency.editorTab.open').targetPaneId),'pane-2');
 assert.equal(await page.getByRole('menu').count(),0);
});

test('Open File item is disabled with Coming soon tooltip',async t=>{
 const page=await setup(t);
 await menu(page,1).click();
 const item=page.getByRole('menuitem',{name:'Open File...',exact:true});
 assert.equal(await item.getAttribute('aria-disabled'),'true');
 assert.equal(await item.getAttribute('title'),'Coming soon');
 await page.keyboard.press('Escape');
});

test('delayed creation retains destination after focus changes, absent snapshots and target deletion; retry works',async t=>{
 const page=await setup(t);await page.evaluate(()=>{window.fixture.delay(true);window.fixture.lag(true)});
 await create(page,2,'terminal');await page.waitForFunction(()=>window.fixture.pending.length===1);
 await pane(page,1).locator('[role=tab]').click();
 await page.evaluate(()=>window.fixture.resolve());await page.waitForFunction(()=>window.fixture.state.layout.tree.second.tabIds.length===2);
 await frames(page);const before=await layout(page);assert.equal(before.focusedPaneId,'pane-2');
 assert.equal(await pane(page,2).getByRole('tab').count(),2,'creation response renders while snapshot is delayed');
 await page.evaluate(()=>window.fixture.snapshot());await frames(page);assert.deepEqual((await layout(page)).tree,before.tree);
 assert.equal(await pane(page,2).getByRole('tab').count(),2);
 await page.evaluate(()=>window.fixture.lag(false));await create(page,2,'terminal');await page.waitForFunction(()=>window.fixture.pending.length===1);
 // Collapsing to a single pane merges tabs and does not terminate any of its sessions.
 await paneAction(page,2).click();
 await page.getByRole('menuitem',{name:'Single pane',exact:true}).click();
 await page.evaluate(()=>window.fixture.resolve());await page.waitForFunction(()=>window.fixture.state.layout.tree.tabIds.length===4);
 const final=await layout(page);assert.equal(new Set(final.tree.tabIds).size,4);assert.equal(final.focusedPaneId,'pane-1');
 await page.evaluate(()=>{window.fixture.delay(false);window.fixture.fail()});
 await create(page,1,'terminal');await page.getByRole('alert').filter({hasText:'Fixture launch failed'}).waitFor();
 await create(page,1,'terminal');await page.waitForFunction(()=>window.fixture.state.layout.tree.tabIds.length===5);
});

for(const shape of ['row','column','three','four-grid','four-asymmetric'])test(`actual pointer swaps preserve all leaf identities in ${shape}`,async t=>{
 const page=await setup(t,'shape='+shape);const before=await layout(page);const positions=await order(page);const target=shape.startsWith('four')?4:2;
 await drag(page,1,target);const after=await layout(page);const expected=[...positions];const a=expected.indexOf('pane-1'),b=expected.indexOf('pane-'+target);[expected[a],expected[b]]=[expected[b],expected[a]];
 assert.deepEqual(await order(page),expected);assert.equal(after.focusedPaneId,'pane-1');
 const leaves=node=>node.type==='pane'?[node]:[...leaves(node.first),...leaves(node.second)];
 assert.deepEqual(leaves(after.tree).sort((a,b)=>a.id.localeCompare(b.id)),leaves(before.tree).sort((a,b)=>a.id.localeCompare(b.id)));
 assert.equal(await page.evaluate(()=>window.disposed),0);assert.equal(await page.evaluate(()=>window.fixture.requests.filter(m=>m.type==='terminal.attach').length),positions.length);
});

test('self, outside and Escape are no-ops; keyboard swap persists across workspace switch and reload',async t=>{
 const page=await setup(t);const before=(await layout(page)).tree;
 for(const options of [{},{cancel:true},{outside:true}]){await drag(page,1,options.cancel||options.outside?2:1,options);assert.deepEqual((await layout(page)).tree,before)}
 await pane(page,1).locator('.maw-pane-grip').focus();await page.keyboard.press('Enter');await page.getByRole('menuitem',{name:/Swap with pane 2/}).click();
 assert.deepEqual(await order(page),['pane-2','pane-1']);
 await page.evaluate(()=>window.fixture.switchWorkspace());await page.evaluate(()=>window.fixture.switchWorkspace());await frames(page);assert.deepEqual(await order(page),['pane-2','pane-1']);
 await page.reload();await page.locator('#start').click();await frames(page);assert.deepEqual(await order(page),['pane-2','pane-1']);
 await paneAction(page,1).click();
 await page.getByRole('menuitem',{name:'Maximize pane',exact:true}).click();assert.equal(await pane(page,1).locator('.maw-pane-grip').isDisabled(),true);
 await paneAction(page,1).click();
 await page.getByRole('menuitem',{name:'Restore pane',exact:true}).click();await frames(page);assert.equal(await pane(page,1).locator('.maw-pane-grip').isDisabled(),false);
});

test('terminal scrollback, selection, viewport and attachments survive repeated swaps; reduced motion and dividers work',async t=>{
 const page=await setup(t);await page.waitForFunction(()=>window.terminals.length===2);
 const initial=await page.evaluate(async()=>{
  const term=window.terminals[0];await new Promise(resolve=>term.write(Array.from({length:150},(_,n)=>'LINE-'+n).join('\r\n'),resolve));term.scrollToLine(3);term.select(0,4,6);
  return {selection:term.getSelection(),viewport:term.buffer.active.viewportY,listeners:window.fixture.listeners()};
 });
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await pane(page,1).locator('.maw-pane-header').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
 const listenerCount=await page.evaluate(()=>window.fixture.listeners());
 const cdp=await page.context().newCDPSession(page);
 const domListeners=async()=>{
  const counts=[];
  for(const expression of ['window','document']){
   const {result}=await cdp.send('Runtime.evaluate',{expression});
   const {listeners}=await cdp.send('DOMDebugger.getEventListeners',{objectId:result.objectId});
   counts.push(listeners.map(listener=>listener.type+':'+listener.useCapture).sort());
  }
  return counts;
 };
 const initialDomListeners=await domListeners();
 for(let n=0;n<6;n++)await drag(page,1,2);
 const after=await page.evaluate(()=>({selection:window.terminals[0].getSelection(),viewport:window.terminals[0].buffer.active.viewportY,disposed:window.disposed,attaches:window.fixture.requests.filter(m=>m.type==='terminal.attach').length,inputs:window.fixture.requests.filter(m=>m.type==='input'),listeners:window.fixture.listeners()}));
 assert.equal(after.selection,initial.selection);assert.equal(after.viewport,initial.viewport);assert.equal(after.disposed,0);assert.equal(after.attaches,2);assert.deepEqual(after.inputs,[]);assert.equal(after.listeners,listenerCount);assert.deepEqual(await domListeners(),initialDomListeners,'repeated swaps retain a bounded set of document/window listeners');
 const divider=await page.locator('.maw-split-divider').boundingBox();
 await page.mouse.move(divider.x+divider.width/2,divider.y+divider.height/2);await page.mouse.down();await page.mouse.move(divider.x+90,divider.y+divider.height/2,{steps:8});await page.mouse.up();await page.waitForTimeout(250);assert.notEqual((await layout(page)).tree.ratio,.5);
});

test('tab dragging moves only one tab and rejects foreign tab payloads',async t=>{
 const page=await setup(t);await create(page,1,'terminal');await frames(page,12);
 const before=await layout(page),tab=pane(page,1).getByRole('tab').first();
 const a=await tab.boundingBox(),b=await pane(page,2).locator('.maw-pane-tabs').boundingBox();
 await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+45,b.y+b.height/2,{steps:20});await page.mouse.up();await frames(page,12);
 const after=await layout(page);assert.deepEqual(await order(page),['pane-1','pane-2']);assert.equal(after.tree.first.tabIds.length,1);assert.equal(after.tree.second.tabIds.length,2);
 assert.equal(after.tree.second.tabIds.includes(before.tree.first.tabIds[0]),true);
 const data=await page.evaluateHandle(()=>{const d=new DataTransfer();d.setData('application/maw-tab-id','foreign-tab');return d});
 await pane(page,2).locator('.maw-pane-header').dispatchEvent('drop',{dataTransfer:data});await frames(page);assert.deepEqual((await layout(page)).tree,after.tree);
});

test('launch errors surface error banner and web validation prevents unwanted launches',async t=>{
 const page=await setup(t);await page.evaluate(()=>window.fixture.fail());
 await create(page,2,'terminal');await page.getByRole('alert').filter({hasText:'Fixture launch failed'}).waitFor();
 await page.locator('.agency-error-bar button').click();await frames(page);
 assert.equal(await page.locator('.agency-error-bar').count(),0);
 await menu(page,1).click();await page.getByRole('menuitem',{name:'Web Page',exact:true}).click();
 await page.getByRole('dialog').getByLabel('Other',{exact:true}).fill('javascript:alert(1)');
 await page.getByRole('dialog').getByRole('button',{name:'Go',exact:true}).click();
 await page.getByRole('dialog').getByRole('alert').waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.requests.filter(m=>m.type==='agency.webTab.create').length),0);
 await page.keyboard.press('Escape');
});

test('each pane exposes the creation menu in single, two and three-pane layouts',async t=>{
 for(const shape of ['single','row','three']){
  await t.test(shape,async t=>{
   const page=await setup(t,'shape='+shape);const count=await page.locator('.maw-split-pane').count();
   for(let n=1;n<=count;n++){
    await menu(page,n).click();assert.equal(await page.getByRole('menuitem',{name:'New Terminal',exact:true}).isVisible(),true);await page.keyboard.press('Escape');
   }
   if(shape==='single'){
    await create(page,1,'terminal');await frames(page);assert.equal(await page.locator('.maw-split-pane').count(),1);assert.equal((await layout(page)).tree.tabIds.length,2);
   }
  });
 }
});

test('placement failure surfaces notice banner with tab context without failing creation; dismissal works',async t=>{
 const page=await setup(t,'shape=row');
 const notice=page.locator('.agency-notice-bar[role="status"]');

 // 1. Create a terminal successfully, then fail layout persistence
 const initSessions=await page.evaluate(()=>window.fixture.state.sessions.length);
 const initWeb=await page.evaluate(()=>window.fixture.state.webTabs.length);
 await page.evaluate(()=>window.fixture.failPlacement());
 await create(page,2,'terminal');
 // 2. Confirm the creation response indicates success
 await page.waitForFunction(cnt=>window.fixture.state.sessions.length===cnt+1,initSessions);
 // 3. Confirm the correct workspace displays a placement warning
 await notice.waitFor();
 const termText=await notice.textContent();
 assert.match(termText,/Layout placement persistence failure for tab "Terminal/i);
 assert.ok(!termText.includes('/'),'sensitive filesystem details must not be exposed');
 assert.equal(await page.locator('.agency-error-bar[role="alert"]').count(),0,'must keep warning separate from launch failures');
 await notice.getByRole('button',{name:'Dismiss notification'}).click();
 assert.equal(await page.locator('.agency-notice-bar[role="status"]').count(),0);

 // 4. Repeat with a file
 await page.evaluate(()=>window.fixture.failPlacement());
 await create(page,2,'file');
 await page.waitForFunction(cnt=>window.fixture.state.sessions.length+window.fixture.state.editorTabs.length===cnt+2,initSessions);
 await notice.waitFor();
 const fileText=await notice.textContent();
 assert.match(fileText,/Layout placement persistence failure for tab "index\.ts"/i);
 await notice.getByRole('button',{name:'Dismiss notification'}).click();

 // Repeat with a ChatGPT tab
 await page.evaluate(()=>window.fixture.failPlacement());
 await create(page,2,'web');
 await page.waitForFunction(cnt=>window.fixture.state.webTabs.length===cnt+1,initWeb);
 await notice.waitFor();
 const webText=await notice.textContent();
 assert.match(webText,/Layout placement persistence failure for tab "ChatGPT/i);
 await notice.getByRole('button',{name:'Dismiss notification'}).click();
 assert.equal(await page.locator('.agency-notice-bar[role="status"]').count(),0);
});

test('Pane action menu: Split vertically and horizontally create terminal immediately, Escape cancels, failure rolls back cleanly, and layout persists', async t => {
 const page = await setup(t, 'shape=single');
 const initialLayout = await layout(page);
 assert.equal(initialLayout.tree.type, 'pane');

 // 1. Pane actions menu: Escape cancels without modifying layout
 await paneAction(page, 1).click();
 const menu = page.getByRole('menu', { name: 'Pane actions' });
 await menu.waitFor();
 assert.equal(await menu.getByRole('menuitem').count() > 0, true);
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('menu').count(), 0);
 assert.deepEqual(await layout(page), initialLayout);

 // 2. Pane actions menu: clicking outside cancels without modifying layout
 await paneAction(page, 1).click();
 await page.getByRole('menu', { name: 'Pane actions' }).waitFor();
 await page.locator('#start').click();
 assert.equal(await page.getByRole('menu').count(), 0);
 assert.deepEqual(await layout(page), initialLayout);

 // 3. Failed creation in an empty split pane surfaces error banner cleanly
 await page.evaluate(() => { window.fixture.delay(false); window.fixture.fail(); });
 await create(page, 1, 'terminal');
 await page.getByRole('alert').filter({ hasText: 'Fixture launch failed' }).waitFor();
 assert.equal(await page.locator('.maw-split-pane').count(), 1);
 assert.equal((await layout(page)).tree.type, 'pane');
 await page.locator('.agency-error-bar button').click();
 assert.equal(await page.locator('.agency-error-bar').count(), 0);

 // 4. Split vertically creates side-by-side split immediately and persists layout
 await paneAction(page, 1).click();
 await page.getByRole('menuitem', { name: 'Split vertically', exact: true }).click();
 await page.waitForFunction(() => window.fixture.state.layout.tree.type === 'split');
 const splitTree = (await layout(page)).tree;
 assert.equal(splitTree.direction, 'row');
 assert.equal(await page.locator('.maw-split-pane').count(), 2);

 // 5. Split horizontally on pane 2 creates vertical split immediately
 await page.locator('.maw-split-pane').nth(1).locator('.maw-pane-menu-toggle').click();
 await page.getByRole('menuitem', { name: 'Split horizontally', exact: true }).click();
 await page.waitForFunction(() => document.querySelectorAll('.maw-split-pane').length === 3);
 assert.equal(await page.locator('.maw-split-pane').count(), 3);
 const layout3 = await layout(page);
 assert.ok(layout3.tree.second.type === 'split');
 assert.equal(layout3.tree.second.direction, 'column');
});

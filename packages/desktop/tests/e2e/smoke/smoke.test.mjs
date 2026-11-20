// Real Electron processes on a Linux display, but fixture UI and synthetic cookies.
// This deliberately does NOT assert live ChatGPT login compatibility.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { PARTITION } from '../../../policy.mjs';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';
const require = createRequire(import.meta.url);
const here = DESKTOP_ROOT;
const electronExecutable = fs.existsSync('/opt/maw-electron/45.2.0/electron')
  ? '/opt/maw-electron/45.2.0/electron'
  : require('electron');
const browserCss = fs.readFileSync(path.join(here, '../web/src/app/workbench.css'), 'utf8');
const ids = ['8e4fefc1-e565-40cc-b85b-f7d43a16b1df', 'f52e047f-d947-426c-a0fa-c349d035d338'];
const fixture = `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {NativeBrowserView} from './src/features/browser/NativeBrowserView.tsx';
function App(){
  const [id,setId]=useState(null),[overlay,setOverlay]=useState(false),[sidebarMenu,setSidebarMenu]=useState(false);
  return <>
    <nav>
      <button onClick={()=>setId(null)}>CLI</button>
      ${ids.map((id,i)=>`<button onClick={()=>setId('${id}')}>ChatGPT ${i+1}</button>`).join('')}
      <button onClick={()=>setOverlay(!overlay)}>Menu</button>
    </nav>
    <aside>
      <button onClick={()=>setSidebarMenu(!sidebarMenu)}>SidebarActions</button>
      {sidebarMenu&&<div className="agency-dropdown-menu" role="menu"><button onClick={()=>setSidebarMenu(false)}>SidebarAction1</button></div>}
    </aside>
    {overlay&&<div role="menu"><button onClick={()=>setOverlay(false)}>Dismiss</button></div>}
    <main>{id?<NativeBrowserView tab={{id,url:'https://chatgpt.com/'}} toolbarOpen={true} onDisplayed={()=>{}}/>:<input aria-label="CLI fixture"/>}</main>
  </>;
};
createRoot(document.getElementById('root')).render(<App/>);`;
async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail('Timed out waiting for native view state');
}
test('native attachment, retention, overlay safety, security and cold cookie storage', { timeout: 90000 }, async () => {
  const bundle = await build({ stdin: { contents: fixture, resolveDir: path.join(here, '../web'), loader: 'tsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic', logLevel: 'silent' });
  const server = createServer((request, response) => {
    if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].text); }
    else response.end('<!doctype html><html><style>' + browserCss + 'body{margin:0}nav{height:60px}aside{position:absolute;top:60px;left:0;width:200px;bottom:0}.agency-dropdown-menu{position:absolute;z-index:2;top:30px;left:10px;width:150px;background:white}main{position:absolute;top:60px;left:210px;right:0;bottom:0}.maw-browser-pane{height:100%}.maw-browser-viewer{width:100%}[role=menu]:not(.agency-dropdown-menu){position:absolute;z-index:2;top:160px;left:220px;background:white}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const data = await mkdtemp(path.join(tmpdir(), 'maw-electron-smoke-'));
  let desktop;
  const launch = () => electron.launch({chromiumSandbox: true,  executablePath: electronExecutable, args: [here, '--ozone-platform=x11'], env: { ...process.env, MAW_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`, MAW_DESKTOP_DATA_DIR: data } });
  const attached = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.webContents).length);
  const chatIds = () => desktop.evaluate(({ webContents, session }) => webContents.getAllWebContents().filter(contents => contents.session === session.fromPartition('persist:maw-chatgpt')).map(contents => contents.id).sort((a,b) => a-b));
  try {
    desktop = await launch();
    // Entirely synthetic native page: keep lifecycle/security regressions
    // independent of provider/network availability. This is not a login test.
    await desktop.evaluate(({ session }) => {
      session.fromPartition('persist:maw-chatgpt').protocol.handle('https', () => new Response('<!doctype html><title>Native fixture</title><input aria-label="fixture input">', { headers: { 'Content-Type': 'text/html' } }));
    });
    const page = await desktop.firstWindow();
    await page.getByText('ChatGPT 1', { exact: true }).click();
    await eventually(async () => await attached() === 1);
    const first = await chatIds();
    assert.equal(first.length, 1);
    await page.getByText('CLI', { exact: true }).click();
    await eventually(async () => await attached() === 0);
    assert.deepEqual(await chatIds(), first, 'CLI detaches without destroying the page');
    await page.getByText('ChatGPT 2', { exact: true }).click();
    await eventually(async () => (await chatIds()).length === 2 && await attached() === 1);
    const both = await chatIds();
    await page.getByText('ChatGPT 1', { exact: true }).click();
    await eventually(async () => await attached() === 1);
    assert.deepEqual(await chatIds(), both, 'switching does not duplicate views');
    // Non-overlapping sidebar menu must keep the native ChatGPT view visible
    await page.getByText('SidebarActions', { exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await attached(), 1, 'sidebar menu opening does not detach the ChatGPT view');
    await page.getByText('SidebarAction1', { exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await attached(), 1, 'normal click keeps ChatGPT attached');
    // Overlapping menu detaches native view so overlay remains interactive
    await page.getByText('Menu', { exact: true }).click();
    await eventually(async () => await attached() === 0);
    await page.getByText('Dismiss', { exact: true }).click();
    await eventually(async () => await attached() === 1);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1010, 720));
    await eventually(async () => await attached() === 1 && (await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find(v => v.webContents)?.getBounds()?.width)) === 800);
    const geometry = await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { size: win.getContentSize(), bounds: win.contentView.children.find(view => view.webContents).getBounds() };
    });
    assert.deepEqual(geometry.size, [1010, 720]);
    const content = await page.locator('.maw-browser-viewer').boundingBox();
    const toolbar = await page.locator('.maw-browser-toolbar').boundingBox();
    assert.equal(geometry.bounds.x, Math.ceil(content.x));
    assert.equal(geometry.bounds.y, Math.ceil(content.y));
    assert.equal(geometry.bounds.width, 800);
    assert.ok(geometry.bounds.y >= toolbar.y + toolbar.height, 'native page never covers navigation controls');
    const address = page.getByRole('textbox', { name: 'Address' });
    await address.click();
    await address.fill('https://chatgpt.com/c/toolbar-test');
    await address.press('Enter');
    await eventually(async () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find(v => v.webContents)?.webContents.getURL().includes('/toolbar-test')));

    const prefs = await desktop.evaluate(({ webContents, session }) => webContents.getAllWebContents().filter(w => w.session === session.fromPartition('persist:maw-chatgpt')).map(w => {
      const p = w.getLastWebPreferences();
      return { node: p.nodeIntegration, isolated: p.contextIsolation, sandbox: p.sandbox, security: p.webSecurity, preload: p.preload, partition: w.session.getStoragePath() };
    }));
    assert.equal(prefs.length, 2);
    for (const p of prefs) { assert.equal(p.node, false); assert.equal(p.isolated, true); assert.equal(p.sandbox, true); assert.equal(p.security, true); assert.ok(!p.preload); }
    assert.equal(prefs[0].partition, prefs[1].partition);
    await page.evaluate(id => window.mawChatGpt.command({ type: 'retain', ids: [id] }), ids[0]);
    await eventually(async () => (await chatIds()).length === 1);
    assert.deepEqual(await chatIds(), first, 'a removed background tab is destroyed without changing the selected view');
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
    await eventually(async () => {
      return desktop.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0], view = win.contentView.children.find(v => v.webContents);
        return win.isFullScreen() && !!view && view.getBounds().width === win.getContentSize()[0] - 210;
      });
    });
    await assert.rejects(page.evaluate(() => window.mawChatGpt.command({ type: 'exec', command: 'id' })));
    // No real credentials: proves Chromium storage durability only.
    await desktop.evaluate(async ({ session }, partition) => {
      const ses = session.fromPartition(partition);
      await ses.cookies.set({ url: 'https://chatgpt.com/', name: 'maw_synthetic_persistence_probe', value: 'not-a-credential', secure: true, expirationDate: Date.now() / 1000 + 3600 });
      ses.flushStorageData(); await ses.cookies.flushStore();
    }, PARTITION);
    await desktop.close();
    desktop = await launch();
    const persisted = await desktop.evaluate(async ({ session }, partition) => (await session.fromPartition(partition).cookies.get({ name: 'maw_synthetic_persistence_probe' })).map(cookie => cookie.value), PARTITION);
    assert.deepEqual(persisted, ['not-a-credential']);
  } finally {
    if (desktop) await desktop.close();
    await new Promise(resolve => server.close(resolve));
    await rm(data, { recursive: true, force: true });
  }
});

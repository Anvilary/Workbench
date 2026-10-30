// Real Electron processes on a Linux display, but fixture UI and synthetic cookies.
// This deliberately does NOT assert live ChatGPT login compatibility.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { PARTITION } from './policy.mjs';
const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const ids = ['8e4fefc1-e565-40cc-b85b-f7d43a16b1df', 'f52e047f-d947-426c-a0fa-c349d035d338'];
const fixture = `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {NativeChatGptView} from './src/agency/NativeChatGptView.tsx';
function App(){const [id,setId]=useState(null),[overlay,setOverlay]=useState(false);return <>
<nav><button onClick={()=>setId(null)}>CLI</button>${ids.map((id,i)=>`<button onClick={()=>setId('${id}')}>ChatGPT ${i+1}</button>`).join('')}
<button onClick={()=>setOverlay(!overlay)}>Menu</button></nav>
{overlay&&<div role="menu"><button onClick={()=>setOverlay(false)}>Dismiss</button></div>}
<main>{id?<NativeChatGptView tab={{id,url:'https://chatgpt.com/'}} onDisplayed={()=>{}}/>:<input aria-label="CLI fixture"/>}</main></>};
createRoot(document.getElementById('root')).render(<App/>);`;
async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail('Timed out waiting for native view state');
}
test('native attachment, retention, overlay safety, security and cold cookie storage', { timeout: 90000 }, async () => {
  const bundle = await build({ stdin: { contents: fixture, resolveDir: path.join(here, '../web'), loader: 'tsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic', logLevel: 'silent' });
  const server = createServer((request, response) => {
    if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].text); }
    else response.end('<!doctype html><html><style>body{margin:0}nav{height:60px}main{position:absolute;top:60px;left:210px;right:0;bottom:0}.maw-browser-viewer{height:100%;width:100%}[role=menu]{position:absolute;z-index:2;top:60px;left:220px;background:white}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const data = await mkdtemp(path.join(tmpdir(), 'maw-electron-smoke-'));
  let desktop;
  const launch = () => electron.launch({chromiumSandbox: true,  executablePath: require('electron'), args: [here, '--ozone-platform=x11'], env: { ...process.env, MAW_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`, MAW_DESKTOP_DATA_DIR: data } });
  const attached = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.webContents).length);
  const chatIds = () => desktop.evaluate(({ webContents, session }) => webContents.getAllWebContents().filter(contents => contents.session === session.fromPartition('persist:maw-chatgpt')).map(contents => contents.id).sort((a,b) => a-b));
  try {
    desktop = await launch();
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
    await page.getByText('Menu', { exact: true }).click();
    await eventually(async () => await attached() === 0);
    await page.getByText('Dismiss', { exact: true }).click();
    await eventually(async () => await attached() === 1);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1010, 720));
    await eventually(async () => await attached() === 1);
    const geometry = await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { size: win.getContentSize(), bounds: win.contentView.children.find(view => view.webContents).getBounds() };
    });
    assert.deepEqual(geometry, { size: [1010, 720], bounds: { x: 210, y: 60, width: 800, height: 660 } });
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

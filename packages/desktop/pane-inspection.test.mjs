import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { fixture, html, workspaceId, tabB } from '../web/src/agency/split/pane-inspection-fixture.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);

async function eventually(check) {
  for (let n = 0; n < 160; n++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for native pane inspection');
}

test('pane inspection selects the correct ChatGPT tab while two native view identities stay attached', { timeout: 60000 }, async t => {
  const bundle = await build({ stdin: { contents: fixture, resolveDir: path.join(here, '../web'), loader: 'tsx' }, bundle: true, write: false, format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const data = await mkdtemp(path.join(tmpdir(), 'maw-pane-inspection-'));
  let desktop;
  t.after(async () => {
    if (desktop) await desktop.close();
    await new Promise(resolve => server.close(resolve));
    await rm(data, { recursive: true, force: true });
  });
  desktop = await electron.launch({ chromiumSandbox: true, executablePath: require('electron'), args: [here, '--ozone-platform=x11'], env: {
    ...process.env, MAW_DESKTOP_URL: 'http://127.0.0.1:' + server.address().port + '/?web', MAW_DESKTOP_DATA_DIR: data,
  } });
  await desktop.evaluate(({ session, app }) => {
    session.fromPartition('persist:maw-chatgpt').protocol.handle('https', () => new Response('<!doctype html><title>Fixture</title><input>', { headers: { 'Content-Type': 'text/html' } }));
    globalThis.inspectionLifecycle = [];
    app.on('web-contents-created', (_event, contents) => {
      if (contents.session !== session.fromPartition('persist:maw-chatgpt')) return;
      for (const event of ['did-start-loading', 'destroyed', 'render-process-gone']) {
        contents.on(event, () => globalThis.inspectionLifecycle.push({ id: contents.id, event }));
      }
    });
  });
  const page = await desktop.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#start').click();
  const identities = () => desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.webContents).map(view => view.webContents.id).sort((a, b) => a - b));
  await eventually(async () => (await identities()).length === 2);
  await eventually(() => desktop.evaluate(({ webContents, session }) => webContents.getAllWebContents()
    .filter(contents => contents.session === session.fromPartition('persist:maw-chatgpt'))
    .every(contents => !contents.isLoading())));
  const before = await identities();
  const lifecycleBefore = await desktop.evaluate(() => globalThis.inspectionLifecycle);
  await page.evaluate(id => window.inspection.finish(id), tabB);
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.inspection.requests.filter(m => m.type === 'agency.tab.acknowledge')), []);
  for (let n = 0; n < 5; n++) {
    for (const side of ['right', 'left']) {
      await page.locator('#pane-container-' + side + ' .maw-pane-header').click({ position: { x: 4, y: 4 } });
      await eventually(async () => await page.evaluate(({ side, ws, id }) =>
        document.querySelector('.maw-split-pane.is-focused')?.id === 'pane-container-' + side && window.inspection.state.selected[ws] === id,
      { side, ws: workspaceId, id: side === 'right' ? tabB : '33333333-3333-4333-8333-333333333333' }));
      assert.deepEqual(await identities(), before, 'focus retains both attached WebContentsViews');
    }
  }
  assert.deepEqual(await page.evaluate(() => window.inspection.requests.filter(m => m.type === 'agency.tab.acknowledge').map(m => m.tabId)), [tabB]);
  assert.deepEqual(await desktop.evaluate(() => globalThis.inspectionLifecycle), lifecycleBefore, 'focus cannot reload or recreate either native page');
  assert.deepEqual(errors, []);
});

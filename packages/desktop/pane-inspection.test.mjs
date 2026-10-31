import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { fixture, html, workspaceId, tabA, tabB } from '../web/src/agency/split/pane-inspection-fixture.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const exec = promisify(execFile);

async function eventually(check) {
  for (let n = 0; n < 160; n++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for native pane inspection');
}

async function setup(t, query = 'web') {
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
    ...process.env, MAW_DESKTOP_URL: 'http://127.0.0.1:' + server.address().port + '/?' + query, MAW_DESKTOP_DATA_DIR: data,
  } });
  await desktop.evaluate(({ session, app, BrowserWindow }) => {
    session.fromPartition('persist:maw-chatgpt').protocol.handle('https', () => new Response('<!doctype html><title>Fixture</title><textarea style="width:90%;height:60px">native selection sample</textarea><div style="height:2000px;background:linear-gradient(red,blue)">Scroll fixture</div>', { headers: { 'Content-Type': 'text/html' } }));
    globalThis.inspectionLifecycle = [];
    globalThis.inspectionDetaches = [];
    const host = BrowserWindow.getAllWindows()[0].contentView;
    const remove = host.removeChildView.bind(host);
    host.removeChildView = view => {
      globalThis.inspectionDetaches.push(view.webContents?.id);
      return remove(view);
    };
    app.on('web-contents-created', (_event, contents) => {
      if (contents.session !== session.fromPartition('persist:maw-chatgpt')) return;
      for (const event of ['did-start-loading', 'destroyed', 'render-process-gone']) {
        contents.on(event, () => globalThis.inspectionLifecycle.push({ id: contents.id, event }));
      }
    });
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.evaluate(() => {
    window.nativeFocusEvents = [];
    window.mawChatGpt.subscribe(state => { if (state.type === 'focused') window.nativeFocusEvents.push(state); });
  });
  await page.locator('#start').click();
  const identities = () => desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.filter(view => view.webContents).map(view => view.webContents.id).sort((a, b) => a - b));
  await eventually(async () => (await identities()).length === 2);
  await eventually(() => desktop.evaluate(({ webContents, session }) => webContents.getAllWebContents()
    .filter(contents => contents.session === session.fromPartition('persist:maw-chatgpt'))
    .every(contents => !contents.isLoading())));
  return { desktop, page, identities };
}

test('pane inspection selects the correct ChatGPT tab while two native view identities stay attached', { timeout: 60000 }, async t => {
  const { desktop, page, identities } = await setup(t);
  const before = await identities();
  const lifecycleBefore = await desktop.evaluate(() => globalThis.inspectionLifecycle);
  await page.evaluate(id => window.inspection.finish(id), tabB);
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.inspection.requests.filter(m => m.type === 'agency.tab.acknowledge')), []);
  for (let n = 0; n < 5; n++) {
    for (const side of ['right', 'left']) {
      await page.locator('#pane-container-' + side + ' .maw-pane-header').click({ position: { x: 30, y: 4 } });
      await eventually(async () => await page.evaluate(({ side, ws, id }) =>
        document.querySelector('.maw-split-pane.is-focused')?.id === 'pane-container-' + side && window.inspection.state.selected[ws] === id,
      { side, ws: workspaceId, id: side === 'right' ? tabB : '33333333-3333-4333-8333-333333333333' }));
      assert.deepEqual(await identities(), before, 'focus retains both attached WebContentsViews');
    }
  }
  assert.deepEqual(await page.evaluate(() => window.inspection.requests.filter(m => m.type === 'agency.tab.acknowledge').map(m => m.tabId)), [tabB]);
  assert.deepEqual(await desktop.evaluate(() => globalThis.inspectionLifecycle), lifecycleBefore, 'focus cannot reload or recreate either native page');
  assert.deepEqual(await page.evaluate(() => window.nativeFocusEvents), [], 'programmatic focus changes cannot echo native user focus');
});

test('native webpage pointer focus synchronizes inspection without stealing MAW control focus', { timeout: 60000 }, async t => {
  await exec('xdotool', ['--version']);
  const { desktop, page, identities } = await setup(t, 'web&mixed');
  const before = await identities();
  const lifecycleBefore = await desktop.evaluate(() => globalThis.inspectionLifecycle);
  const webContentsBySide = await desktop.evaluate(({ BrowserWindow }) => {
    const views = BrowserWindow.getAllWindows()[0].contentView.children.filter(v => v.webContents).sort((a, b) => a.getBounds().x - b.getBounds().x);
    return { left: views[0].webContents.id, right: views[1].webContents.id };
  });
  const selected = async (side, tabId) => {
    await page.waitForFunction(({ side, tabId, ws }) =>
      document.querySelector('.maw-split-pane.is-focused')?.id === 'pane-container-' + side && window.inspection.state.selected[ws] === tabId,
    { side, tabId, ws: workspaceId });
  };
  const pointer = async (side, y = 25) => {
    const point = await desktop.evaluate(({ BrowserWindow }, { contentsId, y }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win.contentView.children.find(v => v.webContents?.id === contentsId);
      const outer = win.getContentBounds(), inner = view.getBounds();
      return { x: outer.x + inner.x + 25, y: outer.y + inner.y + y };
    }, { contentsId: webContentsBySide[side], y });
    await exec('xdotool', ['mousemove', '--sync', String(point.x), String(point.y), 'click', '1']);
  };
  const nativeFocused = side => desktop.evaluate(({ webContents }, id) => webContents.fromId(id).isFocused(), webContentsBySide[side]);
  const shellFocused = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isFocused());
  const shellClick = async locator => {
    const box = await locator.boundingBox();
    const origin = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
    await exec('xdotool', ['mousemove', '--sync', String(Math.round(origin.x + box.x + box.width / 2)), String(Math.round(origin.y + box.y + box.height / 2)), 'click', '1']);
  };

  // OS mouse clicks target the WebContentsView, without invoking any React pane handler.
  await pointer('right'); await selected('right', tabB);
  assert.equal(await nativeFocused('right'), true);
  await pointer('left'); await selected('left', tabA);
  assert.equal(await nativeFocused('left'), true);
  assert.deepEqual(await page.evaluate(() => window.nativeFocusEvents.map(e => e.id)), [tabB, tabA]);
  await page.locator('#tab-88888888-8888-4888-8888-888888888888').click();
  await selected('terminal', '88888888-8888-4888-8888-888888888888');
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  await page.evaluate(id => window.inspection.finish(id), tabB);
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.inspection.requests.filter(m => m.type === 'agency.tab.acknowledge')), []);
  await pointer('right'); await selected('right', tabB);
  await page.waitForFunction(() => window.inspection.requests.some(m => m.type === 'agency.tab.acknowledge'));
  assert.deepEqual(await page.evaluate(() => window.inspection.requests.filter(m => m.type === 'agency.tab.acknowledge').map(m => m.tabId)), [tabB]);
  assert.equal(await page.evaluate(id => window.inspection.frontend.activities.find(a => a.tabId === id).state, tabA), 'working');

  // Native keyboard, selection and clipboard keep their normal behavior.
  await exec('xdotool', ['key', 'ctrl+a']);
  await exec('xdotool', ['key', 'ctrl+c']);
  await eventually(async () => await desktop.evaluate(({ clipboard }) => clipboard.readText()) === 'native selection sample');
  await desktop.evaluate(({ clipboard }) => clipboard.writeText('native paste preserved'));
  await exec('xdotool', ['key', 'ctrl+v']);
  await exec('xdotool', ['key', 'ctrl+a', 'ctrl+c']);
  await eventually(async () => await desktop.evaluate(({ clipboard }) => clipboard.readText()) === 'native paste preserved');
  const image = () => desktop.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toDataURL(), webContentsBySide.right);
  await pointer('right', 130);
  const beforeScroll = await image();
  await exec('xdotool', ['click', '--repeat', '4', '--delay', '30', '5']);
  await eventually(async () => await image() !== beforeScroll);

  // A geometry-only update cannot return keyboard focus from the MAW renderer to ChatGPT.
  await shellClick(page.locator('#start'));
  await page.locator('#start').focus();
  assert.equal(await shellFocused(), true);
  const divider = page.locator('[data-split-id="split"].maw-split-divider');
  const box = await divider.boundingBox();
  const ratioBefore = await divider.getAttribute('aria-valuenow');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(value => document.querySelector('[data-split-id="split"].maw-split-divider').getAttribute('aria-valuenow') !== value, ratioBefore);
  await page.waitForTimeout(100);
  assert.equal(await shellFocused(), true);
  assert.deepEqual(await identities(), before);
  assert.deepEqual(await desktop.evaluate(() => globalThis.inspectionDetaches), [], 'native clicks, terminal focus and divider geometry cannot detach a view');

  // Actual MAW dialogs/menus keep focus through layout measurements and overlay restoration.
  await page.locator('#pane-container-right').getByRole('button', { name: 'Add tab', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New CLI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New CLI', exact: true });
  await dialog.waitFor();
  await dialog.locator('select').focus();
  await page.waitForTimeout(150);
  assert.equal(await shellFocused(), true);
  assert.equal(await dialog.locator('select').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const inbox = page.locator('.maw-notification-inbox');
  await inbox.getByRole('button', { name: 'Close', exact: true }).focus();
  await page.waitForTimeout(150);
  assert.equal(await shellFocused(), true);
  assert.equal(await inbox.getByRole('button', { name: 'Close', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  await inbox.waitFor({ state: 'detached' });
  await eventually(async () => (await identities()).length === 2);
  assert.equal(await shellFocused(), true, 'overlay restoration cannot steal focus');
  assert.deepEqual(await identities(), before);
  assert.deepEqual(await desktop.evaluate(() => globalThis.inspectionLifecycle), lifecycleBefore);
  assert.deepEqual(await page.evaluate(() => window.nativeFocusEvents.map(e => e.id)), [tabB, tabA, tabB], 'React layout echoes and overlays cannot create a focus feedback loop');
  assert.equal(await page.evaluate(() => window.inspection.requests.filter(m => m.type === 'terminal.attach').length), 1);
  assert.equal(await page.evaluate(() => window.inspection.requests.some(m => m.type === 'terminal.detach' || m.type === 'input')), false, 'native interaction cannot detach or send keyboard input to the terminal');

  // Retained views from another workspace cannot report focus into the active layout.
  await page.evaluate(() => window.inspection.switchWorkspace());
  await page.getByRole('tab', { name: /ChatGPT 3/ }).waitFor();
  await eventually(async () => (await identities()).length === 1);
  const requestCount = await page.evaluate(() => window.inspection.requests.filter(m => m.type === 'agency.webTab.select').length);
  await desktop.evaluate(({ webContents }, id) => webContents.fromId(id).emit('before-mouse-event', {}, { type: 'mouseDown' }), webContentsBySide.left);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.inspection.requests.filter(m => m.type === 'agency.webTab.select').length), requestCount);
  assert.equal(await page.getByRole('tab', { name: /ChatGPT 3/ }).getAttribute('aria-selected'), 'true');
  await page.evaluate(() => window.inspection.switchWorkspace());
  await eventually(async () => (await identities()).length === 2);
  assert.deepEqual(await identities(), before);
  assert.equal(await page.evaluate(() => window.inspection.requests.some(m => m.action === 'resume' || m.action === 'close' || m.type === 'agency.session.create')), false);
});

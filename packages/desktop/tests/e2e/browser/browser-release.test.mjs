import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const desktopDir = DESKTOP_ROOT;
const id = '11111111-1111-4111-8111-111111111111';
const ids = Array.from({ length: 5 }, (_, i) => `22222222-2222-4222-8222-22222222222${i}`);
const eventually = async (fn) => {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('Native browser state did not settle');
};

test('general Browser preserves its session, navigation and user input while isolating the shell', { timeout: 60000 }, async () => {
  const server = createServer((_req, res) => res.end('<!doctype html><script>window.events=[];window.workbench.subscribe(s=>events.push(s));</script>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const data = await mkdtemp(path.join(os.tmpdir(), 'wb-browser-release-'));
  let app;
  const launch = () => electron.launch({ chromiumSandbox: true, executablePath: '/opt/workbench-electron/45.2.0/electron',
    args: [desktopDir, '--ozone-platform=x11'], env: { ...process.env, HOME: data, WORKBENCH_DESKTOP_DATA_DIR: data,
      WORKBENCH_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`, WORKBENCH_MAX_RESIDENT_VIEWS: '1', WORKBENCH_MEMORY_PRESSURE_TIER: 'critical' } });
  try {
    app = await launch();
    const page = await app.firstWindow();
    await page.waitForFunction(() => Array.isArray(window.events));
    await app.evaluate(({ session }) => {
      for (const name of ['persist:workbench-browser', 'persist:workbench-github']) session.fromPartition(name).protocol.handle('https', () => new Response('<input id="draft"><a href="https://github.com/two">next</a>', { headers: { 'Content-Type': 'text/html' } }));
    });
    const command = payload => page.evaluate(cmd => window.workbench.command(cmd), payload);
    const state = () => app.evaluate(({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(c => c.session === session.fromPartition('persist:workbench-browser'));
      return contents && { url: contents.getURL(), loading: contents.isLoading(), back: contents.navigationHistory.canGoBack(), forward: contents.navigationHistory.canGoForward(),
        preload: contents.getLastWebPreferences().preload, node: contents.getLastWebPreferences().nodeIntegration };
    });
    await command({ type: 'open', id, provider: 'other', url: 'https://docs.maw-audit.com/one' });
    await eventually(async () => (await state())?.url.endsWith('/one'));
    await command({ type: 'update', id, provider: 'other', url: 'https://github.com/two' });
    await eventually(async () => (await state())?.url.endsWith('/two') && (await state()).back);
    await command({ type: 'browser-action', id, action: 'back' });
    await eventually(async () => (await state())?.url.endsWith('/one') && !(await state()).loading && (await state()).forward);
    assert.equal((await state()).node, false);
    assert.ok(!(await state()).preload);
    await assert.rejects(command({ type: 'update', id, provider: 'other', url: `http://127.0.0.1:${server.address().port}/` }));
    // Navigate while suspended: restore the new URL with the old back stack intact.
    await command({ type: 'open', id: ids[0], provider: 'github', url: 'https://github.com/ordinary' });
    await eventually(async () => !(await state()));
    await command({ type: 'update', id, provider: 'other', url: 'https://docs.maw-audit.com/updated-while-suspended' });
    await command({ type: 'open', id, provider: 'other', url: 'https://docs.maw-audit.com/updated-while-suspended' });
    await eventually(async () => (await state())?.url.endsWith('/updated-while-suspended') && !(await state()).loading);
    assert.equal((await state()).back, true);
    await command({ type: 'browser-action', id, action: 'back' });
    await eventually(async () => (await state())?.url.endsWith('/one') && !(await state()).loading);
    await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(c => c.session === session.fromPartition('persist:workbench-browser'));
      await contents.executeJavaScript('document.querySelector("input").focus()');
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
      await contents.executeJavaScript('document.querySelector("input").value="unsaved draft"');
      await session.fromPartition('persist:workbench-browser').cookies.set({ url: 'https://docs.maw-audit.com/', name: 'fixture', value: 'retained', expirationDate: Date.now() / 1000 + 3600 });
    });
    for (const otherId of ids) {
      await command({ type: 'open', id: otherId, provider: 'github', url: 'https://github.com/ordinary' });
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    await page.waitForTimeout(2200);
    assert.equal((await state()).url, 'https://docs.maw-audit.com/one', 'critical pressure cannot destroy an interacted page');
    assert.equal(await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(c => c.session === session.fromPartition('persist:workbench-browser'));
      return contents.executeJavaScript('document.querySelector("input").value');
    }), 'unsaved draft');
    assert.ok(await page.evaluate(() => events.some(s => s.type === 'navigation' && s.canGoBack)));
    await app.close(); app = await launch();
    const cookies = await app.evaluate(({ session }) => session.fromPartition('persist:workbench-browser').cookies.get({ name: 'fixture' }));
    assert.equal(cookies[0]?.value, 'retained');
    const legacy = await app.evaluate(({ session }) => ['persist:workbench-chatgpt', 'persist:workbench-github', 'persist:workbench-perplexity'].map(p => session.fromPartition(p).getStoragePath()));
    assert.equal(new Set(legacy).size, 3);
  } finally { if (app) await app.close(); await new Promise(r => server.close(r)); await rm(data, { recursive: true, force: true }); }
});

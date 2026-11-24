import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(import.meta.url);
const electronExecutable = fs.existsSync('/opt/maw-electron/45.2.0/electron')
  ? '/opt/maw-electron/45.2.0/electron'
  : require('electron');

async function eventually(check, message = 'condition', timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('Timed out waiting for ' + message);
}

test('native DevTools ownership/cleanup and profile-isolated spellcheck in real Electron', { timeout: 60000 }, async (t) => {
  const mainTabId = '44444444-4444-4444-8444-444444444444';
  const workTabId = '55555555-5555-4555-8555-555555555555';

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>Workbench Test Shell</title></head><body><script>window.events=[];if(window.mawChatGpt)window.mawChatGpt.subscribe(s=>window.events.push(s));</script></body></html>');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const serverPort = server.address().port;
  const shellUrl = `http://127.0.0.1:${serverPort}/`;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'maw-devtools-spell-'));
  let desktop;

  t.after(async () => {
    if (desktop) {
      const child = desktop.process();
      await Promise.race([
        desktop.close().catch(() => {}),
        new Promise((resolve) => setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 5000)),
      ]);
    }
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  });

  desktop = await electron.launch({
    chromiumSandbox: true,
    executablePath: electronExecutable,
    args: [DESKTOP_ROOT, '--ozone-platform=x11'],
    env: {
      ...process.env,
      HOME: dataDir,
      MAW_DESKTOP_DATA_DIR: dataDir,
      MAW_DESKTOP_URL: shellUrl,
    },
  });

  const page = await desktop.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.mawChatGpt !== 'undefined');

  await desktop.evaluate(({ session }) => {
    for (const partition of ['persist:maw-browser', 'persist:maw-profile-work-profile-browser']) {
      const sess = session.fromPartition(partition);
      sess.protocol.handle('https', (req) => {
        const u = new URL(req.url);
        if (u.pathname === '/page') {
          return new Response('<!doctype html><html><body><textarea id="ed">test</textarea></body></html>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response('Not found', { status: 404 });
      });
    }
  });

  const command = (cmd) => page.evaluate((c) => window.mawChatGpt.command(c), cmd);
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

  // 1. Open two tabs on separate browser profiles: 'main' and 'work-profile'
  await command({ type: 'open', id: mainTabId, provider: 'other', url: 'https://main-tab.maw-test.org/page', profileId: 'main' });
  await command({ type: 'open', id: workTabId, provider: 'other', url: 'https://work-tab.maw-test.org/page', profileId: 'work-profile' });
  await command({
    type: 'layout',
    views: [{ id: mainTabId, bounds: { x: 0, y: 40, width: viewport.width, height: viewport.height - 40 } }],
    viewport,
  });

  await eventually(async () => {
    return await desktop.evaluate(({ session, webContents }) => {
      const mainSess = session.fromPartition('persist:maw-browser');
      const workSess = session.fromPartition('persist:maw-profile-work-profile-browser');
      const all = webContents.getAllWebContents();
      const mainView = all.find((c) => c.session === mainSess && c.getURL().includes('/page'));
      const workView = all.find((c) => c.session === workSess && c.getURL().includes('/page'));
      return Boolean(mainView && !mainView.isLoading() && workView && !workView.isLoading());
    });
  }, 'both native WebContentsViews to load');

  // 2. Inspect Page opens detached DevTools strictly for the target native WebContentsView, never the shell
  const inspectRes = await command({ type: 'inspect-page', id: mainTabId, x: 50, y: 50 });
  assert.equal(inspectRes.ok, true);

  await eventually(async () => {
    return await desktop.evaluate(({ BrowserWindow, session, webContents }) => {
      const mainWin = BrowserWindow.getAllWindows()[0];
      const mainSess = session.fromPartition('persist:maw-browser');
      const mainView = webContents.getAllWebContents().find((c) => c.session === mainSess && c.getURL().includes('/page'));
      return Boolean(mainView && mainView.isDevToolsOpened() && mainWin && !mainWin.webContents.isDevToolsOpened());
    });
  }, 'DevTools to open for native view only');

  // Closing the native view closes its DevTools cleanly
  await command({ type: 'close', id: mainTabId });
  await eventually(async () => {
    return await desktop.evaluate(({ session, webContents }) => {
      const mainSess = session.fromPartition('persist:maw-browser');
      const mainView = webContents.getAllWebContents().find((c) => c.session === mainSess && c.getURL().includes('/page'));
      return !mainView || mainView.isDestroyed() || !mainView.isDevToolsOpened();
    });
  }, 'DevTools to close on tab close');

  // 3. Spellcheck languages discovery and live update (including empty selection and global disable)
  const availRes = await command({ type: 'get-available-spellcheck-languages' });
  assert.equal(availRes.ok, true);
  assert.ok(Array.isArray(availRes.languages) && availRes.languages.length > 0);

  await command({ type: 'update-spellcheck-settings', enabled: false, languages: [] });
  const afterDisable = await desktop.evaluate(({ session }) => {
    const workSess = session.fromPartition('persist:maw-profile-work-profile-browser');
    return {
      enabled: workSess.isSpellCheckerEnabled(),
      languages: workSess.getSpellCheckerLanguages(),
    };
  });
  assert.equal(afterDisable.enabled, false);
  assert.deepEqual(afterDisable.languages, []);

  // Re-enable with en-US if available
  const targetLang = availRes.languages.includes('en-US') ? 'en-US' : availRes.languages[0];
  await command({ type: 'update-spellcheck-settings', enabled: true, languages: [targetLang] });
  const afterEnable = await desktop.evaluate(({ session }) => {
    const workSess = session.fromPartition('persist:maw-profile-work-profile-browser');
    return {
      enabled: workSess.isSpellCheckerEnabled(),
      languages: workSess.getSpellCheckerLanguages(),
    };
  });
  assert.equal(afterEnable.enabled, true);
  assert.deepEqual(afterEnable.languages, [targetLang]);

  // 4. Profile-isolated custom dictionary in real Electron sessions (including Unicode)
  assert.equal((await command({ type: 'add-custom-dictionary-word', word: 'anvilarymainonly', profileId: 'main' })).ok, true);
  assert.equal((await command({ type: 'add-custom-dictionary-word', word: 'ação', profileId: 'main' })).ok, true);
  assert.equal((await command({ type: 'add-custom-dictionary-word', word: 'anvilaryworkonly', profileId: 'work-profile' })).ok, true);

  const mainList = await command({ type: 'list-custom-dictionary-words', profileId: 'main' });
  const workList = await command({ type: 'list-custom-dictionary-words', profileId: 'work-profile' });
  const defaultSessionWords = await desktop.evaluate(async ({ session }) => {
    return await session.defaultSession.listWordsInSpellCheckerDictionary();
  });

  assert.equal(mainList.words.includes('anvilarymainonly'), true);
  assert.equal(mainList.words.includes('ação'), true);
  assert.equal(mainList.words.includes('anvilaryworkonly'), false);
  assert.equal(workList.words.includes('anvilaryworkonly'), true);
  assert.equal(workList.words.includes('anvilarymainonly'), false);
  assert.equal(defaultSessionWords.includes('anvilarymainonly'), false);
  assert.equal(defaultSessionWords.includes('anvilaryworkonly'), false);

  // Removing from work-profile does not remove from main; delete-profile clears work-profile dictionary
  await command({ type: 'remove-custom-dictionary-word', word: 'anvilaryworkonly', profileId: 'work-profile' });
  assert.equal((await command({ type: 'list-custom-dictionary-words', profileId: 'work-profile' })).words.includes('anvilaryworkonly'), false);
  assert.equal((await command({ type: 'list-custom-dictionary-words', profileId: 'main' })).words.includes('anvilarymainonly'), true);

  await command({ type: 'add-custom-dictionary-word', word: 'tempworkword', profileId: 'work-profile' });
  await command({ type: 'delete-profile', profileId: 'work-profile' });
  const workAfterDelete = await command({ type: 'list-custom-dictionary-words', profileId: 'work-profile' });
  assert.equal(workAfterDelete.words.includes('tempworkword'), false);
  assert.equal((await command({ type: 'list-custom-dictionary-words', profileId: 'main' })).words.includes('anvilarymainonly'), true);
});

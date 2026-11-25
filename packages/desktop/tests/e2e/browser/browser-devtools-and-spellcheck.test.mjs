import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { DESKTOP_ROOT, REPO_ROOT } from '../../helpers/paths.mjs';

const require = createRequire(import.meta.url);
const WEB_ROOT = path.join(REPO_ROOT, 'packages/web');
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

async function closeElectronSafely(desktop) {
  if (!desktop) return;
  const child = desktop.process();
  let timer;
  try {
    await Promise.race([
      desktop.close().catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          resolve();
        }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function buildHostSettingsModule(outDir) {
  const outPath = path.join(outDir, 'settings-host.mjs');
  const entry = `
    export { SettingsStore } from './packages/server/src/features/settings/settings-store.ts';
    export { AppSettingsService } from './packages/server/src/features/settings/app-settings-service.ts';
  `;
  await build({
    stdin: { contents: entry, resolveDir: REPO_ROOT, sourcefile: 'host.ts', loader: 'ts' },
    outfile: outPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  return await import(pathToFileURL(outPath).href);
}

const shellReactSource = `
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserContextMenu } from './src/features/browser/BrowserContextMenu.tsx';
import { useBrowserSettings, resetBrowserSettingsStoreForTests } from './src/features/browser/useBrowserSettings.ts';
import { SettingsDialog } from './src/features/settings/SettingsDialog.tsx';
import './src/app/workbench.css';

resetBrowserSettingsStoreForTests();

function ShellApp() {
  const [status, setStatus] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refreshStatus = useCallback(async () => {
    const res = await fetch('/api/settings');
    const data = await res.json();
    setStatus(data);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const appSettings = {
    status,
    problem: null,
    setConsoleShell: () => {},
    setDisabledAgents: () => {},
    setBrowserSettings: (browser) => {
      void fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browser }),
      })
        .then((r) => r.json())
        .then((updated) => setStatus(updated));
    },
    updateBrowserSettings: async (change) => {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Settings write failed' }));
        return { ok: false, code: 'rejected', error: err.error || 'Settings write failed' };
      }
      const updated = await res.json();
      setStatus(updated);
      return { ok: true, settings: updated };
    },
    dismissProblem: () => {},
  };

  useBrowserSettings(appSettings);

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#121214', color: '#eee' }}>
      <div style={{ height: 40, display: 'flex', gap: 8, alignItems: 'center', padding: '0 12px' }}>
        <button id="open-settings-btn" type="button" onClick={() => setSettingsOpen(true)}>Settings</button>
        <span id="settings-loaded">{status ? 'loaded' : 'loading'}</span>
      </div>
      <div className="maw-browser-pane" style={{ width: 700, height: 420 }}>
        <div className="maw-browser-viewer" data-native-id="44444444-4444-4444-8444-444444444444" />
      </div>
      <BrowserContextMenu appSettings={appSettings} />
      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          terminalTheme={{ preference: 'dark', current: 'dark', setPreference: () => {} }}
          appSettings={appSettings}
          agents={[]}
          remoteClient={false}
          initialTab="browser"
          browserProfiles={[
            { id: 'main', name: 'Main', createdAt: '', updatedAt: '', isDefault: true },
            { id: 'work-profile', name: 'Work Profile', createdAt: '', updatedAt: '' },
          ]}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<ShellApp />);
`;

test('R6: real Electron custom dictionary ownership, 4-partition consistency, restart persistence, lazy partition, profile deletion, and real en-US spellcheck replacement', { timeout: 120000 }, async (t) => {
  const mainTabId = '44444444-4444-4444-8444-444444444444';
  const workTabId = '55555555-5555-4555-8555-555555555555';
  const workGithubTabId = '66666666-6666-4666-8666-666666666666';

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'maw-r6-e2e-'));
  const homeDir = path.join(tempRoot, 'home');
  const xdgConfig = path.join(tempRoot, 'xdg-config');
  const desktopDataDir = path.join(tempRoot, 'electron-data');
  const settingsFilePath = path.join(tempRoot, 'settings.json');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(xdgConfig, { recursive: true });
  fs.mkdirSync(desktopDataDir, { recursive: true });

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const { SettingsStore, AppSettingsService } = await buildHostSettingsModule(tempRoot);

  const bundle = await build({
    stdin: { contents: shellReactSource, resolveDir: WEB_ROOT, sourcefile: 'r6-shell.tsx', loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  const shellJs = bundle.outputFiles[0].text;
  const shellCss = fs.readFileSync(path.join(WEB_ROOT, 'src/app/workbench.css'), 'utf8');

  let activeService;
  const loadService = async () => {
    const store = new SettingsStore(settingsFilePath, { log: { warn: () => undefined } });
    await store.load();
    activeService = new AppSettingsService({
      settings: store,
      agents: { disabledIds: () => [] },
      shells: [],
      onShellChange: () => undefined,
    });
  };
  await loadService();

  const server = createServer(async (req, res) => {
    if (req.url === '/test.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(shellCss);
      return;
    }
    if (req.url === '/test.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(shellJs);
      return;
    }
    if (req.url === '/api/settings' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(activeService.status()));
      return;
    }
    if (req.url === '/api/settings' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await activeService.update(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(activeService.status()));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/test.css"></head><body><div id="root"></div><script type="module" src="/test.js"></script></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const shellUrl = `http://127.0.0.1:${server.address().port}/`;

  const installTestHttpsPages = async (desktop) => {
    await desktop.evaluate(({ session }) => {
      const html = '<!doctype html><html><body style="margin:0;padding:0"><textarea id="ed" spellcheck="true" style="position:absolute;left:20px;top:20px;width:400px;height:120px;font-family:monospace;font-size:18px;padding:8px"></textarea></body></html>';
      for (const partition of [
        'persist:maw-browser',
        'persist:maw-profile-work-profile-browser',
        'persist:maw-profile-work-profile-github',
      ]) {
        const sess = session.fromPartition(partition);
        sess.protocol.handle('https', (req) => {
          const u = new URL(req.url);
          if (u.pathname === '/page' || u.pathname === '/') {
            return new Response(html, { headers: { 'Content-Type': 'text/html' } });
          }
          return new Response('Not found', { status: 404 });
        });
      }
    });
  };

  const launchDesktop = async () => {
    const desktop = await electron.launch({
      chromiumSandbox: true,
      executablePath: electronExecutable,
      args: [DESKTOP_ROOT, '--ozone-platform=x11'],
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: xdgConfig,
        MAW_DESKTOP_DATA_DIR: desktopDataDir,
        MAW_DESKTOP_URL: shellUrl,
      },
    });
    const page = await desktop.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.mawChatGpt !== 'undefined');
    await page.waitForSelector('#settings-loaded', { state: 'attached' });
    await eventually(async () => (await page.locator('#settings-loaded').textContent()) === 'loaded', 'settings loaded');
    await installTestHttpsPages(desktop);
    return { desktop, page };
  };

  // === LAUNCH 1 ===
  let session1 = await launchDesktop();
  try {
    const { desktop, page } = session1;
    const command = (cmd) => page.evaluate((c) => window.mawChatGpt.command(c), cmd);

    // Open main tab ('other' provider) and work-profile tab ('other' provider)
    await command({ type: 'open', id: mainTabId, provider: 'other', url: 'https://main.maw-test.org/page', profileId: 'main' });
    await command({ type: 'open', id: workTabId, provider: 'other', url: 'https://work.maw-test.org/page', profileId: 'work-profile' });
    const vp1 = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await command({
      type: 'layout',
      views: [{ id: mainTabId, bounds: { x: 0, y: 40, width: Math.min(700, vp1.width), height: Math.min(420, Math.max(200, vp1.height - 40)) } }],
      viewport: vp1,
    });

    await eventually(async () => {
      return await desktop.evaluate(({ session, webContents }) => {
        const s = session.fromPartition('persist:maw-browser');
        const v = webContents.getAllWebContents().find((c) => c.session === s && c.getURL().includes('/page'));
        return Boolean(v && !v.isLoading());
      });
    }, 'main WebContentsView loaded');

    // 12. Wait for real Chromium en-US dictionary readiness and test misspelling suggestion + replacement
    await eventually(async () => {
      const st = await command({ type: 'get-spellcheck-status' });
      return st?.statuses?.['en-US']?.status === 'ready';
    }, 'en-US dictionary ready', 20000);

    // Focus textarea in native WebContentsView, insert misspelling "teh ", right-click -> real suggestions -> click suggestion -> verify "the "
    await desktop.evaluate(async ({ BrowserWindow, session, webContents }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const s = session.fromPartition('persist:maw-browser');
      const v = webContents.getAllWebContents().find((c) => c.session === s && c.getURL().includes('/page'));
      win.focus();
      v.focus();
      await v.executeJavaScript('document.getElementById("ed").focus();');
      await new Promise((r) => setTimeout(r, 150));
      await v.insertText('teh ');
    });
    await eventually(async () => {
      const val = await desktop.evaluate(async ({ session, webContents }) => {
        const s = session.fromPartition('persist:maw-browser');
        const v = webContents.getAllWebContents().find((c) => c.session === s && c.getURL().includes('/page'));
        return await v.executeJavaScript('document.getElementById("ed").value');
      });
      return val === 'teh ';
    }, 'teh inserted into native textarea');

    // Poll boundedly for Chromium's async spellchecker underline pass to populate suggestions
    await eventually(async () => {
      const hasMenu = await page.locator('.maw-context-menu-suggestion').count();
      if (hasMenu > 0) return true;
      await desktop.evaluate(({ session, webContents }) => {
        const s = session.fromPartition('persist:maw-browser');
        const v = webContents.getAllWebContents().find((c) => c.session === s && c.getURL().includes('/page'));
        v.sendInputEvent({ type: 'mouseDown', x: 42, y: 38, button: 'right', clickCount: 1 });
        v.sendInputEvent({ type: 'mouseUp', x: 42, y: 38, button: 'right', clickCount: 1 });
      });
      await new Promise((r) => setTimeout(r, 250));
      return (await page.locator('.maw-context-menu-suggestion').count()) > 0;
    }, 'Chromium spelling suggestions menu to open', 15000);
    const suggestions = await page.locator('.maw-context-menu-suggestion').allTextContents();
    assert.ok(suggestions.includes('the'), `Expected Chromium suggestion 'the', got: ${JSON.stringify(suggestions)}`);
    await page.locator('.maw-context-menu-suggestion', { hasText: /^the$/ }).click();
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });

    await eventually(async () => {
      const val = await desktop.evaluate(async ({ session, webContents }) => {
        const s = session.fromPartition('persist:maw-browser');
        const v = webContents.getAllWebContents().find((c) => c.session === s && c.getURL().includes('/page'));
        return await v.executeJavaScript('document.getElementById("ed").value');
      });
      return val === 'the ';
    }, 'misspelling replaced in native textarea');

    // 1. Add custom dictionary word via actual context-menu flow BEFORE Settings has ever been opened!
    await desktop.evaluate(async ({ session, webContents }) => {
      const s = session.fromPartition('persist:maw-browser');
      const v = webContents.getAllWebContents().find((c) => c.session === s && c.getURL().includes('/page'));
      await v.executeJavaScript('document.getElementById("ed").value = ""; document.getElementById("ed").focus();');
      await v.insertText('anvilaryctxword ');
    });
    await new Promise((r) => setTimeout(r, 600));
    await desktop.evaluate(({ session, webContents }) => {
      const s = session.fromPartition('persist:maw-browser');
      const v = webContents.getAllWebContents().find((c) => c.session === s && c.getURL().includes('/page'));
      v.sendInputEvent({ type: 'mouseDown', x: 55, y: 38, button: 'right', clickCount: 1 });
      v.sendInputEvent({ type: 'mouseUp', x: 55, y: 38, button: 'right', clickCount: 1 });
    });
    await page.waitForSelector('.maw-context-menu-spelling');
    await page.locator('.maw-context-menu-action-item', { hasText: 'Add to Dictionary' }).click();
    await page.waitForSelector('.maw-context-menu', { state: 'detached' });

    // Verify persisted to settings.json on disk even without opening Settings
    await eventually(async () => {
      const disk = JSON.parse(await readFile(settingsFilePath, 'utf8'));
      return disk.browser?.spellCheck?.customWordsByProfile?.main?.includes('anvilaryctxword');
    }, 'context-menu word persisted to settings.json');

    // Detach native WebContentsView before interacting with SettingsDialog modal in DOM
    await command({ type: 'layout', views: [], viewport: vp1 });

    // 2. Open Settings -> verify anvilaryctxword is present, add/remove words across profiles (with Unicode)
    await page.click('#open-settings-btn');
    await page.waitForSelector('#setting-card-spellcheck');
    const spellCard = page.locator('#setting-card-spellcheck');
    await spellCard.locator('.maw-settings-dict-word', { hasText: 'anvilaryctxword' }).waitFor();

    // Add Unicode word to Main, and add temporary word then remove it
    await spellCard.locator('.maw-settings-dict-add-form input').fill('ação');
    await spellCard.locator('.maw-settings-dict-add-form button[type="submit"]').click();
    await spellCard.locator('.maw-settings-dict-word', { hasText: 'ação' }).waitFor();

    await spellCard.locator('.maw-settings-dict-add-form input').fill('removetemp');
    await spellCard.locator('.maw-settings-dict-add-form button[type="submit"]').click();
    await spellCard.locator('.maw-settings-dict-word', { hasText: 'removetemp' }).waitFor();
    await spellCard.locator('button[aria-label="Remove removetemp"]').click();
    await spellCard.locator('.maw-settings-dict-word', { hasText: 'removetemp' }).waitFor({ state: 'detached' });

    // Switch to Work Profile and add Unicode + ASCII words
    await spellCard.locator('select.maw-settings-select').selectOption('work-profile');
    await spellCard.locator('.maw-settings-dict-add-form input').fill('résumé');
    await spellCard.locator('.maw-settings-dict-add-form button[type="submit"]').click();
    await spellCard.locator('.maw-settings-dict-word', { hasText: 'résumé' }).waitFor();

    // 3 & 4. Inspect ALL 4 native provider partitions for both profiles and defaultSession
    const mainInspect = await command({ type: 'list-custom-dictionary-words', profileId: 'main' });
    const workInspect = await command({ type: 'list-custom-dictionary-words', profileId: 'work-profile' });
    const defaultWords = await desktop.evaluate(async ({ session }) => session.defaultSession.listWordsInSpellCheckerDictionary());

    assert.equal(mainInspect.consistent, true);
    assert.deepEqual(mainInspect.words, ['anvilaryctxword', 'ação']);
    assert.deepEqual(mainInspect.byProvider.chatgpt, ['anvilaryctxword', 'ação']);
    assert.deepEqual(mainInspect.byProvider.github, ['anvilaryctxword', 'ação']);
    assert.deepEqual(mainInspect.byProvider.perplexity, ['anvilaryctxword', 'ação']);
    assert.deepEqual(mainInspect.byProvider.other, ['anvilaryctxword', 'ação']);

    assert.equal(workInspect.consistent, true);
    assert.deepEqual(workInspect.words, ['résumé']);
    assert.equal(defaultWords.includes('anvilaryctxword'), false);
    assert.equal(defaultWords.includes('résumé'), false);

    // 10. Simulate native partition divergence directly on one active partition ('main' / github) and verify reconciliation recovers deterministically
    await desktop.evaluate(({ session }) => {
      const gh = session.fromPartition('persist:maw-github');
      gh.addWordToSpellCheckerDictionary('divergentghost');
    });
    const divergentRead = await command({ type: 'list-custom-dictionary-words', profileId: 'main' });
    assert.equal(divergentRead.consistent, false);
    assert.deepEqual(divergentRead.inconsistentWords, ['divergentghost']);

    await command({
      type: 'reconcile-custom-dictionary',
      customWordsByProfile: { main: ['anvilaryctxword', 'ação'], 'work-profile': ['résumé'] },
    });
    const recoveredRead = await command({ type: 'list-custom-dictionary-words', profileId: 'main' });
    assert.equal(recoveredRead.consistent, true);
    assert.deepEqual(recoveredRead.words, ['anvilaryctxword', 'ação']);

    // 11. Remove all configured languages in Settings -> verify empty state persists in settings.json
    const langRemoveButtons = spellCard.locator('.maw-settings-lang-item button[aria-label^="Remove "]');
    while (true) {
      const count = await langRemoveButtons.count();
      if (count === 0) break;
      await langRemoveButtons.first().click();
      await page.waitForFunction(
        (expectedMax) => document.querySelectorAll('#setting-card-spellcheck .maw-settings-lang-item').length < expectedMax,
        count,
      );
    }
    await spellCard.locator('.maw-settings-empty-hint', { hasText: 'No spell check languages configured.' }).waitFor();
    await eventually(async () => {
      const disk = JSON.parse(await readFile(settingsFilePath, 'utf8'));
      return Array.isArray(disk.browser?.spellCheck?.configuredLanguages) &&
        disk.browser.spellCheck.configuredLanguages.length === 0 &&
        disk.browser.spellCheck.languages.length === 0;
    }, 'empty configuredLanguages persisted');
  } finally {
    await closeElectronSafely(session1.desktop);
  }

  // === LAUNCH 2: Relaunch Electron with same disposable userData & settings.json ===
  await loadService();
  let session2 = await launchDesktop();
  try {
    const { desktop, page } = session2;
    const command = (cmd) => page.evaluate((c) => window.mawChatGpt.command(c), cmd);

    // 5 & 6. Verify additions, removals, and empty configuredLanguages survived restart
    await page.click('#open-settings-btn');
    await page.waitForSelector('#setting-card-spellcheck');
    const spellCard = page.locator('#setting-card-spellcheck');
    await spellCard.locator('.maw-settings-empty-hint', { hasText: 'No spell check languages configured.' }).waitFor();
    await spellCard.locator('.maw-settings-dict-word', { hasText: 'anvilaryctxword' }).waitFor();
    await spellCard.locator('.maw-settings-dict-word', { hasText: 'ação' }).waitFor();
    assert.equal(await spellCard.locator('.maw-settings-dict-word', { hasText: 'removetemp' }).count(), 0);

    // 7 & 8. Initialize another provider partition ('github') on 'work-profile' AFTER restart & dictionary ops
    await command({ type: 'open', id: workGithubTabId, provider: 'github', url: 'https://github.com/', profileId: 'work-profile' });
    const workAfterLazy = await command({ type: 'list-custom-dictionary-words', profileId: 'work-profile' });
    assert.equal(workAfterLazy.consistent, true);
    assert.deepEqual(workAfterLazy.words, ['résumé']);

    const mainAfterRestart = await command({ type: 'list-custom-dictionary-words', profileId: 'main' });
    assert.equal(mainAfterRestart.consistent, true);
    assert.deepEqual(mainAfterRestart.words, ['anvilaryctxword', 'ação']);

    // 9. Delete custom profile -> dictionary state removed across all 4 native partitions without affecting 'main'
    await command({ type: 'delete-profile', profileId: 'work-profile' });
    const workAfterDelete = await command({ type: 'list-custom-dictionary-words', profileId: 'work-profile' });
    assert.equal(workAfterDelete.consistent, true, `Expected clean deletion: ${JSON.stringify(workAfterDelete)}`);
    assert.deepEqual(workAfterDelete.words, [], `Expected empty words after delete: ${JSON.stringify(workAfterDelete)}`);

    const mainAfterDelete = await command({ type: 'list-custom-dictionary-words', profileId: 'main' });
    assert.equal(mainAfterDelete.consistent, true);
    assert.deepEqual(mainAfterDelete.words, ['anvilaryctxword', 'ação']);
  } finally {
    await closeElectronSafely(session2.desktop);
  }
});

async function readSelectedElementInDevTools(desktop, partitionName, urlFragment) {
  return await desktop.evaluate(async ({ session, webContents }, { part, frag }) => {
    const sess = session.fromPartition(part);
    const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes(frag));
    const dt = v?.devToolsWebContents;
    if (!dt || dt.isDestroyed()) return [];
    return await dt.executeJavaScript(`
      (() => {
        const out = [];
        function walk(root) {
          for (const el of root.querySelectorAll('.selected')) {
            const text = (el.textContent || '').trim();
            if (text) out.push(text.slice(0, 140));
          }
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        }
        walk(document);
        return out;
      })()
    `);
  }, { part: partitionName, frag: urlFragment });
}

test('R7: native DevTools element inspection accuracy across layouts, zoom levels, crash, close, and shutdown', { timeout: 90000 }, async (t) => {
  const tabId = '77777777-7777-4777-8777-777777777777';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>R7 Shell</title></head><body><div>Shell</div></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'maw-r7-normal-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const desktop = await electron.launch({
    chromiumSandbox: true,
    executablePath: electronExecutable,
    args: [DESKTOP_ROOT, '--ozone-platform=x11'],
    env: { ...process.env, HOME: dataDir, MAW_DESKTOP_DATA_DIR: dataDir, MAW_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/` },
  });
  t.after(() => closeElectronSafely(desktop));

  const page = await desktop.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.mawChatGpt !== 'undefined');

  await desktop.evaluate(({ session }) => {
    const sess = session.fromPartition('persist:maw-browser');
    sess.protocol.handle('https', () => {
      return new Response(
        '<!doctype html><html><body style="margin:0;padding:0"><div id="decoy" style="position:absolute;left:10px;top:10px;width:120px;height:40px">Decoy</div><button id="target-btn" data-probe="exact-hit" style="position:absolute;left:180px;top:140px;width:160px;height:60px">Target</button></body></html>',
        { headers: { 'Content-Type': 'text/html' } },
      );
    });
  });

  const command = (cmd) => page.evaluate((c) => window.mawChatGpt.command(c), cmd);
  await command({ type: 'open', id: tabId, provider: 'other', url: 'https://r7.maw-test.org/page' });

  const vp = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const layouts = [
    { name: 'sidebar-expanded', bounds: { x: 260, y: 40, width: Math.max(240, vp.width - 280), height: Math.max(240, vp.height - 60) } },
    { name: 'sidebar-collapsed', bounds: { x: 0, y: 40, width: vp.width, height: Math.max(240, vp.height - 60) } },
    { name: 'split-right', bounds: { x: Math.min(480, Math.floor(vp.width / 2)), y: 40, width: Math.max(240, vp.width - Math.min(480, Math.floor(vp.width / 2)) - 20), height: Math.max(240, vp.height - 60) } },
    { name: 'split-bottom', bounds: { x: 0, y: Math.min(260, Math.floor(vp.height / 2)), width: vp.width, height: Math.max(220, vp.height - Math.min(260, Math.floor(vp.height / 2)) - 20) } },
  ];

  await command({ type: 'layout', views: [{ id: tabId, bounds: layouts[0].bounds }], viewport: vp });
  await eventually(async () => {
    return await desktop.evaluate(({ session, webContents }) => {
      const sess = session.fromPartition('persist:maw-browser');
      const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
      return Boolean(v && !v.isLoading());
    });
  }, 'R7 page loaded');

  // Verify unprivileged isolation and no fixed remote debugging listener configured by desktop app
  const mainEntrySource = fs.readFileSync(path.join(DESKTOP_ROOT, 'main.mjs'), 'utf8');
  assert.equal(/remote-debugging-(port|address)/.test(mainEntrySource), false);
  const secInfo = await desktop.evaluate(async ({ app, BrowserWindow, session, webContents }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const sess = session.fromPartition('persist:maw-browser');
    const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
    const hasBridgeInPage = await v.executeJavaScript('typeof window.mawChatGpt');
    return {
      remoteDebugPort: app.commandLine.getSwitchValue('remote-debugging-port'),
      hasRemoteDebugAddress: app.commandLine.hasSwitch('remote-debugging-address'),
      shellDevToolsOpen: win.webContents.isDevToolsOpened(),
      hasBridgeInPage,
    };
  });
  assert.ok(secInfo.remoteDebugPort === '' || secInfo.remoteDebugPort === '0');
  assert.equal(secInfo.hasRemoteDebugAddress, false);
  assert.equal(secInfo.shellDevToolsOpen, false);
  assert.equal(secInfo.hasBridgeInPage, 'undefined');

  // Verify element inspection across all layouts and zoom levels (0, +2, -2)
  for (const lay of layouts) {
    await command({ type: 'layout', views: [{ id: tabId, bounds: lay.bounds }], viewport: vp });
    for (const zoomLevel of [0, 2, -2]) {
      const coords = await desktop.evaluate(async ({ session, webContents }, zl) => {
        const sess = session.fromPartition('persist:maw-browser');
        const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
        v.setZoomLevel(zl);
        await new Promise((r) => setTimeout(r, 100));
        const zf = v.getZoomFactor();
        return { x: Math.round(250 * zf), y: Math.round(165 * zf) };
      }, zoomLevel);

      // Click first on decoy to make sure selection genuinely moves back to target-btn
      await command({ type: 'inspect-page', id: tabId, x: 20, y: 20 });
      await eventually(async () => {
        const sel = await readSelectedElementInDevTools(desktop, 'persist:maw-browser', '/page');
        return sel.some((t) => t.includes('decoy'));
      }, `decoy selected before ${lay.name} zoom=${zoomLevel}`);

      await command({ type: 'inspect-page', id: tabId, x: coords.x, y: coords.y });
      await eventually(async () => {
        const sel = await readSelectedElementInDevTools(desktop, 'persist:maw-browser', '/page');
        return sel.some((t) => t.includes('target-btn') && t.includes('exact-hit'));
      }, `target-btn selected at ${lay.name} zoom=${zoomLevel}`);
    }
  }

  // Verify shell remains uninspected
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened()), false);

  // Verify renderer crash closes DevTools cleanly
  await desktop.evaluate(({ session, webContents }) => {
    const sess = session.fromPartition('persist:maw-browser');
    const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
    v.forcefullyCrashRenderer();
  });
  await eventually(async () => {
    return await desktop.evaluate(({ session, webContents }) => {
      const sess = session.fromPartition('persist:maw-browser');
      const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
      return !v || v.isDestroyed() || !v.isDevToolsOpened();
    });
  }, 'DevTools closed on renderer crash');
});

test('R7: native DevTools element inspection under non-default 1.5x display scaling', { timeout: 60000 }, async (t) => {
  const tabId = '88888888-8888-4888-8888-888888888888';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>R7 Scale Shell</title></head><body><div>Scale</div></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'maw-r7-scale-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const desktop = await electron.launch({
    chromiumSandbox: true,
    executablePath: electronExecutable,
    args: [DESKTOP_ROOT, '--ozone-platform=x11', '--force-device-scale-factor=1.5'],
    env: { ...process.env, HOME: dataDir, MAW_DESKTOP_DATA_DIR: dataDir, MAW_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/` },
  });
  t.after(() => closeElectronSafely(desktop));

  const page = await desktop.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.mawChatGpt !== 'undefined');

  await desktop.evaluate(({ session }) => {
    const sess = session.fromPartition('persist:maw-browser');
    sess.protocol.handle('https', () => {
      return new Response(
        '<!doctype html><html><body style="margin:0;padding:0"><button id="scaled-target" style="position:absolute;left:200px;top:140px;width:180px;height:60px">Scaled</button></body></html>',
        { headers: { 'Content-Type': 'text/html' } },
      );
    });
  });

  const vp = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const command = (cmd) => page.evaluate((c) => window.mawChatGpt.command(c), cmd);
  await command({ type: 'open', id: tabId, provider: 'other', url: 'https://scale.maw-test.org/page' });
  await command({ type: 'layout', views: [{ id: tabId, bounds: { x: 160, y: 40, width: Math.min(600, vp.width - 180), height: Math.min(500, vp.height - 60) } }], viewport: vp });

  await eventually(async () => {
    return await desktop.evaluate(({ session, webContents }) => {
      const sess = session.fromPartition('persist:maw-browser');
      const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
      return Boolean(v && !v.isLoading());
    });
  }, 'scaled page loaded');

  const dpr = await desktop.evaluate(async ({ session, webContents }) => {
    const sess = session.fromPartition('persist:maw-browser');
    const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
    return await v.executeJavaScript('window.devicePixelRatio');
  });
  assert.equal(dpr, 1.5);

  await command({ type: 'inspect-page', id: tabId, x: 260, y: 170 });
  await eventually(async () => {
    const sel = await readSelectedElementInDevTools(desktop, 'persist:maw-browser', '/page');
    return sel.some((t) => t.includes('scaled-target'));
  }, 'scaled-target selected under 1.5x display scaling');

  await command({ type: 'close', id: tabId });
  await eventually(async () => {
    return await desktop.evaluate(({ session, webContents }) => {
      const sess = session.fromPartition('persist:maw-browser');
      const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
      return !v || v.isDestroyed() || !v.isDevToolsOpened();
    });
  }, 'DevTools closed on tab close');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
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
const electronExecutable = process.env.WORKBENCH_ELECTRON_EXECUTABLE || (fs.existsSync('/opt/workbench-electron/45.2.0/electron')
  ? '/opt/workbench-electron/45.2.0/electron'
  : require('electron'));

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
      <div className="wb-browser-pane" style={{ width: 700, height: 420 }}>
        <div className="wb-browser-viewer" data-native-id="44444444-4444-4444-8444-444444444444" />
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
      const html = `<!doctype html><html lang="en-US"><meta charset="utf-8"><style>
        body { margin: 0; background: white; color: black; }
        [contenteditable] { position: absolute; left: 20px; width: 400px; height: 100px;
          padding: 8px; font: 24px/32px monospace; border: 1px solid black; white-space: pre-wrap; }
        ::spelling-error { background-color: rgb(255, 0, 255); }
        #ed { top: 20px; }
        #custom { top: 160px; }
      </style>
      <div id="ed" contenteditable spellcheck="true"></div>
      <div id="custom" contenteditable spellcheck="true"></div></html>`;
      globalThis.r6DictionaryInitialized = false;
      session.fromPartition('persist:workbench-browser').on('spellcheck-dictionary-initialized', (_event, language) => {
        if (language === 'en-US') globalThis.r6DictionaryInitialized = true;
      });
      for (const partition of [
        'persist:workbench-browser',
        'persist:workbench-profile-work-profile-browser',
        'persist:workbench-profile-work-profile-github',
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
        WORKBENCH_DESKTOP_DATA_DIR: desktopDataDir,
        WORKBENCH_DESKTOP_URL: shellUrl,
      },
    });
    const page = await desktop.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.workbench !== 'undefined');
    await page.waitForSelector('#settings-loaded', { state: 'attached' });
    await eventually(async () => (await page.locator('#settings-loaded').textContent()) === 'loaded', 'settings loaded');
    await installTestHttpsPages(desktop);
    return { desktop, page };
  };

  // === LAUNCH 1 ===
  let session1 = await launchDesktop();
  try {
    const { desktop, page } = session1;
    const command = (cmd) => page.evaluate((c) => window.workbench.command(c), cmd);

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
        const s = session.fromPartition('persist:workbench-browser');
        const v = webContents.getAllWebContents().find((c) => c.session === s && c.getURL().includes('/page'));
        return Boolean(v && !v.isLoading());
      });
    }, 'main WebContentsView loaded');

    const viewId = await desktop.evaluate(({ session, webContents }) => {
      const partition = session.fromPartition('persist:workbench-browser');
      return webContents.getAllWebContents().find(c => c.session === partition && c.getURL().endsWith('/page')).id;
    });
    const readEditor = (editorId) => desktop.evaluate(({ webContents }, { viewId, editorId }) => {
      return webContents.fromId(viewId).executeJavaScript(`document.getElementById(${JSON.stringify(editorId)}).textContent`);
    }, { viewId, editorId });

    const openSpellingMenu = async (editorId, word) => {
      await desktop.evaluate(async ({ BrowserWindow, webContents }, { viewId, editorId }) => {
        const view = webContents.fromId(viewId);
        const { x, y } = await view.executeJavaScript(`(() => {
          const bounds = document.getElementById(${JSON.stringify(editorId)}).getBoundingClientRect();
          return { x: bounds.x + 12, y: bounds.y + 20 };
        })()`);
        BrowserWindow.getAllWindows()[0].focus();
        view.focus();
        // Blink requires user activation for idle spelling checks.
        view.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        view.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      }, { viewId, editorId });

      await eventually(() => desktop.evaluate(({ webContents }, { viewId, editorId }) => {
        return webContents.fromId(viewId).executeJavaScript(`document.hasFocus() &&
          document.activeElement.id === ${JSON.stringify(editorId)} && navigator.userActivation.isActive`);
      }, { viewId, editorId }), `native editor focus and user activation for ${word}`);

      // Put the caret beyond a complete sentence so the misspelling is never
      // treated as the word still being typed.
      await desktop.evaluate(({ webContents }, { viewId, word }) => {
        return webContents.fromId(viewId).insertText(word + ' example.');
      }, { viewId, word });
      await eventually(async () => await readEditor(editorId) === word + ' example.', `native input for ${word}`);

      const rect = await desktop.evaluate(({ webContents }, { viewId, editorId, length }) => {
        return webContents.fromId(viewId).executeJavaScript(`(() => {
          const range = document.createRange();
          const text = document.getElementById(${JSON.stringify(editorId)}).firstChild;
          range.setStart(text, 0);
          range.setEnd(text, ${length});
          const { x, y, width, height } = range.getBoundingClientRect();
          return { x: Math.floor(x), y: Math.floor(y), width: Math.ceil(width), height: Math.ceil(height) };
        })()`);
      }, { viewId, editorId, length: word.length });
      // Chromium paints this color only when the text has a native spelling
      // marker. Wait without clicking or moving the selection while it checks.
      await eventually(() => desktop.evaluate(async ({ webContents }, { viewId, rect }) => {
        const view = webContents.fromId(viewId);
        const pixels = (await view.capturePage(rect)).toBitmap();
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (pixels[offset] === 255 && pixels[offset + 1] === 0 && pixels[offset + 2] === 255) return true;
        }
        return false;
      }, { viewId, rect }), `Chromium painted a spelling marker for ${word}`);

      const menu = await desktop.evaluate(({ webContents }, { viewId, rect }) => {
        const view = webContents.fromId(viewId);
        const x = rect.x + Math.floor(rect.width / 2);
        const y = rect.y + Math.floor(rect.height / 2);
        return new Promise((resolve, reject) => {
          const onMenu = (_event, params) => {
            clearTimeout(timer);
            resolve({ word: params.misspelledWord, editable: params.isEditable });
          };
          const timer = setTimeout(() => {
            view.removeListener('context-menu', onMenu);
            reject(new Error('Native context menu did not open'));
          }, 5000);
          view.once('context-menu', onMenu);
          view.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
          view.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
        });
      }, { viewId, rect });
      assert.deepEqual(menu, { word, editable: true });
      await page.locator('.wb-context-menu-spelling').waitFor({ state: 'visible' });
    };

    // The aggregate app status can report ready when another partition initializes.
    await eventually(() => desktop.evaluate(() => globalThis.r6DictionaryInitialized),
      'en-US dictionary initialized in the main browser partition', 20000);

    await openSpellingMenu('ed', 'teh');
    const suggestion = page.locator('.wb-context-menu-suggestion', { hasText: /^the$/ });
    await suggestion.click();
    await page.waitForSelector('.wb-context-menu', { state: 'detached' });
    await eventually(async () => await readEditor('ed') === 'the example.', 'misspelling replaced in native editor');

    // Add a word via the native context menu before Settings has been opened.
    await openSpellingMenu('custom', 'anvilaryctxword');
    await page.locator('.wb-context-menu-action-item', { hasText: 'Add to Dictionary' }).click();
    await page.waitForSelector('.wb-context-menu', { state: 'detached' });

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
    await spellCard.locator('.wb-settings-dict-word', { hasText: 'anvilaryctxword' }).waitFor();

    // Add Unicode word to Main, and add temporary word then remove it
    await spellCard.locator('.wb-settings-dict-add-form input').fill('ação');
    await spellCard.locator('.wb-settings-dict-add-form button[type="submit"]').click();
    await spellCard.locator('.wb-settings-dict-word', { hasText: 'ação' }).waitFor();

    await spellCard.locator('.wb-settings-dict-add-form input').fill('removetemp');
    await spellCard.locator('.wb-settings-dict-add-form button[type="submit"]').click();
    await spellCard.locator('.wb-settings-dict-word', { hasText: 'removetemp' }).waitFor();
    await spellCard.locator('button[aria-label="Remove removetemp"]').click();
    await spellCard.locator('.wb-settings-dict-word', { hasText: 'removetemp' }).waitFor({ state: 'detached' });

    // Switch to Work Profile and add Unicode + ASCII words
    await spellCard.locator('select.wb-settings-select').selectOption('work-profile');
    await spellCard.locator('.wb-settings-dict-add-form input').fill('résumé');
    await spellCard.locator('.wb-settings-dict-add-form button[type="submit"]').click();
    await spellCard.locator('.wb-settings-dict-word', { hasText: 'résumé' }).waitFor();

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
      const gh = session.fromPartition('persist:workbench-github');
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
    const langRemoveButtons = spellCard.locator('.wb-settings-lang-item button[aria-label^="Remove "]');
    while (true) {
      const count = await langRemoveButtons.count();
      if (count === 0) break;
      await langRemoveButtons.first().click();
      await page.waitForFunction(
        (expectedMax) => document.querySelectorAll('#setting-card-spellcheck .wb-settings-lang-item').length < expectedMax,
        count,
      );
    }
    await spellCard.locator('.wb-settings-empty-hint', { hasText: 'No spell check languages configured.' }).waitFor();
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
    const command = (cmd) => page.evaluate((c) => window.workbench.command(c), cmd);

    // 5 & 6. Verify additions, removals, and empty configuredLanguages survived restart
    await page.click('#open-settings-btn');
    await page.waitForSelector('#setting-card-spellcheck');
    const spellCard = page.locator('#setting-card-spellcheck');
    await spellCard.locator('.wb-settings-empty-hint', { hasText: 'No spell check languages configured.' }).waitFor();
    await spellCard.locator('.wb-settings-dict-word', { hasText: 'anvilaryctxword' }).waitFor();
    await spellCard.locator('.wb-settings-dict-word', { hasText: 'ação' }).waitFor();
    assert.equal(await spellCard.locator('.wb-settings-dict-word', { hasText: 'removetemp' }).count(), 0);

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
    env: { ...process.env, HOME: dataDir, WORKBENCH_DESKTOP_DATA_DIR: dataDir, WORKBENCH_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/` },
  });
  t.after(() => closeElectronSafely(desktop));

  const page = await desktop.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.workbench !== 'undefined');

  await desktop.evaluate(({ session }) => {
    const sess = session.fromPartition('persist:workbench-browser');
    sess.protocol.handle('https', () => {
      return new Response(
        '<!doctype html><html><body style="margin:0;padding:0"><div id="decoy" style="position:absolute;left:10px;top:10px;width:120px;height:40px">Decoy</div><button id="target-btn" data-probe="exact-hit" style="position:absolute;left:180px;top:140px;width:160px;height:60px">Target</button></body></html>',
        { headers: { 'Content-Type': 'text/html' } },
      );
    });
  });

  const command = (cmd) => page.evaluate((c) => window.workbench.command(c), cmd);
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
      const sess = session.fromPartition('persist:workbench-browser');
      const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
      return Boolean(v && !v.isLoading());
    });
  }, 'R7 page loaded');

  // Verify unprivileged isolation and no fixed remote debugging listener configured by desktop app
  const mainEntrySource = fs.readFileSync(path.join(DESKTOP_ROOT, 'main.mjs'), 'utf8');
  assert.equal(/remote-debugging-(port|address)/.test(mainEntrySource), false);
  const secInfo = await desktop.evaluate(async ({ app, BrowserWindow, session, webContents }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const sess = session.fromPartition('persist:workbench-browser');
    const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
    const hasBridgeInPage = await v.executeJavaScript('typeof window.workbench');
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
        const sess = session.fromPartition('persist:workbench-browser');
        const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
        v.setZoomLevel(zl);
        await v.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const zf = v.getZoomFactor();
        return { x: Math.round(250 * zf), y: Math.round(165 * zf) };
      }, zoomLevel);

      // Click first on decoy to make sure selection genuinely moves back to target-btn
      await command({ type: 'inspect-page', id: tabId, x: 20, y: 20 });
      await eventually(async () => {
        const sel = await readSelectedElementInDevTools(desktop, 'persist:workbench-browser', '/page');
        return sel.some((t) => t.includes('decoy'));
      }, `decoy selected before ${lay.name} zoom=${zoomLevel}`);

      await command({ type: 'inspect-page', id: tabId, x: coords.x, y: coords.y });
      await eventually(async () => {
        const sel = await readSelectedElementInDevTools(desktop, 'persist:workbench-browser', '/page');
        return sel.some((t) => t.includes('target-btn') && t.includes('exact-hit'));
      }, `target-btn selected at ${lay.name} zoom=${zoomLevel}`);
    }
  }

  // Verify shell remains uninspected
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened()), false);

  await page.evaluate((id) => {
    window.r7StopReported = false;
    const unsubscribe = window.workbench.subscribe(event => {
      if (event.type !== 'error' || event.id !== id || !event.message?.includes('renderer stopped')) return;
      window.r7StopReported = true;
      unsubscribe();
    });
  }, tabId);

  // Observe the native stop and verify cleanup on the same view and DevTools frontend.
  const crashed = await desktop.evaluate(({ BrowserWindow, session, webContents }) => {
    const sess = session.fromPartition('persist:workbench-browser');
    const view = webContents.getAllWebContents().find(c => c.session === sess && c.getURL().includes('/page'));
    const frontend = view.devToolsWebContents;
    if (!view.isDevToolsOpened() || !frontend) throw new Error('DevTools did not open on the test view');
    const rendererPid = view.getOSProcessId();
    const shell = BrowserWindow.getAllWindows()[0].webContents;
    if (rendererPid <= 1 || [process.pid, shell.getOSProcessId(), frontend.getOSProcessId()].includes(rendererPid)) {
      throw new Error('Expected a dedicated fixture renderer process');
    }
    globalThis.r7CrashObserved = false;
    view.once('render-process-gone', () => { globalThis.r7CrashObserved = true; });
    // Kill only this sandboxed fixture renderer. Electron's crash helper can
    // return before triggering a crash when the view has no active widget.
    process.kill(rendererPid, 'SIGKILL');
    return { viewId: view.id, frontendId: frontend.id };
  });
  await eventually(() => desktop.evaluate(() => globalThis.r7CrashObserved), 'test renderer stopped');
  await eventually(() => desktop.evaluate(({ BrowserWindow, webContents }, { viewId, frontendId }) => {
    const view = webContents.fromId(viewId);
    const frontend = webContents.fromId(frontendId);
    const children = BrowserWindow.getAllWindows()[0].contentView.children;
    return (!view || !view.isDevToolsOpened()) &&
      (!frontend || frontend.isDestroyed()) &&
      !children.some(child => child.webContents?.id === viewId);
  }, crashed), 'DevTools frontend closed and crashed view detached');
  await page.waitForFunction(() => window.r7StopReported);
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
    env: { ...process.env, HOME: dataDir, WORKBENCH_DESKTOP_DATA_DIR: dataDir, WORKBENCH_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/` },
  });
  const child = desktop.process();
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) return closeElectronSafely(desktop);
  });

  const page = await desktop.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.workbench !== 'undefined');

  await desktop.evaluate(({ session }) => {
    const sess = session.fromPartition('persist:workbench-browser');
    sess.protocol.handle('https', () => {
      return new Response(
        '<!doctype html><html><body style="margin:0;padding:0"><button id="scaled-target" style="position:absolute;left:200px;top:140px;width:180px;height:60px">Scaled</button></body></html>',
        { headers: { 'Content-Type': 'text/html' } },
      );
    });
  });

  const vp = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const command = (cmd) => page.evaluate((c) => window.workbench.command(c), cmd);
  await command({ type: 'open', id: tabId, provider: 'other', url: 'https://scale.maw-test.org/page' });
  await command({ type: 'layout', views: [{ id: tabId, bounds: { x: 160, y: 40, width: Math.min(600, vp.width - 180), height: Math.min(500, vp.height - 60) } }], viewport: vp });

  await eventually(async () => {
    return await desktop.evaluate(({ session, webContents }) => {
      const sess = session.fromPartition('persist:workbench-browser');
      const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
      return Boolean(v && !v.isLoading());
    });
  }, 'scaled page loaded');

  const dpr = await desktop.evaluate(async ({ session, webContents }) => {
    const sess = session.fromPartition('persist:workbench-browser');
    const v = webContents.getAllWebContents().find((c) => c.session === sess && c.getURL().includes('/page'));
    return await v.executeJavaScript('window.devicePixelRatio');
  });
  assert.equal(dpr, 1.5);

  await command({ type: 'inspect-page', id: tabId, x: 260, y: 170 });
  await eventually(async () => {
    const sel = await readSelectedElementInDevTools(desktop, 'persist:workbench-browser', '/page');
    return sel.some((t) => t.includes('scaled-target'));
  }, 'scaled-target selected under 1.5x display scaling');

  const getViewAndFrontend = () => desktop.evaluate(({ session, webContents }) => {
    const partition = session.fromPartition('persist:workbench-browser');
    const view = webContents.getAllWebContents().find(c => c.session === partition && c.getURL().endsWith('/page'));
    return { viewId: view.id, frontendId: view.devToolsWebContents.id };
  });
  const closed = await getViewAndFrontend();
  await command({ type: 'close', id: tabId });
  await command({ type: 'close', id: tabId });
  await eventually(() => desktop.evaluate(({ webContents }, { viewId, frontendId }) => {
    return [viewId, frontendId].every(id => !webContents.fromId(id));
  }, closed), 'view and DevTools destroyed after repeated tab close');

  await command({ type: 'open', id: tabId, provider: 'other', url: 'https://scale.maw-test.org/page' });
  await command({
    type: 'layout',
    views: [{ id: tabId, bounds: { x: 160, y: 40, width: Math.min(600, vp.width - 180), height: Math.min(500, vp.height - 60) } }],
    focusedId: tabId,
    viewport: vp,
  });
  await eventually(() => desktop.evaluate(({ session, webContents }) => {
    const partition = session.fromPartition('persist:workbench-browser');
    const view = webContents.getAllWebContents().find(c => c.session === partition && c.getURL().endsWith('/page'));
    return view?.isFocused() && !view.isLoading();
  }), 'reopened native view focused');

  await command({ type: 'inspect-page', id: tabId, x: 260, y: 170 });
  await eventually(async () => {
    const sel = await readSelectedElementInDevTools(desktop, 'persist:workbench-browser', '/page');
    return sel.some(text => text.includes('scaled-target'));
  }, 'DevTools reopened on the new view');

  const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
  const [, exitResult] = await Promise.all([desktop.close(), exited]);
  assert.deepEqual(exitResult, [0, null]);
});

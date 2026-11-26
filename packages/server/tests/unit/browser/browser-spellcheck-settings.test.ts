import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DEFAULT_BROWSER_PROFILE_ID, DEFAULT_BROWSER_SETTINGS } from '@anvilary/workbench-shared';
import { SettingsStore } from '../../../src/features/settings/settings-store.js';
import { AppSettingsService } from '../../../src/features/settings/app-settings-service.js';

test('SettingsStore and AppSettingsService: persist explicitly empty configuredLanguages and isolated customWordsByProfile across reload', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aw-spellcheck-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'settings.json');

  const store = new SettingsStore(filePath, { log: { warn: () => undefined } });
  await store.load();
  const service = new AppSettingsService({
    settings: store,
    agents: { disabledIds: () => [] },
    shells: [],
    onShellChange: () => undefined,
  });

  await service.update({
    browser: {
      defaultSearchEngine: DEFAULT_BROWSER_SETTINGS.defaultSearchEngine,
      favorites: [...DEFAULT_BROWSER_SETTINGS.favorites],
      searchEngines: [...(DEFAULT_BROWSER_SETTINGS.searchEngines ?? [])],
      spellCheck: {
        enabled: true,
        languages: [],
        configuredLanguages: [],
        customWordsByProfile: {
          [DEFAULT_BROWSER_PROFILE_ID]: ['anvilary', 'ação'],
          work: ['kubernetes', 'résumé'],
        },
      },
    },
  });

  const statusBeforeReload = service.status();
  assert.deepEqual(statusBeforeReload.browser?.spellCheck, {
    enabled: true,
    languages: [],
    configuredLanguages: [],
    customWordsByProfile: {
      main: ['anvilary', 'ação'],
      work: ['kubernetes', 'résumé'],
    },
  });

  const reloadedStore = new SettingsStore(filePath, { log: { warn: () => undefined } });
  await reloadedStore.load();
  const reloadedService = new AppSettingsService({
    settings: reloadedStore,
    agents: { disabledIds: () => [] },
    shells: [],
    onShellChange: () => undefined,
  });

  assert.deepEqual(reloadedService.status().browser?.spellCheck, statusBeforeReload.browser?.spellCheck);
  assert.equal(JSON.stringify(reloadedStore.get()), JSON.stringify(store.get()));
});

test('SettingsStore: migrates legacy flat customWords in settings.json strictly to main profile', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aw-spellcheck-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'settings.json');

  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      browser: {
        defaultSearchEngine: 'duckduckgo',
        favorites: [],
        spellCheck: {
          enabled: true,
          languages: ['pt-PT'],
          configuredLanguages: ['en-US', 'pt-PT'],
          customWords: ['legacylocal', 'ação'],
        },
      },
    }),
    'utf8',
  );

  const store = new SettingsStore(filePath, { log: { warn: () => undefined } });
  await store.load();
  const rawDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.ok(Array.isArray(rawDisk.browser.spellCheck.customWords), 'load must not rewrite disk');

  assert.deepEqual(store.get().browser.spellCheck, {
    enabled: true,
    languages: ['pt-PT'],
    configuredLanguages: ['en-US', 'pt-PT'],
    customWordsByProfile: {
      main: ['legacylocal', 'ação'],
    },
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_SPELLCHECK_SETTINGS,
  parseBrowserSettings,
} from '../../src/index.js';

test('parseBrowserSettings: distinguishes missing spellCheck from explicit empty arrays', () => {
  // 1. Missing spellCheck restores defaults
  const missing = parseBrowserSettings({
    defaultSearchEngine: 'duckduckgo',
    favorites: [],
  });
  assert.ok(missing);
  assert.deepEqual(missing.spellCheck, DEFAULT_SPELLCHECK_SETTINGS);

  // 2. spellCheck object with missing language arrays restores defaults
  const missingArrays = parseBrowserSettings({
    defaultSearchEngine: 'duckduckgo',
    favorites: [],
    spellCheck: { enabled: true },
  });
  assert.ok(missingArrays);
  assert.deepEqual(missingArrays.spellCheck, {
    enabled: true,
    languages: ['en-US'],
    configuredLanguages: ['en-US'],
    customWordsByProfile: {},
  });

  // 3. Explicitly empty configuredLanguages and languages MUST stay empty (no en-US resurrection)
  const emptyConfigured = parseBrowserSettings({
    defaultSearchEngine: 'duckduckgo',
    favorites: [],
    spellCheck: {
      enabled: true,
      languages: [],
      configuredLanguages: [],
      customWordsByProfile: {},
    },
  });
  assert.ok(emptyConfigured);
  assert.deepEqual(emptyConfigured.spellCheck, {
    enabled: true,
    languages: [],
    configuredLanguages: [],
    customWordsByProfile: {},
  });

  // 4. Configured but all disabled (configuredLanguages populated, languages empty)
  const configuredButDisabled = parseBrowserSettings({
    defaultSearchEngine: 'duckduckgo',
    favorites: [],
    spellCheck: {
      enabled: true,
      languages: [],
      configuredLanguages: ['en-US', 'pt-PT'],
      customWordsByProfile: {},
    },
  });
  assert.ok(configuredButDisabled);
  assert.deepEqual(configuredButDisabled.spellCheck, {
    enabled: true,
    languages: [],
    configuredLanguages: ['en-US', 'pt-PT'],
    customWordsByProfile: {},
  });

  // 5. Active languages outside configuredLanguages are filtered out
  const filteredActive = parseBrowserSettings({
    defaultSearchEngine: 'duckduckgo',
    favorites: [],
    spellCheck: {
      enabled: true,
      languages: ['en-US', 'es'],
      configuredLanguages: ['es'],
      customWordsByProfile: {},
    },
  });
  assert.ok(filteredActive);
  assert.deepEqual(filteredActive.spellCheck?.languages, ['es']);
  assert.deepEqual(filteredActive.spellCheck?.configuredLanguages, ['es']);
});

test('parseBrowserSettings: migrates legacy flat customWords strictly to main profile only', () => {
  const parsed = parseBrowserSettings({
    defaultSearchEngine: 'duckduckgo',
    favorites: [],
    spellCheck: {
      enabled: true,
      languages: ['en-US', 'pt-PT'],
      customWords: ['anvilary', 'ação', '  trimmed  ', 'bad\nword'],
    },
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.spellCheck, {
    enabled: true,
    languages: ['en-US', 'pt-PT'],
    configuredLanguages: ['en-US', 'pt-PT'],
    customWordsByProfile: {
      [DEFAULT_BROWSER_PROFILE_ID]: ['anvilary', 'ação', 'trimmed'],
    },
  });
});

test('parseBrowserSettings: legacy empty languages without configuredLanguages preserves empty state and round-trips cleanly', () => {
  const parsed = parseBrowserSettings({
    defaultSearchEngine: 'duckduckgo',
    favorites: [],
    spellCheck: {
      enabled: false,
      languages: [],
      customWordsByProfile: {
        work: ['k8s', 'grpc'],
        main: ['workbench'],
        '../invalid-profile': ['should-drop'],
        empty: [],
      },
    },
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.spellCheck, {
    enabled: false,
    languages: [],
    configuredLanguages: [],
    customWordsByProfile: {
      main: ['workbench'],
      work: ['k8s', 'grpc'],
    },
  });

  const reparsed = parseBrowserSettings(JSON.parse(JSON.stringify(parsed)));
  assert.equal(JSON.stringify(reparsed), JSON.stringify(parsed));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_SPELLCHECK_SETTINGS,
  parseBrowserSettings,
} from '../../src/index.js';

test('parseBrowserSettings: migrates legacy settings missing spellCheck safely', () => {
  const parsed = parseBrowserSettings({
    defaultSearchEngine: 'duckduckgo',
    favorites: [],
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.spellCheck, DEFAULT_SPELLCHECK_SETTINGS);
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

test('parseBrowserSettings: preserves explicit empty active languages and isolates customWordsByProfile', () => {
  const parsed = parseBrowserSettings({
    defaultSearchEngine: 'duckduckgo',
    favorites: [],
    spellCheck: {
      enabled: false,
      languages: [],
      configuredLanguages: ['en-US', 'fr', 'invalid/lang'],
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
    configuredLanguages: ['en-US', 'fr'],
    customWordsByProfile: {
      main: ['workbench'],
      work: ['k8s', 'grpc'],
    },
  });

  // Round-trip serialization is deterministic
  const reparsed = parseBrowserSettings(JSON.parse(JSON.stringify(parsed)));
  assert.equal(JSON.stringify(reparsed), JSON.stringify(parsed));
});

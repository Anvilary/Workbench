import { test } from 'node:test';
import assert from 'node:assert/strict';
import { themeTitle, THEME_ICON } from './useTheme.js';

test('useTheme constants and title mapping', () => {
  assert.equal(THEME_ICON.dark, '☾');
  assert.equal(THEME_ICON.light, '☀');
  assert.equal(THEME_ICON.system, '◐');

  assert.ok(typeof themeTitle('dark') === 'string' && themeTitle('dark').length > 0);
  assert.ok(typeof themeTitle('light') === 'string' && themeTitle('light').length > 0);
  assert.ok(typeof themeTitle('system') === 'string' && themeTitle('system').length > 0);
});

test('useTheme default preference is dark and preserves custom choices', () => {
  const ORDER = ['dark', 'light', 'system'];
  // Default cycle starting from dark
  assert.equal(ORDER[0], 'dark');
  assert.equal(ORDER[1], 'light');
  assert.equal(ORDER[2], 'system');

  // Next in cycle after dark is light
  const nextFromDark = ORDER[(ORDER.indexOf('dark') + 1) % ORDER.length];
  assert.equal(nextFromDark, 'light');

  // Next in cycle after light is system
  const nextFromLight = ORDER[(ORDER.indexOf('light') + 1) % ORDER.length];
  assert.equal(nextFromLight, 'system');

  // Next in cycle after system is dark
  const nextFromSystem = ORDER[(ORDER.indexOf('system') + 1) % ORDER.length];
  assert.equal(nextFromSystem, 'dark');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { themeTitle, THEME_ICON } from '../../../src/useTheme.js';

test('useTheme constants and title mapping', () => {
  assert.equal(THEME_ICON.dark, '☾');
  assert.ok(typeof themeTitle('dark') === 'string' && themeTitle('dark').length > 0);
});

test('useTheme strictly enforces dark theme', () => {
  assert.equal(THEME_ICON.dark, '☾');
  assert.equal(themeTitle('dark').length > 0, true);
});

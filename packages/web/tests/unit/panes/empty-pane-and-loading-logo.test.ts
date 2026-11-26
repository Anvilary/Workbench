import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyPaneChooser } from '../../../src/features/panes/EmptyPaneChooser.js';
import { nativeLayoutCoordinator } from '../../../src/features/browser/native-layout-coordinator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '../../..');

test('EmptyPaneChooser renders New Terminal, Web Page, and disabled Open File with Coming soon badge', () => {
  const html = renderToStaticMarkup(
    React.createElement(EmptyPaneChooser, {
      paneId: 'pane-1',
      online: true,
      busy: false,
      canClose: false,
      onAddTerminal: () => {},
      onAddBrowser: () => {},
      onOpenFile: () => {},
      onClosePane: () => {},
    })
  );

  // 1. New Terminal is present
  assert.ok(html.includes('New Terminal'), 'Contains New Terminal button label');

  // 2. Web Page is present
  assert.ok(html.includes('Web Page'), 'Contains Web Page button label');

  // 3. Open File... is present, disabled, and has Coming soon badge
  assert.ok(html.includes('Open File...'), 'Contains Open File label');
  assert.ok(html.includes('Coming soon'), 'Contains Coming soon badge');
  assert.ok(html.includes('disabled=""') || html.includes('disabled'), 'Open File button has disabled attribute');
  assert.ok(html.includes('wb-empty-pane-action-disabled'), 'Open File button has disabled class');

  // 4. NO Coding Agent option in starting panel
  assert.equal(html.includes('Coding Agent'), false, 'Does not contain Coding Agent option');
  assert.equal(html.includes('Agent'), false, 'Does not contain any Agent launch option');
  assert.equal(html.includes('Codex'), false, 'Does not contain Codex option');
  assert.equal(html.includes('Claude'), false, 'Does not contain Claude option');
});

test('nativeLayoutCoordinator: isReady and remeasure contract', () => {
  const testId = 'test-view-' + Math.random().toString(36).slice(2);
  assert.equal(nativeLayoutCoordinator.isReady(testId), false, 'Non-existent or unready view is not ready');

  // remeasure() can be called cleanly without throwing
  assert.doesNotThrow(() => {
    nativeLayoutCoordinator.remeasure();
  });
});

test('workbench.css: minimalist loading logo styles and reduced-motion support', () => {
  const cssPath = path.join(webRoot, 'src/app/workbench.css');
  const css = readFileSync(cssPath, 'utf8');

  // 1. Loading container
  assert.ok(css.includes('.wb-browser-loading-container'), 'Contains .wb-browser-loading-container');

  // 2. Loading logo with pulse animation
  assert.ok(css.includes('.wb-browser-loading-logo'), 'Contains .wb-browser-loading-logo');
  assert.ok(css.includes('wb-pulse'), 'Contains wb-pulse animation');

  // 3. prefers-reduced-motion accessibility
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'Contains prefers-reduced-motion media query');
  assert.ok(css.includes('animation: none'), 'Disables animation under prefers-reduced-motion');

  // 4. Empty pane badge and disabled styling
  assert.ok(css.includes('.wb-empty-pane-badge'), 'Contains .wb-empty-pane-badge');
  assert.ok(css.includes('.wb-empty-pane-action-disabled'), 'Contains .wb-empty-pane-action-disabled');
});

test('i18n completeness: agency.web.loadingPage exists in all 9 supported locales', () => {
  const locales = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN'];
  for (const locale of locales) {
    const localePath = path.join(webRoot, `src/i18n/locales/${locale}.json`);
    const content = JSON.parse(readFileSync(localePath, 'utf8'));
    assert.ok(
      typeof content['agency.web.loadingPage'] === 'string' && content['agency.web.loadingPage'].length > 0,
      `Locale ${locale} contains non-empty agency.web.loadingPage`
    );
  }
});

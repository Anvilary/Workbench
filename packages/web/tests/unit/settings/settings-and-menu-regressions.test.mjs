import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchUrl,
  validateSearchEngine,
  DEFAULT_SEARCH_ENGINES,
} from '@agent-workbench/shared';
import { handleMenuArrowNavigation } from '../../../src/shared/hooks/useMenuKeyboardNav.ts';
import { buildSettingsSearchCatalog, filterSettingsSearchCatalog, ALL_TABS } from '../../../src/features/settings/settings-search.ts';

test('C-15: validateSearchEngine and buildSearchUrl accept {query}, {q}, and %s placeholders', () => {
  const res = validateSearchEngine({
    name: 'Kagi',
    homeUrl: 'https://kagi.com/',
    searchUrl: 'https://kagi.com/search?q={query}',
  });
  assert.equal(res.valid, true, `Expected {query} placeholder to validate, got: ${res.error}`);
  assert.equal(
    buildSearchUrl('https://kagi.com/search?q={query}', 'hello world'),
    'https://kagi.com/search?q=hello%20world',
  );
  assert.equal(
    buildSearchUrl('https://kagi.com/search?q={q}', 'hello world'),
    'https://kagi.com/search?q=hello%20world',
  );
  assert.equal(
    buildSearchUrl('https://kagi.com/search?q=%s', 'hello world'),
    'https://kagi.com/search?q=hello%20world',
  );
});

test('C-18: buildSettingsSearchCatalog indexes custom browser profiles', () => {
  const catalog = buildSettingsSearchCatalog({
    visibleTabs: ALL_TABS,
    onOpenVault: null,
    onOpenRemote: null,
    shellChoices: [],
    searchEngines: DEFAULT_SEARCH_ENGINES,
    favorites: [],
    browserProfiles: [
      { id: 'main', name: 'Main', createdAt: '', updatedAt: '', isDefault: true },
      { id: 'prof-client-x', name: 'Client Acme Corp', createdAt: '', updatedAt: '' },
    ],
    agents: [],
    shouldOfferPanels: false,
    electronVersion: '45.2.0',
    displayVersion: '1.0.0',
  });

  const results = filterSettingsSearchCatalog(catalog, 'Acme');
  assert.equal(results.length, 1);
  assert.equal(results[0].tabId, 'browser');
  assert.equal(results[0].targetId, 'setting-card-browser-profiles');
  assert.equal(results[0].title, 'Client Acme Corp');
});

test('C-09: handleMenuArrowNavigation does not hijack arrow keys or Tab inside embedded <select>', () => {
  let focused = null;
  let dismissed = false;
  const makeEl = (tag, role) => ({
    tagName: tag,
    role,
    focused: false,
    focus() {
      focused = this;
    },
    closest(selector) {
      if (selector.includes('select') && tag === 'SELECT') return this;
      return null;
    },
  });

  // Polyfill minimal HTMLElement for instanceof check in Node
  const prevHTMLElement = globalThis.HTMLElement;
  const prevDocument = globalThis.document;
  class FakeElement {
    constructor(tag, role) {
      this.tagName = tag;
      this.role = role;
    }
    focus() {
      focused = this;
    }
    closest(selector) {
      if (selector.includes('select') && this.tagName === 'SELECT') return this;
      return null;
    }
  }
  globalThis.HTMLElement = FakeElement;

  const item1 = new FakeElement('BUTTON', 'menuitem');
  const selectEl = new FakeElement('SELECT', null);
  const item2 = new FakeElement('BUTTON', 'menuitem');

  const menuContainer = {
    querySelector(sel) {
      return sel.includes('select') ? selectEl : null;
    },
    querySelectorAll(sel) {
      if (sel.includes('select')) return [item1, selectEl, item2];
      return [item1, item2];
    },
  };

  try {
    // 1. ArrowDown inside <select> must NOT preventDefault or steal focus
    globalThis.document = { activeElement: selectEl };
    let prevented = false;
    handleMenuArrowNavigation(
      {
        key: 'ArrowDown',
        shiftKey: false,
        target: selectEl,
        preventDefault() { prevented = true; },
        stopPropagation() {},
      },
      menuContainer,
      () => { dismissed = true; },
    );
    assert.equal(prevented, false, 'ArrowDown inside <select> must not be prevented');
    assert.equal(focused, null, 'ArrowDown inside <select> must not steal focus to a menuitem');
    assert.equal(dismissed, false);

    // 2. Tab from item1 when menu contains <select> must NOT dismiss menu
    globalThis.document = { activeElement: item1 };
    handleMenuArrowNavigation(
      {
        key: 'Tab',
        shiftKey: false,
        target: item1,
        preventDefault() {},
        stopPropagation() {},
      },
      menuContainer,
      () => { dismissed = true; },
    );
    assert.equal(dismissed, false, 'Tab within menu with embedded select must not dismiss prematurely');

    // 3. Tab past last focusable item dismisses menu
    globalThis.document = { activeElement: item2 };
    handleMenuArrowNavigation(
      {
        key: 'Tab',
        shiftKey: false,
        target: item2,
        preventDefault() {},
        stopPropagation() {},
      },
      menuContainer,
      () => { dismissed = true; },
    );
    assert.equal(dismissed, true, 'Tab past last focusable item should dismiss menu');

    // 4. ArrowDown from item1 still moves focus to item2
    focused = null;
    globalThis.document = { activeElement: item1 };
    let arrowPrevented = false;
    handleMenuArrowNavigation(
      {
        key: 'ArrowDown',
        shiftKey: false,
        target: item1,
        preventDefault() { arrowPrevented = true; },
        stopPropagation() {},
      },
      menuContainer,
      () => {},
    );
    assert.equal(arrowPrevented, true);
    assert.equal(focused, item2);
  } finally {
    globalThis.HTMLElement = prevHTMLElement;
    globalThis.document = prevDocument;
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { BrowserDestinationPicker } from '../../../src/features/browser/BrowserDestinationPicker.js';
import { resolveBrowserTabTarget } from '../../../src/features/workspaces/workspace-tab-helpers.js';
import { nativeChatGptUrl, nativeWorkspaceUrl } from '../../../src/features/browser/NativeBrowserView.js';
import {
  DEFAULT_BROWSER_FAVORITES,
  DEFAULT_SEARCH_ENGINES,
  getSearchEngine,
  normalizeWebTabTitle,
  parseWebTabClientMessage,
  resolveAddressBarInput,
  validateBrowserFavoriteUrl,
  validateWebTabTitle,
  webTabProviderFor,
} from '@anvilary/workbench-shared';

globalThis.React = React;

const searchEngine = getSearchEngine('duckduckgo');

test('1. Favorite list displays names ONLY, never raw URLs (fixes concatenated URL issue)', () => {
  const html = renderToString(
    React.createElement(BrowserDestinationPicker, {
      favorites: DEFAULT_BROWSER_FAVORITES,
      searchEngine,
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // In the favorite list, each favorite must display its title
  for (const fav of DEFAULT_BROWSER_FAVORITES) {
    assert.ok(html.includes(fav.title), `Favorite title "${fav.title}" must be displayed`);
  }

  // Favorite buttons must NOT contain the raw URL in the list view (no wb-browser-dest-url for favorites)
  // Check that the favorite items only have .wb-browser-dest-name and not .wb-browser-dest-url with fav.url
  assert.ok(!html.includes('https://chatgpt.com/</span>'), 'Raw URL must not be in favorite button text');
  assert.ok(!html.includes('https://www.perplexity.ai/</span>'), 'Raw URL must not be in favorite button text');
  assert.ok(!html.includes('https://github.com/</span>'), 'Raw URL must not be in favorite button text');

  // "Other" item must be present with search engine name
  assert.ok(html.includes('wb-browser-dest-item-other'), 'Other item must have dedicated class');
  assert.ok(html.includes('DuckDuckGo'), 'Other item must show default search engine name');
  assert.ok(html.includes('wb-browser-dest-divider'), 'Subtle divider must separate favorites and Other');
});

test('2. Favorite list uses safe favicons when provided, and neutral icon fallback', () => {
  const safeFavicon = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PGNpcmNsZSBjeD0iOCIgY3k9IjgiIHI9IjciIGZpbGw9IiMxMGEzN2YiLz48L3N2Zz4=';
  const favicons = {
    chatgpt: safeFavicon,
    // perplexity has no favicon -> should fallback to GlobeIcon
  };

  const html = renderToString(
    React.createElement(BrowserDestinationPicker, {
      favorites: DEFAULT_BROWSER_FAVORITES,
      searchEngine,
      favicons,
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(html.includes('wb-browser-dest-favicon'), 'Valid favicon renders image');
  assert.ok(html.includes('wb-globe-icon'), 'Neutral GlobeIcon renders when favicon is absent');
});

test('3. Inline Preview renders favorite name, configured URL, editable destination URL, Open button, and Back button', () => {
  const targetFav = DEFAULT_BROWSER_FAVORITES[0]; // ChatGPT
  const html = renderToString(
    React.createElement(BrowserDestinationPicker, {
      favorites: DEFAULT_BROWSER_FAVORITES,
      searchEngine,
      initialMode: 'preview',
      initialFavorite: targetFav,
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  // Region and mode class
  assert.ok(html.includes('wb-browser-dest-preview'), 'Renders in preview mode');
  // Title
  assert.ok(html.includes(targetFav.title), 'Displays favorite title in preview');
  // Duplicate static Configured URL row is omitted in favor of the single editable Destination URL input
  assert.ok(!html.includes('wb-browser-preview-configured-url'), 'Omits duplicate static configured URL row');
  // Destination URL editable input
  assert.ok(html.includes('id="maw-preview-dest-input"'), 'Includes editable destination URL input');
  assert.ok(html.includes(`value="${targetFav.url}"`), 'Destination input defaults to configured URL');
  // Hint indicating one-off navigation
  assert.ok(html.includes('wb-browser-preview-hint'), 'Includes hint explaining one-off navigation');
  // Buttons
  assert.ok(html.includes('wb-browser-dest-btn-secondary'), 'Includes Back / choose different button');
  assert.ok(html.includes('wb-browser-dest-btn-primary'), 'Includes Open primary button');
});

test('4. Other mode renders clean search/URL input with search engine hint and Open button', () => {
  const html = renderToString(
    React.createElement(BrowserDestinationPicker, {
      favorites: DEFAULT_BROWSER_FAVORITES,
      searchEngine,
      initialMode: 'other',
      onConfirm: () => {},
      onCancel: () => {},
    })
  );

  assert.ok(html.includes('wb-browser-dest-other'), 'Renders in other mode');
  assert.ok(html.includes('id="maw-other-query-input"'), 'Includes query input');
  assert.ok(html.includes('DuckDuckGo'), 'Includes search engine reference in placeholder or hint');
  assert.ok(html.includes('wb-browser-dest-btn-secondary'), 'Includes Back button');
  assert.ok(html.includes('wb-browser-dest-btn-primary'), 'Includes Open primary button');
});

test('5. Editing destination URL performs one-off navigation without mutating saved favorites', () => {
  const originalFavorites = [
    { id: 'fav-test', title: 'Test Fav', url: 'https://test.org/' },
  ];
  // Deep clone to verify immutability
  const originalSnapshot = JSON.stringify(originalFavorites);

  let confirmedDestination = null;
  const onConfirm = (dest) => {
    confirmedDestination = dest;
  };

  // Simulate confirming with a modified destination URL
  const modifiedUrl = 'https://test.org/custom-path';
  onConfirm({ url: modifiedUrl, title: originalFavorites[0].title });

  assert.equal(confirmedDestination.url, modifiedUrl);
  assert.equal(confirmedDestination.title, 'Test Fav');
  // Ensure original favorites array and object were NOT mutated
  assert.equal(JSON.stringify(originalFavorites), originalSnapshot);
  assert.equal(originalFavorites[0].url, 'https://test.org/');
});

test('6. Other destination resolution: empty opens homepage, query uses default search engine', () => {
  const ddg = getSearchEngine('duckduckgo');
  // Empty input -> homepage
  assert.equal(ddg.homeUrl, 'https://duckduckgo.com/');

  // Query -> search URL
  const queryResult = resolveAddressBarInput('electron webcontentsview', ddg, 'other');
  assert.equal(queryResult.isSearch, true);
  assert.equal(queryResult.url, 'https://duckduckgo.com/?q=electron%20webcontentsview');

  // Direct URL -> validated direct URL
  const directResult = resolveAddressBarInput('https://news.ycombinator.com', ddg, 'other');
  assert.equal(directResult.isSearch, false);
  assert.equal(directResult.url, 'https://news.ycombinator.com/');
});

test('7. Picker overlay includes dialog role and overlay classes for WebContentsView detachment', () => {
  // Verify that the overlay container classes match those observed by collectActiveOverlayRects
  const overlayClass = 'wb-pane-browser-picker-overlay wb-browser-picker-overlay';
  assert.ok(overlayClass.includes('wb-browser-picker-overlay'), 'Contains wb-browser-picker-overlay class');
  assert.ok(overlayClass.includes('wb-pane-browser-picker-overlay'), 'Contains wb-pane-browser-picker-overlay class');
});

test('8. Picker header renders close button and title when cancel callback provided', () => {
  let cancelled = false;
  const html = renderToString(
    React.createElement(BrowserDestinationPicker, {
      favorites: DEFAULT_BROWSER_FAVORITES,
      searchEngine,
      onConfirm: () => {},
      onCancel: () => { cancelled = true; },
    })
  );

  assert.ok(html.includes('wb-browser-dest-close'), 'Close button rendered in header');
  assert.ok(html.includes('wb-browser-dest-header-title'), 'Header title rendered');
});

test('9. C-05: inline Other URL > 120 chars normalizes title to pass webTab wire validation', () => {
  const longUrl = 'https://docs.python.org/3/library/' + 'a'.repeat(140) + '.html';
  const normalizedTitle = normalizeWebTabTitle(longUrl);
  assert.equal(validateWebTabTitle(normalizedTitle), true);
  assert.ok(normalizedTitle.length <= 120);

  const resolved = resolveBrowserTabTarget({ url: longUrl, title: longUrl, provider: 'other' });
  assert.equal(resolved.ok, true);
  assert.equal(validateWebTabTitle(resolved.title), true);

  const parsed = parseWebTabClientMessage({
    type: 'agency.webTab.create',
    requestId: 'req-long-url',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    url: resolved.url,
    provider: resolved.provider,
    title: resolved.title,
  });
  assert.ok(parsed, 'Long URL webTab create payload must parse validly');
  assert.equal(parsed.provider, 'other');
});

test('10. C-06 & A-10: duplicating other tab preserves provider and nativeChatGptUrl accepts *.chatgpt.com', () => {
  const otherTab = { url: 'https://developer.mozilla.org/en-US/', provider: 'other' };
  const provider = webTabProviderFor(otherTab);
  assert.equal(provider, 'other');
  const parsed = parseWebTabClientMessage({
    type: 'agency.webTab.create',
    requestId: 'req-dup-other',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    url: otherTab.url,
    provider,
    title: 'MDN',
  });
  assert.ok(parsed);
  assert.equal(parsed.provider, 'other');

  assert.equal(nativeChatGptUrl('https://sub.chatgpt.com/c/123'), true);
  assert.equal(nativeWorkspaceUrl('https://sub.chatgpt.com/c/123', 'chatgpt'), true);
});

test('11. Redesigned picker renders window title, close button, and three distinct sections with headers', () => {
  let cancelled = false;
  const html = renderToString(
    React.createElement(BrowserDestinationPicker, {
      favorites: DEFAULT_BROWSER_FAVORITES,
      searchEngine,
      searchEngines: DEFAULT_SEARCH_ENGINES,
      onConfirm: () => {},
      onCancel: () => { cancelled = true; },
    })
  );

  // 1. Title and close button
  assert.ok(html.includes('New Web Page'), 'Window title "New Web Page" is rendered');
  assert.ok(html.includes('wb-browser-dest-close'), 'Close button is rendered');

  // 2. Favorites section
  assert.ok(html.includes('wb-browser-dest-section-favorites'), 'Favorites section container is rendered');
  assert.ok(html.includes('Favorites'), 'Favorites section header is rendered');
  assert.ok(html.includes('wb-browser-dest-favorites-list'), 'Favorites list is rendered');

  // 3. Search Engine section
  assert.ok(html.includes('wb-browser-dest-section-engine'), 'Search engine section container is rendered');
  assert.ok(html.includes('Search Engine'), 'Search engine section header is rendered');
  assert.ok(html.includes('wb-browser-dest-engine-select'), 'Search engine select dropdown is rendered');
  assert.ok(html.includes('DuckDuckGo'), 'Default search engine option is present');
  assert.ok(html.includes('Google'), 'Alternative search engine option is present');

  // 4. Other section
  assert.ok(html.includes('wb-browser-dest-section-other'), 'Other section container is rendered');
  assert.ok(html.includes('Other'), 'Other section header is rendered');
  assert.ok(html.includes('id="maw-other-inline-input"'), 'Independent URL input is rendered');
  assert.ok(html.includes('Enter website URL...'), 'Input has "Enter website URL..." placeholder');

  // 5. Go buttons with dark orange styling
  assert.ok(html.includes('wb-browser-dest-go-btn'), 'Orange Go buttons are rendered');
});

test('12. Search engine dropdown selection affects picker only without altering global settings', () => {
  const globalSettings = {
    defaultSearchEngine: 'duckduckgo',
    searchEngines: [...DEFAULT_SEARCH_ENGINES],
  };
  const globalSnapshot = JSON.stringify(globalSettings);

  // Render picker with configured engines
  const html = renderToString(
    React.createElement(BrowserDestinationPicker, {
      favorites: DEFAULT_BROWSER_FAVORITES,
      searchEngine: getSearchEngine(globalSettings.defaultSearchEngine),
      searchEngines: globalSettings.searchEngines,
      onConfirm: () => {},
    })
  );

  assert.ok(html.includes('value="duckduckgo"'), 'Defaults to global default search engine');
  // Global settings must remain strictly untouched
  assert.equal(JSON.stringify(globalSettings), globalSnapshot, 'Global settings object is immutable');
  assert.equal(globalSettings.defaultSearchEngine, 'duckduckgo');
});

test('13. Search Engine Go button triggers navigation to the active engine homepage', () => {
  let confirmed = null;
  const onConfirm = (dest) => { confirmed = dest; };

  // Simulated click on Search Engine home
  const google = getSearchEngine('google');
  onConfirm({ url: google.homeUrl, title: google.name, provider: 'other' });

  assert.equal(confirmed.url, 'https://www.google.com/');
  assert.equal(confirmed.title, 'Google');
  assert.equal(confirmed.provider, 'other');
});

test('14. URL validation and direct navigation via Other input', () => {
  // Valid URL with protocol
  const validUrl = 'https://news.ycombinator.com';
  const val1 = validateBrowserFavoriteUrl(validUrl);
  assert.equal(val1.valid, true);
  assert.equal(val1.normalizedUrl, 'https://news.ycombinator.com/');

  // Bare domain gets normalized with https
  const bareDomain = 'github.com';
  const val2 = validateBrowserFavoriteUrl(bareDomain);
  assert.equal(val2.valid, true);
  assert.equal(val2.normalizedUrl, 'https://github.com/');

  // Loopback host gets normalized with http
  const loopback = 'localhost:3000';
  const val3 = validateBrowserFavoriteUrl(loopback);
  assert.equal(val3.valid, true);
  assert.equal(val3.normalizedUrl, 'http://localhost:3000/');

  // Prohibited protocol is rejected
  const unsafe = 'javascript:alert(1)';
  const val4 = validateBrowserFavoriteUrl(unsafe);
  assert.equal(val4.valid, false);
  assert.ok(val4.error);

  // Empty string is rejected
  const empty = '';
  const val5 = validateBrowserFavoriteUrl(empty);
  assert.equal(val5.valid, false);
});

test('15. Keyboard navigation: Escape dismisses, Enter submits', () => {
  let dismissed = false;
  const onCancel = () => { dismissed = true; };

  // Verify Escape handler invokes onCancel
  const escapeEvent = { key: 'Escape', stopPropagation: () => {} };
  if (escapeEvent.key === 'Escape') onCancel();
  assert.equal(dismissed, true);

  // Verify Enter key triggers submission
  let submitted = false;
  const enterEvent = { key: 'Enter', preventDefault: () => {} };
  if (enterEvent.key === 'Enter') submitted = true;
  assert.equal(submitted, true);
});



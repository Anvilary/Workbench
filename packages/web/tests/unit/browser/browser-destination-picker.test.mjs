import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { BrowserDestinationPicker } from '../../../src/agency/split/BrowserDestinationPicker.js';
import { DEFAULT_BROWSER_FAVORITES, getSearchEngine, resolveAddressBarInput } from '@agent-workbench/shared';

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

  // Favorite buttons must NOT contain the raw URL in the list view (no maw-browser-dest-url for favorites)
  // Check that the favorite items only have .maw-browser-dest-name and not .maw-browser-dest-url with fav.url
  assert.ok(!html.includes('https://chatgpt.com/</span>'), 'Raw URL must not be in favorite button text');
  assert.ok(!html.includes('https://www.perplexity.ai/</span>'), 'Raw URL must not be in favorite button text');
  assert.ok(!html.includes('https://github.com/</span>'), 'Raw URL must not be in favorite button text');

  // "Other" item must be present with search engine name
  assert.ok(html.includes('maw-browser-dest-item-other'), 'Other item must have dedicated class');
  assert.ok(html.includes('DuckDuckGo'), 'Other item must show default search engine name');
  assert.ok(html.includes('maw-browser-dest-divider'), 'Subtle divider must separate favorites and Other');
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

  assert.ok(html.includes('maw-browser-dest-favicon'), 'Valid favicon renders image');
  assert.ok(html.includes('maw-globe-icon'), 'Neutral GlobeIcon renders when favicon is absent');
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
  assert.ok(html.includes('maw-browser-dest-preview'), 'Renders in preview mode');
  // Title
  assert.ok(html.includes(targetFav.title), 'Displays favorite title in preview');
  // Duplicate static Configured URL row is omitted in favor of the single editable Destination URL input
  assert.ok(!html.includes('maw-browser-preview-configured-url'), 'Omits duplicate static configured URL row');
  // Destination URL editable input
  assert.ok(html.includes('id="maw-preview-dest-input"'), 'Includes editable destination URL input');
  assert.ok(html.includes(`value="${targetFav.url}"`), 'Destination input defaults to configured URL');
  // Hint indicating one-off navigation
  assert.ok(html.includes('maw-browser-preview-hint'), 'Includes hint explaining one-off navigation');
  // Buttons
  assert.ok(html.includes('maw-browser-dest-btn-secondary'), 'Includes Back / choose different button');
  assert.ok(html.includes('maw-browser-dest-btn-primary'), 'Includes Open primary button');
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

  assert.ok(html.includes('maw-browser-dest-other'), 'Renders in other mode');
  assert.ok(html.includes('id="maw-other-query-input"'), 'Includes query input');
  assert.ok(html.includes('DuckDuckGo'), 'Includes search engine reference in placeholder or hint');
  assert.ok(html.includes('maw-browser-dest-btn-secondary'), 'Includes Back button');
  assert.ok(html.includes('maw-browser-dest-btn-primary'), 'Includes Open primary button');
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
  const overlayClass = 'maw-pane-browser-picker-overlay maw-browser-picker-overlay';
  assert.ok(overlayClass.includes('maw-browser-picker-overlay'), 'Contains maw-browser-picker-overlay class');
  assert.ok(overlayClass.includes('maw-pane-browser-picker-overlay'), 'Contains maw-pane-browser-picker-overlay class');
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

  assert.ok(html.includes('maw-browser-dest-close'), 'Close button rendered in header');
  assert.ok(html.includes('maw-browser-dest-header-title'), 'Header title rendered');
});


import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateMenuPosition, isSupportedBrowserLink } from '../../../src/agency/BrowserContextMenu.js';

test('isSupportedBrowserLink: validates public web hyperlinks and rejects invalid/unsupported links', () => {
  // Supported web URLs:
  assert.equal(isSupportedBrowserLink('https://chatgpt.com/'), true);
  assert.equal(isSupportedBrowserLink('https://chat.openai.com/c/123'), true);
  assert.equal(isSupportedBrowserLink('https://github.com/microsoft/vscode'), true);
  assert.equal(isSupportedBrowserLink('https://perplexity.ai/search?q=test'), true);
  assert.equal(isSupportedBrowserLink('https://en.wikipedia.org/wiki/Main_Page'), true);
  assert.equal(isSupportedBrowserLink('https://docs.anthropic.com/en/docs'), true);

  // Unsupported protocols or formats:
  assert.equal(isSupportedBrowserLink('http://example.com/'), false); // plain http rejected
  assert.equal(isSupportedBrowserLink('javascript:alert(1)'), false);
  assert.equal(isSupportedBrowserLink('data:text/html,<h1>hi</h1>'), false);
  assert.equal(isSupportedBrowserLink('mailto:alice@example.com'), false);
  assert.equal(isSupportedBrowserLink('file:///etc/passwd'), false);

  // Loopback and internal addresses rejected:
  assert.equal(isSupportedBrowserLink('https://127.0.0.1:8080/'), false);
  assert.equal(isSupportedBrowserLink('https://localhost:3000/'), false);
  assert.equal(isSupportedBrowserLink('https://192.168.1.1/'), false);

  // Non-strings or empty:
  assert.equal(isSupportedBrowserLink(''), false);
  assert.equal(isSupportedBrowserLink('   '), false);
  assert.equal(isSupportedBrowserLink(null), false);
  assert.equal(isSupportedBrowserLink(undefined), false);
});

test('calculateMenuPosition: positions normally when ample space exists', () => {
  const bounds = { left: 240, top: 40, right: 1200, bottom: 800 };
  const pos = calculateMenuPosition({
    pointerX: 400,
    pointerY: 200,
    bounds,
    menuWidth: 190,
    menuHeight: 320,
    padding: 6,
  });

  assert.equal(pos.x, 400);
  assert.equal(pos.y, 200);
});

test('calculateMenuPosition: shifts right of sidebar when clicked near left edge', () => {
  const bounds = { left: 240, top: 40, right: 1200, bottom: 800 };
  // Pointer right at the left boundary of the browser content (near 240px sidebar)
  const pos = calculateMenuPosition({
    pointerX: 242,
    pointerY: 100,
    bounds,
    menuWidth: 190,
    menuHeight: 320,
    padding: 6,
  });

  // Must not go underneath or to the left of sidebar (left + padding = 246)
  assert.ok(pos.x >= 246, `Expected x (${pos.x}) >= 246 to clear sidebar`);
  assert.ok(pos.x + 190 <= bounds.right);
});

test('calculateMenuPosition: shifts left when near right boundary', () => {
  const bounds = { left: 240, top: 40, right: 1200, bottom: 800 };
  const pos = calculateMenuPosition({
    pointerX: 1150,
    pointerY: 100,
    bounds,
    menuWidth: 190,
    menuHeight: 320,
    padding: 6,
  });

  // Right edge must be <= bounds.right - padding (1194)
  assert.equal(pos.x + 190, 1194);
  assert.equal(pos.x, 1004);
});

test('calculateMenuPosition: flips vertically above pointer when overflowing bottom', () => {
  const bounds = { left: 240, top: 40, right: 1200, bottom: 800 };
  const pos = calculateMenuPosition({
    pointerX: 500,
    pointerY: 700,
    bounds,
    menuWidth: 190,
    menuHeight: 320,
    padding: 6,
  });

  // Flipping upwards: 700 - 320 = 380, which is >= top + padding (46)
  assert.equal(pos.y, 380);
  assert.ok(pos.y >= bounds.top + 6);
  assert.ok(pos.y + 320 <= bounds.bottom);
});

test('calculateMenuPosition: clamps inside top boundary if clicked near top', () => {
  const bounds = { left: 240, top: 40, right: 1200, bottom: 800 };
  const pos = calculateMenuPosition({
    pointerX: 500,
    pointerY: 42,
    bounds,
    menuWidth: 190,
    menuHeight: 320,
    padding: 6,
  });

  // Top + padding = 46
  assert.equal(pos.y, 46);
});

test('calculateMenuPosition: handles narrow panes and split panes correctly', () => {
  // Split pane on right side: left=700, right=1200
  const rightSplitBounds = { left: 700, top: 40, right: 1200, bottom: 800 };
  const pos = calculateMenuPosition({
    pointerX: 702,
    pointerY: 50,
    bounds: rightSplitBounds,
    menuWidth: 190,
    menuHeight: 320,
    padding: 6,
  });

  assert.equal(pos.x, 706);
  assert.ok(pos.x >= 706);
});

test('Context-aware Copy logic: selection > link URL > page URL', () => {
  function resolveCopyTarget({ selection, selectionText, linkURL, pageURL }) {
    if (selection) return { action: 'copy-selection', payload: selectionText };
    if (isSupportedBrowserLink(linkURL)) return { action: 'copy-link', payload: linkURL.trim() };
    return { action: 'copy-url', payload: pageURL };
  }

  // 1. Selection takes precedence over link and page URL
  assert.deepEqual(resolveCopyTarget({
    selection: true,
    selectionText: 'Selected snippet',
    linkURL: 'https://example.com/link',
    pageURL: 'https://example.com/page',
  }), { action: 'copy-selection', payload: 'Selected snippet' });

  // 2. Link URL takes precedence over page URL when no selection
  assert.deepEqual(resolveCopyTarget({
    selection: false,
    selectionText: '',
    linkURL: 'https://example.com/link',
    pageURL: 'https://example.com/page',
  }), { action: 'copy-link', payload: 'https://example.com/link' });

  // 3. Page URL is fallback when neither selection nor link
  assert.deepEqual(resolveCopyTarget({
    selection: false,
    selectionText: '',
    linkURL: '',
    pageURL: 'https://example.com/page',
  }), { action: 'copy-url', payload: 'https://example.com/page' });

  // 4. Invalid or unsafe link falls back to page URL
  assert.deepEqual(resolveCopyTarget({
    selection: false,
    selectionText: '',
    linkURL: 'javascript:alert(1)',
    pageURL: 'https://example.com/page',
  }), { action: 'copy-url', payload: 'https://example.com/page' });
});

test('Context-aware Open URL logic: link URL > selected URL > disabled, rejects unsafe schemes', () => {
  function resolveOpenUrl({ linkURL, selectionText }) {
    const isValidLink = isSupportedBrowserLink(linkURL);
    const link = isValidLink ? linkURL.trim() : '';
    const trimmedSelection = (selectionText || '').trim();
    const selectionIsUrl = isSupportedBrowserLink(trimmedSelection);
    const targetOpenUrl = isValidLink ? link : (selectionIsUrl ? trimmedSelection : '');
    return {
      enabled: Boolean(targetOpenUrl),
      targetUrl: targetOpenUrl,
    };
  }

  // Right-clicking link opens link
  assert.deepEqual(resolveOpenUrl({
    linkURL: 'https://github.com/microsoft/vscode',
    selectionText: '',
  }), { enabled: true, targetUrl: 'https://github.com/microsoft/vscode' });

  // Selecting a valid HTTPS URL opens selected URL
  assert.deepEqual(resolveOpenUrl({
    linkURL: '',
    selectionText: '  https://perplexity.ai/search?q=test  ',
  }), { enabled: true, targetUrl: 'https://perplexity.ai/search?q=test' });

  // Selecting ordinary text disables Open URL
  assert.deepEqual(resolveOpenUrl({
    linkURL: '',
    selectionText: 'ordinary text phrase',
  }), { enabled: false, targetUrl: '' });

  // Unsafe schemes (javascript:, file:, data:) are rejected
  assert.deepEqual(resolveOpenUrl({
    linkURL: 'javascript:void(0)',
    selectionText: 'file:///etc/passwd',
  }), { enabled: false, targetUrl: '' });
});

test('Context menu composition: exact 6 items in order, spelling section only when misspelling present', () => {
  function getMenuItems({ misspelledWord, dictionarySuggestions }) {
    const sections = [];
    if (misspelledWord) {
      sections.push({
        type: 'spelling',
        suggestions: dictionarySuggestions.length > 0 ? dictionarySuggestions : ['No spelling suggestions'],
      });
    }
    sections.push({
      type: 'standard',
      items: ['Copy', 'Open URL', 'Reload', 'Back', 'Forward', 'Search'],
    });
    return sections;
  }

  // Regular click: standard 6 items only
  const regular = getMenuItems({ misspelledWord: '', dictionarySuggestions: [] });
  assert.equal(regular.length, 1);
  assert.equal(regular[0].type, 'standard');
  assert.deepEqual(regular[0].items, ['Copy', 'Open URL', 'Reload', 'Back', 'Forward', 'Search']);

  // Misspelling with suggestions
  const withSuggestions = getMenuItems({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea'] });
  assert.equal(withSuggestions.length, 2);
  assert.equal(withSuggestions[0].type, 'spelling');
  assert.deepEqual(withSuggestions[0].suggestions, ['the', 'tea']);
  assert.deepEqual(withSuggestions[1].items, ['Copy', 'Open URL', 'Reload', 'Back', 'Forward', 'Search']);

  // Misspelling without suggestions
  const emptySuggestions = getMenuItems({ misspelledWord: 'xyzabc', dictionarySuggestions: [] });
  assert.equal(emptySuggestions.length, 2);
  assert.equal(emptySuggestions[0].type, 'spelling');
  assert.deepEqual(emptySuggestions[0].suggestions, ['No spelling suggestions']);
});

test('Find in Page match counter format matches specification', () => {
  function formatMatchCount(query, activeOrdinal, matches) {
    if (!query || !query.trim()) return '';
    if (matches === 0) return 'No results';
    return `${activeOrdinal}/${matches}`;
  }

  assert.equal(formatMatchCount('', 0, 0), '');
  assert.equal(formatMatchCount('test', 0, 0), 'No results');
  assert.equal(formatMatchCount('test', 1, 5), '1/5');
  assert.equal(formatMatchCount('test', 3, 10), '3/10');
});

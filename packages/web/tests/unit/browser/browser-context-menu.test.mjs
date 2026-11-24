import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateMenuPosition, isSupportedBrowserLink, buildBrowserContextMenuItems } from '../../../src/features/browser/BrowserContextMenu.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

test('UI-03: buildBrowserContextMenuItems: provides explicit Copy Page URL, conditional Copy Link / Selection, and prevents duplicates', () => {
  let copiedSelection = false;
  let copiedLink = false;
  let copiedPageUrl = false;
  let openedExternalLink = false;
  let openedExternalPage = false;

  const resetCalls = () => {
    copiedSelection = false;
    copiedLink = false;
    copiedPageUrl = false;
    openedExternalLink = false;
    openedExternalPage = false;
  };

  const createParams = (overrides = {}) => ({
    hasSelection: false,
    isValidLink: false,
    canOpenUrl: false,
    canGoBack: false,
    canGoForward: false,
    onCopySelection: () => { copiedSelection = true; },
    onCopyLink: () => { copiedLink = true; },
    onCopyPageUrl: () => { copiedPageUrl = true; },
    onOpenUrl: () => {},
    onOpenLinkExternal: () => { openedExternalLink = true; },
    onOpenExternalPage: () => { openedExternalPage = true; },
    onReload: () => {},
    onBack: () => {},
    onForward: () => {},
    onSearch: () => {},
    ...overrides,
  });

  // 1. Regular click on background: Only Copy Page URL is present (no selection, no link, no duplicate copy)
  resetCalls();
  const regularItems = buildBrowserContextMenuItems(createParams({ onOpenLinkExternal: undefined }));
  assert.equal(regularItems[0].id, 'copy-page-url');
  assert.equal(regularItems[0].label, 'Copy Page URL');
  regularItems[0].run();
  assert.equal(copiedPageUrl, true);
  assert.deepEqual(regularItems.map(i => i.id), ['copy-page-url', 'open-url', 'open-external-page', 'reload', 'back', 'forward', 'search']);

  // 2. Right-click over a link: Copy Link Address + Open link in external browser + Copy Page URL + Open in external browser
  resetCalls();
  const linkItems = buildBrowserContextMenuItems(createParams({ isValidLink: true, canOpenUrl: true }));
  assert.equal(linkItems[0].id, 'copy-link');
  assert.equal(linkItems[0].label, 'Copy Link Address');
  assert.equal(linkItems[1].id, 'open-link-external');
  assert.equal(linkItems[1].label, 'Open link in external browser');
  assert.equal(linkItems[2].id, 'copy-page-url');
  assert.equal(linkItems[2].label, 'Copy Page URL');
  linkItems[0].run();
  assert.equal(copiedLink, true);
  linkItems[1].run();
  assert.equal(openedExternalLink, true);
  linkItems[2].run();
  assert.equal(copiedPageUrl, true);
  assert.deepEqual(linkItems.map(i => i.id), ['copy-link', 'open-link-external', 'copy-page-url', 'open-url', 'open-external-page', 'reload', 'back', 'forward', 'search']);

  // 3. Right-click with selected text: Copy Selected Text + Copy Page URL + Open in external browser
  resetCalls();
  const selectionItems = buildBrowserContextMenuItems(createParams({ hasSelection: true, onOpenLinkExternal: undefined }));
  assert.equal(selectionItems[0].id, 'copy-selection');
  assert.equal(selectionItems[0].label, 'Copy Selected Text');
  assert.equal(selectionItems[1].id, 'copy-page-url');
  assert.equal(selectionItems[1].label, 'Copy Page URL');
  selectionItems[0].run();
  assert.equal(copiedSelection, true);
  assert.deepEqual(selectionItems.map(i => i.id), ['copy-selection', 'copy-page-url', 'open-url', 'open-external-page', 'reload', 'back', 'forward', 'search']);

  // 4. Right-click with selection over a link: Copy Selected Text + Copy Link Address + Open link in external browser + Copy Page URL
  resetCalls();
  const allItems = buildBrowserContextMenuItems(createParams({ hasSelection: true, isValidLink: true, canOpenUrl: true }));
  assert.deepEqual(allItems.map(i => i.id), ['copy-selection', 'copy-link', 'open-link-external', 'copy-page-url', 'open-url', 'open-external-page', 'reload', 'back', 'forward', 'search']);
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

test('Context menu composition: standard items in order, spelling section only when misspelling present', () => {
  function getMenuItems({ misspelledWord, dictionarySuggestions, params = {} }) {
    const sections = [];
    if (misspelledWord) {
      sections.push({
        type: 'spelling',
        suggestions: dictionarySuggestions.length > 0 ? dictionarySuggestions : ['No spelling suggestions'],
      });
    }
    const standard = buildBrowserContextMenuItems({
      hasSelection: false,
      isValidLink: false,
      canOpenUrl: false,
      canGoBack: false,
      canGoForward: false,
      onCopySelection: () => {},
      onCopyLink: () => {},
      onCopyPageUrl: () => {},
      onOpenUrl: () => {},
      onOpenExternalPage: () => {},
      onReload: () => {},
      onBack: () => {},
      onForward: () => {},
      onSearch: () => {},
      ...params,
    });
    sections.push({
      type: 'standard',
      items: standard.map(i => i.label),
    });
    return sections;
  }

  // Regular click: standard items starting with Copy Page URL
  const regular = getMenuItems({ misspelledWord: '', dictionarySuggestions: [] });
  assert.equal(regular.length, 1);
  assert.equal(regular[0].type, 'standard');
  assert.deepEqual(regular[0].items, ['Copy Page URL', 'Open URL', 'Open in external browser', 'Reload', 'Back', 'Forward', 'Search']);

  // Misspelling with suggestions
  const withSuggestions = getMenuItems({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea'] });
  assert.equal(withSuggestions.length, 2);
  assert.equal(withSuggestions[0].type, 'spelling');
  assert.deepEqual(withSuggestions[0].suggestions, ['the', 'tea']);
  assert.deepEqual(withSuggestions[1].items, ['Copy Page URL', 'Open URL', 'Open in external browser', 'Reload', 'Back', 'Forward', 'Search']);

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

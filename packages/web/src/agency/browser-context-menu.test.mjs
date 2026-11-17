import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateMenuPosition, isSupportedBrowserLink } from './BrowserContextMenu.js';

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

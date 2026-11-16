import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateMenuPosition } from './BrowserContextMenu.js';

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

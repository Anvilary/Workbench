import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSidebarDropdownPosition } from './AgencySidebar.js';

test('calculateSidebarDropdownPosition: places menu below trigger with standard margin', () => {
  const pos = calculateSidebarDropdownPosition({
    triggerRect: { left: 100, top: 100, right: 130, bottom: 130 },
    menuWidth: 150,
    menuHeight: 120,
    viewportWidth: 1280,
    viewportHeight: 800,
  });

  assert.equal(pos.left, 100);
  assert.equal(pos.top, 134); // bottom + 4
});

test('calculateSidebarDropdownPosition: flips above trigger when overflowing bottom', () => {
  const pos = calculateSidebarDropdownPosition({
    triggerRect: { left: 100, top: 700, right: 130, bottom: 730 },
    menuWidth: 150,
    menuHeight: 120,
    viewportWidth: 1280,
    viewportHeight: 800,
  });

  assert.equal(pos.left, 100);
  assert.equal(pos.top, 700 - 120 - 4); // top - menuHeight - 4 = 576
});

test('calculateSidebarDropdownPosition: shifts left when near right viewport edge', () => {
  const pos = calculateSidebarDropdownPosition({
    triggerRect: { left: 1200, top: 100, right: 1250, bottom: 130 },
    menuWidth: 150,
    menuHeight: 120,
    viewportWidth: 1280,
    viewportHeight: 800,
    margin: 8,
  });

  // right - menuWidth = 1250 - 150 = 1100 <= 1280 - 8 = 1272
  assert.equal(pos.left, 1100);
  assert.equal(pos.top, 134);
});

test('calculateSidebarDropdownPosition: clamps to left margin when trigger is negative or near edge', () => {
  const pos = calculateSidebarDropdownPosition({
    triggerRect: { left: 2, top: 100, right: 20, bottom: 130 },
    menuWidth: 150,
    menuHeight: 120,
    viewportWidth: 1280,
    viewportHeight: 800,
    margin: 8,
  });

  assert.equal(pos.left, 8);
  assert.equal(pos.top, 134);
});

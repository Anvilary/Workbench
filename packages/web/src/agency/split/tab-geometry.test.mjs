import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertionIndex, tabShift } from './tab-geometry.mjs';

test('insertion index uses the midpoint and lands after the last tab', () => {
  const rects = [
    { left: 0, width: 100 },
    { left: 100, width: 100 },
    { left: 200, width: 80 },
  ];
  assert.equal(insertionIndex(40, rects), 0);
  assert.equal(insertionIndex(60, rects), 1);
  assert.equal(insertionIndex(150, rects), 2);
  assert.equal(insertionIndex(400, rects), 3);
});

test('neighbors slide toward the gap and the dragged tab stays put', () => {
  assert.equal(tabShift(0, 0, 3, 40, true), 0);
  assert.equal(tabShift(1, 0, 3, 40, true), -40);
  assert.equal(tabShift(2, 0, 3, 40, true), -40);
  assert.equal(tabShift(3, 0, 3, 40, true), 0);
  assert.equal(tabShift(1, 3, 1, 40, true), 40);
  assert.equal(tabShift(2, 3, 1, 40, true), 40);
  assert.equal(tabShift(0, 3, 1, 40, true), 0);
});

test('a tab entering another pane opens a gap at the insertion index', () => {
  assert.equal(tabShift(0, -1, 1, 36, false), 0);
  assert.equal(tabShift(1, -1, 1, 36, false), 36);
  assert.equal(tabShift(2, -1, 1, 36, false), 36);
});

test('cancel and a missing target do not shift tabs', () => {
  assert.equal(tabShift(1, 0, null, 40, true), 0);
  assert.equal(tabShift(1, 0, 2, 0, true), 0);
});

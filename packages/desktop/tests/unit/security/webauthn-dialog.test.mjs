import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculatePinDialogPosition } from '../../../src/security/webauthn/dialog-position.mjs';

test('calculatePinDialogPosition: centers horizontally over originating pane near top', () => {
  const contentBounds = { x: 100, y: 50, width: 1200, height: 800 };
  const paneBounds = { x: 300, y: 100, width: 600, height: 700 };

  const pos = calculatePinDialogPosition({
    contentBounds,
    paneBounds,
    dialogWidth: 400,
    dialogHeight: 230,
  });

  // Screen pane X = 100 + 300 = 400
  // Centered in pane = 400 + (600 - 400) / 2 = 500
  assert.equal(pos.x, 500);

  // Screen pane Y = 50 + 100 = 150
  // Top offset = 150 + 40 = 190
  assert.equal(pos.y, 190);
});

test('calculatePinDialogPosition: falls back to centering in window when pane bounds are null', () => {
  const contentBounds = { x: 100, y: 50, width: 1200, height: 800 };

  const pos = calculatePinDialogPosition({
    contentBounds,
    paneBounds: null,
    dialogWidth: 400,
    dialogHeight: 230,
  });

  // Centered in contentBounds:
  // x = 100 + (1200 - 400) / 2 = 500
  assert.equal(pos.x, 500);
  // y = 50 + (800 - 230) / 2 = 50 + 285 = 335
  assert.equal(pos.y, 335);
});

test('calculatePinDialogPosition: handles pane in split layout (right pane)', () => {
  const contentBounds = { x: 0, y: 0, width: 1600, height: 900 };
  const paneBounds = { x: 800, y: 0, width: 800, height: 900 };

  const pos = calculatePinDialogPosition({
    contentBounds,
    paneBounds,
    dialogWidth: 400,
    dialogHeight: 230,
  });

  // x = 800 + (800 - 400) / 2 = 1000
  assert.equal(pos.x, 1000);
  // y = 0 + 40 = 40
  assert.equal(pos.y, 40);
});

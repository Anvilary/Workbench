import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYBOARD_GESTURE_WINDOW_MS,
  documentHasWindowFocus,
  isKeyboardOrigin,
  ownsKeyboard,
  shouldForwardTerminalData,
  shouldForwardWheelInput,
} from '../../../src/features/terminals/terminal-input-gate.ts';

const owner = { active: true, textareaFocused: true, documentFocused: true };

test('ownsKeyboard needs an active tab, a focused textarea and window focus', () => {
  assert.equal(ownsKeyboard(owner), true);
  assert.equal(ownsKeyboard({ ...owner, active: false }), false);
  assert.equal(ownsKeyboard({ ...owner, textareaFocused: false }), false);
  assert.equal(ownsKeyboard({ ...owner, documentFocused: false }), false);
});

test('keyboard origin is bounded to a short window after a gesture on the textarea', () => {
  assert.equal(isKeyboardOrigin(null, 1000), false);
  assert.equal(isKeyboardOrigin(1000, 1000), true);
  assert.equal(isKeyboardOrigin(1000, 1000 + KEYBOARD_GESTURE_WINDOW_MS), true);
  assert.equal(isKeyboardOrigin(1000, 1000 + KEYBOARD_GESTURE_WINDOW_MS + 1), false);
  assert.equal(isKeyboardOrigin(2000, 1000), false, 'a clock that went backwards is not a gesture');
});

test('keyboard-origin data is blocked without ownership; other data always passes', () => {
  const typed = { lastGestureAt: 1000, now: 1005 };
  assert.equal(shouldForwardTerminalData({ ...typed, ownership: owner }), true);
  for (const lost of [{ active: false }, { textareaFocused: false }, { documentFocused: false }]) {
    assert.equal(shouldForwardTerminalData({ ...typed, ownership: { ...owner, ...lost } }), false, JSON.stringify(lost));
  }
  const noOwner = { active: false, textareaFocused: false, documentFocused: false };
  assert.equal(shouldForwardTerminalData({ lastGestureAt: null, now: 5000, ownership: noOwner }), true, 'protocol reply');
  assert.equal(shouldForwardTerminalData({ lastGestureAt: 1000, now: 9000, ownership: noOwner }), true, 'no recent gesture');
});

test('wheel input and window focus helpers', () => {
  assert.equal(shouldForwardWheelInput(true), true);
  assert.equal(shouldForwardWheelInput(false), false);
  assert.equal(documentHasWindowFocus(undefined), true, 'environments without a document do not block');
  assert.equal(documentHasWindowFocus({ hasFocus: () => false }), false);
  assert.equal(documentHasWindowFocus({ hasFocus: () => true }), true);
});

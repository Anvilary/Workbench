import assert from 'node:assert/strict';
import { test } from 'node:test';
import { centerCurrentMatch } from '../../../src/features/terminals/TerminalSearchBar.js';

test('centerCurrentMatch centers the matching buffer line in the viewport', () => {
  let scrolledTo = -1;
  const mockTerminal = {
    rows: 30,
    getSelectionPosition: () => ({
      start: { x: 5, y: 100 },
      end: { x: 15, y: 100 },
    }),
    scrollToLine: (line) => {
      scrolledTo = line;
    },
  };

  centerCurrentMatch(mockTerminal);

  // Buffer line is 100. Terminal has 30 rows. Center is 15 rows from top.
  // Target scroll line = 100 - 15 = 85.
  assert.equal(scrolledTo, 85);
});

test('centerCurrentMatch clamps to line 0 when match is near the buffer start', () => {
  let scrolledTo = -1;
  const mockTerminal = {
    rows: 40,
    getSelectionPosition: () => ({
      start: { x: 0, y: 5 },
      end: { x: 10, y: 5 },
    }),
    scrollToLine: (line) => {
      scrolledTo = line;
    },
  };

  centerCurrentMatch(mockTerminal);

  // 5 - 20 = -15, clamped to 0
  assert.equal(scrolledTo, 0);
});

test('centerCurrentMatch does nothing when there is no active selection position', () => {
  let scrolledTo = -1;
  const mockTerminal = {
    rows: 30,
    getSelectionPosition: () => null,
    scrollToLine: (line) => {
      scrolledTo = line;
    },
  };

  centerCurrentMatch(mockTerminal);

  assert.equal(scrolledTo, -1);
});

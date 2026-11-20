import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInsertionIndex, siblingDisplacementPx } from '../../../src/features/navigation/useSidebarDrag.ts';

const rows = [0, 1, 2, 3].map((i) => ({ top: i * 40, height: 40 }));

test('the insertion index is the final array index after the dragged row is removed', () => {
  assert.equal(resolveInsertionIndex(rows, 5, 2), 0);
  assert.equal(resolveInsertionIndex(rows, 5, 0), 0);
  assert.equal(resolveInsertionIndex(rows, 500, 0), 3, 'below every row means the end of the list');
  assert.equal(resolveInsertionIndex(rows, 500, 3), 3);
  assert.equal(resolveInsertionIndex(rows, 65, 1), 1);
});

test('rows between the source and the slot shift by the height of the dragged row', () => {
  assert.equal(siblingDisplacementPx(1, 0, 2, 40), -40, 'moving down pulls the rows in between up');
  assert.equal(siblingDisplacementPx(2, 0, 2, 40), -40);
  assert.equal(siblingDisplacementPx(3, 0, 2, 40), 0);
  assert.equal(siblingDisplacementPx(1, 3, 1, 40), 40, 'moving up pushes the rows in between down');
  assert.equal(siblingDisplacementPx(2, 3, 1, 40), 40);
  assert.equal(siblingDisplacementPx(0, 3, 1, 40), 0);
});

test('the dragged row and an invalid slot never displace anything', () => {
  assert.equal(siblingDisplacementPx(2, 2, 0, 40), 0);
  assert.equal(siblingDisplacementPx(1, 0, null, 40), 0);
});

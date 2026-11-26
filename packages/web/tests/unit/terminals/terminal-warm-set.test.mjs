import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WARM_TERMINAL_LIMIT,
  forgetTerminal,
  isTerminalMounted,
  mountedTerminals,
  noteTerminalHidden,
  noteTerminalVisible,
  readTerminalRestore,
  rememberTerminalRestore,
  resetWarmSet,
  subscribeWarmSet,
} from '../../../src/features/terminals/terminal-warm-set.ts';

test('visible terminals plus the most recently visible ones stay mounted', () => {
  resetWarmSet();
  const ids = Array.from({ length: WARM_TERMINAL_LIMIT + 4 }, (_, i) => `t${i}`);
  for (const id of ids) {
    noteTerminalVisible(id);
    noteTerminalHidden(id);
  }
  // The last one shown is still visible; show it again and keep it there.
  const current = ids[ids.length - 1];
  noteTerminalVisible(current);

  assert.equal(isTerminalMounted(current), true, 'the visible terminal is mounted');
  const warm = mountedTerminals();
  assert.equal(warm.length, WARM_TERMINAL_LIMIT + 1, 'visible terminal plus the warm budget');
  for (const id of ids.slice(-(WARM_TERMINAL_LIMIT + 1))) {
    assert.equal(isTerminalMounted(id), true, `${id} is recent enough to stay mounted`);
  }
  for (const id of ids.slice(0, ids.length - (WARM_TERMINAL_LIMIT + 1))) {
    assert.equal(isTerminalMounted(id), false, `${id} fell out of the warm set`);
  }
});

test('the warm budget never evicts a visible terminal', () => {
  resetWarmSet();
  const visible = ['a', 'b', 'c'];
  for (const id of visible) noteTerminalVisible(id);
  for (let i = 0; i < WARM_TERMINAL_LIMIT + 5; i++) {
    noteTerminalVisible(`bg${i}`);
    noteTerminalHidden(`bg${i}`);
  }
  for (const id of visible) {
    assert.equal(isTerminalMounted(id), true, `${id} is visible and must stay mounted`);
  }
  assert.equal(mountedTerminals().length, visible.length + WARM_TERMINAL_LIMIT);
});

test('subscribers are notified only when the mounted set actually changes', () => {
  resetWarmSet();
  let notifications = 0;
  const unsubscribe = subscribeWarmSet(() => { notifications += 1; });
  try {
    noteTerminalVisible('one');
    assert.equal(notifications, 1);
    noteTerminalVisible('one');
    assert.equal(notifications, 1, 'showing an already mounted terminal changes nothing');
    noteTerminalHidden('one');
    assert.equal(notifications, 1, 'hiding keeps it warm, so the mounted set is the same');
    noteTerminalHidden('one');
    assert.equal(notifications, 1, 'hiding twice is a no-op');
  } finally {
    unsubscribe();
  }
  noteTerminalVisible('two');
  assert.equal(notifications, 1, 'an unsubscribed listener stops being called');
});

test('restore metadata survives hiding and is dropped only when the terminal is removed', () => {
  resetWarmSet();
  noteTerminalVisible('keep');
  rememberTerminalRestore('keep', { offset: 4096, atBottom: false, viewportLine: 120 });
  noteTerminalHidden('keep');
  for (let i = 0; i < WARM_TERMINAL_LIMIT + 2; i++) {
    noteTerminalVisible(`other${i}`);
    noteTerminalHidden(`other${i}`);
  }
  assert.equal(isTerminalMounted('keep'), false, 'the terminal left the warm set');
  assert.deepEqual(readTerminalRestore('keep'), { offset: 4096, atBottom: false, viewportLine: 120 });

  forgetTerminal('keep');
  assert.equal(readTerminalRestore('keep'), undefined, 'removing the terminal clears its restore point');
  assert.equal(isTerminalMounted('keep'), false);
});

test('a forgotten terminal frees warm budget for the next one', () => {
  resetWarmSet();
  for (let i = 0; i < WARM_TERMINAL_LIMIT; i++) {
    noteTerminalVisible(`w${i}`);
    noteTerminalHidden(`w${i}`);
  }
  assert.equal(mountedTerminals().length, WARM_TERMINAL_LIMIT);
  assert.equal(isTerminalMounted('w0'), true);
  forgetTerminal(`w${WARM_TERMINAL_LIMIT - 1}`);
  assert.equal(mountedTerminals().length, WARM_TERMINAL_LIMIT - 1);
  noteTerminalVisible('fresh');
  noteTerminalHidden('fresh');
  assert.equal(isTerminalMounted('fresh'), true);
  assert.equal(isTerminalMounted('w0'), true, 'the oldest warm terminal still fits');
});

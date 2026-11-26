import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createBrowserViewState } from '../../../src/browser/view-state.mjs';
import { createNavigationGuard } from '../../../src/browser/navigation-guard.mjs';

function makeGuard() {
  const state = createBrowserViewState();
  const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
  state.views.set('tab-1', { webContents: contents });
  const { guard } = createNavigationGuard({
    electron: { shell: {}, dialog: {} },
    win: {},
    send: () => {},
    backend: { current: () => ({ port: 45_000 }) },
    secure: {},
    state,
    layout: {},
    flushBrowserSession() {},
    desktopShortcut() {},
  });
  guard(contents);
  return { state, contents };
}

test('pointer interaction protects page state through same-document navigation', () => {
  const { state, contents } = makeGuard();
  contents.emit('before-mouse-event', {}, { type: 'mouseMove' });
  assert.equal(state.interactionProtected.has('tab-1'), false);
  contents.emit('before-mouse-event', {}, { type: 'mouseDown' });
  assert.equal(state.interactionProtected.has('tab-1'), true);
  contents.emit('did-navigate-in-page', {}, 'https://example.com/#section', true);
  assert.equal(state.interactionProtected.has('tab-1'), true);
  assert.equal(typeof state.protectionSince.get('tab-1').interaction, 'number');
});

test('keyboard paste and shortcut protection distinguish page input from desktop commands', () => {
  const { state, contents } = makeGuard();
  const event = { preventDefault() {} };
  contents.emit('before-input-event', event, { type: 'keyDown', key: 'f', control: true });
  assert.equal(state.interactionProtected.has('tab-1'), false);
  contents.emit('before-input-event', event, { type: 'keyDown', key: 'v', control: true });
  assert.equal(state.interactionProtected.has('tab-1'), true);
});

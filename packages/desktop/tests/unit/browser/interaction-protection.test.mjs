import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserViewState, markProtectionReason } from '../../../src/browser/view-state.mjs';
import { createNavigationGuard } from '../../../src/browser/navigation-guard.mjs';

function makeGuard({ isolatedWorld } = {}) {
  const state = createBrowserViewState();
  const calls = [];
  const contents = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.com/c/abc',
    ...(isolatedWorld
      ? {
        executeJavaScriptInIsolatedWorld: (worldId, scripts) => {
          calls.push({ worldId, scripts });
          return isolatedWorld(worldId, scripts);
        },
      }
      : {}),
  };
  state.views.set('tab-1', { webContents: contents });
  state.providers.set('tab-1', 'chatgpt');
  state.interactionProtected.add('tab-1');
  markProtectionReason(state, 'tab-1', 'interaction', 1000);

  const guard = createNavigationGuard({
    electron: { shell: {}, dialog: {} },
    win: { isDestroyed: () => false },
    send: () => {},
    backend: { current: () => ({ port: 45_000 }) },
    secure: {},
    isWebAuthnEnabled: false,
    webauthnPreload: '',
    state,
    layout: { invalidate: () => {}, hideAll: () => {} },
    flushBrowserSession: () => {},
    desktopShortcut: () => {},
  });
  return { state, guard, contents, calls };
}

test('interaction protection is released only when the page reports no focused draft', async () => {
  const { state, guard, calls } = makeGuard({ isolatedWorld: () => Promise.resolve(false) });
  const cleared = await guard.clearInteractionProtectionIfIdle('tab-1', state.views.get('tab-1').webContents);
  assert.equal(cleared, true);
  assert.equal(state.interactionProtected.has('tab-1'), false);
  assert.equal(state.protectionSince.has('tab-1'), false);
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].worldId, 'number');
  assert.notEqual(calls[0].worldId, 0, 'the probe must not run in the page main world');
  assert.equal(calls[0].scripts.length, 1);
  assert.match(calls[0].scripts[0].code, /isContentEditable/);
  assert.doesNotMatch(calls[0].scripts[0].code, /chatgpt|openai|perplexity/i);
});

test('interaction protection survives when a focused editable still holds content', async () => {
  const { state, guard } = makeGuard({ isolatedWorld: () => Promise.resolve(true) });
  const cleared = await guard.clearInteractionProtectionIfIdle('tab-1', state.views.get('tab-1').webContents);
  assert.equal(cleared, false);
  assert.equal(state.interactionProtected.has('tab-1'), true);
});

test('a non-boolean or failing probe never releases protection', async () => {
  for (const probe of [() => Promise.resolve(undefined), () => Promise.resolve('false'), () => Promise.reject(new Error('gone'))]) {
    const { state, guard } = makeGuard({ isolatedWorld: probe });
    const cleared = await guard.clearInteractionProtectionIfIdle('tab-1', state.views.get('tab-1').webContents);
    assert.equal(cleared, false);
    assert.equal(state.interactionProtected.has('tab-1'), true);
  }
});

test('without the isolated-world API protection is kept and no script runs', async () => {
  const { state, guard, calls } = makeGuard();
  const cleared = await guard.clearInteractionProtectionIfIdle('tab-1', state.views.get('tab-1').webContents);
  assert.equal(cleared, false);
  assert.equal(state.interactionProtected.has('tab-1'), true);
  assert.equal(calls.length, 0);
});

test('an unprotected or stale view is never probed', async () => {
  const { state, guard, calls } = makeGuard({ isolatedWorld: () => Promise.resolve(false) });
  state.interactionProtected.delete('tab-1');
  assert.equal(await guard.clearInteractionProtectionIfIdle('tab-1', state.views.get('tab-1').webContents), false);
  assert.equal(calls.length, 0);

  state.interactionProtected.add('tab-1');
  const detached = { isDestroyed: () => false, executeJavaScriptInIsolatedWorld: () => Promise.resolve(false) };
  assert.equal(await guard.clearInteractionProtectionIfIdle('tab-1', detached), false);
  assert.equal(state.interactionProtected.has('tab-1'), true, 'a replaced WebContents must not clear the live view');
});

test('concurrent in-page navigations run at most one probe per view', async () => {
  let resolveProbe;
  const { state, guard, calls } = makeGuard({
    isolatedWorld: () => new Promise((resolve) => { resolveProbe = resolve; }),
  });
  const contents = state.views.get('tab-1').webContents;
  const first = guard.clearInteractionProtectionIfIdle('tab-1', contents);
  const second = guard.clearInteractionProtectionIfIdle('tab-1', contents);
  assert.equal(await second, false);
  resolveProbe(false);
  assert.equal(await first, true);
  assert.equal(calls.length, 1);
});

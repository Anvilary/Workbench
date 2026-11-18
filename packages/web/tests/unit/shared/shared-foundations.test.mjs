import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateSidebarDropdownPosition,
  calculateViewportMenuPosition,
} from '../../../src/shared/lib/overlay-position.ts';
import { sameSet, toggled } from '../../../src/features/settings/version-info.ts';
import { resolveBrowserTabTarget } from '../../../src/features/workspaces/workspace-tab-helpers.ts';

test('calculateSidebarDropdownPosition keeps menu inside viewport and flips on overflow', () => {
  const below = calculateSidebarDropdownPosition({
    triggerRect: { left: 40, top: 80, right: 160, bottom: 110 },
    menuWidth: 200,
    menuHeight: 150,
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  assert.deepEqual(below, { left: 40, top: 114 });

  const flippedUpAndLeft = calculateSidebarDropdownPosition({
    triggerRect: { left: 1150, top: 700, right: 1250, bottom: 730 },
    menuWidth: 220,
    menuHeight: 180,
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  assert.equal(flippedUpAndLeft.left, 1030);
  assert.equal(flippedUpAndLeft.top, 516);
});

test('calculateViewportMenuPosition clamps coordinates within viewport margins', () => {
  const pos = calculateViewportMenuPosition({
    triggerRect: { left: 2, top: 100, right: 30, bottom: 120 },
    menuWidth: 180,
    menuHeight: 120,
    viewportWidth: 400,
    viewportHeight: 300,
  });
  assert.deepEqual(pos, { left: 8, top: 124 });

  const flipped = calculateViewportMenuPosition({
    triggerRect: { left: 320, top: 240, right: 350, bottom: 260 },
    menuWidth: 180,
    menuHeight: 120,
    viewportWidth: 400,
    viewportHeight: 300,
  });
  assert.equal(flipped.left, 212);
  assert.equal(flipped.top, 116);
});

test('toggled and sameSet manipulate agent sets deterministically', () => {
  const disabled = toggled(['claude', 'gemini'], 'codex', true);
  assert.equal(sameSet(disabled, ['codex', 'gemini', 'claude']), true);

  const reenabled = toggled(disabled, 'gemini', false);
  assert.equal(sameSet(reenabled, ['claude', 'codex']), true);
  assert.equal(sameSet(reenabled, ['claude']), false);
});

test('resolveBrowserTabTarget validates URLs, identifies providers, and blocks unsafe schemes', () => {
  const github = resolveBrowserTabTarget({ url: 'https://github.com/user/My-Amazing-Workspace' });
  assert.equal(github.ok, true);
  if (github.ok) {
    assert.equal(github.provider, 'github');
    assert.equal(github.title, 'GitHub');
  }

  const chatgpt = resolveBrowserTabTarget({ url: 'https://chatgpt.com/c/123', title: 'Custom Title' });
  assert.equal(chatgpt.ok, true);
  if (chatgpt.ok) {
    assert.equal(chatgpt.provider, 'chatgpt');
    assert.equal(chatgpt.title, 'Custom Title');
  }

  const loopback = resolveBrowserTabTarget({ url: 'http://127.0.0.1:3000/' });
  assert.equal(loopback.ok, true);
  if (loopback.ok) {
    assert.equal(loopback.provider, 'other');
    assert.equal(loopback.title, 'Browser');
  }

  assert.equal(resolveBrowserTabTarget({ url: 'javascript:alert(1)' }).ok, false);
  assert.equal(resolveBrowserTabTarget({ url: 'file:///etc/passwd' }).ok, false);
  assert.equal(resolveBrowserTabTarget({ url: 'https://user:pass@example.com/' }).ok, false);
});

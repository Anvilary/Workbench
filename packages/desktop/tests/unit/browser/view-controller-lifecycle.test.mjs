import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserViewController } from '../../../src/browser/view-controller.mjs';
import { createFakeElectron, createFakeWindow } from './controller-harness.mjs';

const CHATGPT_URL = 'https://chatgpt.com/';
const GITHUB_URL = 'https://github.com/org/repo';

function setup({ maxResident, tier } = {}) {
  const previous = {
    max: process.env.WORKBENCH_MAX_RESIDENT_VIEWS,
    tier: process.env.WORKBENCH_MEMORY_PRESSURE_TIER,
  };
  if (maxResident !== undefined) process.env.WORKBENCH_MAX_RESIDENT_VIEWS = String(maxResident);
  if (tier !== undefined) process.env.WORKBENCH_MEMORY_PRESSURE_TIER = tier;

  const { electron, createdViews } = createFakeElectron();
  const win = createFakeWindow();
  const sent = [];
  const controller = createBrowserViewController({
    electron,
    win,
    send: (message) => sent.push(message),
    backend: { current: () => ({ port: 45_000 }) },
    secure: {},
    isWebAuthnEnabled: false,
    webauthnPreload: '',
    desktopShortcut: () => {},
  });

  const restore = () => {
    if (previous.max === undefined) delete process.env.WORKBENCH_MAX_RESIDENT_VIEWS;
    else process.env.WORKBENCH_MAX_RESIDENT_VIEWS = previous.max;
    if (previous.tier === undefined) delete process.env.WORKBENCH_MEMORY_PRESSURE_TIER;
    else process.env.WORKBENCH_MEMORY_PRESSURE_TIER = previous.tier;
  };
  return { controller, createdViews, sent, restore, win };
}

function type(contents, key = 'a') {
  contents.emit('before-input-event', { preventDefault: () => {} }, { type: 'keyDown', key });
}

test('typing marks a view interaction protected and records its protection age', () => {
  const { controller, createdViews, restore } = setup();
  try {
    controller.open({ id: 'tab-a', url: GITHUB_URL, provider: 'github' });
    type(createdViews[0].webContents);

    const telemetry = controller.browserLifecycleTelemetry();
    assert.equal(telemetry.protectedCounts.interaction, 1);
    assert.equal(typeof telemetry.protectionAgeMs.interaction, 'number');
  } finally {
    restore();
  }
});

test('critical pressure preserves an interacted document while a second tab opens', () => {
  const { controller, createdViews, sent, restore } = setup({ maxResident: 1, tier: 'critical' });
  try {
    controller.open({ id: 'tab-a', url: GITHUB_URL, provider: 'github' });
    type(createdViews[0].webContents);
    controller.open({ id: 'tab-b', url: GITHUB_URL, provider: 'github' });

    assert.ok(!sent.some(m => m.type === 'suspended' && m.id === 'tab-a'));
    const telemetry = controller.browserLifecycleTelemetry();
    assert.equal(telemetry.residentViews, 2);
    assert.equal(telemetry.suspendedViews, 0);
    assert.equal(telemetry.protectedCounts.interaction, 1);
    assert.equal(telemetry.overBudget, true);
  } finally {
    restore();
  }
});

test('in-page navigation retains interaction protection without inspecting page content', () => {
  const { controller, createdViews, restore } = setup();
  try {
    controller.open({ id: 'tab-a', url: CHATGPT_URL, provider: 'chatgpt' });
    const contents = createdViews[0].webContents;
    type(contents);
    contents.__state.probeResult = false;
    contents.emit('did-navigate-in-page', {}, 'https://chatgpt.com/c/1', true);

    assert.equal(controller.browserLifecycleTelemetry().protectedCounts.interaction, 1);
    assert.equal(contents.__state.probeCalls.length, 0);
  } finally {
    restore();
  }
});

test('subframe in-page navigation does not probe or release protection', async () => {
  const { controller, createdViews, restore } = setup();
  try {
    controller.open({ id: 'tab-a', url: CHATGPT_URL, provider: 'chatgpt' });
    const contents = createdViews[0].webContents;
    type(contents);
    contents.__state.probeResult = false;
    contents.emit('did-navigate-in-page', { preventDefault: () => {} }, 'https://chatgpt.com/c/3', false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(contents.__state.probeCalls.length, 0);
    assert.equal(controller.browserLifecycleTelemetry().protectedCounts.interaction, 1);
  } finally {
    restore();
  }
});

test('a document navigation keeps the protection age of reasons that still apply', () => {
  const { controller, createdViews, restore } = setup();
  try {
    controller.open({ id: 'tab-a', url: CHATGPT_URL, provider: 'chatgpt' });
    const contents = createdViews[0].webContents;
    type(contents);
    contents.__state.devTools = true;
    const first = controller.browserLifecycleTelemetry();
    assert.equal(first.protectedCounts.devtools, 1);
    assert.equal(first.protectionAgeMs.devtools, 0);

    contents.emit('did-navigate', { preventDefault: () => {} }, 'https://chatgpt.com/other');
    const after = controller.browserLifecycleTelemetry(0);
    assert.equal(after.protectedCounts.interaction, 0);
    assert.equal(after.protectedCounts.devtools, 1);
    assert.ok(
      (after.protectionAgeMs.devtools ?? 0) > 0,
      'the DevTools protection age must survive a navigation that only ends interaction protection',
    );
  } finally {
    restore();
  }
});

test('a full document navigation still clears interaction protection outright', () => {
  const { controller, createdViews, restore } = setup();
  try {
    controller.open({ id: 'tab-a', url: CHATGPT_URL, provider: 'chatgpt' });
    const contents = createdViews[0].webContents;
    type(contents);
    contents.emit('did-navigate', { preventDefault: () => {} }, 'https://chatgpt.com/other');
    assert.equal(controller.browserLifecycleTelemetry().protectedCounts.interaction, 0);
  } finally {
    restore();
  }
});

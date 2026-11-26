import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserViewController } from '../../../src/browser/view-controller.mjs';
import { createFakeElectron, createFakeWindow } from './controller-harness.mjs';

const CHATGPT_URL = 'https://chatgpt.com/';
const GITHUB_URL = 'https://github.com/org/repo';

function setup({ maxResident, tier } = {}) {
  const previous = {
    max: process.env.MAW_MAX_RESIDENT_VIEWS,
    tier: process.env.MAW_MEMORY_PRESSURE_TIER,
  };
  if (maxResident !== undefined) process.env.MAW_MAX_RESIDENT_VIEWS = String(maxResident);
  if (tier !== undefined) process.env.MAW_MEMORY_PRESSURE_TIER = tier;

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
    if (previous.max === undefined) delete process.env.MAW_MAX_RESIDENT_VIEWS;
    else process.env.MAW_MAX_RESIDENT_VIEWS = previous.max;
    if (previous.tier === undefined) delete process.env.MAW_MEMORY_PRESSURE_TIER;
    else process.env.MAW_MEMORY_PRESSURE_TIER = previous.tier;
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

test('eviction clears interaction protection so a restored view starts unprotected', () => {
  const { controller, createdViews, sent, restore } = setup({ maxResident: 1, tier: 'critical' });
  try {
    controller.open({ id: 'tab-a', url: GITHUB_URL, provider: 'github' });
    type(createdViews[0].webContents);
    assert.equal(controller.browserLifecycleTelemetry().protectedCounts.interaction, 1);

    // Opening a second tab trims the pool back to the budget of one resident view.
    controller.open({ id: 'tab-b', url: GITHUB_URL, provider: 'github' });

    assert.ok(sent.some((m) => m.type === 'suspended' && m.id === 'tab-a'), 'tab-a must be suspended');
    const afterEviction = controller.browserLifecycleTelemetry();
    assert.equal(afterEviction.residentViews, 1);
    assert.equal(afterEviction.suspendedViews, 1);
    assert.equal(afterEviction.protectedCounts.interaction, 0, 'protection must not survive eviction');

    controller.open({ id: 'tab-a', url: GITHUB_URL, provider: 'github' });
    assert.equal(controller.browserLifecycleTelemetry().protectedCounts.interaction, 0);
  } finally {
    restore();
  }
});

test('in-page navigation releases interaction protection only when the page reports no draft', async () => {
  const { controller, createdViews, restore } = setup();
  try {
    controller.open({ id: 'tab-a', url: CHATGPT_URL, provider: 'chatgpt' });
    const contents = createdViews[0].webContents;
    type(contents);

    contents.__state.probeResult = true;
    contents.emit('did-navigate-in-page', { preventDefault: () => {} }, 'https://chatgpt.com/c/1', true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.browserLifecycleTelemetry().protectedCounts.interaction, 1, 'a held draft keeps protection');

    contents.__state.probeResult = false;
    contents.emit('did-navigate-in-page', { preventDefault: () => {} }, 'https://chatgpt.com/c/2', true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.browserLifecycleTelemetry().protectedCounts.interaction, 0);

    const worldIds = contents.__state.probeCalls.map((call) => call.worldId);
    assert.equal(worldIds.length, 2);
    assert.ok(worldIds.every((id) => id !== 0), 'the probe never runs in the page main world');
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

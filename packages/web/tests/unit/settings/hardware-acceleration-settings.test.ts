import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  fetchHardwareAcceleration,
  parseHardwareAccelerationStatus,
  saveHardwareAcceleration,
} from '../../../src/features/settings/hardware-acceleration.js';
import { HardwareAccelerationControl, PerformanceSettingsSubsection } from '../../../src/features/settings/sections/PerformanceSettingsSubsection.js';
import { buildSettingsSearchCatalog, filterSettingsSearchCatalog, ALL_TABS } from '../../../src/features/settings/settings-search.js';
import type { DesktopBridge } from '../../../src/connection/desktop-bridge.js';

const GPU_SUMMARY = { compositing: 'hardware', rasterization: 'hardware', webgl: 'software', videoDecode: 'off', text: '' } as const;

/** A desktop shell double with the same contract as the real command router. */
function mockBridge(options: { source?: 'env' | 'preference' | 'default'; effective?: boolean; failWrites?: boolean } = {}) {
  const effective = options.effective ?? true;
  let configured = effective;
  const commands: unknown[] = [];
  const status = () => ({
    ok: true,
    configured,
    effectiveAtStartup: effective,
    source: options.source ?? 'default',
    pendingRestart: configured !== effective,
    gpuFeatureStatus: { gpu_compositing: 'enabled' },
    gpuSummary: GPU_SUMMARY,
  });
  const bridge: DesktopBridge = {
    command: async (command: unknown) => {
      commands.push(command);
      const c = command as { type: string; enabled?: boolean };
      if (c.type === 'get-hardware-acceleration') return status();
      if (c.type === 'set-hardware-acceleration') {
        if (options.failWrites) return { ok: false, error: 'could not save the preference (EACCES)' };
        configured = c.enabled === true;
        return status();
      }
      return undefined;
    },
    subscribe: () => () => {},
  };
  return { bridge, commands };
}

const render = (props: Parameters<typeof HardwareAccelerationControl>[0]) =>
  renderToStaticMarkup(React.createElement(HardwareAccelerationControl, props));

test('toggle round trip through the desktop bridge: off shows Restart required, back on clears it', async () => {
  const { bridge, commands } = mockBridge();
  const initial = await fetchHardwareAcceleration(bridge);
  assert.ok(initial);
  let html = render({ available: true, status: initial, onToggle: () => {} });
  assert.match(html, /Use hardware acceleration when available/);
  assert.match(html, /Restart Workbench to apply changes\./);
  assert.match(html, /data-testid="hardware-acceleration-toggle"[^>]*checked=""/);
  assert.doesNotMatch(html, /Restart required/);
  assert.match(html, /started with hardware acceleration enabled/);
  assert.match(html, /compositing: hardware, rasterization: hardware, WebGL: software, video decoding: off/);
  assert.match(html, /does not guarantee acceleration for every feature/);

  const off = await saveHardwareAcceleration(bridge, false);
  html = render({ available: true, status: off, onToggle: () => {} });
  assert.doesNotMatch(html, /data-testid="hardware-acceleration-toggle"[^>]*checked=""/);
  assert.match(html, /Restart required/);
  assert.match(html, /reloads browser tabs, so unsaved page content may be lost\. Terminal processes keep running\./);
  // The running session is still what it started with.
  assert.match(html, /started with hardware acceleration enabled/);

  const on = await saveHardwareAcceleration(bridge, true);
  assert.equal(on.pendingRestart, false);
  assert.doesNotMatch(render({ available: true, status: on, onToggle: () => {} }), /Restart required/);
  assert.deepEqual(commands, [
    { type: 'get-hardware-acceleration' },
    { type: 'set-hardware-acceleration', enabled: false },
    { type: 'set-hardware-acceleration', enabled: true },
  ]);
});

test('the toggle calls onToggle with the new value', () => {
  const seen: boolean[] = [];
  const element = HardwareAccelerationControl({ available: true, status: parseHardwareAccelerationStatus({ ok: true, configured: true, effectiveAtStartup: true, source: 'default', pendingRestart: false, gpuFeatureStatus: null, gpuSummary: null }), onToggle: (v) => seen.push(v) });
  // Walk the element tree to the checkbox and fire its onChange.
  const find = (node: unknown): { props: { onChange: (e: unknown) => void } } | null => {
    if (!node || typeof node !== 'object') return null;
    const n = node as { props?: { type?: string; children?: unknown } };
    if (n.props?.type === 'checkbox') return n as never;
    const children = n.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  const checkbox = find(element);
  assert.ok(checkbox);
  checkbox.props.onChange({ target: { checked: false } });
  assert.deepEqual(seen, [false]);
});

test('a failed save surfaces an error instead of a status', async () => {
  const { bridge } = mockBridge({ failWrites: true });
  await assert.rejects(saveHardwareAcceleration(bridge, false), /EACCES/);
  const html = render({ available: true, status: await fetchHardwareAcceleration(bridge), error: 'EACCES', onToggle: () => {} });
  assert.match(html, /Could not save the setting\./);
});

test('an environment override is reported instead of a restart prompt', async () => {
  const { bridge } = mockBridge({ source: 'env', effective: false });
  const status = await saveHardwareAcceleration(bridge, true);
  assert.equal(status.pendingRestart, true);
  const html = render({ available: true, status, onToggle: () => {} });
  assert.match(html, /MAW_SAFE_GRAPHICS/);
  assert.doesNotMatch(html, /Restart required/);
  assert.match(html, /started with hardware acceleration disabled/);
});

test('without the desktop bridge the control is shown as unavailable', async () => {
  assert.equal(await fetchHardwareAcceleration(null), null);
  const html = renderToStaticMarkup(React.createElement(PerformanceSettingsSubsection, { bridge: null }));
  assert.match(html, /Performance/);
  assert.match(html, /Desktop app only/);
  assert.match(html, /available only in the Workbench desktop app/);
  assert.doesNotMatch(html, /type="checkbox"/);
});

test('an older shell that does not know the command is treated as unavailable', async () => {
  const bridge: DesktopBridge = { command: async () => { throw new Error('Invalid desktop request'); }, subscribe: () => () => {} };
  assert.equal(await fetchHardwareAcceleration(bridge), null);
  assert.equal(parseHardwareAccelerationStatus({ ok: true, configured: 'yes' }), null);
  assert.equal(parseHardwareAccelerationStatus({ ok: false, error: 'x' }), null);
});

test('settings search finds the hardware acceleration setting under General', () => {
  const catalog = buildSettingsSearchCatalog({
    visibleTabs: ALL_TABS, onOpenVault: null, onOpenRemote: null, shellChoices: [], searchEngines: [], favorites: [],
    browserProfiles: [], agents: [], shouldOfferPanels: false, electronVersion: '45.2.0', displayVersion: '1.0.0',
  } as never);
  const results = filterSettingsSearchCatalog(catalog, 'hardware acceleration');
  assert.ok(results.some((r) => r.tabId === 'general' && r.targetId === 'setting-card-performance'));
});

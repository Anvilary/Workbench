/**
 * Process level setup that must run before the app is ready: data directory,
 * application name, sandboxing, GPU switches, graphics policy and the single
 * instance lock. Returns the backend URL this instance was started for.
 */

import path from 'node:path';
import { serviceUrl } from '../../policy.mjs';
import { applyGraphicsPolicy, resolveGraphicsPolicy, shouldDisableHardwareVideoDecode } from '../gpu/graphics-policy.mjs';

export function configureProcess({ app }) {
// Deliberately distinct from both production MAW and any Brave/Neko profile.
app.setPath('userData', path.resolve(process.env.MAW_DESKTOP_DATA_DIR || path.join(app.getPath('appData'), 'maw-desktop-prototype')));
app.setName(process.env.MAW_DESKTOP_PRODUCTION === '1' ? 'Anvilary Workbench' : 'Anvilary Workbench Prototype');
if (process.platform === 'linux') app.setDesktopName('maw.desktop');
if (app.commandLine.hasSwitch('no-sandbox')) throw new Error('MAW desktop requires Chromium sandboxing');
app.enableSandbox();
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!process.env.DRI_PRIME) process.env.DRI_PRIME = '0';
// Must run before app.whenReady(): disableHardwareAcceleration() is only valid before ready.
// Vendor isolation is applied by the launcher; see src/gpu/graphics-policy.mjs.
const graphicsPolicy = applyGraphicsPolicy(resolveGraphicsPolicy(), { app });
const softwareVideoDecode = shouldDisableHardwareVideoDecode({ policy: graphicsPolicy, env: process.env });
if (softwareVideoDecode) app.commandLine.appendSwitch('disable-accelerated-video-decode');
console.error(`[maw-desktop] graphics mode=${graphicsPolicy.mode} (${graphicsPolicy.reason}); video decode=${softwareVideoDecode ? 'software' : 'hardware'}`);
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU') console.error(`[maw-desktop] GPU process gone: reason=${details.reason} exitCode=${details.exitCode}`);
});
let local = serviceUrl(process.env.MAW_DESKTOP_URL || '');
delete process.env.MAW_DESKTOP_URL;
if (!app.requestSingleInstanceLock({ serviceUrl: local.href })) app.exit(0);

// Do not await app.whenReady() at module scope: Electron waits for ESM
  return local;
}

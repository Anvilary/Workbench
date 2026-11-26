import { workbenchEnv } from '../../../../packages/shared/src/workbench-env.mjs';
/**
 * Process level setup that must run before the app is ready: data directory,
 * application name, sandboxing, GPU switches, graphics policy and the single
 * instance lock. Returns the backend URL this instance was started for and the
 * hardware acceleration setting decided for it.
 */

import path from 'node:path';
import { serviceUrl } from '../../policy.mjs';
import { applyGraphicsPolicy, resolveGraphicsPolicy, shouldDisableHardwareVideoDecode } from '../gpu/graphics-policy.mjs';
import { readDesktopPreferences } from './desktop-preferences.mjs';
import { createHardwareAccelerationSettings } from './hardware-acceleration.mjs';

/** The saved hardware acceleration preference; anything unusable means "use the default" and is logged. */
function readAccelerationPreference(userDataDir, logger) {
  const { prefs, state, error } = readDesktopPreferences(userDataDir);
  if (state !== 'ok') logger?.warn(`desktop preferences ${state}${error ? ` (${error})` : ''}; hardware acceleration uses its default`);
  return prefs.hardwareAcceleration;
}

export function configureProcess({ app, logger }) {
// Deliberately distinct from both production Workbench and any Brave/Neko profile.
app.setPath('userData', path.resolve(workbenchEnv('DESKTOP_DATA_DIR') || path.join(app.getPath('appData'), 'workbench-desktop-dev')));
app.setName(workbenchEnv('DESKTOP_PRODUCTION') === '1' ? 'Anvilary Workbench' : 'Anvilary Workbench Prototype');
if (process.platform === 'linux') app.setDesktopName('workbench.desktop');
if (app.commandLine.hasSwitch('no-sandbox')) throw new Error('Workbench desktop requires Chromium sandboxing');
app.enableSandbox();
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!process.env.DRI_PRIME) process.env.DRI_PRIME = '0';
// Must run before app.whenReady(): disableHardwareAcceleration() is only valid before ready.
// Vendor isolation is applied by the launcher; see src/gpu/graphics-policy.mjs.
const userDataDir = app.getPath('userData');
const graphicsPolicy = applyGraphicsPolicy(resolveGraphicsPolicy({ hardwareAccelerationPreference: readAccelerationPreference(userDataDir, logger) }), { app });
const softwareVideoDecode = shouldDisableHardwareVideoDecode({ policy: graphicsPolicy, env: process.env });
if (softwareVideoDecode) app.commandLine.appendSwitch('disable-accelerated-video-decode');
console.error(`[workbench-desktop] graphics mode=${graphicsPolicy.mode} (${graphicsPolicy.reason}); hardware acceleration=${graphicsPolicy.hardwareAcceleration.effective ? 'on' : 'off'} (source ${graphicsPolicy.hardwareAcceleration.source}); video decode=${softwareVideoDecode ? 'software' : 'hardware'}`);
const hardwareAcceleration = createHardwareAccelerationSettings({ app, userDataDir, startup: graphicsPolicy.hardwareAcceleration, logger });
let local = serviceUrl(workbenchEnv('DESKTOP_URL') || '');
delete process.env.WORKBENCH_DESKTOP_URL;
delete process.env.MAW_DESKTOP_URL;
if (!app.requestSingleInstanceLock({ serviceUrl: local.href })) app.exit(0);

// Do not await app.whenReady() at module scope: Electron waits for ESM
  return { backendUrl: local, hardwareAcceleration };
}

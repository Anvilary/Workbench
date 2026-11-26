/**
 * The "Use hardware acceleration when available" setting.
 *
 * The decision is taken once, before app ready, by resolveGraphicsPolicy (see
 * src/gpu/graphics-policy.mjs); this module reports it and lets the Settings
 * page change the saved preference. Changing it never restarts the app: the
 * new value applies on the next start, and `pendingRestart` says so.
 */

import { readDesktopPreferences, writeDesktopPreferences } from './desktop-preferences.mjs';

const GPU_FEATURES = [
  ['compositing', 'gpu_compositing'],
  ['rasterization', 'rasterization'],
  ['webgl', 'webgl'],
  ['videoDecode', 'video_decode'],
];

function classify(value) {
  if (typeof value !== 'string') return 'unknown';
  if (value.startsWith('enabled')) return 'hardware';
  if (value.endsWith('_software')) return 'software';
  if (value.includes('_off') || value.startsWith('disabled') || value.startsWith('unavailable')) return 'off';
  return 'unknown';
}

/** A short, renderer friendly summary of app.getGPUFeatureStatus(). */
export function summarizeGpuFeatureStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const summary = {};
  for (const [key, feature] of GPU_FEATURES) summary[key] = classify(status[feature]);
  summary.text = GPU_FEATURES.map(([key]) => `${key}=${summary[key]}`).join(', ');
  return summary;
}

/** Only the string values Chromium reports, nothing else crosses the IPC boundary. */
function cleanFeatureStatus(status) {
  if (!status || typeof status !== 'object') return null;
  const clean = {};
  for (const [key, value] of Object.entries(status)) {
    if (typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(key)) clean[key] = value.slice(0, 64);
  }
  return clean;
}

export function createHardwareAccelerationSettings({
  app,
  userDataDir,
  startup,
  readPrefs = readDesktopPreferences,
  writePrefs = writeDesktopPreferences,
  logger,
}) {
  const configured = () => readPrefs(userDataDir).prefs.hardwareAcceleration ?? true;

  function status() {
    const value = configured();
    let gpuFeatureStatus = null;
    try { if (app.isReady()) gpuFeatureStatus = cleanFeatureStatus(app.getGPUFeatureStatus()); } catch {}
    return {
      ok: true,
      configured: value,
      effectiveAtStartup: startup.effective,
      source: startup.source,
      pendingRestart: value !== startup.effective,
      gpuFeatureStatus,
      gpuSummary: summarizeGpuFeatureStatus(gpuFeatureStatus),
    };
  }

  function set(enabled) {
    if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' };
    const result = writePrefs(userDataDir, { hardwareAcceleration: enabled });
    if (!result.ok) {
      logger?.warn(`could not save the hardware acceleration preference: ${result.error}`);
      return { ok: false, error: `could not save the preference (${result.error})` };
    }
    logger?.info(`hardware acceleration preference set to ${enabled}; applies on the next start`);
    return status();
  }

  return { status, set };
}

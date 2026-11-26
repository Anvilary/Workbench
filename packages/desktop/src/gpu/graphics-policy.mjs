import fs from 'node:fs';
import path from 'node:path';

/**
 * Graphics policy for the Electron shell.
 *
 * On Linux hybrid laptops (AMD iGPU + NVIDIA dGPU) Chromium renders on the iGPU, but
 * libglvnd still loads the NVIDIA EGL/GLX vendor libraries inside the Electron GPU process.
 * That opens /dev/nvidia* and creates NVIDIA RM clients that do no useful work for Workbench, and
 * whose teardown (for example when the process is killed under memory pressure) has been
 * observed to fault inside nvidia.ko. Restricting the vendor libraries to Mesa keeps the iGPU
 * fully hardware accelerated while giving the NVIDIA driver nothing to tear down.
 *
 * Two different mechanisms are involved, and they are NOT interchangeable:
 *   - Vendor selection (`graphicsLaunchEnv`) is an environment variable read by the GPU
 *     process. Chromium forks the GPU process from a zygote that exists before any JavaScript
 *     runs, so assigning process.env inside main.mjs does NOT reach it (verified on Electron
 *     45.2.0). It must be in the environment of the Electron process at spawn time, i.e. it is
 *     applied by the launcher (scripts/workbench/desktop-launch.mjs).
 *   - Safe graphics (`applyGraphicsPolicy`) uses app.disableHardwareAcceleration(), which is an
 *     in-process API that is valid before app.whenReady().
 *
 * This module only decides; it never touches Electron itself, so it is unit-testable.
 */

export const MESA_EGL_VENDOR_FILE = '/usr/share/glvnd/egl_vendor.d/50_mesa.json';
// The Vulkan loader opens every installed ICD, which brings the NVIDIA driver in through WebGPU/ANGLE/VA-API
// probing even when EGL/GLX are restricted (verified: 12 /dev/nvidia fds during H.264 playback until this is set).
export const RADEON_VULKAN_ICD = '/usr/share/vulkan/icd.d/radeon_icd.json';
const DRM_ROOT = '/sys/class/drm';

export const GraphicsMode = {
  DEFAULT: 'default',
  AMD_ISOLATED: 'amd-isolated',
  SAFE: 'safe',
};

/**
 * Lists DRM render nodes with the kernel driver that owns them.
 * @returns {{ node: string, driver: string }[]}
 */
export function detectRenderNodes({
  drmRoot = DRM_ROOT,
  readdir = fs.readdirSync,
  readlink = fs.readlinkSync,
} = {}) {
  let entries;
  try { entries = readdir(drmRoot); } catch { return []; }
  const nodes = [];
  for (const entry of entries) {
    if (!/^renderD\d+$/.test(entry)) continue;
    try {
      nodes.push({ node: entry, driver: path.basename(readlink(path.join(drmRoot, entry, 'device', 'driver'))) });
    } catch {}
  }
  return nodes;
}

/**
 * Decides the graphics configuration before Electron is ready.
 *
 * Hardware acceleration precedence:
 *   1. WORKBENCH_SAFE_GRAPHICS=1   forces it off (software compositing, no WebGL). Diagnostic override.
 *   2. WORKBENCH_SAFE_GRAPHICS=0   forces it on, whatever the saved preference says.
 *   3. the saved desktop preference (`hardwareAccelerationPreference`, boolean).
 *   4. otherwise on (missing, invalid or unreadable preference).
 * Other operator controls (environment):
 *   WORKBENCH_GPU_ISOLATION=0   keep the historical behaviour even on an AMD+NVIDIA hybrid.
 *
 * `hardwareAcceleration.source` says which rule decided: 'env', 'preference' or 'default'.
 *
 * @returns {{ mode: string, disableHardwareAcceleration: boolean, env: Record<string,string>, reason: string,
 *   hardwareAcceleration: { effective: boolean, source: 'env'|'preference'|'default' } }}
 */
export function resolveGraphicsPolicy({
  platform = process.platform,
  env = process.env,
  renderNodes = detectRenderNodes(),
  exists = fs.existsSync,
  hardwareAccelerationPreference,
} = {}) {
  const forced = env.WORKBENCH_SAFE_GRAPHICS === '1' || env.WORKBENCH_SAFE_GRAPHICS === '0';
  const source = forced ? 'env' : typeof hardwareAccelerationPreference === 'boolean' ? 'preference' : 'default';
  if (env.WORKBENCH_SAFE_GRAPHICS === '1') {
    return { mode: GraphicsMode.SAFE, disableHardwareAcceleration: true, env: {}, reason: 'WORKBENCH_SAFE_GRAPHICS=1', hardwareAcceleration: { effective: false, source } };
  }
  if (source === 'preference' && hardwareAccelerationPreference === false) {
    return { mode: GraphicsMode.SAFE, disableHardwareAcceleration: true, env: {}, reason: 'hardware acceleration disabled in desktop preferences', hardwareAcceleration: { effective: false, source } };
  }
  return { ...resolveAcceleratedPolicy({ platform, env, renderNodes, exists }), hardwareAcceleration: { effective: true, source } };
}

function resolveAcceleratedPolicy({ platform, env, renderNodes, exists }) {
  const base = { mode: GraphicsMode.DEFAULT, disableHardwareAcceleration: false, env: {} };
  if (platform !== 'linux') return { ...base, reason: 'not linux' };
  if (env.WORKBENCH_GPU_ISOLATION === '0') return { ...base, reason: 'WORKBENCH_GPU_ISOLATION=0' };

  const drivers = new Set(renderNodes.map((n) => n.driver));
  if (!(drivers.has('nvidia') && drivers.has('amdgpu'))) return { ...base, reason: 'not an AMD+NVIDIA hybrid' };
  if (!exists(MESA_EGL_VENDOR_FILE)) return { ...base, reason: 'Mesa EGL vendor file not found' };

  const overrides = {};
  // Respect an explicit user or distro choice; only fill in what is unset.
  if (!env.__EGL_VENDOR_LIBRARY_FILENAMES && !env.__EGL_VENDOR_LIBRARY_DIRS) overrides.__EGL_VENDOR_LIBRARY_FILENAMES = MESA_EGL_VENDOR_FILE;
  if (!env.__GLX_VENDOR_LIBRARY_NAME) overrides.__GLX_VENDOR_LIBRARY_NAME = 'mesa';
  if (!env.VK_DRIVER_FILES && !env.VK_ICD_FILENAMES && exists(RADEON_VULKAN_ICD)) overrides.VK_DRIVER_FILES = RADEON_VULKAN_ICD;
  return {
    mode: GraphicsMode.AMD_ISOLATED,
    disableHardwareAcceleration: false,
    env: overrides,
    reason: Object.keys(overrides).length ? 'AMD+NVIDIA hybrid: Mesa-only GL/EGL vendors' : 'AMD+NVIDIA hybrid: vendor selection already set by the environment',
  };
}

/**
 * Environment the launcher must give the Electron process so the GPU process never loads the
 * NVIDIA GL/EGL vendors. Empty unless the policy is `amd-isolated`.
 */
export function graphicsLaunchEnv(policy) {
  return policy.mode === GraphicsMode.AMD_ISOLATED ? { ...policy.env } : {};
}

/**
 * Applies the in-process part of a policy. Must run before `app.whenReady()`.
 * Deliberately does not write process.env: that cannot reach the GPU process (see above).
 */
export function applyGraphicsPolicy(policy, { app }) {
  if (policy.disableHardwareAcceleration) app.disableHardwareAcceleration();
  return policy;
}

/**
 * Hardware video decode (VA-API on the AMD GPU) moves decode work off the CPU: measured 7.9% vs 19.1% of a
 * core for 1080p H.264, 0 dropped frames. It had been disabled (commit ac580cf) as a mitigation for NVIDIA
 * driver trouble, so it is only enabled when the NVIDIA stack is demonstrably out of the picture: the policy is
 * `amd-isolated` AND the EGL, GLX and Vulkan restrictions are actually present in this process's environment
 * (they are set by the launcher; assigning them inside main.mjs has no effect). WORKBENCH_HW_VIDEO_DECODE=0 forces
 * software decode.
 */
export function shouldDisableHardwareVideoDecode({ policy, env = process.env }) {
  if (env.WORKBENCH_HW_VIDEO_DECODE === '0') return true;
  if (policy.mode !== GraphicsMode.AMD_ISOLATED) return true;
  const restricted = Boolean(
    (env.__EGL_VENDOR_LIBRARY_FILENAMES || env.__EGL_VENDOR_LIBRARY_DIRS)
    && env.__GLX_VENDOR_LIBRARY_NAME
    && (env.VK_DRIVER_FILES || env.VK_ICD_FILENAMES),
  );
  return !restricted;
}

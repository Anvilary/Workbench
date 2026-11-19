import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  GraphicsMode,
  MESA_EGL_VENDOR_FILE,
  RADEON_VULKAN_ICD,
  shouldDisableHardwareVideoDecode,
  applyGraphicsPolicy,
  graphicsLaunchEnv,
  detectRenderNodes,
  resolveGraphicsPolicy,
} from '../../../src/gpu/graphics-policy.mjs';

const HYBRID = [{ node: 'renderD128', driver: 'nvidia' }, { node: 'renderD129', driver: 'amdgpu' }];
const present = () => true;
const absent = () => false;

test('safe graphics wins over every other setting and changes no environment', () => {
  const policy = resolveGraphicsPolicy({ platform: 'linux', env: { MAW_SAFE_GRAPHICS: '1', MAW_GPU_ISOLATION: '0' }, renderNodes: HYBRID, exists: present });
  assert.equal(policy.mode, GraphicsMode.SAFE);
  assert.equal(policy.disableHardwareAcceleration, true);
  assert.deepEqual(policy.env, {});
});

test('safe graphics applies on every platform', () => {
  const policy = resolveGraphicsPolicy({ platform: 'win32', env: { MAW_SAFE_GRAPHICS: '1' }, renderNodes: [], exists: absent });
  assert.equal(policy.mode, GraphicsMode.SAFE);
});

test('only the exact value 1 enables safe graphics', () => {
  for (const value of ['0', 'true', '', 'yes']) {
    const policy = resolveGraphicsPolicy({ platform: 'linux', env: { MAW_SAFE_GRAPHICS: value }, renderNodes: [], exists: absent });
    assert.equal(policy.mode, GraphicsMode.DEFAULT, `value ${JSON.stringify(value)}`);
  }
});

test('an AMD+NVIDIA hybrid restricts GL and EGL vendors to Mesa without disabling acceleration', () => {
  const policy = resolveGraphicsPolicy({ platform: 'linux', env: {}, renderNodes: HYBRID, exists: present });
  assert.equal(policy.mode, GraphicsMode.AMD_ISOLATED);
  assert.equal(policy.disableHardwareAcceleration, false);
  assert.deepEqual(policy.env, { __EGL_VENDOR_LIBRARY_FILENAMES: MESA_EGL_VENDOR_FILE, __GLX_VENDOR_LIBRARY_NAME: 'mesa', VK_DRIVER_FILES: RADEON_VULKAN_ICD });
});

test('MAW_GPU_ISOLATION=0 restores the historical behaviour on a hybrid', () => {
  const policy = resolveGraphicsPolicy({ platform: 'linux', env: { MAW_GPU_ISOLATION: '0' }, renderNodes: HYBRID, exists: present });
  assert.equal(policy.mode, GraphicsMode.DEFAULT);
  assert.deepEqual(policy.env, {});
});

test('machines that are not AMD+NVIDIA hybrids are left untouched', () => {
  const cases = {
    'NVIDIA only': [{ node: 'renderD128', driver: 'nvidia' }],
    'AMD only': [{ node: 'renderD128', driver: 'amdgpu' }],
    'Intel + NVIDIA': [{ node: 'renderD128', driver: 'i915' }, { node: 'renderD129', driver: 'nvidia' }],
    'no render nodes': [],
  };
  for (const [name, renderNodes] of Object.entries(cases)) {
    const policy = resolveGraphicsPolicy({ platform: 'linux', env: {}, renderNodes, exists: present });
    assert.equal(policy.mode, GraphicsMode.DEFAULT, name);
    assert.deepEqual(policy.env, {}, name);
  }
});

test('non-Linux platforms and a missing Mesa vendor file fall back to the default', () => {
  assert.equal(resolveGraphicsPolicy({ platform: 'darwin', env: {}, renderNodes: HYBRID, exists: present }).mode, GraphicsMode.DEFAULT);
  const policy = resolveGraphicsPolicy({ platform: 'linux', env: {}, renderNodes: HYBRID, exists: absent });
  assert.equal(policy.mode, GraphicsMode.DEFAULT);
  assert.match(policy.reason, /Mesa/);
});

test('an explicit user vendor selection is never overridden, but unset variables are still filled in', () => {
  const userEgl = '/custom/egl.json';
  const policy = resolveGraphicsPolicy({ platform: 'linux', env: { __EGL_VENDOR_LIBRARY_FILENAMES: userEgl }, renderNodes: HYBRID, exists: present });
  assert.equal(policy.env.__EGL_VENDOR_LIBRARY_FILENAMES, undefined);
  assert.equal(policy.env.__GLX_VENDOR_LIBRARY_NAME, 'mesa');

  const dirs = resolveGraphicsPolicy({ platform: 'linux', env: { __EGL_VENDOR_LIBRARY_DIRS: '/custom', __GLX_VENDOR_LIBRARY_NAME: 'nvidia' }, renderNodes: HYBRID, exists: present });
  assert.deepEqual(dirs.env, { VK_DRIVER_FILES: RADEON_VULKAN_ICD }, 'only the unset Vulkan restriction is added');
  assert.equal(dirs.mode, GraphicsMode.AMD_ISOLATED);
});

test('graphicsLaunchEnv exports the Mesa-only variables for an isolated hybrid and nothing otherwise', () => {
  const isolated = resolveGraphicsPolicy({ platform: 'linux', env: {}, renderNodes: HYBRID, exists: present });
  assert.deepEqual(graphicsLaunchEnv(isolated), { __EGL_VENDOR_LIBRARY_FILENAMES: MESA_EGL_VENDOR_FILE, __GLX_VENDOR_LIBRARY_NAME: 'mesa', VK_DRIVER_FILES: RADEON_VULKAN_ICD });
  assert.notEqual(graphicsLaunchEnv(isolated), isolated.env, 'returns a copy');
  for (const env of [{ MAW_SAFE_GRAPHICS: '1' }, { MAW_GPU_ISOLATION: '0' }]) {
    assert.deepEqual(graphicsLaunchEnv(resolveGraphicsPolicy({ platform: 'linux', env, renderNodes: HYBRID, exists: present })), {});
  }
});

test('applyGraphicsPolicy only disables hardware acceleration in safe mode and never writes process.env', () => {
  const before = { ...process.env };
  let disabled = 0;
  const app = { disableHardwareAcceleration: () => { disabled += 1; } };
  applyGraphicsPolicy(resolveGraphicsPolicy({ platform: 'linux', env: {}, renderNodes: HYBRID, exists: present }), { app });
  assert.equal(disabled, 0);
  applyGraphicsPolicy(resolveGraphicsPolicy({ platform: 'linux', env: { MAW_SAFE_GRAPHICS: '1' }, renderNodes: HYBRID, exists: present }), { app });
  assert.equal(disabled, 1);
  assert.deepEqual({ ...process.env }, before);
});

test('detectRenderNodes maps render nodes to their kernel drivers and ignores everything else', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maw-drm-'));
  try {
    const drivers = path.join(root, 'bus', 'pci', 'drivers');
    await mkdir(path.join(drivers, 'nvidia'), { recursive: true });
    await mkdir(path.join(drivers, 'amdgpu'), { recursive: true });
    const drm = path.join(root, 'class', 'drm');
    for (const [node, driver] of [['renderD128', 'nvidia'], ['renderD129', 'amdgpu']]) {
      await mkdir(path.join(drm, node, 'device'), { recursive: true });
      await symlink(path.join(drivers, driver), path.join(drm, node, 'device', 'driver'));
    }
    await mkdir(path.join(drm, 'card1', 'device'), { recursive: true });
    await mkdir(path.join(drm, 'renderD130', 'device'), { recursive: true }); // no driver link: skipped
    assert.deepEqual(
      detectRenderNodes({ drmRoot: drm }).sort((a, b) => a.node.localeCompare(b.node)),
      [{ node: 'renderD128', driver: 'nvidia' }, { node: 'renderD129', driver: 'amdgpu' }],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detectRenderNodes returns an empty list when the DRM tree is unreadable', () => {
  assert.deepEqual(detectRenderNodes({ drmRoot: '/nonexistent/drm-root-for-test' }), []);
});

test('the Vulkan ICD restriction is skipped when the Radeon ICD is missing or the user chose Vulkan drivers', () => {
  const noIcd = resolveGraphicsPolicy({ platform: 'linux', env: {}, renderNodes: HYBRID, exists: (f) => f === MESA_EGL_VENDOR_FILE });
  assert.equal(noIcd.env.VK_DRIVER_FILES, undefined);
  const user = resolveGraphicsPolicy({ platform: 'linux', env: { VK_ICD_FILENAMES: '/x.json' }, renderNodes: HYBRID, exists: present });
  assert.equal(user.env.VK_DRIVER_FILES, undefined);
});

test('hardware video decode is enabled only when isolation is effective in the actual environment', () => {
  const isolated = resolveGraphicsPolicy({ platform: 'linux', env: {}, renderNodes: HYBRID, exists: present });
  const applied = { ...isolated.env };
  assert.equal(shouldDisableHardwareVideoDecode({ policy: isolated, env: applied }), false);
  // policy says isolated but the launcher did not provide the environment (for example started by hand): stay on software decode
  assert.equal(shouldDisableHardwareVideoDecode({ policy: isolated, env: {} }), true);
  // any missing restriction keeps software decode
  for (const k of Object.keys(applied)) {
    const partial = { ...applied }; delete partial[k];
    assert.equal(shouldDisableHardwareVideoDecode({ policy: isolated, env: partial }), true, `without ${k}`);
  }
  // explicit opt-out, and every non-isolated mode
  assert.equal(shouldDisableHardwareVideoDecode({ policy: isolated, env: { ...applied, MAW_HW_VIDEO_DECODE: '0' } }), true);
  const def = resolveGraphicsPolicy({ platform: 'linux', env: { MAW_GPU_ISOLATION: '0' }, renderNodes: HYBRID, exists: present });
  assert.equal(shouldDisableHardwareVideoDecode({ policy: def, env: applied }), true);
  const safe = resolveGraphicsPolicy({ platform: 'linux', env: { MAW_SAFE_GRAPHICS: '1' }, renderNodes: HYBRID, exists: present });
  assert.equal(shouldDisableHardwareVideoDecode({ policy: safe, env: applied }), true);
});

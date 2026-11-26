/**
 * Client side of the desktop "Use hardware acceleration when available"
 * setting. The desktop shell owns the value (a file it reads before startup),
 * so it is read and written through the desktop bridge only; a plain browser
 * has no such setting.
 */

import type { DesktopBridge } from '../../connection/desktop-bridge.js';

export type GpuFeatureState = 'hardware' | 'software' | 'off' | 'unknown';

export interface GpuSummary {
  compositing: GpuFeatureState;
  rasterization: GpuFeatureState;
  webgl: GpuFeatureState;
  videoDecode: GpuFeatureState;
  text: string;
}

export interface HardwareAccelerationStatus {
  ok: true;
  /** The saved preference: what the next start will use unless the environment overrides it. */
  configured: boolean;
  /** What this running session uses. */
  effectiveAtStartup: boolean;
  source: 'env' | 'preference' | 'default';
  pendingRestart: boolean;
  gpuFeatureStatus: Record<string, string> | null;
  gpuSummary: GpuSummary | null;
}

const SOURCES = new Set(['env', 'preference', 'default']);

export function parseHardwareAccelerationStatus(value: unknown): HardwareAccelerationStatus | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v['ok'] !== true || typeof v['configured'] !== 'boolean' || typeof v['effectiveAtStartup'] !== 'boolean') return null;
  if (typeof v['source'] !== 'string' || !SOURCES.has(v['source']) || typeof v['pendingRestart'] !== 'boolean') return null;
  return {
    ok: true,
    configured: v['configured'],
    effectiveAtStartup: v['effectiveAtStartup'],
    source: v['source'] as HardwareAccelerationStatus['source'],
    pendingRestart: v['pendingRestart'],
    gpuFeatureStatus: v['gpuFeatureStatus'] && typeof v['gpuFeatureStatus'] === 'object' ? (v['gpuFeatureStatus'] as Record<string, string>) : null,
    gpuSummary: v['gpuSummary'] && typeof v['gpuSummary'] === 'object' ? (v['gpuSummary'] as GpuSummary) : null,
  };
}

export function desktopBridge(): DesktopBridge | null {
  return typeof window !== 'undefined' && window.mawChatGpt ? window.mawChatGpt : null;
}

/** null when there is no desktop shell or it does not know the command (an older shell). */
export async function fetchHardwareAcceleration(bridge: DesktopBridge | null): Promise<HardwareAccelerationStatus | null> {
  if (!bridge) return null;
  try {
    return parseHardwareAccelerationStatus(await bridge.command({ type: 'get-hardware-acceleration' }));
  } catch {
    return null;
  }
}

/** Saves the preference. Never restarts anything. Throws when the shell could not save it. */
export async function saveHardwareAcceleration(bridge: DesktopBridge, enabled: boolean): Promise<HardwareAccelerationStatus> {
  const result = await bridge.command({ type: 'set-hardware-acceleration', enabled });
  const status = parseHardwareAccelerationStatus(result);
  if (!status) {
    const error = result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string'
      ? (result as { error: string }).error
      : 'unexpected response';
    throw new Error(error);
  }
  return status;
}

import { useEffect, useState } from 'react';
import { t, type MessageKey } from '../../../i18n/index.js';
import type { DesktopBridge } from '../../../connection/desktop-bridge.js';
import { CollapsibleSubsection } from '../CollapsibleSubsection.js';
import {
  desktopBridge,
  fetchHardwareAcceleration,
  saveHardwareAcceleration,
  type GpuFeatureState,
  type GpuSummary,
  type HardwareAccelerationStatus,
} from '../hardware-acceleration.js';

const GPU_FEATURE_LABELS: ReadonlyArray<[keyof Omit<GpuSummary, 'text'>, MessageKey]> = [
  ['compositing', 'settings.performance.gpu.compositing'],
  ['rasterization', 'settings.performance.gpu.rasterization'],
  ['webgl', 'settings.performance.gpu.webgl'],
  ['videoDecode', 'settings.performance.gpu.videoDecode'],
];

const GPU_STATE_LABELS: Record<GpuFeatureState, MessageKey> = {
  hardware: 'settings.performance.gpu.state.hardware',
  software: 'settings.performance.gpu.state.software',
  off: 'settings.performance.gpu.state.off',
  unknown: 'settings.performance.gpu.state.unknown',
};

export function gpuSummaryText(summary: GpuSummary): string {
  return GPU_FEATURE_LABELS
    .map(([key, label]) => `${t(label)}: ${t(GPU_STATE_LABELS[summary[key]] ?? GPU_STATE_LABELS.unknown)}`)
    .join(', ');
}

export interface HardwareAccelerationControlProps {
  /** false in a plain browser: the setting belongs to the desktop app. */
  available: boolean;
  status: HardwareAccelerationStatus | null;
  busy?: boolean;
  error?: string | null;
  onToggle: (enabled: boolean) => void;
}

/** The presentational row; the state lives in PerformanceSettingsSubsection. */
export function HardwareAccelerationControl({ available, status, busy = false, error = null, onToggle }: HardwareAccelerationControlProps): JSX.Element {
  const usable = available && status !== null;
  return (
    <>
      <div className="wb-settings-row wb-settings-row-top">
        <div className="wb-settings-row-text">
          <span className="wb-settings-label">{t('settings.performance.hardwareAcceleration')}</span>
          <span className="wb-settings-subtext">{t('settings.performance.hardwareAccelerationDesc')}</span>
        </div>
        <div className="wb-settings-control">
          {usable ? (
            <label className="wb-settings-toggle-label">
              <input
                type="checkbox"
                className="wb-settings-checkbox"
                data-testid="hardware-acceleration-toggle"
                checked={status.configured}
                disabled={busy}
                aria-label={t('settings.performance.hardwareAcceleration')}
                onChange={(event) => onToggle(event.target.checked)}
              />
            </label>
          ) : (
            <span className="wb-settings-badge badge-unavailable">{t('settings.performance.unavailableBadge')}</span>
          )}
        </div>
      </div>
      {!usable && <p className="wb-settings-hint">{t('settings.performance.unavailable')}</p>}
      {usable && (
        <>
          {status.source === 'env' ? (
            <p className="wb-settings-hint" data-testid="hardware-acceleration-env">{t('settings.performance.envOverride')}</p>
          ) : status.pendingRestart && (
            <div className="wb-settings-warning" data-testid="hardware-acceleration-restart">
              <span className="wb-settings-badge badge-partial">{t('settings.performance.restartRequired')}</span>
              <span className="wb-settings-warning-text">{t('settings.performance.restartNote')}</span>
            </div>
          )}
          <p className="wb-settings-hint" data-testid="hardware-acceleration-effective">
            {t(status.effectiveAtStartup ? 'settings.performance.effectiveOn' : 'settings.performance.effectiveOff')}
            {status.gpuSummary ? ` ${t('settings.performance.gpuStatus', { summary: gpuSummaryText(status.gpuSummary) })}` : ''}
          </p>
          <p className="wb-settings-hint">{t('settings.performance.gpuNote')}</p>
        </>
      )}
      {error && <p className="wb-settings-error-text" role="alert">{t('settings.performance.saveFailed')}</p>}
    </>
  );
}

export interface PerformanceSettingsSubsectionProps {
  highlighted?: boolean;
  expandSignal?: number;
  /** Injected for tests; defaults to `window.workbench`. */
  bridge?: DesktopBridge | null;
}

export function PerformanceSettingsSubsection({ highlighted = false, expandSignal, bridge }: PerformanceSettingsSubsectionProps): JSX.Element {
  const activeBridge = bridge === undefined ? desktopBridge() : bridge;
  const [status, setStatus] = useState<HardwareAccelerationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchHardwareAcceleration(activeBridge).then((next) => { if (!cancelled) setStatus(next); });
    return () => { cancelled = true; };
  }, [activeBridge]);

  const onToggle = (enabled: boolean): void => {
    if (!activeBridge) return;
    setBusy(true);
    setError(null);
    saveHardwareAcceleration(activeBridge, enabled)
      .then(setStatus)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <CollapsibleSubsection
      id="setting-card-performance"
      title={t('settings.section.performance')}
      highlighted={highlighted}
      forceExpanded={highlighted}
      expandSignal={expandSignal}
    >
      <HardwareAccelerationControl available={activeBridge !== null} status={status} busy={busy} error={error} onToggle={onToggle} />
    </CollapsibleSubsection>
  );
}

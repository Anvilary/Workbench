/**
 * Pure formatting and calculation helpers for the Agents Usage interface.
 *
 * Strictly distinguishes valid numeric percentages from missing, unavailable,
 * unsupported, errored, or out-of-range telemetry. Never invents usage values
 * or reset dates.
 */

import type { AgentProfileUsage, WindowUtilization } from '@anvilary/workbench-shared';
import { t } from '../../i18n/index.js';

export const QUOTA_ELEVATED_THRESHOLD = 70;
export const QUOTA_CRITICAL_THRESHOLD = 90;

export type QuotaSeverity = 'normal' | 'elevated' | 'critical';

export interface ValidQuotaDisplay {
  readonly hasBar: true;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly severity: QuotaSeverity;
}

export interface UnavailableQuotaDisplay {
  readonly hasBar: false;
  readonly reason: 'unavailable' | 'unsupported' | 'error';
}

export type QuotaDisplay = ValidQuotaDisplay | UnavailableQuotaDisplay;

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

const PLACEHOLDER = '\u2014';

export function formatTokens(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return PLACEHOLDER;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function formatExactNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return PLACEHOLDER;
  return n.toLocaleString();
}

export function formatPath(p: string): string {
  const parts = p.split('/');
  if (parts[1] === 'home' && parts[2]) {
    const home = '/home/' + parts[2];
    if (p === home || p.startsWith(home + '/')) {
      return '~' + p.slice(home.length);
    }
  }
  return p;
}

export function getProfileFamily(profile: Pick<AgentProfileUsage, 'provider' | 'profileId'>): 'Codex' | 'AGY' | 'Claude' | 'Other' {
  const prov = (profile.provider || '').toLowerCase();
  const id = (profile.profileId || '').toLowerCase();
  if (prov === 'openai' || id.startsWith('codex')) return 'Codex';
  if (prov === 'google' || id.startsWith('agy') || id.startsWith('antigravity')) return 'AGY';
  if (prov === 'anthropic' || id.startsWith('claude')) return 'Claude';
  return 'Other';
}

export function filterProfiles(
  profiles: readonly AgentProfileUsage[],
  providerFilter: string,
  searchQuery: string,
): AgentProfileUsage[] {
  let list = profiles as AgentProfileUsage[];
  if (providerFilter !== 'all') {
    const target = providerFilter.toLowerCase();
    list = list.filter((p) => p.provider.toLowerCase() === target);
  }
  const q = searchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (p) =>
        p.profileId.toLowerCase().includes(q) ||
        p.label.toLowerCase().includes(q) ||
        (p.model && p.model.toLowerCase().includes(q)) ||
        (p.planType && p.planType.toLowerCase().includes(q)) ||
        p.provider.toLowerCase().includes(q),
    );
  }
  return list;
}

export function computeQuotaSeverity(usedPercent: number): QuotaSeverity {
  if (usedPercent >= QUOTA_CRITICAL_THRESHOLD) return 'critical';
  if (usedPercent >= QUOTA_ELEVATED_THRESHOLD) return 'elevated';
  return 'normal';
}

export function computeQuotaFillClass(usedPercent: number): string {
  const severity = computeQuotaSeverity(usedPercent);
  if (severity === 'critical') return 'fill-critical';
  if (severity === 'elevated') return 'fill-elevated';
  return '';
}

export function computeQuotaDisplay(window: WindowUtilization | undefined | null): QuotaDisplay {
  if (!window) {
    return { hasBar: false, reason: 'unavailable' };
  }

  if (window.status === 'unsupported') {
    return { hasBar: false, reason: 'unsupported' };
  }
  if (window.status === 'error') {
    return { hasBar: false, reason: 'error' };
  }
  if (window.status === 'unavailable') {
    return { hasBar: false, reason: 'unavailable' };
  }

  const rawPercent =
    window.usedPercent !== undefined
      ? window.usedPercent
      : window.status === 'zero'
        ? 0
        : undefined;

  if (
    rawPercent === undefined ||
    rawPercent === null ||
    typeof rawPercent !== 'number' ||
    !Number.isFinite(rawPercent) ||
    rawPercent < 0 ||
    rawPercent > 100
  ) {
    return { hasBar: false, reason: 'unavailable' };
  }

  const usedPercent = Math.round(rawPercent);
  const remainingPercent = Math.min(100, Math.max(0, 100 - usedPercent));

  return {
    hasBar: true,
    usedPercent,
    remainingPercent,
    severity: computeQuotaSeverity(usedPercent),
  };
}

/**
 * Resolves the absolute epoch ms when a quota window resets.
 * Prefers `resetsAt` when valid; falls back to `anchorMs + resetsInSeconds * 1000`.
 */
export function resolveResetTimestamp(
  window: WindowUtilization | undefined | null,
  anchorMs?: number,
): number | null {
  if (!window) return null;

  if (
    typeof window.resetsAt === 'number' &&
    Number.isFinite(window.resetsAt) &&
    window.resetsAt > 0
  ) {
    return window.resetsAt;
  }

  if (
    typeof window.resetsInSeconds === 'number' &&
    Number.isFinite(window.resetsInSeconds) &&
    window.resetsInSeconds >= 0 &&
    typeof anchorMs === 'number' &&
    Number.isFinite(anchorMs)
  ) {
    return anchorMs + window.resetsInSeconds * 1000;
  }

  return null;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isNextLocalDay(target: Date, now: Date): boolean {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return isSameLocalDay(target, tomorrow);
}

/**
 * Formats quota reset information relative to `nowMs`.
 * Anchors relative `resetsInSeconds` to `anchorMs` (snapshot observation time)
 * so countdowns tick smoothly without re-querying telemetry and never go negative.
 */
export function formatResetCountdown(
  window: WindowUtilization | undefined | null,
  options: {
    nowMs?: number;
    anchorMs?: number;
    translate?: TranslateFn;
    locale?: string;
  } = {},
): string {
  const customT = options.translate;
  const nowMs = options.nowMs ?? Date.now();
  const anchorMs = options.anchorMs ?? nowMs;
  const resetMs = resolveResetTimestamp(window, anchorMs);

  if (resetMs === null) {
    return customT ? customT('usage.resetUnavailable') : t('usage.resetUnavailable');
  }

  const remainingMs = Math.max(0, resetMs - nowMs);
  if (remainingMs < 60_000) {
    return customT ? customT('usage.resetsSoon') : t('usage.resetsSoon');
  }

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours < 24) {
    if (hours === 0) {
      return customT
        ? customT('usage.resetsInMinutes', { minutes })
        : t('usage.resetsInMinutes', { minutes });
    }
    if (minutes === 0) {
      return customT
        ? customT('usage.resetsInHours', { hours })
        : t('usage.resetsInHours', { hours });
    }
    return customT
      ? customT('usage.resetsInHoursMinutes', { hours, minutes })
      : t('usage.resetsInHoursMinutes', { hours, minutes });
  }

  const targetDate = new Date(resetMs);
  const nowDate = new Date(nowMs);
  const timeStr = targetDate.toLocaleTimeString(options.locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  if (isNextLocalDay(targetDate, nowDate)) {
    return customT
      ? customT('usage.resetsTomorrowAt', { time: timeStr })
      : t('usage.resetsTomorrowAt', { time: timeStr });
  }

  const dateStr = targetDate.toLocaleDateString(options.locale, {
    month: 'short',
    day: 'numeric',
  });
  return customT
    ? customT('usage.resetsAtDate', { date: dateStr, time: timeStr })
    : t('usage.resetsAtDate', { date: dateStr, time: timeStr });
}

/**
 * Compact legacy helper retained for unit compatibility.
 */
export function formatReset(window: WindowUtilization, nowMs?: number, anchorMs?: number): string {
  const effectiveNow = nowMs ?? Date.now();
  const resetMs = resolveResetTimestamp(window, anchorMs ?? effectiveNow);
  if (resetMs === null) return '';
  const remainingSec = Math.max(0, Math.floor((resetMs - effectiveNow) / 1000));
  if (remainingSec < 60) return 'in <1m';
  const hours = Math.floor(remainingSec / 3600);
  const mins = Math.floor((remainingSec % 3600) / 60);
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

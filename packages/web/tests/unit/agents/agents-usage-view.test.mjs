import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  QUOTA_CRITICAL_THRESHOLD,
  QUOTA_ELEVATED_THRESHOLD,
  computeQuotaDisplay,
  computeQuotaFillClass,
  computeQuotaSeverity,
  filterProfiles,
  formatExactNumber,
  formatPath,
  formatReset,
  formatResetCountdown,
  formatTokens,
  getProfileFamily,
  resolveResetTimestamp,
} from '../../../src/features/agents/usage-format.ts';
import {
  USAGE_REFRESH_INTERVAL_MS,
  USAGE_REQUEST_TIMEOUT_MS,
} from '../../../src/features/agents/useAgentsUsage.ts';

test('usage refresh constants define 5-minute auto-refresh and bounded timeout', () => {
  assert.equal(USAGE_REFRESH_INTERVAL_MS, 5 * 60 * 1000);
  assert.equal(USAGE_REQUEST_TIMEOUT_MS, 15_000);
  assert.equal(QUOTA_ELEVATED_THRESHOLD, 70);
  assert.equal(QUOTA_CRITICAL_THRESHOLD, 90);
});

test('formatTokens and formatExactNumber format values without inventing data', () => {
  assert.equal(formatTokens(undefined), '\u2014');
  assert.equal(formatTokens(null), '\u2014');
  assert.equal(formatTokens(Number.NaN), '\u2014');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(500), '500');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(2500000), '2.50M');
  assert.equal(formatTokens(5619787818), '5.62B');
  assert.equal(formatExactNumber(undefined), '\u2014');
  assert.equal(formatExactNumber(12345), (12345).toLocaleString());
});

test('computeQuotaDisplay handles valid percentages, thresholds, and exact used/remaining math', () => {
  const zero = computeQuotaDisplay({ status: 'zero', usedPercent: 0 });
  assert.deepEqual(zero, { hasBar: true, usedPercent: 0, remainingPercent: 100, severity: 'normal' });

  const zeroOmitted = computeQuotaDisplay({ status: 'zero' });
  assert.deepEqual(zeroOmitted, { hasBar: true, usedPercent: 0, remainingPercent: 100, severity: 'normal' });

  const p32 = computeQuotaDisplay({ status: 'available', usedPercent: 32 });
  assert.deepEqual(p32, { hasBar: true, usedPercent: 32, remainingPercent: 68, severity: 'normal' });

  const p50 = computeQuotaDisplay({ status: 'available', usedPercent: 50 });
  assert.deepEqual(p50, { hasBar: true, usedPercent: 50, remainingPercent: 50, severity: 'normal' });

  const p69 = computeQuotaDisplay({ status: 'available', usedPercent: 69 });
  assert.equal(p69.hasBar, true);
  if (p69.hasBar) assert.equal(p69.severity, 'normal');

  const p70 = computeQuotaDisplay({ status: 'available', usedPercent: 70 });
  assert.deepEqual(p70, { hasBar: true, usedPercent: 70, remainingPercent: 30, severity: 'elevated' });

  const p89 = computeQuotaDisplay({ status: 'available', usedPercent: 89 });
  assert.deepEqual(p89, { hasBar: true, usedPercent: 89, remainingPercent: 11, severity: 'elevated' });

  const p90 = computeQuotaDisplay({ status: 'available', usedPercent: 90 });
  assert.deepEqual(p90, { hasBar: true, usedPercent: 90, remainingPercent: 10, severity: 'critical' });

  const p95 = computeQuotaDisplay({ status: 'available', usedPercent: 95 });
  assert.deepEqual(p95, { hasBar: true, usedPercent: 95, remainingPercent: 5, severity: 'critical' });

  const p100 = computeQuotaDisplay({ status: 'available', usedPercent: 100 });
  assert.deepEqual(p100, { hasBar: true, usedPercent: 100, remainingPercent: 0, severity: 'critical' });
});

test('computeQuotaDisplay rejects missing, unavailable, unsupported, errored, and out-of-range metrics', () => {
  assert.deepEqual(computeQuotaDisplay(undefined), { hasBar: false, reason: 'unavailable' });
  assert.deepEqual(computeQuotaDisplay({ status: 'available' }), { hasBar: false, reason: 'unavailable' });
  assert.deepEqual(computeQuotaDisplay({ status: 'unavailable' }), { hasBar: false, reason: 'unavailable' });
  assert.deepEqual(computeQuotaDisplay({ status: 'unsupported' }), { hasBar: false, reason: 'unsupported' });
  assert.deepEqual(computeQuotaDisplay({ status: 'error' }), { hasBar: false, reason: 'error' });

  // Invalid or out-of-range numeric values must never fabricate 0% or 100%
  assert.deepEqual(computeQuotaDisplay({ status: 'available', usedPercent: -5 }), { hasBar: false, reason: 'unavailable' });
  assert.deepEqual(computeQuotaDisplay({ status: 'available', usedPercent: 101 }), { hasBar: false, reason: 'unavailable' });
  assert.deepEqual(computeQuotaDisplay({ status: 'available', usedPercent: Number.NaN }), { hasBar: false, reason: 'unavailable' });
  assert.deepEqual(computeQuotaDisplay({ status: 'available', usedPercent: Number.POSITIVE_INFINITY }), { hasBar: false, reason: 'unavailable' });
});

test('computeQuotaSeverity and computeQuotaFillClass align with 70% and 90% thresholds', () => {
  assert.equal(computeQuotaSeverity(0), 'normal');
  assert.equal(computeQuotaSeverity(69), 'normal');
  assert.equal(computeQuotaSeverity(70), 'elevated');
  assert.equal(computeQuotaSeverity(89), 'elevated');
  assert.equal(computeQuotaSeverity(90), 'critical');
  assert.equal(computeQuotaSeverity(100), 'critical');

  assert.equal(computeQuotaFillClass(42), '');
  assert.equal(computeQuotaFillClass(70), 'fill-elevated');
  assert.equal(computeQuotaFillClass(89), 'fill-elevated');
  assert.equal(computeQuotaFillClass(90), 'fill-critical');
  assert.equal(computeQuotaFillClass(95), 'fill-critical');
});

test('reset countdown prefers resetsAt, anchors resetsInSeconds, never goes negative, and formats cleanly', () => {
  const baseNow = new Date(2026, 10, 24, 10, 0, 0).getTime();

  // Relative 52 minutes anchored to snapshot time
  assert.equal(
    formatResetCountdown(
      { status: 'available', usedPercent: 40, resetsInSeconds: 52 * 60 },
      { nowMs: baseNow, anchorMs: baseNow },
    ),
    'Resets in 52m',
  );

  // Ticking forward 12 minutes locally decrements the anchored countdown without refetching
  assert.equal(
    formatResetCountdown(
      { status: 'available', usedPercent: 40, resetsInSeconds: 52 * 60 },
      { nowMs: baseNow + 12 * 60_000, anchorMs: baseNow },
    ),
    'Resets in 40m',
  );

  // Hours and minutes
  assert.equal(
    formatResetCountdown(
      { status: 'available', usedPercent: 40, resetsInSeconds: 3 * 3600 + 15 * 60 },
      { nowMs: baseNow, anchorMs: baseNow },
    ),
    'Resets in 3h 15m',
  );

  // Absolute resetsAt takes precedence over resetsInSeconds
  const preferredReset = baseNow + 2 * 3600_000;
  assert.equal(
    resolveResetTimestamp(
      { status: 'available', usedPercent: 40, resetsAt: preferredReset, resetsInSeconds: 99999 },
      baseNow,
    ),
    preferredReset,
  );
  assert.equal(
    formatResetCountdown(
      { status: 'available', usedPercent: 40, resetsAt: preferredReset, resetsInSeconds: 99999 },
      { nowMs: baseNow, anchorMs: baseNow },
    ),
    'Resets in 2h',
  );

  // Tomorrow (> 24h away, next local day)
  const tomorrow1030 = new Date(2026, 10, 25, 10, 30, 0).getTime();
  assert.equal(
    formatResetCountdown(
      { status: 'available', usedPercent: 95, resetsAt: tomorrow1030 },
      { nowMs: baseNow, anchorMs: baseNow, locale: 'en-US' },
    ),
    'Resets tomorrow at 10:30',
  );

  // Past timestamp never produces negative time
  assert.equal(
    formatResetCountdown(
      { status: 'available', usedPercent: 95, resetsAt: baseNow - 120_000 },
      { nowMs: baseNow, anchorMs: baseNow },
    ),
    'Resets in <1m',
  );

  // Missing reset data never invents a date
  assert.equal(
    formatResetCountdown({ status: 'available', usedPercent: 25 }, { nowMs: baseNow, anchorMs: baseNow }),
    'Reset time unavailable',
  );

  // Legacy formatReset helper
  assert.equal(formatReset({ status: 'available', resetsInSeconds: 3660 }, baseNow, baseNow), 'in 1h 1m');
  assert.equal(formatReset({ status: 'available', resetsInSeconds: 120 }, baseNow, baseNow), 'in 2m');
  assert.equal(formatReset({ status: 'unavailable' }, baseNow, baseNow), '');
});

test('formatPath abbreviates user home directory cleanly', () => {
  assert.equal(formatPath('/home/developer/.codex-a'), '~/.codex-a');
  assert.equal(formatPath('/home/user/some/path'), '~/some/path');
  assert.equal(formatPath('/var/log/syslog'), '/var/log/syslog');
});

test('filterProfiles filters correctly by provider and search term', () => {
  const sampleProfiles = [
    { profileId: 'codex-a', label: 'Codex A', provider: 'OpenAI', model: 'gpt-5', planType: 'Plus' },
    { profileId: 'codex-b', label: 'Codex B', provider: 'OpenAI', model: 'gpt-5', planType: 'Team' },
    { profileId: 'agy-a', label: 'AGY A', provider: 'Google', model: 'Gemini 3.8 Flash' },
    { profileId: 'agy-h', label: 'AGY H', provider: 'Anthropic', model: 'Claude Sonnet 4.6' },
    { profileId: 'claude-code', label: 'Claude Code', provider: 'Anthropic', model: 'claude-opus-5-5' },
  ];

  assert.equal(filterProfiles(sampleProfiles, 'all', '').length, 5);

  const openai = filterProfiles(sampleProfiles, 'openai', '');
  assert.equal(openai.length, 2);
  assert.ok(openai.every((p) => p.provider === 'OpenAI'));

  const anthropic = filterProfiles(sampleProfiles, 'anthropic', '');
  assert.equal(anthropic.length, 2);
  assert.ok(anthropic.some((p) => p.profileId === 'agy-h'));
  assert.ok(anthropic.some((p) => p.profileId === 'claude-code'));

  const google = filterProfiles(sampleProfiles, 'google', '');
  assert.equal(google.length, 1);
  assert.equal(google[0].profileId, 'agy-a');

  assert.equal(filterProfiles(sampleProfiles, 'all', 'Sonnet')[0].profileId, 'agy-h');
  assert.equal(filterProfiles(sampleProfiles, 'all', 'codex-b')[0].profileId, 'codex-b');
  assert.equal(filterProfiles(sampleProfiles, 'all', 'Team')[0].profileId, 'codex-b');
});

test('getProfileFamily correctly maps profiles to Codex, AGY, and Claude families', () => {
  assert.equal(getProfileFamily({ profileId: 'codex-a', provider: 'OpenAI' }), 'Codex');
  assert.equal(getProfileFamily({ profileId: 'codex-d', provider: 'OpenAI' }), 'Codex');
  assert.equal(getProfileFamily({ profileId: 'custom-openai', provider: 'OpenAI' }), 'Codex');

  assert.equal(getProfileFamily({ profileId: 'agy-b', provider: 'Google' }), 'AGY');
  assert.equal(getProfileFamily({ profileId: 'agy-h', provider: 'Anthropic' }), 'AGY');
  assert.equal(getProfileFamily({ profileId: 'antigravity-dev', provider: 'Custom' }), 'AGY');

  assert.equal(getProfileFamily({ profileId: 'claude-code', provider: 'Anthropic' }), 'Claude');
  assert.equal(getProfileFamily({ profileId: 'claude02', provider: 'Anthropic' }), 'Claude');
});

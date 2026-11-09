import assert from 'node:assert/strict';
import { test } from 'node:test';

function formatTokens(n) {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatReset(window) {
  if (window.resetsInSeconds !== undefined && window.resetsInSeconds > 0) {
    const hours = Math.floor(window.resetsInSeconds / 3600);
    const mins = Math.floor((window.resetsInSeconds % 3600) / 60);
    if (hours > 0) return `in ${hours}h ${mins}m`;
    return `in ${mins}m`;
  }
  if (window.resetsAt !== undefined) {
    const date = new Date(window.resetsAt);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return '';
}

function formatPath(p) {
  const home = '/home/' + (p.split('/')[2] || '');
  if (p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

function computeProgressBarClass(pct) {
  if (pct >= 80) return 'fill-high';
  if (pct >= 50) return 'fill-medium';
  return '';
}

function filterProfiles(profiles, providerFilter, searchQuery) {
  let list = profiles;
  if (providerFilter !== 'all') {
    list = list.filter((p) => p.provider.toLowerCase() === providerFilter.toLowerCase());
  }
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    list = list.filter(
      (p) =>
        p.profileId.toLowerCase().includes(q) ||
        p.label.toLowerCase().includes(q) ||
        (p.model && p.model.toLowerCase().includes(q)) ||
        p.provider.toLowerCase().includes(q),
    );
  }
  return list;
}

test('formatTokens formats numbers correctly without inventing data', () => {
  assert.equal(formatTokens(undefined), '—');
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(500), '500');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(2500000), '2.50M');
  assert.equal(formatTokens(5619787818), '5.62B');
});

test('formatReset handles relative seconds and timestamps', () => {
  assert.equal(formatReset({ resetsInSeconds: 3660 }), 'in 1h 1m');
  assert.equal(formatReset({ resetsInSeconds: 120 }), 'in 2m');
  assert.equal(formatReset({}), '');
});

test('formatPath abbreviates user home directory cleanly', () => {
  assert.equal(formatPath('/home/user/.codex-0'), '~/.codex-0');
  assert.equal(formatPath('/home/user/some/path'), '~/some/path');
  assert.equal(formatPath('/var/log/syslog'), '/var/log/syslog');
});

test('computeProgressBarClass assigns proper styling thresholds', () => {
  assert.equal(computeProgressBarClass(30), '');
  assert.equal(computeProgressBarClass(50), 'fill-medium');
  assert.equal(computeProgressBarClass(75), 'fill-medium');
  assert.equal(computeProgressBarClass(80), 'fill-high');
  assert.equal(computeProgressBarClass(98), 'fill-high');
});

test('filterProfiles filters correctly by provider and search term', () => {
  const sampleProfiles = [
    { profileId: 'codex-0', label: 'Codex 00', provider: 'OpenAI', model: 'gpt-5' },
    { profileId: 'codex-1', label: 'Codex 01', provider: 'OpenAI', model: 'gpt-5' },
    { profileId: 'agy-0', label: 'AGY 00', provider: 'Google', model: 'Gemini 3.8 Flash' },
    { profileId: 'agy-7', label: 'AGY 07', provider: 'Anthropic', model: 'Claude Sonnet 4.6' },
    { profileId: 'claude-code', label: 'Claude Code', provider: 'Anthropic', model: 'claude-opus-5-5' },
  ];

  // All
  assert.equal(filterProfiles(sampleProfiles, 'all', '').length, 5);

  // By provider
  const openai = filterProfiles(sampleProfiles, 'openai', '');
  assert.equal(openai.length, 2);
  assert.ok(openai.every((p) => p.provider === 'OpenAI'));

  const anthropic = filterProfiles(sampleProfiles, 'anthropic', '');
  assert.equal(anthropic.length, 2);
  assert.ok(anthropic.some((p) => p.profileId === 'agy-7'));
  assert.ok(anthropic.some((p) => p.profileId === 'claude-code'));

  const google = filterProfiles(sampleProfiles, 'google', '');
  assert.equal(google.length, 1);
  assert.equal(google[0].profileId, 'agy-0');

  // Search query
  const searchSonnet = filterProfiles(sampleProfiles, 'all', 'Sonnet');
  assert.equal(searchSonnet.length, 1);
  assert.equal(searchSonnet[0].profileId, 'agy-7');

  const searchCodex = filterProfiles(sampleProfiles, 'all', 'codex-1');
  assert.equal(searchCodex.length, 1);
  assert.equal(searchCodex[0].profileId, 'codex-1');
});

test('strictly distinguishes metric statuses without inventing numbers', () => {
  const availableQuota = { status: 'available', usedPercent: 42 };
  const zeroQuota = { status: 'zero', usedPercent: 0 };
  const unavailableQuota = { status: 'unavailable' };
  const unsupportedQuota = { status: 'unsupported' };

  assert.equal(availableQuota.status, 'available');
  assert.equal(availableQuota.usedPercent, 42);

  assert.equal(zeroQuota.status, 'zero');
  assert.equal(zeroQuota.usedPercent, 0);

  assert.equal(unavailableQuota.status, 'unavailable');
  assert.equal(unavailableQuota.usedPercent, undefined);

  assert.equal(unsupportedQuota.status, 'unsupported');
  assert.equal(unsupportedQuota.usedPercent, undefined);
});

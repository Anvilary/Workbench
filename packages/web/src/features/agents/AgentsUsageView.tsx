/**
 * Agents Usage view component for MAW Settings.
 *
 * Implements read-only monitoring of coding agent profiles (Codex, AGY, Claude).
 * Strictly distinguishes between zero usage, unavailable telemetry, missing profiles,
 * collection errors, and unsupported metrics. Never invents numbers.
 */

import { useMemo, useState } from 'react';
import type {
  AgentProfileUsage,
  CostMetrics,
  TokenUsageMetrics,
  WindowUtilization,
} from '@agent-workbench/shared';
import type { AgentConnection } from '../../connection/connection.js';
import { useAgentsUsage } from './useAgentsUsage.js';

interface AgentsUsageViewProps {
  connection?: AgentConnection;
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function formatExactNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString();
}

export function formatReset(window: WindowUtilization): string {
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

export function formatPath(p: string): string {
  const home = '/home/' + (p.split('/')[2] || '');
  if (p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

export function getProfileFamily(profile: AgentProfileUsage): 'Codex' | 'AGY' | 'Claude' | 'Other' {
  const prov = (profile.provider || '').toLowerCase();
  const id = (profile.profileId || '').toLowerCase();
  if (prov === 'openai' || id.startsWith('codex')) return 'Codex';
  if (prov === 'google' || id.startsWith('agy') || id.startsWith('antigravity')) return 'AGY';
  if (prov === 'anthropic' || id.startsWith('claude')) return 'Claude';
  return 'Other';
}

export function AgentsUsageView({ connection }: AgentsUsageViewProps): JSX.Element {
  const { snapshot, loading, refreshing, error, refresh } = useAgentsUsage(connection, true);
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const profiles = useMemo(() => {
    if (!snapshot) return [];
    let list = snapshot.profiles;
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
  }, [snapshot, providerFilter, searchQuery]);

  const groupedProfiles = useMemo(() => {
    const families: Array<'Codex' | 'AGY' | 'Claude' | 'Other'> = ['Codex', 'AGY', 'Claude'];
    const groups: Record<string, { family: string; profiles: AgentProfileUsage[]; totalTokens: number }> = {
      Codex: { family: 'Codex', profiles: [], totalTokens: 0 },
      AGY: { family: 'AGY', profiles: [], totalTokens: 0 },
      Claude: { family: 'Claude', profiles: [], totalTokens: 0 },
    };

    for (const p of profiles) {
      const fam = getProfileFamily(p);
      if (!groups[fam]) {
        groups[fam] = { family: fam, profiles: [], totalTokens: 0 };
        families.push(fam);
      }
      groups[fam]!.profiles.push(p);
      groups[fam]!.totalTokens += p.tokens?.totalTokens ?? 0;
    }

    return families.map((fam) => groups[fam]!).filter((g) => g.profiles.length > 0);
  }, [profiles]);

  const toggleGroup = (group: string) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [group]: !prev[group],
    }));
  };

  return (
    <div className="agents-usage-view">
      {/* Header controls */}
      <div className="agents-usage-header">
        <div>
          <h2 className="agents-usage-title">Agents Usage</h2>
          <p className="agents-usage-subtitle">
            Local telemetry, quota windows, and resource usage for agent profiles
          </p>
        </div>
        <div className="agents-usage-actions">
          {snapshot?.aggregated.lastRefresh ? (
            <span className="agents-usage-last-refresh">
              Refreshed: {new Date(snapshot.aggregated.lastRefresh).toLocaleTimeString()}
            </span>
          ) : null}
          <button
            type="button"
            className="primary-button primary-button-small agents-usage-refresh-btn"
            disabled={loading || refreshing}
            onClick={() => refresh(true)}
          >
            {refreshing || loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="agents-usage-banner error" role="alert">
          <span className="agents-usage-banner-icon">⚠</span>
          <span>{error}</span>
          <button type="button" className="link-button" onClick={() => refresh(true)}>
            Retry
          </button>
        </div>
      )}

      {/* Loading state when no snapshot yet */}
      {loading && !snapshot && (
        <div className="agents-usage-loading">
          <div className="agents-usage-spinner" />
          <span>Collecting local agent telemetry…</span>
        </div>
      )}

      {snapshot && (
        <>
          {/* Aggregated summary row - simplified to 2 cards */}
          <div className="agents-usage-summary-grid two-cards">
            <div className="agents-usage-summary-card">
              <span className="summary-label">Profiles Monitored</span>
              <div className="summary-value">
                <span className="value-highlight">{snapshot.aggregated.availableProfiles}</span>
                <span className="value-total"> / {snapshot.aggregated.totalProfiles}</span>
              </div>
              <span className="summary-sub">
                {snapshot.aggregated.missingProfiles > 0
                  ? `${snapshot.aggregated.missingProfiles} missing / unconfigured`
                  : 'All configured profiles detected'}
              </span>
            </div>

            <div className="agents-usage-summary-card">
              <span className="summary-label">Recorded Tokens</span>
              <div className="summary-value value-highlight">
                {formatTokens(snapshot.aggregated.totalTokens)}
              </div>
              <span className="summary-sub" title={formatExactNumber(snapshot.aggregated.totalTokens)}>
                {snapshot.aggregated.totalTokens > 0
                  ? `${formatTokens(snapshot.aggregated.totalInputTokens)} in · ${formatTokens(snapshot.aggregated.totalOutputTokens)} out`
                  : 'No token telemetry available'}
              </span>
            </div>
          </div>

          {/* Provider summaries - single horizontal row */}
          <div className="agents-usage-providers-section">
            <h3 className="section-title">Providers Overview</h3>
            <div className="agents-usage-providers-row">
              {snapshot.providers.map((p) => {
                return (
                  <div key={p.provider} className={`provider-summary-item provider-${p.provider.toLowerCase()}`}>
                    <div className="provider-summary-name-row">
                      <span className="provider-name">{p.provider}</span>
                      <span className={`provider-status status-${p.status}`}>{p.status}</span>
                    </div>
                    <div className="provider-summary-details">
                      <span><strong>Profiles:</strong> {p.availableCount} / {p.profileCount}</span>
                      <span><strong>Tokens:</strong> {formatTokens(p.totalTokens)}</span>
                      {p.totalCostUSD !== undefined && p.totalCostUSD > 0 && (
                        <span><strong>Cost:</strong> ${p.totalCostUSD.toFixed(2)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Profile filter & search toolbar */}
          <div className="agents-usage-filter-bar">
            <div className="filter-tabs">
              {(['all', 'OpenAI', 'Google', 'Anthropic'] as const).map((prov) => (
                <button
                  key={prov}
                  type="button"
                  className={`filter-tab ${providerFilter.toLowerCase() === prov.toLowerCase() ? 'active' : ''}`}
                  onClick={() => setProviderFilter(prov.toLowerCase())}
                >
                  {prov === 'all' ? 'All Profiles' : prov}
                </button>
              ))}
            </div>
            <div className="filter-search">
              <input
                type="text"
                placeholder="Search profiles or models…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="filter-search-input"
              />
              {searchQuery && (
                <button type="button" className="filter-search-clear" onClick={() => setSearchQuery('')}>
                  ×
                </button>
              )}
            </div>
          </div>

          {/* Profile Groups: Collapsible groups collapsed by default */}
          <div className="agents-usage-profiles-list">
            {groupedProfiles.length === 0 ? (
              <div className="agents-usage-empty">No agent profiles match current filter.</div>
            ) : (
              groupedProfiles.map((group) => {
                const isSearching = searchQuery.trim().length > 0;
                const isExpanded = isSearching ? true : !!expandedGroups[group.family];

                return (
                  <div key={group.family} className="profile-family-group">
                    <button
                      type="button"
                      className="profile-family-header"
                      onClick={() => toggleGroup(group.family)}
                      aria-expanded={isExpanded}
                    >
                      <div className="profile-family-title-group">
                        <span className={`profile-family-chevron ${isExpanded ? 'expanded' : ''}`}>▶</span>
                        <span>{group.family} ({group.profiles.length})</span>
                      </div>
                      <span className="profile-family-stats">
                        {group.profiles.filter((p) => p.availability === 'available').length} available &bull; {formatTokens(group.totalTokens)} tokens
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="profile-family-content">
                        {group.profiles.map((profile) => (
                          <ProfileUsageCard key={profile.profileId} profile={profile} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ProfileUsageCard({ profile }: { profile: AgentProfileUsage }): JSX.Element {
  return (
    <div className={`profile-usage-card availability-${profile.availability}`}>
      <div className="profile-card-header">
        <div className="profile-card-title-group">
          <span className="profile-id">{profile.profileId}</span>
          <span className="profile-label">{profile.label}</span>
          <span className={`provider-badge provider-badge-${profile.provider.toLowerCase()}`}>
            {profile.provider}
          </span>
          {profile.isSharedStorage && (
            <span className="storage-badge" title="Shares underlying configuration or credentials">
              Shared storage
            </span>
          )}
        </div>
        <div className="profile-card-badges">
          <span className={`availability-badge badge-${profile.availability}`}>
            {profile.availability === 'available' ? 'Available' : profile.availability}
          </span>
          {profile.collectionStatus !== 'healthy' && (
            <span className={`collection-badge badge-${profile.collectionStatus}`}>
              {profile.collectionStatus}
            </span>
          )}
        </div>
      </div>

      <div className="profile-card-meta">
        <span className="meta-item">
          <strong>Model:</strong> {profile.model || <span className="dim">Default</span>}
        </span>
        {profile.planType && (
          <span className="meta-item">
            <strong>Plan:</strong> {profile.planType}
          </span>
        )}
        <span className="meta-item meta-path" title={profile.profileDir}>
          <strong>Path:</strong> {formatPath(profile.profileDir)}
        </span>
      </div>

      {profile.collectionError && (
        <div className="profile-card-error">
          <span className="error-icon">ℹ</span> {profile.collectionError}
        </div>
      )}

      {/* Quota window metrics */}
      {((profile.fiveHourUtilization?.status === 'available' || profile.fiveHourUtilization?.status === 'zero') ||
        (profile.weeklyUtilization?.status === 'available' || profile.weeklyUtilization?.status === 'zero')) && (
        <div className="profile-card-quotas">
          <span className="sub-heading">Quota Windows</span>
          <div className="quota-bars">
            {(profile.fiveHourUtilization?.status === 'available' || profile.fiveHourUtilization?.status === 'zero') && (
              <QuotaBar label="5-Hour Quota" window={profile.fiveHourUtilization} />
            )}
            {(profile.weeklyUtilization?.status === 'available' || profile.weeklyUtilization?.status === 'zero') && (
              <QuotaBar label="Weekly Quota" window={profile.weeklyUtilization} />
            )}
          </div>
        </div>
      )}

      {/* Token breakdown */}
      {profile.tokens && (
        <div className="profile-card-tokens">
          <span className="sub-heading">Token Breakdown</span>
          <TokenMetricsRow metrics={profile.tokens} />
        </div>
      )}

      {/* Cost metrics */}
      {profile.cost && profile.cost.amount !== undefined && profile.cost.amount > 0 && (
        <div className="profile-card-cost">
          <span className="sub-heading">Estimated Cost</span>
          <CostMetricsRow cost={profile.cost} model={profile.model} />
        </div>
      )}
    </div>
  );
}

function QuotaBar({ label, window }: { label: string; window: WindowUtilization }): JSX.Element {
  const pct = Math.min(100, Math.max(0, window.usedPercent ?? 0));
  let fillClass = '';
  if (pct >= 80) fillClass = 'fill-high';
  else if (pct >= 50) fillClass = 'fill-medium';

  return (
    <div className="quota-bar-item">
      <div className="quota-bar-label-row">
        <span className="quota-label">{label}</span>
        <span className="quota-values">
          {window.usedPercent ?? 0}%
          {formatReset(window) ? <span className="quota-reset"> · resets {formatReset(window)}</span> : null}
        </span>
      </div>
      <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`progress-fill ${fillClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TokenMetricsRow({ metrics }: { metrics: TokenUsageMetrics }): JSX.Element {
  return (
    <div className="token-metrics-row">
      <div className="token-stat">
        <span className="token-stat-label">Total</span>
        <span className="token-stat-val" title={formatExactNumber(metrics.totalTokens)}>
          {formatTokens(metrics.totalTokens)}
        </span>
      </div>
      <div className="token-stat">
        <span className="token-stat-label">Input</span>
        <span className="token-stat-val" title={formatExactNumber(metrics.inputTokens)}>
          {formatTokens(metrics.inputTokens)}
        </span>
      </div>
      <div className="token-stat">
        <span className="token-stat-label">Output</span>
        <span className="token-stat-val" title={formatExactNumber(metrics.outputTokens)}>
          {formatTokens(metrics.outputTokens)}
        </span>
      </div>
      {metrics.cachedInputTokens !== undefined && metrics.cachedInputTokens > 0 && (
        <div className="token-stat">
          <span className="token-stat-label">Cached</span>
          <span className="token-stat-val" title={formatExactNumber(metrics.cachedInputTokens)}>
            {formatTokens(metrics.cachedInputTokens)}
          </span>
        </div>
      )}
      {metrics.reasoningOutputTokens !== undefined && metrics.reasoningOutputTokens > 0 && (
        <div className="token-stat">
          <span className="token-stat-label">Reasoning</span>
          <span className="token-stat-val" title={formatExactNumber(metrics.reasoningOutputTokens)}>
            {formatTokens(metrics.reasoningOutputTokens)}
          </span>
        </div>
      )}
    </div>
  );
}

function CostMetricsRow({ cost, model }: { cost: CostMetrics; model?: string | null }): JSX.Element {
  return (
    <div className="cost-metrics-row">
      <span className="cost-val">${(cost.amount ?? 0).toFixed(2)}</span>
      <span className="cost-currency">{cost.currency || 'USD'}</span>
      {model && (
        <span className="cost-model">({model})</span>
      )}
    </div>
  );
}

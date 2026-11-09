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
import type { AgentConnection } from './connection.js';
import { useAgentsUsage } from './useAgentsUsage.js';

interface AgentsUsageViewProps {
  connection?: AgentConnection;
}

function formatTokens(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatExactNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString();
}

function formatReset(window: WindowUtilization): string {
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

function formatPath(p: string): string {
  const home = '/home/' + (p.split('/')[2] || '');
  if (p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

export function AgentsUsageView({ connection }: AgentsUsageViewProps): JSX.Element {
  const { snapshot, loading, refreshing, error, refresh } = useAgentsUsage(connection, true);
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

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
          {/* Aggregated summary row */}
          <div className="agents-usage-summary-grid">
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

            <div className="agents-usage-summary-card">
              <span className="summary-label">Recorded Cost</span>
              <div className="summary-value value-highlight">
                ${snapshot.aggregated.totalCostUSD.toFixed(2)}
              </div>
              <span className="summary-sub">Authoritative provider telemetry</span>
            </div>

            <div className="agents-usage-summary-card">
              <span className="summary-label">Collector Health</span>
              <div className="summary-value">
                <span className={`status-pill pill-${snapshot.aggregated.status}`}>
                  {snapshot.aggregated.status === 'ok' ? 'Healthy' : snapshot.aggregated.status.toUpperCase()}
                </span>
              </div>
              <span className="summary-sub">Lightweight local read-only</span>
            </div>
          </div>

          {/* Provider summaries */}
          <div className="agents-usage-providers-section">
            <h3 className="section-title">Providers Overview</h3>
            <div className="agents-usage-providers-grid">
              {snapshot.providers.map((p) => (
                <div key={p.provider} className={`provider-card provider-${p.provider.toLowerCase()}`}>
                  <div className="provider-header">
                    <span className="provider-name">{p.provider}</span>
                    <span className={`provider-status status-${p.status}`}>{p.status}</span>
                  </div>
                  <div className="provider-metrics">
                    <div className="provider-metric">
                      <span className="metric-label">Profiles:</span>
                      <span className="metric-val">{p.availableCount} / {p.profileCount}</span>
                    </div>
                    <div className="provider-metric">
                      <span className="metric-label">Tokens:</span>
                      <span className="metric-val">{formatTokens(p.totalTokens)}</span>
                    </div>
                    <div className="provider-metric">
                      <span className="metric-label">Cost:</span>
                      <span className="metric-val">
                        {p.totalCostUSD !== undefined ? `$${p.totalCostUSD.toFixed(2)}` : 'Unsupported'}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
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

          {/* Profile Cards */}
          <div className="agents-usage-profiles-list">
            {profiles.length === 0 ? (
              <div className="agents-usage-empty">No agent profiles match current filter.</div>
            ) : (
              profiles.map((profile) => (
                <ProfileUsageCard key={profile.profileId} profile={profile} />
              ))
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

      {profile.availabilityMessage && profile.availability !== 'available' && (
        <div className="profile-card-notice">{profile.availabilityMessage}</div>
      )}

      <div className="profile-utilization-row">
        {/* 5-Hour Utilization */}
        <div className="utilization-col">
          <div className="utilization-header">
            <span className="utilization-title">5-Hour Quota</span>
            {renderWindowBadge(profile.fiveHourUtilization)}
          </div>
          {renderProgressBar(profile.fiveHourUtilization)}
        </div>

        {/* Weekly Utilization */}
        <div className="utilization-col">
          <div className="utilization-header">
            <span className="utilization-title">Weekly Quota</span>
            {renderWindowBadge(profile.weeklyUtilization)}
          </div>
          {renderProgressBar(profile.weeklyUtilization)}
        </div>
      </div>

      <div className="profile-metrics-footer">
        <div className="metric-group">
          <span className="metric-group-title">Tokens</span>
          {renderTokenMetrics(profile.tokens)}
        </div>
        <div className="metric-group">
          <span className="metric-group-title">Cost</span>
          {renderCostMetrics(profile.cost, profile.credits)}
        </div>
      </div>
    </div>
  );
}

function renderWindowBadge(w: WindowUtilization): JSX.Element {
  if (w.status === 'available' || w.status === 'zero') {
    const pct = w.usedPercent !== undefined ? Math.round(w.usedPercent) : 0;
    const reset = formatReset(w);
    return (
      <span className="utilization-stat">
        <strong>{pct}%</strong> used {reset ? `(${reset})` : ''}
      </span>
    );
  }
  if (w.status === 'unavailable') {
    return <span className="utilization-stat stat-dim">Telemetry unavailable</span>;
  }
  if (w.status === 'unsupported') {
    return <span className="utilization-stat stat-dim">Unsupported metric</span>;
  }
  return <span className="utilization-stat stat-error">Error</span>;
}

function renderProgressBar(w: WindowUtilization): JSX.Element {
  if (w.status === 'available' || w.status === 'zero') {
    const pct = Math.min(100, Math.max(0, w.usedPercent ?? 0));
    const isHigh = pct >= 80;
    const isMedium = pct >= 50 && pct < 80;
    return (
      <div className="quota-bar-track">
        <div
          className={`quota-bar-fill ${isHigh ? 'fill-high' : isMedium ? 'fill-medium' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    );
  }
  if (w.status === 'unavailable') {
    return (
      <div className="quota-bar-track track-unavailable" title="Telemetry not reported by agent runtime">
        <span className="track-dim-label">Telemetry unavailable</span>
      </div>
    );
  }
  return (
    <div className="quota-bar-track track-unsupported" title="Provider does not publish window quota telemetry">
      <span className="track-dim-label">Unsupported by provider</span>
    </div>
  );
}

function renderTokenMetrics(tokens: TokenUsageMetrics): JSX.Element {
  if (tokens.status === 'available' || tokens.status === 'zero') {
    return (
      <div className="metric-items">
        <span className="metric-detail" title={formatExactNumber(tokens.totalTokens)}>
          Total: <strong>{formatTokens(tokens.totalTokens)}</strong>
        </span>
        {tokens.inputTokens !== undefined && (
          <span className="metric-detail-dim" title={formatExactNumber(tokens.inputTokens)}>
            In: {formatTokens(tokens.inputTokens)}
          </span>
        )}
        {tokens.outputTokens !== undefined && (
          <span className="metric-detail-dim" title={formatExactNumber(tokens.outputTokens)}>
            Out: {formatTokens(tokens.outputTokens)}
          </span>
        )}
        {tokens.cachedInputTokens !== undefined && tokens.cachedInputTokens > 0 && (
          <span className="metric-detail-dim" title={formatExactNumber(tokens.cachedInputTokens)}>
            Cache: {formatTokens(tokens.cachedInputTokens)}
          </span>
        )}
      </div>
    );
  }
  if (tokens.status === 'unavailable') {
    return <span className="metric-status-dim">Telemetry unavailable</span>;
  }
  return <span className="metric-status-dim">Unsupported metric</span>;
}

function renderCostMetrics(
  cost: CostMetrics,
  credits?: { hasCredits: boolean; balance?: string; unlimited?: boolean },
): JSX.Element {
  if (cost.status === 'available' || cost.status === 'zero') {
    return (
      <div className="metric-items">
        <span className="metric-detail">
          <strong>${(cost.amount ?? 0).toFixed(2)}</strong> {cost.currency || 'USD'}
        </span>
        {credits?.hasCredits && (
          <span className="metric-detail-dim">
            Credits: {credits.unlimited ? 'Unlimited' : credits.balance || 'Active'}
          </span>
        )}
      </div>
    );
  }
  if (credits?.hasCredits) {
    return (
      <span className="metric-detail">
        Credits: <strong>{credits.unlimited ? 'Unlimited' : credits.balance || 'Active'}</strong>
      </span>
    );
  }
  if (cost.status === 'unsupported') {
    return <span className="metric-status-dim">Unsupported by provider</span>;
  }
  return <span className="metric-status-dim">Cost unavailable</span>;
}

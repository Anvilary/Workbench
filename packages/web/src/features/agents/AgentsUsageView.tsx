/**
 * Agents Usage view component for Workbench Settings.
 *
 * Implements compact, read-only monitoring of coding agent profiles (Codex, AGY, Claude)
 * with visible 5-hour and weekly quota progress bars, localized labels, accurate reset
 * countdowns, manual refresh, and 5-minute automatic refresh.
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  AgentProfileUsage,
  CostMetrics,
  TokenUsageMetrics,
  WindowUtilization,
} from '@anvilary/workbench-shared';
import { t } from '../../i18n/index.js';
import type { UsageConnectionLike } from './useAgentsUsage.js';
import { useAgentsUsage } from './useAgentsUsage.js';
import {
  computeQuotaDisplay,
  computeQuotaFillClass,
  filterProfiles,
  formatExactNumber,
  formatPath,
  formatReset,
  formatResetCountdown,
  formatTokens,
  getProfileFamily,
} from './usage-format.js';

export {
  computeQuotaDisplay,
  computeQuotaFillClass,
  filterProfiles,
  formatExactNumber,
  formatPath,
  formatReset,
  formatResetCountdown,
  formatTokens,
  getProfileFamily,
};

const COUNTDOWN_TICK_MS = 30_000;

interface AgentsUsageViewProps {
  connection?: UsageConnectionLike;
}

export function AgentsUsageView({ connection }: AgentsUsageViewProps): JSX.Element {
  const { snapshot, loading, refreshing, error, lastUpdatedAt, refresh } = useAgentsUsage(
    connection,
    true,
  );
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Tick displayed countdowns locally without triggering telemetry collection.
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Sync local clock immediately when a fresh snapshot arrives.
  useEffect(() => {
    if (lastUpdatedAt !== null) {
      setNowMs(Date.now());
    }
  }, [lastUpdatedAt]);

  const availableProviders = useMemo(() => {
    const base = ['OpenAI', 'Google', 'Anthropic'];
    if (!snapshot) return base;
    const seen = new Set(base.map((p) => p.toLowerCase()));
    const extra: string[] = [];
    for (const p of snapshot.profiles) {
      const key = p.provider.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        extra.push(p.provider);
      }
    }
    return [...base, ...extra];
  }, [snapshot]);

  const profiles = useMemo(() => {
    if (!snapshot) return [];
    return filterProfiles(snapshot.profiles, providerFilter, searchQuery);
  }, [snapshot, providerFilter, searchQuery]);

  const groupedProfiles = useMemo(() => {
    const families: Array<'Codex' | 'AGY' | 'Claude' | 'Other'> = ['Codex', 'AGY', 'Claude'];
    const groups: Record<
      string,
      { family: string; profiles: AgentProfileUsage[]; totalTokens: number }
    > = {
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
    setCollapsedGroups((prev) => ({
      ...prev,
      [group]: !prev[group],
    }));
  };

  const isBusy = loading || refreshing;
  const rawLastRefresh = snapshot?.aggregated.lastRefresh;
  const parsedSnapshotTs =
    typeof rawLastRefresh === 'number' && Number.isFinite(rawLastRefresh)
      ? rawLastRefresh
      : typeof rawLastRefresh === 'string' && !Number.isNaN(Date.parse(rawLastRefresh))
        ? Date.parse(rawLastRefresh)
        : null;
  const displayedTimestamp = lastUpdatedAt ?? parsedSnapshotTs;
  const formattedLastUpdated = displayedTimestamp
    ? new Date(displayedTimestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <div className="agents-usage-view">
      {/* Compact Usage header */}
      <div className="agents-usage-header">
        <div className="agents-usage-heading">
          <h2 className="agents-usage-title">{t('usage.title')}</h2>
          <p className="agents-usage-subtitle">{t('usage.subtitle')}</p>
        </div>
        <div className="agents-usage-actions">
          <span
            className="agents-usage-last-refresh"
            role="status"
            aria-live="polite"
            title={t('usage.autoRefreshHint')}
          >
            {formattedLastUpdated
              ? t('usage.lastUpdated', { time: formattedLastUpdated })
              : null}
          </span>
          <button
            type="button"
            className="agents-usage-refresh-btn"
            disabled={isBusy}
            aria-busy={isBusy}
            onClick={() => refresh(true)}
          >
            {isBusy && <span className="agents-usage-btn-spinner" aria-hidden="true" />}
            <span>{isBusy ? t('usage.refreshing') : t('usage.refresh')}</span>
          </button>
        </div>
      </div>

      {/* Concise error banner; preserves last snapshot */}
      {error && (
        <div className="agents-usage-banner error" role="alert">
          <span className="agents-usage-banner-icon" aria-hidden="true">!</span>
          <span className="agents-usage-banner-text">{error}</span>
          <button
            type="button"
            className="agents-usage-retry-btn"
            disabled={isBusy}
            onClick={() => refresh(true)}
          >
            {t('usage.retry')}
          </button>
        </div>
      )}

      {/* Initial loading state before first snapshot */}
      {loading && !snapshot && (
        <div className="agents-usage-loading" role="status" aria-live="polite">
          <div className="agents-usage-spinner" aria-hidden="true" />
          <span>{t('usage.collecting')}</span>
        </div>
      )}

      {snapshot && (
        <>
          {/* Compact aggregate summary strip */}
          <div className="agents-usage-summary-grid two-cards">
            <div className="agents-usage-summary-card">
              <span className="summary-label">{t('usage.summary.profiles')}</span>
              <div className="summary-value">
                <span className="value-highlight">{snapshot.aggregated.availableProfiles}</span>
                <span className="value-total"> / {snapshot.aggregated.totalProfiles}</span>
              </div>
              <span className="summary-sub">
                {snapshot.aggregated.missingProfiles > 0
                  ? t('usage.summary.missingProfiles', {
                      count: snapshot.aggregated.missingProfiles,
                    })
                  : t('usage.summary.allDetected')}
              </span>
            </div>

            <div className="agents-usage-summary-card">
              <span className="summary-label">{t('usage.summary.recordedTokens')}</span>
              <div className="summary-value value-highlight">
                {formatTokens(snapshot.aggregated.totalTokens)}
              </div>
              <span
                className="summary-sub"
                title={formatExactNumber(snapshot.aggregated.totalTokens)}
              >
                {snapshot.aggregated.totalTokens > 0
                  ? t('usage.summary.tokensInOut', {
                      input: formatTokens(snapshot.aggregated.totalInputTokens),
                      output: formatTokens(snapshot.aggregated.totalOutputTokens),
                    })
                  : t('usage.summary.noTokenTelemetry')}
              </span>
            </div>
          </div>

          {/* Filter and search toolbar */}
          <div className="agents-usage-filter-bar">
            <div className="filter-tabs" role="tablist" aria-label={t('usage.filterByProvider')}>
              <button
                type="button"
                role="tab"
                aria-selected={providerFilter === 'all'}
                className={`filter-tab ${providerFilter === 'all' ? 'active' : ''}`}
                onClick={() => setProviderFilter('all')}
              >
                {t('usage.filterAll')}
              </button>
              {availableProviders.map((prov) => {
                const active = providerFilter.toLowerCase() === prov.toLowerCase();
                return (
                  <button
                    key={prov}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`filter-tab ${active ? 'active' : ''}`}
                    onClick={() => setProviderFilter(prov.toLowerCase())}
                  >
                    {prov}
                  </button>
                );
              })}
            </div>
            <div className="filter-search">
              <input
                type="search"
                aria-label={t('usage.searchPlaceholder')}
                placeholder={t('usage.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="filter-search-input"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="filter-search-clear"
                  aria-label={t('usage.clearSearch')}
                  onClick={() => setSearchQuery('')}
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {/* Provider groups: expanded by default so quota bars are immediately visible */}
          <div className="agents-usage-profiles-list">
            {groupedProfiles.length === 0 ? (
              <div className="agents-usage-empty">{t('usage.emptyFilter')}</div>
            ) : (
              groupedProfiles.map((group) => {
                const isSearching = searchQuery.trim().length > 0;
                const isExpanded = isSearching ? true : !collapsedGroups[group.family];
                const availableCount = group.profiles.filter(
                  (p) => p.availability === 'available',
                ).length;

                return (
                  <section key={group.family} className="profile-family-group">
                    <button
                      type="button"
                      className="profile-family-header"
                      onClick={() => toggleGroup(group.family)}
                      aria-expanded={isExpanded}
                    >
                      <div className="profile-family-title-group">
                        <span
                          className={`profile-family-chevron ${isExpanded ? 'expanded' : ''}`}
                          aria-hidden="true"
                        >
                          ▶
                        </span>
                        <span>
                          {group.family} ({group.profiles.length})
                        </span>
                      </div>
                      <span className="profile-family-stats">
                        {t('usage.groupStats', {
                          available: availableCount,
                          tokens: formatTokens(group.totalTokens),
                        })}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="profile-family-content">
                        {group.profiles.map((profile) => (
                          <ProfileUsageCard
                            key={profile.profileId}
                            profile={profile}
                            nowMs={nowMs}
                            snapshotTimestamp={displayedTimestamp ?? nowMs}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface ProfileUsageCardProps {
  profile: AgentProfileUsage;
  nowMs: number;
  snapshotTimestamp: number;
}

function ProfileUsageCard({
  profile,
  nowMs,
  snapshotTimestamp,
}: ProfileUsageCardProps): JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const anchorMs = profile.observedAt ?? snapshotTimestamp;

  const availabilityLabel =
    profile.availability === 'available'
      ? t('usage.status.available')
      : profile.availability === 'missing'
        ? t('usage.status.missing')
        : profile.availability === 'unconfigured'
          ? t('usage.status.unconfigured')
          : t('usage.status.error');

  const collectionLabel =
    profile.collectionStatus === 'partial'
      ? t('usage.collection.partial')
      : profile.collectionStatus === 'unavailable'
        ? t('usage.collection.unavailable')
        : profile.collectionStatus === 'error'
          ? t('usage.collection.error')
          : profile.collectionStatus === 'missing'
            ? t('usage.collection.missing')
            : null;

  const showCollectionBadge =
    collectionLabel !== null && profile.collectionStatus !== profile.availability;

  const hasTokenData = Boolean(
    profile.tokens &&
      (profile.tokens.status === 'available' ||
        profile.tokens.status === 'zero' ||
        profile.tokens.status === undefined) &&
      profile.tokens.totalTokens !== undefined,
  );
  const hasCostData = Boolean(
    profile.cost &&
      (profile.cost.status === 'available' ||
        profile.cost.status === 'zero' ||
        profile.cost.status === undefined) &&
      profile.cost.amount !== undefined &&
      profile.cost.amount > 0,
  );

  const showLabel =
    profile.label && profile.label.toLowerCase() !== profile.profileId.toLowerCase();

  return (
    <article className={`profile-usage-card availability-${profile.availability}`}>
      {/* Clean single-line profile header */}
      <div className="profile-card-header">
        <div className="profile-card-identity">
          <span className="profile-id">{profile.profileId}</span>
          {showLabel && (
            <>
              <span className="profile-sep" aria-hidden="true">·</span>
              <span className="profile-label">{profile.label}</span>
            </>
          )}
          <span className="profile-sep" aria-hidden="true">·</span>
          <span className={`profile-provider provider-${profile.provider.toLowerCase()}`}>
            {profile.provider}
          </span>
          {profile.planType && (
            <>
              <span className="profile-sep" aria-hidden="true">·</span>
              <span className="profile-plan">{profile.planType}</span>
            </>
          )}
          {profile.isSharedStorage && (
            <span className="storage-badge" title={t('usage.sharedStorageHint')}>
              {t('usage.sharedStorage')}
            </span>
          )}
        </div>

        <div className="profile-card-badges">
          <span className={`availability-badge badge-${profile.availability}`}>
            {availabilityLabel}
          </span>
          {showCollectionBadge && (
            <span className={`collection-badge badge-${profile.collectionStatus}`}>
              {collectionLabel}
            </span>
          )}
        </div>
      </div>

      {/* Availability or telemetry error message */}
      {profile.collectionError && (
        <div className="profile-card-error" role="status">
          <span className="error-icon" aria-hidden="true">!</span>
          <span>{profile.collectionError}</span>
        </div>
      )}

      {/* Primary quota windows directly beneath the header */}
      <div className="profile-card-quotas">
        <QuotaBar
          label={t('usage.fiveHourUsage')}
          window={profile.fiveHourUtilization}
          nowMs={nowMs}
          anchorMs={anchorMs}
        />
        <QuotaBar
          label={t('usage.weeklyUsage')}
          window={profile.weeklyUtilization}
          nowMs={nowMs}
          anchorMs={anchorMs}
        />
      </div>

      {/* Secondary token, cost, model, and path details in a compact collapsible section */}
      <div className="profile-details-section">
        <button
          type="button"
          className="profile-details-toggle"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <span className="profile-details-toggle-left">
            <span
              className={`profile-details-chevron ${detailsOpen ? 'expanded' : ''}`}
              aria-hidden="true"
            >
              ▶
            </span>
            <span>{t('usage.detailsToggle')}</span>
          </span>
          <span className="profile-details-preview">
            {hasTokenData
              ? t('usage.detailsTokensPreview', {
                  tokens: formatTokens(profile.tokens.totalTokens),
                })
              : t('usage.detailsNoTokens')}
            {hasCostData ? ` · $${(profile.cost.amount ?? 0).toFixed(2)}` : ''}
          </span>
        </button>

        {detailsOpen && (
          <div className="profile-details-body">
            {hasTokenData && <TokenMetricsRow metrics={profile.tokens} />}
            {hasCostData && <CostMetricsRow cost={profile.cost} model={profile.model} />}
            <div className="profile-details-meta">
              <div className="profile-detail-pair">
                <span className="profile-detail-label">{t('usage.modelLabel')}</span>
                <span className="profile-detail-value">
                  {profile.model || <span className="dim">{t('usage.modelDefault')}</span>}
                </span>
              </div>
              <div className="profile-detail-pair profile-detail-path">
                <span className="profile-detail-label">{t('usage.pathLabel')}</span>
                <span className="profile-detail-value mono" title={profile.profileDir}>
                  {formatPath(profile.profileDir)}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

interface QuotaBarProps {
  label: string;
  window: WindowUtilization | undefined;
  nowMs: number;
  anchorMs: number;
}

function QuotaBar({ label, window, nowMs, anchorMs }: QuotaBarProps): JSX.Element {
  const display = computeQuotaDisplay(window);

  if (!display.hasBar) {
    const unavailableText =
      display.reason === 'unsupported'
        ? t('usage.telemetryUnsupported')
        : display.reason === 'error'
          ? t('usage.telemetryError')
          : t('usage.telemetryUnavailable');

    return (
      <div className="quota-bar-item quota-bar-unavailable">
        <div className="quota-bar-label-row">
          <span className="quota-label">{label}</span>
          <span className={`quota-status-text status-${display.reason}`}>{unavailableText}</span>
        </div>
        <div className={`quota-bar-track track-${display.reason}`} aria-hidden="true" />
      </div>
    );
  }

  const fillClass = computeQuotaFillClass(display.usedPercent);
  const resetText = formatResetCountdown(window, {
    nowMs,
    anchorMs,
  });

  const severityLabel =
    display.severity === 'critical'
      ? t('usage.severityCritical')
      : display.severity === 'elevated'
        ? t('usage.severityElevated')
        : null;

  const valueText = t('usage.usedRemaining', {
    used: display.usedPercent,
    remaining: display.remainingPercent,
  });

  return (
    <div className={`quota-bar-item severity-${display.severity}`}>
      <div className="quota-bar-label-row">
        <span className="quota-label">
          {label}
          {severityLabel && (
            <span className={`quota-severity-tag tag-${display.severity}`}>{severityLabel}</span>
          )}
        </span>
        <span className="quota-values">{valueText}</span>
      </div>
      <div
        className="quota-bar-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={display.usedPercent}
        aria-valuetext={`${valueText}. ${resetText}`}
      >
        <div
          className={`quota-bar-fill ${fillClass}`.trim()}
          style={{ width: `${display.usedPercent}%` }}
        />
      </div>
      <div className="quota-reset-row">
        <span className="quota-reset">{resetText}</span>
      </div>
    </div>
  );
}

function TokenMetricsRow({ metrics }: { metrics: TokenUsageMetrics }): JSX.Element {
  return (
    <div className="token-metrics-row">
      <div className="token-stat">
        <span className="token-stat-label">{t('usage.tokens.total')}</span>
        <span className="token-stat-val" title={formatExactNumber(metrics.totalTokens)}>
          {formatTokens(metrics.totalTokens)}
        </span>
      </div>
      <div className="token-stat">
        <span className="token-stat-label">{t('usage.tokens.input')}</span>
        <span className="token-stat-val" title={formatExactNumber(metrics.inputTokens)}>
          {formatTokens(metrics.inputTokens)}
        </span>
      </div>
      <div className="token-stat">
        <span className="token-stat-label">{t('usage.tokens.output')}</span>
        <span className="token-stat-val" title={formatExactNumber(metrics.outputTokens)}>
          {formatTokens(metrics.outputTokens)}
        </span>
      </div>
      {metrics.cachedInputTokens !== undefined && metrics.cachedInputTokens > 0 && (
        <div className="token-stat">
          <span className="token-stat-label">{t('usage.tokens.cached')}</span>
          <span className="token-stat-val" title={formatExactNumber(metrics.cachedInputTokens)}>
            {formatTokens(metrics.cachedInputTokens)}
          </span>
        </div>
      )}
      {metrics.reasoningOutputTokens !== undefined && metrics.reasoningOutputTokens > 0 && (
        <div className="token-stat">
          <span className="token-stat-label">{t('usage.tokens.reasoning')}</span>
          <span className="token-stat-val" title={formatExactNumber(metrics.reasoningOutputTokens)}>
            {formatTokens(metrics.reasoningOutputTokens)}
          </span>
        </div>
      )}
    </div>
  );
}

function CostMetricsRow({
  cost,
  model,
}: {
  cost: CostMetrics;
  model?: string | null;
}): JSX.Element {
  return (
    <div className="cost-metrics-row">
      <span className="profile-detail-label">{t('usage.estimatedCost')}</span>
      <span className="cost-val">${(cost.amount ?? 0).toFixed(2)}</span>
      <span className="cost-currency">{cost.currency || 'USD'}</span>
      {model && <span className="cost-model">({model})</span>}
    </div>
  );
}

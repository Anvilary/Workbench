/**
 * Types and schema for the Agents Usage monitoring system (MAW Settings > Agents Usage).
 *
 * Provides read-only telemetry aggregation across Codex, AGY, and Claude profiles.
 * Distinguishes between zero usage, unavailable telemetry, missing profiles,
 * collection errors, and unsupported metrics.
 */

export type MetricStatus = 'available' | 'zero' | 'unavailable' | 'unsupported' | 'error';

export interface WindowUtilization {
  readonly status: MetricStatus;
  /** Percentage used (0..100) when status is 'available' or 'zero'. */
  readonly usedPercent?: number;
  /** Duration of window in minutes (e.g. 300 for 5 hours, 10080 for weekly). */
  readonly windowMinutes?: number;
  /** Absolute epoch ms when the quota window resets, if reported by telemetry. */
  readonly resetsAt?: number;
  /** Relative seconds until reset, if reported by telemetry. */
  readonly resetsInSeconds?: number;
}

export interface TokenUsageMetrics {
  readonly status: MetricStatus;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly totalTokens?: number;
  readonly reasoningOutputTokens?: number;
}

export interface CostMetrics {
  readonly status: MetricStatus;
  readonly currency?: string;
  readonly amount?: number;
}

export type ProfileAvailability = 'available' | 'missing' | 'unconfigured' | 'error';
export type CollectionStatus = 'healthy' | 'partial' | 'unavailable' | 'missing' | 'error';

export interface AgentProfileUsage {
  readonly profileId: string;
  readonly label: string;
  readonly provider: string;
  readonly model: string | null;
  readonly profileDir: string;
  readonly canonicalDir: string;
  readonly isSharedStorage: boolean;
  readonly sharedWithProfileId?: string;
  readonly availability: ProfileAvailability;
  readonly availabilityMessage?: string;
  readonly collectionStatus: CollectionStatus;
  readonly collectionError?: string;
  readonly observedAt?: number;
  readonly fiveHourUtilization: WindowUtilization;
  readonly weeklyUtilization: WindowUtilization;
  readonly tokens: TokenUsageMetrics;
  readonly cost: CostMetrics;
  readonly planType?: string;
  readonly credits?: {
    readonly hasCredits: boolean;
    readonly balance?: string;
    readonly unlimited?: boolean;
  };
}

export interface ProviderUsageSummary {
  readonly provider: string;
  readonly profileCount: number;
  readonly availableCount: number;
  readonly totalTokens: number;
  readonly totalCostUSD?: number;
  readonly status: 'healthy' | 'degraded' | 'unavailable' | 'missing';
}

export interface AggregatedUsageSummary {
  readonly totalProfiles: number;
  readonly availableProfiles: number;
  readonly missingProfiles: number;
  readonly totalTokens: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCachedTokens: number;
  readonly totalCostUSD: number;
  readonly lastRefresh: number;
  readonly status: 'ok' | 'partial' | 'error';
}

export interface AgentsUsageSnapshot {
  readonly aggregated: AggregatedUsageSummary;
  readonly providers: readonly ProviderUsageSummary[];
  readonly profiles: readonly AgentProfileUsage[];
}

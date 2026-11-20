import type {
  AgentProfileUsage,
  AgentsUsageSnapshot,
  AggregatedUsageSummary,
  ProviderUsageSummary,
} from '@agent-workbench/shared';
import { discoverProfiles, type MonitoredProfileConfig } from './discovery.js';
import { collectCodexUsage } from './codex-collector.js';
import { collectClaudeUsage } from './claude-collector.js';
import { collectAntigravityUsage } from './antigravity-collector.js';

export interface UsageCollectorOptions {
  readonly configs?: readonly MonitoredProfileConfig[];
  readonly cacheTtlMs?: number;
}

export class AgentsUsageCollector {
  private cachedSnapshot: AgentsUsageSnapshot | null = null;
  private cacheExpiresAt = 0;
  private inflight: Promise<AgentsUsageSnapshot> | null = null;

  constructor(private readonly options: UsageCollectorOptions = {}) {}

  /**
   * Retrieves the current usage snapshot across all monitored profiles.
   * Uses cached results within TTL unless forceRefresh is true.
   */
  async getSnapshot(forceRefresh = false): Promise<AgentsUsageSnapshot> {
    const now = Date.now();
    const ttl = this.options.cacheTtlMs ?? 5000;

    if (!forceRefresh && this.cachedSnapshot && now < this.cacheExpiresAt) {
      return this.cachedSnapshot;
    }

    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.collectAll(now).finally(() => {
      this.inflight = null;
    });

    const snapshot = await this.inflight;
    this.cachedSnapshot = snapshot;
    this.cacheExpiresAt = now + ttl;
    return snapshot;
  }

  private async collectAll(timestamp: number): Promise<AgentsUsageSnapshot> {
    const discovered = discoverProfiles(this.options.configs);

    const profilePromises = discovered.map((profile) => {
      try {
        if (profile.profileId.startsWith('codex')) {
          return Promise.resolve(collectCodexUsage(profile));
        } else if (profile.profileId === 'claude-code' || profile.profileId.startsWith('claude')) {
          return Promise.resolve(collectClaudeUsage(profile));
        } else if (profile.profileId.startsWith('agy')) {
          return Promise.resolve(collectAntigravityUsage(profile));
        } else {
          // Fallback based on defaultProvider
          if (profile.defaultProvider === 'OpenAI') return Promise.resolve(collectCodexUsage(profile));
          if (profile.defaultProvider === 'Anthropic') return Promise.resolve(collectClaudeUsage(profile));
          return Promise.resolve(collectAntigravityUsage(profile));
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const fallback: AgentProfileUsage = {
          profileId: profile.profileId,
          label: profile.label,
          provider: profile.defaultProvider,
          model: null,
          profileDir: profile.profileDir,
          canonicalDir: profile.canonicalDir,
          isSharedStorage: profile.isSharedStorage,
          sharedWithProfileId: profile.sharedWithProfileId,
          availability: profile.availability,
          availabilityMessage: profile.availabilityMessage,
          collectionStatus: 'error',
          collectionError: errorMsg,
          fiveHourUtilization: { status: 'error', windowMinutes: 300 },
          weeklyUtilization: { status: 'error', windowMinutes: 10080 },
          tokens: { status: 'error' },
          cost: { status: 'error' },
        };
        return Promise.resolve(fallback);
      }
    });

    const settled = await Promise.allSettled(profilePromises);
    const profiles: AgentProfileUsage[] = settled.map((res, index) => {
      if (res.status === 'fulfilled') return res.value;
      const profile = discovered[index]!;
      return {
        profileId: profile.profileId,
        label: profile.label,
        provider: profile.defaultProvider,
        model: null,
        profileDir: profile.profileDir,
        canonicalDir: profile.canonicalDir,
        isSharedStorage: profile.isSharedStorage,
        sharedWithProfileId: profile.sharedWithProfileId,
        availability: profile.availability,
        availabilityMessage: profile.availabilityMessage,
        collectionStatus: 'error',
        collectionError: res.reason instanceof Error ? res.reason.message : String(res.reason),
        fiveHourUtilization: { status: 'error', windowMinutes: 300 },
        weeklyUtilization: { status: 'error', windowMinutes: 10080 },
        tokens: { status: 'error' },
        cost: { status: 'error' },
      };
    });

    // Providers summary
    const providerMap = new Map<string, {
      profileCount: number;
      availableCount: number;
      totalTokens: number;
      totalCostUSD: number;
      hasError: boolean;
      hasTelemetry: boolean;
    }>();

    let totalTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let totalCostUSD = 0;
    let availableProfiles = 0;
    let missingProfiles = 0;
    let anyError = false;

    for (const p of profiles) {
      if (p.availability === 'available') {
        availableProfiles++;
      } else if (p.availability === 'missing') {
        missingProfiles++;
      }

      if (p.collectionStatus === 'error') {
        anyError = true;
      }

      const provKey = p.provider;
      if (!providerMap.has(provKey)) {
        providerMap.set(provKey, {
          profileCount: 0,
          availableCount: 0,
          totalTokens: 0,
          totalCostUSD: 0,
          hasError: false,
          hasTelemetry: false,
        });
      }

      const provData = providerMap.get(provKey)!;
      provData.profileCount++;
      if (p.availability === 'available') provData.availableCount++;
      if (p.collectionStatus === 'error') provData.hasError = true;

      // Avoid double counting if underlying storage is shared with another profile
      if (!p.isSharedStorage) {
        if (p.tokens.status === 'available' || p.tokens.status === 'zero') {
          provData.hasTelemetry = true;
          const inp = p.tokens.inputTokens ?? 0;
          const out = p.tokens.outputTokens ?? 0;
          const cached = p.tokens.cachedInputTokens ?? 0;
          const tot = p.tokens.totalTokens ?? (inp + out + cached);

          provData.totalTokens += tot;
          totalTokens += tot;
          totalInputTokens += inp;
          totalOutputTokens += out;
          totalCachedTokens += cached;
        }

        if (p.cost.status === 'available' || p.cost.status === 'zero') {
          const c = p.cost.amount ?? 0;
          provData.totalCostUSD += c;
          totalCostUSD += c;
        }
      }
    }

    const providers: ProviderUsageSummary[] = Array.from(providerMap.entries()).map(([provider, data]) => {
      let status: 'healthy' | 'degraded' | 'unavailable' | 'missing';
      if (data.availableCount === 0) {
        status = 'missing';
      } else if (data.hasError) {
        status = 'degraded';
      } else if (data.hasTelemetry) {
        status = 'healthy';
      } else {
        status = 'unavailable';
      }

      return {
        provider,
        profileCount: data.profileCount,
        availableCount: data.availableCount,
        totalTokens: data.totalTokens,
        totalCostUSD: data.totalCostUSD > 0 ? data.totalCostUSD : undefined,
        status,
      };
    });

    const aggregated: AggregatedUsageSummary = {
      totalProfiles: profiles.length,
      availableProfiles,
      missingProfiles,
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCachedTokens,
      totalCostUSD,
      lastRefresh: timestamp,
      status: anyError ? 'partial' : 'ok',
    };

    return {
      aggregated,
      providers,
      profiles,
    };
  }
}

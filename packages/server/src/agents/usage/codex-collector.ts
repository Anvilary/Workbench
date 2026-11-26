import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentProfileUsage,
  CollectionStatus,
  CostMetrics,
  TokenUsageMetrics,
  WindowUtilization,
} from '@anvilary/workbench-shared';
import type { DiscoveredProfile } from './discovery.js';

interface TokenCountPayload {
  info?: {
    total_token_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
      total_tokens?: number;
      reasoning_output_tokens?: number;
    };
    last_token_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cached_input_tokens?: number;
      total_tokens?: number;
      reasoning_output_tokens?: number;
    };
  };
  rate_limits?: {
    primary?: {
      used_percent?: number;
      window_minutes?: number;
      resets_at?: number;
    };
    secondary?: {
      used_percent?: number;
      window_minutes?: number;
      resets_at?: number;
    };
    plan_type?: string;
    credits?: {
      has_credits?: boolean;
      balance?: string;
      unlimited?: boolean;
    };
  };
}

/**
 * Finds the latest rollout-*.jsonl file under `<sessionsDir>/YYYY/MM/DD/`.
 * Inspects directories in descending order so it performs O(1) lookups rather
 * than a recursive scan of thousands of historical files.
 */
export function findLatestRollout(sessionsDir: string): string | null {
  if (!fs.existsSync(sessionsDir)) return null;

  try {
    const years = fs.readdirSync(sessionsDir)
      .filter((y) => /^\d{4}$/.test(y))
      .sort((a, b) => b.localeCompare(a));

    for (const year of years) {
      const yearPath = path.join(sessionsDir, year);
      const months = fs.readdirSync(yearPath)
        .filter((m) => /^\d{2}$/.test(m))
        .sort((a, b) => b.localeCompare(a));

      for (const month of months) {
        const monthPath = path.join(yearPath, month);
        const days = fs.readdirSync(monthPath)
          .filter((d) => /^\d{2}$/.test(d))
          .sort((a, b) => b.localeCompare(a));

        for (const day of days) {
          const dayPath = path.join(monthPath, day);
          const rollouts = fs.readdirSync(dayPath)
            .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
            .sort((a, b) => b.localeCompare(a));

          if (rollouts.length > 0 && rollouts[0]) {
            return path.join(dayPath, rollouts[0]);
          }
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Reads the tail of a file (up to maxBytes) and parses the latest token_count line.
 */
export function parseLatestCodexTelemetry(filePath: string, maxBytes = 64 * 1024): {
  payload: TokenCountPayload | null;
  observedAt: number | null;
} {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return { payload: null, observedAt: null };

    const readSize = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    } finally {
      fs.closeSync(fd);
    }

    const text = buffer.toString('utf8');
    const lines = text.split('\n');

    // Search lines from bottom up
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line || !line.includes('token_count')) continue;

      try {
        const parsed = JSON.parse(line);
        let tokenPayload: TokenCountPayload | null = null;
        let observedAt: number | null = null;

        if (parsed?.type === 'event_msg' && parsed.payload?.type === 'token_count') {
          tokenPayload = parsed.payload as TokenCountPayload;
        } else if (parsed?.type === 'token_count') {
          tokenPayload = (parsed.payload || parsed) as TokenCountPayload;
        }

        if (tokenPayload) {
          if (typeof parsed.timestamp === 'string') {
            const ms = Date.parse(parsed.timestamp);
            if (!Number.isNaN(ms)) observedAt = ms;
          }
          return {
            payload: tokenPayload,
            observedAt,
          };
        }
      } catch {
        // Continue searching previous line
      }
    }
  } catch {
    return { payload: null, observedAt: null };
  }

  return { payload: null, observedAt: null };
}

export function collectCodexUsage(profile: DiscoveredProfile): AgentProfileUsage {
  if (profile.availability === 'missing') {
    return {
      profileId: profile.profileId,
      label: profile.label,
      provider: profile.defaultProvider,
      model: null,
      profileDir: profile.profileDir,
      canonicalDir: profile.canonicalDir,
      isSharedStorage: profile.isSharedStorage,
      sharedWithProfileId: profile.sharedWithProfileId,
      availability: 'missing',
      availabilityMessage: profile.availabilityMessage,
      collectionStatus: 'missing',
      collectionError: profile.availabilityMessage,
      fiveHourUtilization: { status: 'unavailable', windowMinutes: 300 },
      weeklyUtilization: { status: 'unavailable', windowMinutes: 10080 },
      tokens: { status: 'unavailable' },
      cost: { status: 'unsupported' },
    };
  }

  const sessionsDir = path.join(profile.profileDir, 'sessions');
  const latestRollout = findLatestRollout(sessionsDir);

  if (!latestRollout) {
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
      collectionStatus: 'unavailable',
      collectionError: 'No sessions recorded yet',
      fiveHourUtilization: { status: 'unavailable', windowMinutes: 300 },
      weeklyUtilization: { status: 'unavailable', windowMinutes: 10080 },
      tokens: { status: 'unavailable' },
      cost: { status: 'unsupported' },
    };
  }

  const { payload, observedAt } = parseLatestCodexTelemetry(latestRollout);

  if (!payload) {
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
      collectionStatus: 'partial',
      collectionError: 'Rollout found but contains no token_count telemetry',
      observedAt: observedAt ?? undefined,
      fiveHourUtilization: { status: 'unavailable', windowMinutes: 300 },
      weeklyUtilization: { status: 'unavailable', windowMinutes: 10080 },
      tokens: { status: 'unavailable' },
      cost: { status: 'unsupported' },
    };
  }

  // Extract rate limits
  const rateLimits = payload.rate_limits;
  const primary = rateLimits?.primary;
  const secondary = rateLimits?.secondary;

  const fiveHourUtilization: WindowUtilization =
    primary && typeof primary.used_percent === 'number'
      ? {
          status: primary.used_percent === 0 ? 'zero' : 'available',
          usedPercent: primary.used_percent,
          windowMinutes: primary.window_minutes ?? 300,
          resetsAt: primary.resets_at ? primary.resets_at * 1000 : undefined,
          resetsInSeconds: (primary as any).resets_in_seconds ?? (primary.resets_at ? Math.max(0, primary.resets_at - Math.floor(Date.now() / 1000)) : undefined),
        }
      : { status: 'unavailable', windowMinutes: 300 };

  const weeklyUtilization: WindowUtilization =
    secondary && typeof secondary.used_percent === 'number'
      ? {
          status: secondary.used_percent === 0 ? 'zero' : 'available',
          usedPercent: secondary.used_percent,
          windowMinutes: secondary.window_minutes ?? 10080,
          resetsAt: secondary.resets_at ? secondary.resets_at * 1000 : undefined,
          resetsInSeconds: (secondary as any).resets_in_seconds ?? (secondary.resets_at ? Math.max(0, secondary.resets_at - Math.floor(Date.now() / 1000)) : undefined),
        }
      : { status: 'unavailable', windowMinutes: 10080 };

  // Extract token counts
  const rawPayload = payload as Record<string, unknown>;
  const totalUsage =
    payload.info?.total_token_usage ??
    (rawPayload['total_token_usage'] as Record<string, unknown> | undefined) ??
    (typeof rawPayload['input_tokens'] === 'number'
      ? {
          input_tokens: rawPayload['input_tokens'] as number,
          output_tokens: (rawPayload['output_tokens'] as number) ?? 0,
          cached_input_tokens: (rawPayload['cached_tokens'] as number) ?? (rawPayload['cached_input_tokens'] as number) ?? 0,
          total_tokens: (rawPayload['total_tokens'] as number) ?? ((rawPayload['input_tokens'] as number) + ((rawPayload['output_tokens'] as number) ?? 0)),
        }
      : undefined);
  const tokens: TokenUsageMetrics = totalUsage
    ? {
        status: (Number(totalUsage['total_tokens']) || 0) === 0 ? 'zero' : 'available',
        inputTokens: Number(totalUsage['input_tokens']) || 0,
        outputTokens: Number(totalUsage['output_tokens']) || 0,
        cachedInputTokens: Number(totalUsage['cached_input_tokens']) || 0,
        totalTokens: Number(totalUsage['total_tokens']) || 0,
        reasoningOutputTokens: typeof totalUsage['reasoning_output_tokens'] === 'number' ? totalUsage['reasoning_output_tokens'] : undefined,
      }
    : { status: 'unavailable' };

  // Cost: OpenAI CLI does not report USD directly in rollouts, but may report credits
  const credits = rateLimits?.credits ?? (rawPayload['credits'] as { has_credits: boolean; balance?: string; unlimited?: boolean } | undefined);
  const cost: CostMetrics = {
    status: credits?.has_credits ? 'available' : 'unsupported',
    amount: credits?.balance ? parseFloat(credits.balance) : undefined,
    currency: credits?.has_credits ? 'Credits' : undefined,
  };

  const planType = rateLimits?.plan_type ?? (rawPayload['plan_type'] as string | undefined);
  const collectionStatus: CollectionStatus = 'healthy';

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
    collectionStatus,
    observedAt: observedAt ?? undefined,
    fiveHourUtilization,
    weeklyUtilization,
    tokens,
    cost,
    planType,
    credits: credits ? {
      hasCredits: credits.has_credits ?? false,
      balance: credits.balance,
      unlimited: credits.unlimited,
    } : undefined,
  };
}

import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentProfileUsage,
  CollectionStatus,
  CostMetrics,
  TokenUsageMetrics,
  WindowUtilization,
} from '@agent-workbench/shared';
import type { DiscoveredProfile } from './discovery.js';
import { agentStatusDir } from '../paths.js';

interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

interface ClaudeStatsCache {
  version?: number;
  lastComputedDate?: string;
  totalSessions?: number;
  totalMessages?: number;
  modelUsage?: Record<string, ClaudeModelUsage>;
}

interface StatusLineRecord {
  planLimits?: Array<{
    id?: string;
    minutes?: number | null;
    usedPercent?: number | null;
    resetsAt?: number | null;
    observedAt?: number | null;
  }>;
}

export function parseClaudeStatsCache(filePath: string): {
  tokens: TokenUsageMetrics;
  cost: CostMetrics;
  model: string | null;
  observedAt?: number;
} {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        tokens: { status: 'unavailable' },
        cost: { status: 'unavailable' },
        model: null,
      };
    }

    const text = fs.readFileSync(filePath, 'utf8');
    const data: ClaudeStatsCache = JSON.parse(text);

    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;
    let totalCreation = 0;
    let totalCostUSD = 0;
    let topModel: string | null = null;
    let maxModelTokens = 0;

    if (data.modelUsage && typeof data.modelUsage === 'object') {
      for (const [modelName, usage] of Object.entries(data.modelUsage)) {
        const inp = usage.inputTokens ?? 0;
        const out = usage.outputTokens ?? 0;
        const cached = usage.cacheReadInputTokens ?? 0;
        const creation = usage.cacheCreationInputTokens ?? 0;
        const cost = usage.costUSD ?? 0;

        totalInput += inp;
        totalOutput += out;
        totalCached += cached;
        totalCreation += creation;
        totalCostUSD += cost;

        const modelTotal = inp + out + cached + creation;
        if (modelTotal > maxModelTokens) {
          maxModelTokens = modelTotal;
          topModel = modelName;
        }
      }
    }

    const grandTotal = totalInput + totalOutput + totalCached + totalCreation;
    const tokens: TokenUsageMetrics = {
      status: grandTotal === 0 ? 'zero' : 'available',
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedInputTokens: totalCached,
      totalTokens: grandTotal,
    };

    const cost: CostMetrics = {
      status: totalCostUSD === 0 ? 'zero' : 'available',
      currency: 'USD',
      amount: totalCostUSD,
    };

    let observedAt: number | undefined;
    if (data.lastComputedDate) {
      const ms = Date.parse(data.lastComputedDate);
      if (!Number.isNaN(ms)) observedAt = ms;
    }

    return { tokens, cost, model: topModel, observedAt };
  } catch (error) {
    return {
      tokens: { status: 'error' },
      cost: { status: 'error' },
      model: null,
    };
  }
}

/**
 * Checks agent-status/claude-code directory for active plan limits from the statusline script.
 */
export function readClaudeStatusLineLimits(): {
  fiveHour: WindowUtilization;
  weekly: WindowUtilization;
} {
  const dir = agentStatusDir('claude-code');
  if (!fs.existsSync(dir)) {
    return {
      fiveHour: { status: 'unavailable', windowMinutes: 300 },
      weekly: { status: 'unavailable', windowMinutes: 10080 },
    };
  }

  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map((f) => {
        const p = path.join(dir, f);
        return { path: p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0 || !files[0]) {
      return {
        fiveHour: { status: 'unavailable', windowMinutes: 300 },
        weekly: { status: 'unavailable', windowMinutes: 10080 },
      };
    }

    const record: StatusLineRecord = JSON.parse(fs.readFileSync(files[0].path, 'utf8'));
    const windows = record.planLimits || [];

    let fiveHour: WindowUtilization = { status: 'unavailable', windowMinutes: 300 };
    let weekly: WindowUtilization = { status: 'unavailable', windowMinutes: 10080 };

    for (const win of windows) {
      const minutes = win.minutes ?? (win.id?.includes('5h') ? 300 : win.id?.includes('week') ? 10080 : null);
      const used = win.usedPercent;

      if (used !== null && used !== undefined) {
        const util: WindowUtilization = {
          status: used === 0 ? 'zero' : 'available',
          usedPercent: used,
          windowMinutes: minutes ?? undefined,
          resetsAt: win.resetsAt ?? undefined,
        };

        if (minutes === 300 || win.id?.toLowerCase().includes('5h') || win.id?.toLowerCase().includes('five')) {
          fiveHour = util;
        } else if (minutes === 10080 || win.id?.toLowerCase().includes('week') || win.id?.toLowerCase().includes('seven')) {
          weekly = util;
        }
      }
    }

    return { fiveHour, weekly };
  } catch {
    return {
      fiveHour: { status: 'unavailable', windowMinutes: 300 },
      weekly: { status: 'unavailable', windowMinutes: 10080 },
    };
  }
}

export function collectClaudeUsage(profile: DiscoveredProfile): AgentProfileUsage {
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
      cost: { status: 'unavailable' },
    };
  }

  const statsPath = path.join(profile.profileDir, 'stats-cache.json');
  const { tokens, cost, model, observedAt } = parseClaudeStatsCache(statsPath);
  const { fiveHour, weekly } = readClaudeStatusLineLimits();

  const collectionStatus: CollectionStatus =
    tokens.status === 'error' || cost.status === 'error'
      ? 'error'
      : tokens.status === 'available' || tokens.status === 'zero'
        ? 'healthy'
        : 'unavailable';

  return {
    profileId: profile.profileId,
    label: profile.label,
    provider: profile.defaultProvider,
    model,
    profileDir: profile.profileDir,
    canonicalDir: profile.canonicalDir,
    isSharedStorage: profile.isSharedStorage,
    sharedWithProfileId: profile.sharedWithProfileId,
    availability: profile.availability,
    availabilityMessage: profile.availabilityMessage,
    collectionStatus,
    observedAt,
    fiveHourUtilization: fiveHour,
    weeklyUtilization: weekly,
    tokens,
    cost,
  };
}

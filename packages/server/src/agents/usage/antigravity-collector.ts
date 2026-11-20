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
import { agentStatusDir } from '../../shared/app-paths.js';

interface AntigravitySettingsFile {
  model?: string;
  allowNonWorkspaceAccess?: boolean;
}

interface AntigravityStatusRecord {
  current?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  totalInputTokens?: number;
  totalOutputTokens?: number;
  planLimits?: Array<{
    id?: string;
    minutes?: number | null;
    usedPercent?: number | null;
    resetsAt?: number | null;
    observedAt?: number | null;
  }>;
}

/**
 * Infers provider identity from the model string.
 * Antigravity profiles can be configured to use Gemini (Google), Claude (Anthropic), etc.
 */
export function inferAgyProvider(model: string | null, fallback: string): string {
  if (!model) return fallback;
  const lower = model.toLowerCase();
  if (lower.includes('gemini')) return 'Google';
  if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('haiku')) return 'Anthropic';
  if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('codex')) return 'OpenAI';
  return fallback;
}

export function readAgySettings(profileDir: string): {
  model: string | null;
  provider: string;
} {
  let settingsPath = path.join(profileDir, '.gemini/antigravity-cli/settings.json');
  if (!fs.existsSync(settingsPath)) {
    const directPath = path.join(profileDir, 'settings.json');
    if (fs.existsSync(directPath)) {
      settingsPath = directPath;
    } else {
      return { model: null, provider: 'Google' };
    }
  }

  try {
    const content = fs.readFileSync(settingsPath, 'utf8');
    const parsed: AntigravitySettingsFile = JSON.parse(content);
    const model = parsed.model && parsed.model.trim().length > 0 ? parsed.model.trim() : null;
    const provider = inferAgyProvider(model, 'Google');
    return { model, provider };
  } catch {
    return { model: null, provider: 'Google' };
  }
}

/**
 * Checks agent-status/antigravity directory for active statusline records.
 */
export function readAgyStatusLine(): {
  fiveHour: WindowUtilization;
  weekly: WindowUtilization;
  tokens: TokenUsageMetrics | null;
  observedAt?: number;
} {
  const dir = agentStatusDir('antigravity');
  if (!fs.existsSync(dir)) {
    return {
      fiveHour: { status: 'unavailable', windowMinutes: 300 },
      weekly: { status: 'unavailable', windowMinutes: 10080 },
      tokens: null,
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
        tokens: null,
      };
    }

    const record: AntigravityStatusRecord = JSON.parse(fs.readFileSync(files[0].path, 'utf8'));
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

    let tokens: TokenUsageMetrics | null = null;
    const inp = record.totalInputTokens ?? record.current?.inputTokens;
    const out = record.totalOutputTokens ?? record.current?.outputTokens;
    const cached = record.current?.cacheReadInputTokens ?? 0;

    if (inp !== undefined || out !== undefined) {
      const total = (inp ?? 0) + (out ?? 0) + cached;
      tokens = {
        status: total === 0 ? 'zero' : 'available',
        inputTokens: inp ?? 0,
        outputTokens: out ?? 0,
        cachedInputTokens: cached,
        totalTokens: total,
      };
    }

    return { fiveHour, weekly, tokens, observedAt: files[0].mtime };
  } catch {
    return {
      fiveHour: { status: 'unavailable', windowMinutes: 300 },
      weekly: { status: 'unavailable', windowMinutes: 10080 },
      tokens: null,
    };
  }
}

/**
 * Searches the brain directory for the newest conversation transcript step with token counts.
 */
export function readLatestBrainTranscriptTokens(profileDir: string): {
  tokens: TokenUsageMetrics;
  observedAt?: number;
} {
  const brainDir = path.join(profileDir, '.gemini/antigravity-cli/brain');
  if (!fs.existsSync(brainDir)) {
    return { tokens: { status: 'unavailable' } };
  }

  try {
    const convs = fs.readdirSync(brainDir)
      .map((name) => {
        const p = path.join(brainDir, name);
        try {
          return { path: p, mtime: fs.statSync(p).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((c): c is { path: string; mtime: number } => c !== null)
      .sort((a, b) => b.mtime - a.mtime);

    for (const conv of convs.slice(0, 5)) {
      const logFile = path.join(conv.path, '.system_generated/logs/transcript.jsonl');
      if (!fs.existsSync(logFile)) continue;

      const stat = fs.statSync(logFile);
      if (stat.size === 0) continue;

      const readSize = Math.min(stat.size, 32 * 1024);
      const buffer = Buffer.alloc(readSize);
      const fd = fs.openSync(logFile, 'r');
      try {
        fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
      } finally {
        fs.closeSync(fd);
      }

      const lines = buffer.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line || !line.includes('input_tokens')) continue;

        try {
          const step = JSON.parse(line);
          const inp = step.input_tokens;
          const out = step.output_tokens;
          const cached = step.cache_read_tokens ?? 0;

          if (typeof inp === 'number' || typeof out === 'number') {
            const total = (inp ?? 0) + (out ?? 0) + cached;
            let observedAt: number | undefined;
            if (typeof step.created_at === 'string') {
              const ms = Date.parse(step.created_at);
              if (!Number.isNaN(ms)) observedAt = ms;
            }
            return {
              tokens: {
                status: total === 0 ? 'zero' : 'available',
                inputTokens: inp ?? 0,
                outputTokens: out ?? 0,
                cachedInputTokens: cached,
                totalTokens: total,
              },
              observedAt,
            };
          }
        } catch {
          // Continue searching earlier line
        }
      }
    }
  } catch {
    // Return unavailable on error
  }

  return { tokens: { status: 'unavailable' } };
}

export function collectAntigravityUsage(profile: DiscoveredProfile): AgentProfileUsage {
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

  const { model, provider } = readAgySettings(profile.profileDir);
  const statusLine = readAgyStatusLine();

  let tokens = statusLine.tokens;
  let observedAt = statusLine.observedAt;

  if (!tokens || tokens.status === 'unavailable') {
    const brainTokens = readLatestBrainTranscriptTokens(profile.profileDir);
    tokens = brainTokens.tokens;
    if (brainTokens.observedAt) observedAt = brainTokens.observedAt;
  }

  // Cost: Antigravity CLI does not expose cost metrics
  const cost: CostMetrics = { status: 'unsupported' };

  const collectionStatus: CollectionStatus =
    tokens && (tokens.status === 'available' || tokens.status === 'zero')
      ? 'healthy'
      : statusLine.fiveHour.status === 'available' || statusLine.weekly.status === 'available'
        ? 'partial'
        : 'unavailable';

  return {
    profileId: profile.profileId,
    label: profile.label,
    provider,
    model,
    profileDir: profile.profileDir,
    canonicalDir: profile.canonicalDir,
    isSharedStorage: profile.isSharedStorage,
    sharedWithProfileId: profile.sharedWithProfileId,
    availability: profile.availability,
    availabilityMessage: profile.availabilityMessage,
    collectionStatus,
    observedAt,
    fiveHourUtilization: statusLine.fiveHour,
    weeklyUtilization: statusLine.weekly,
    tokens: tokens || { status: 'unavailable' },
    cost,
  };
}

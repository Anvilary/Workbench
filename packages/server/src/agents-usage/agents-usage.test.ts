import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProfiles, type MonitoredProfileConfig } from './discovery.js';
import { collectCodexUsage } from './codex-collector.js';
import { collectClaudeUsage } from './claude-collector.js';
import { collectAntigravityUsage } from './antigravity-collector.js';
import { AgentsUsageCollector } from './collector.js';

describe('Agents Usage Backend', () => {
  describe('Profile Discovery & Provider Mapping', () => {
    it('discovers all 12 default monitored profiles', async () => {
      const profiles = await discoverProfiles();
      assert.equal(profiles.length, 12, 'Must discover all 12 monitored profiles');

      const ids = profiles.map((p) => p.profileId);
      assert.ok(ids.includes('codex-0'));
      assert.ok(ids.includes('codex-1'));
      assert.ok(ids.includes('codex-2'));
      for (let i = 0; i <= 7; i++) {
        assert.ok(ids.includes(`agy0${i}`));
      }
      assert.ok(ids.includes('claude-code'));
    });

    it('correctly maps providers according to configurations', async () => {
      const profiles = await discoverProfiles();
      const codexProfiles = profiles.filter((p) => p.profileId.startsWith('codex'));
      for (const p of codexProfiles) {
        assert.equal(p.provider, 'OpenAI', `Codex profile ${p.profileId} must map to OpenAI`);
      }

      const claudeProfile = profiles.find((p) => p.profileId === 'claude-code');
      assert.ok(claudeProfile);
      assert.equal(claudeProfile.provider, 'Anthropic', 'Claude code must map to Anthropic');

      const agy-7 = profiles.find((p) => p.profileId === 'agy-7');
      assert.ok(agy-7);
      // agy-7 uses Claude Sonnet in local config, or Anthropic/Google provider
      assert.ok(['Anthropic', 'Google'].includes(agy-7.provider));
    });

    it('identifies missing profile directories gracefully', async () => {
      const missingConfig: MonitoredProfileConfig[] = [
        {
          profileId: 'nonexistent-profile',
          label: 'Non-existent Agent',
          agentType: 'codex',
          provider: 'OpenAI',
          profileDir: join(tmpdir(), 'nonexistent-dir-for-maw-test-' + Date.now()),
        },
      ];

      const profiles = await discoverProfiles(missingConfig);
      assert.equal(profiles.length, 1);
      assert.equal(profiles[0]!.availability, 'missing');
      assert.equal(profiles[0]!.isSharedStorage, false);
    });

    it('detects shared canonical storage between profiles', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'maw-shared-'));
      try {
        const configs: MonitoredProfileConfig[] = [
          {
            profileId: 'agent-primary',
            label: 'Primary Agent',
            agentType: 'antigravity',
            provider: 'Google',
            profileDir: tempDir,
          },
          {
            profileId: 'agent-secondary',
            label: 'Secondary Agent',
            agentType: 'antigravity',
            provider: 'Google',
            profileDir: tempDir,
          },
        ];

        const profiles = await discoverProfiles(configs);
        assert.equal(profiles.length, 2);
        assert.equal(profiles[0]!.isSharedStorage, false);
        assert.equal(profiles[1]!.isSharedStorage, true);
        assert.equal(profiles[1]!.sharedWithProfileId, 'agent-primary');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Telemetry Parsing: Codex', () => {
    it('parses rollout tokens, rate limits, and plan type', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'maw-codex-test-'));
      try {
        const sessionsDir = join(tempDir, 'sessions', '2026', '11', '09');
        await mkdir(sessionsDir, { recursive: true });

        const rolloutFile = join(sessionsDir, 'rollout-2026-11-09T08-00-00-001Z.jsonl');
        const sessionMeta = JSON.stringify({
          type: 'session_meta',
          payload: { plan_type: 'pro', credits: { has_credits: true, balance: '$120.00' } },
        });
        const tokenCount = JSON.stringify({
          type: 'token_count',
          payload: {
            input_tokens: 1500,
            output_tokens: 350,
            cached_tokens: 600,
            rate_limits: {
              primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 7200 },
              secondary: { used_percent: 91.0, window_minutes: 10080, resets_in_seconds: 144000 },
              plan_type: 'pro',
              credits: { has_credits: true, balance: '$120.00' },
            },
          },
        });

        await writeFile(rolloutFile, `${sessionMeta}\n${tokenCount}\n`);

        const usage = await collectCodexUsage({
          profileId: 'codex-test',
          label: 'Test Codex',
          defaultProvider: 'OpenAI',
          provider: 'OpenAI',
          binaryName: 'codex',
          executablePath: null,
          profileDir: tempDir,
          canonicalDir: tempDir,
          availability: 'available',
          isSharedStorage: false,
        });

        assert.equal(usage.collectionStatus, 'healthy');
        assert.equal(usage.planType, 'pro');
        assert.equal(usage.credits?.hasCredits, true);
        assert.equal(usage.credits?.balance, '$120.00');

        assert.equal(usage.fiveHourUtilization.status, 'available');
        assert.equal(usage.fiveHourUtilization.usedPercent, 42.5);
        assert.equal(usage.fiveHourUtilization.windowMinutes, 300);
        assert.equal(usage.fiveHourUtilization.resetsInSeconds, 7200);

        assert.equal(usage.weeklyUtilization.status, 'available');
        assert.equal(usage.weeklyUtilization.usedPercent, 91.0);
        assert.equal(usage.weeklyUtilization.windowMinutes, 10080);

        assert.equal(usage.tokens.status, 'available');
        assert.equal(usage.tokens.inputTokens, 1500);
        assert.equal(usage.tokens.outputTokens, 350);
        assert.equal(usage.tokens.cachedInputTokens, 600);
        assert.equal(usage.tokens.totalTokens, 1850);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('distinguishes between zero tokens and unavailable telemetry', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'maw-codex-empty-'));
      try {
        const usage = await collectCodexUsage({
          profileId: 'codex-empty',
          label: 'Empty Codex',
          defaultProvider: 'OpenAI',
          provider: 'OpenAI',
          binaryName: 'codex',
          executablePath: null,
          profileDir: tempDir,
          canonicalDir: tempDir,
          availability: 'available',
          isSharedStorage: false,
        });

        assert.equal(usage.tokens.status, 'unavailable');
        assert.equal(usage.fiveHourUtilization.status, 'unavailable');
        assert.equal(usage.weeklyUtilization.status, 'unavailable');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Telemetry Parsing: Claude', () => {
    it('parses stats-cache.json model usage and costs', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'maw-claude-test-'));
      try {
        const statsFile = join(tempDir, 'stats-cache.json');
        await writeFile(
          statsFile,
          JSON.stringify({
            modelUsage: {
              'claude-3-7-sonnet': {
                inputTokens: 10000,
                outputTokens: 2500,
                cacheReadInputTokens: 4000,
                costUSD: 0.15,
              },
              'claude-opus-4': {
                inputTokens: 5000,
                outputTokens: 1000,
                cacheReadInputTokens: 0,
                costUSD: 0.25,
              },
            },
          }),
        );

        const usage = await collectClaudeUsage({
          profileId: 'claude-test',
          label: 'Test Claude',
          defaultProvider: 'Anthropic',
          provider: 'Anthropic',
          binaryName: 'claude',
          executablePath: null,
          profileDir: tempDir,
          canonicalDir: tempDir,
          availability: 'available',
          isSharedStorage: false,
        });

        assert.equal(usage.collectionStatus, 'healthy');
        assert.equal(usage.tokens.status, 'available');
        assert.equal(usage.tokens.inputTokens, 15000);
        assert.equal(usage.tokens.outputTokens, 3500);
        assert.equal(usage.tokens.cachedInputTokens, 4000);
        assert.equal(usage.tokens.totalTokens, 22500);

        assert.equal(usage.cost.status, 'available');
        assert.equal(usage.cost.currency, 'USD');
        assert.equal(Number(usage.cost.amount?.toFixed(2)), 0.4);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('marks cost as unavailable when costUSD is missing rather than fabricating zero', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'maw-claude-test-missing-cost-'));
      try {
        const statsFile = join(tempDir, 'stats-cache.json');
        await writeFile(
          statsFile,
          JSON.stringify({
            modelUsage: {
              'claude-sonnet-4-6': {
                inputTokens: 5000,
                outputTokens: 1000,
              },
            },
          }),
        );

        const usage = await collectClaudeUsage({
          profileId: 'claude-test',
          label: 'Test Claude',
          defaultProvider: 'Anthropic',
          provider: 'Anthropic',
          binaryName: 'claude',
          executablePath: null,
          profileDir: tempDir,
          canonicalDir: tempDir,
          availability: 'available',
          isSharedStorage: false,
        });

        assert.equal(usage.tokens.status, 'available');
        assert.equal(usage.tokens.totalTokens, 6000);
        assert.equal(usage.cost.status, 'unavailable', 'Missing costUSD must be marked unavailable');
        assert.equal(usage.cost.amount, undefined);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('records zero cost when costUSD is explicitly 0 from local subscription cache', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'maw-claude-test-zero-cost-'));
      try {
        const statsFile = join(tempDir, 'stats-cache.json');
        await writeFile(
          statsFile,
          JSON.stringify({
            modelUsage: {
              'claude-sonnet-4-6': {
                inputTokens: 5000,
                outputTokens: 1000,
                costUSD: 0,
              },
            },
          }),
        );

        const usage = await collectClaudeUsage({
          profileId: 'claude-test',
          label: 'Test Claude',
          defaultProvider: 'Anthropic',
          provider: 'Anthropic',
          binaryName: 'claude',
          executablePath: null,
          profileDir: tempDir,
          canonicalDir: tempDir,
          availability: 'available',
          isSharedStorage: false,
        });

        assert.equal(usage.tokens.status, 'available');
        assert.equal(usage.cost.status, 'zero', 'Explicit costUSD: 0 must be marked zero');
        assert.equal(usage.cost.amount, 0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Telemetry Parsing: Antigravity', () => {
    it('marks cost as unsupported for Antigravity profiles', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'maw-agy-test-'));
      try {
        const settingsFile = join(tempDir, 'settings.json');
        await writeFile(settingsFile, JSON.stringify({ model: 'gemini-2.5-pro' }));

        const usage = await collectAntigravityUsage({
          profileId: 'agy-test',
          label: 'Test AGY',
          defaultProvider: 'Google',
          provider: 'Google',
          binaryName: 'agy',
          executablePath: null,
          profileDir: tempDir,
          canonicalDir: tempDir,
          availability: 'available',
          isSharedStorage: false,
        });

        assert.equal(usage.cost.status, 'unsupported', 'AGY cost must be marked as unsupported');
        assert.equal(usage.cost.amount, undefined);
        assert.equal(usage.model, 'gemini-2.5-pro');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Aggregation & Security Guarantees', () => {
    it('aggregates multiple profiles correctly without double-counting shared storage', async () => {
      const tempDirA = await mkdtemp(join(tmpdir(), 'maw-agg-a-'));
      const tempDirB = await mkdtemp(join(tmpdir(), 'maw-agg-b-'));
      try {
        const statsFileA = join(tempDirA, 'stats-cache.json');
        await writeFile(
          statsFileA,
          JSON.stringify({
            modelUsage: {
              'model-1': { inputTokens: 1000, outputTokens: 200, costUSD: 0.05 },
            },
          }),
        );

        const configs: MonitoredProfileConfig[] = [
          {
            profileId: 'p1',
            label: 'Profile 1',
            agentType: 'claude',
            provider: 'Anthropic',
            profileDir: tempDirA,
          },
          {
            profileId: 'p2-shared',
            label: 'Profile 2 Shared',
            agentType: 'claude',
            provider: 'Anthropic',
            profileDir: tempDirA, // Same canonical path
          },
          {
            profileId: 'p3-missing',
            label: 'Profile 3 Missing',
            agentType: 'codex',
            provider: 'OpenAI',
            profileDir: join(tmpdir(), 'does-not-exist-maw-' + Date.now()),
          },
        ];

        const collector = new AgentsUsageCollector({ configs, cacheTtlMs: 0 });
        const snapshot = await collector.getSnapshot(true);

        assert.equal(snapshot.aggregated.totalProfiles, 3);
        assert.equal(snapshot.aggregated.availableProfiles, 2);
        assert.equal(snapshot.aggregated.missingProfiles, 1);

        // Tokens from p1 should be counted, but p2-shared (isSharedStorage = true) must not double count
        assert.equal(snapshot.aggregated.totalTokens, 1200);
        assert.equal(snapshot.aggregated.totalCostUSD, 0.05);

        // Check provider breakdown
        const anthropicSummary = snapshot.providers.find((p) => p.provider === 'Anthropic');
        assert.ok(anthropicSummary);
        assert.equal(anthropicSummary.profileCount, 2);
        assert.equal(anthropicSummary.availableCount, 2);
        assert.equal(anthropicSummary.totalTokens, 1200);
        assert.equal(anthropicSummary.totalCostUSD, 0.05);
      } finally {
        await rm(tempDirA, { recursive: true, force: true });
        await rm(tempDirB, { recursive: true, force: true });
      }
    });

    it('guarantees no authentication secrets or tokens are exposed', async () => {
      const collector = new AgentsUsageCollector({ cacheTtlMs: 0 });
      const snapshot = await collector.getSnapshot(true);

      const serialized = JSON.stringify(snapshot);
      assert.ok(!serialized.includes('sk-'), 'Must never leak OpenAI/Anthropic secret API keys');
      assert.ok(!serialized.includes('Bearer '), 'Must never leak bearer tokens');
      assert.ok(!serialized.includes('auth_token'), 'Must never leak auth tokens');
      assert.ok(!serialized.includes('cookie'), 'Must never leak session cookies');
    });
  });
});

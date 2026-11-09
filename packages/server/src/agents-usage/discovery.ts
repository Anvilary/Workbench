import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProfileAvailability } from '@agent-workbench/shared';

export interface DiscoveredProfile {
  readonly profileId: string;
  readonly label: string;
  readonly provider: string;
  readonly defaultProvider: string;
  readonly binaryName: string;
  readonly executablePath: string | null;
  readonly profileDir: string;
  readonly canonicalDir: string;
  readonly isSharedStorage: boolean;
  readonly sharedWithProfileId?: string;
  readonly availability: ProfileAvailability;
  readonly availabilityMessage?: string;
}

export interface MonitoredProfileConfig {
  readonly profileId: string;
  readonly label: string;
  readonly agentType?: 'codex' | 'antigravity' | 'claude';
  readonly defaultProvider?: string;
  readonly provider?: string;
  readonly binaryName?: string;
  readonly getProfileDir?: () => string;
  readonly profileDir?: string;
}

export function getUserHome(): string {
  const raw = os.homedir();
  const match = raw.match(/^(\/home\/[^/]+)\/\.local\/share\/agy\d+-profile\/home/);
  if (match && match[1]) {
    return match[1];
  }
  return raw;
}

export const MONITORED_PROFILES: readonly MonitoredProfileConfig[] = [
  // Codex
  {
    profileId: 'codex-0',
    label: 'Codex 00',
    defaultProvider: 'OpenAI',
    binaryName: 'codex-0',
    getProfileDir: () => process.env['CODEX_00_HOME'] || path.join(getUserHome(), '.codex-0'),
  },
  {
    profileId: 'codex-1',
    label: 'Codex 01',
    defaultProvider: 'OpenAI',
    binaryName: 'codex-1',
    getProfileDir: () => process.env['CODEX_01_HOME'] || path.join(getUserHome(), '.codex-1'),
  },
  {
    profileId: 'codex-2',
    label: 'Codex 02',
    defaultProvider: 'OpenAI',
    binaryName: 'codex-2',
    getProfileDir: () => process.env['CODEX_02_HOME'] || path.join(getUserHome(), '.codex-2'),
  },

  // AGY
  {
    profileId: 'agy-0',
    label: 'AGY 00',
    defaultProvider: 'Google',
    binaryName: 'agy-0',
    getProfileDir: () => process.env['AGY_00_HOME'] || getUserHome(),
  },
  {
    profileId: 'agy-1',
    label: 'AGY 01',
    defaultProvider: 'Google',
    binaryName: 'agy-1',
    getProfileDir: () => process.env['AGY_01_HOME'] || path.join(getUserHome(), '.local/share/agy-1-profile/home'),
  },
  {
    profileId: 'agy-2',
    label: 'AGY 02',
    defaultProvider: 'Anthropic',
    binaryName: 'agy-2',
    getProfileDir: () => process.env['AGY_02_HOME'] || path.join(getUserHome(), '.local/share/agy-2-profile/home'),
  },
  {
    profileId: 'agy-3',
    label: 'AGY 03',
    defaultProvider: 'Google',
    binaryName: 'agy-3',
    getProfileDir: () => process.env['AGY_03_HOME'] || path.join(getUserHome(), '.local/share/agy-3-profile/home'),
  },
  {
    profileId: 'agy-4',
    label: 'AGY 04',
    defaultProvider: 'Google',
    binaryName: 'agy-4',
    getProfileDir: () => process.env['AGY_04_HOME'] || path.join(getUserHome(), '.local/share/agy-4-profile/home'),
  },
  {
    profileId: 'agy-5',
    label: 'AGY 05',
    defaultProvider: 'Google',
    binaryName: 'agy-5',
    getProfileDir: () => process.env['AGY_05_HOME'] || path.join(getUserHome(), '.local/share/agy-5-profile/home'),
  },
  {
    profileId: 'agy-6',
    label: 'AGY 06',
    defaultProvider: 'Google',
    binaryName: 'agy-6',
    getProfileDir: () => process.env['AGY_06_HOME'] || path.join(getUserHome(), '.local/share/agy-6-profile/home'),
  },
  {
    profileId: 'agy-7',
    label: 'AGY 07',
    defaultProvider: 'Anthropic',
    binaryName: 'agy-7',
    getProfileDir: () => process.env['AGY_07_HOME'] || path.join(getUserHome(), '.local/share/agy-7-profile/home'),
  },

  // Claude
  {
    profileId: 'claude-code',
    label: 'Claude Code',
    defaultProvider: 'Anthropic',
    binaryName: 'claude',
    getProfileDir: () => process.env['CLAUDE_CONFIG_DIR'] || path.join(getUserHome(), '.claude'),
  },
];

function resolveBinary(binaryName: string): string | null {
  // Check standard user bin directory first
  const userBin = path.join(getUserHome(), '.local/bin', binaryName);
  if (fs.existsSync(userBin)) return userBin;

  // Check PATH
  const pathEnv = process.env['PATH'] || '';
  const dirs = pathEnv.split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, binaryName);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore unreadable dirs
    }
  }

  return null;
}

export function discoverProfiles(configs: readonly MonitoredProfileConfig[] = MONITORED_PROFILES): DiscoveredProfile[] {
  const seenCanonical = new Map<string, string>(); // canonical path -> first profileId
  const results: DiscoveredProfile[] = [];

  for (const cfg of configs) {
    const rawDir = cfg.getProfileDir ? cfg.getProfileDir() : (cfg.profileDir ?? '');
    const defaultProvider = cfg.defaultProvider ?? cfg.provider ?? 'Unknown';
    const binaryName = cfg.binaryName ?? cfg.profileId;
    let canonicalDir = rawDir;
    let exists = false;
    let isDir = false;

    try {
      if (fs.existsSync(rawDir)) {
        exists = true;
        const stats = fs.statSync(rawDir);
        isDir = stats.isDirectory();
        canonicalDir = fs.realpathSync(rawDir);
      }
    } catch {
      exists = false;
    }

    const execPath = resolveBinary(binaryName);

    let availability: ProfileAvailability = 'available';
    let availabilityMessage: string | undefined;

    if (!exists) {
      availability = 'missing';
      availabilityMessage = `Profile directory not found: ${rawDir}`;
    } else if (!isDir) {
      availability = 'error';
      availabilityMessage = `Profile path is not a directory: ${rawDir}`;
    } else {
      availability = 'available';
      if (!execPath) {
        availabilityMessage = `CLI binary not found on standard PATH: ${binaryName}`;
      }
    }

    let isSharedStorage = false;
    let sharedWithProfileId: string | undefined;

    if (exists && isDir) {
      const prior = seenCanonical.get(canonicalDir);
      if (prior !== undefined && prior !== cfg.profileId) {
        isSharedStorage = true;
        sharedWithProfileId = prior;
      } else {
        seenCanonical.set(canonicalDir, cfg.profileId);
      }
    }

    results.push({
      profileId: cfg.profileId,
      label: cfg.label,
      provider: defaultProvider,
      defaultProvider,
      binaryName,
      executablePath: execPath,
      profileDir: rawDir,
      canonicalDir,
      isSharedStorage,
      sharedWithProfileId,
      availability,
      availabilityMessage,
    });
  }

  return results;
}

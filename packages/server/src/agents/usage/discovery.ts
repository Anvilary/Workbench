import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProfileAvailability } from '@anvilary/workbench-shared';

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

/**
 * The real user home. When the server itself runs inside an AGY multi-account
 * profile (HOME set to `<home>/.local/share/agy<suffix>-profile/home`), climb
 * back out of it so every account is discovered from the same root.
 */
export function getUserHome(raw: string = os.homedir()): string {
  const match = raw.match(/^(.+?)\/\.local\/share\/[^/]+-profile\/home\/?$/);
  if (match && match[1]) {
    return match[1];
  }
  return raw;
}

export interface DiscoveryOptions {
  /** Real user home; defaults to `getUserHome()`. */
  readonly home?: string;
  /** Environment for CODEX_HOME, CLAUDE_CONFIG_DIR and PATH; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Locates a CLI command; defaults to `~/.local/bin` then PATH. */
  readonly which?: (binaryName: string) => string | null;
}

/** Suffix of an additional account directory, e.g. `00`, `work`, `-personal`. */
const ACCOUNT_SUFFIX = /^[-_]?([A-Za-z0-9][A-Za-z0-9_-]{0,31})$/;
const CODEX_ACCOUNT_MARKERS = ['auth.json', 'config.toml'];

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function listEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function accountSuffix(rest: string): string | null {
  const match = rest.match(ACCOUNT_SUFFIX);
  return match && match[1] ? match[1] : null;
}

/**
 * Additional Codex accounts: `~/.codex<suffix>` directories that hold Codex
 * auth or config files. Only existing directories are returned.
 */
function discoverCodexAccounts(home: string, standardDir: string): MonitoredProfileConfig[] {
  const result: MonitoredProfileConfig[] = [];
  for (const entry of listEntries(home)) {
    if (!entry.startsWith('.codex')) continue;
    const suffix = accountSuffix(entry.slice('.codex'.length));
    if (suffix === null) continue;
    const dir = path.join(home, entry);
    if (!isDirectory(dir) || sameDirectory(dir, standardDir)) continue;
    if (!CODEX_ACCOUNT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) continue;
    const profileId = 'codex' + entry.slice('.codex'.length);
    result.push({ profileId, label: `Codex ${suffix}`, defaultProvider: 'OpenAI', binaryName: profileId, profileDir: dir });
  }
  return result;
}

/** Additional AGY accounts: existing `~/.local/share/agy<suffix>-profile/home` directories. */
function discoverAgyAccounts(home: string): MonitoredProfileConfig[] {
  const root = path.join(home, '.local', 'share');
  const result: MonitoredProfileConfig[] = [];
  for (const entry of listEntries(root)) {
    if (!entry.startsWith('agy') || !entry.endsWith('-profile')) continue;
    const rest = entry.slice('agy'.length, -'-profile'.length);
    const suffix = accountSuffix(rest);
    if (suffix === null) continue;
    const dir = path.join(root, entry, 'home');
    if (!isDirectory(dir)) continue;
    const profileId = 'agy' + rest;
    result.push({ profileId, label: `AGY ${suffix}`, defaultProvider: 'Google', binaryName: profileId, profileDir: dir });
  }
  return result;
}

/**
 * Profiles to monitor, derived from this machine only:
 *  - one generic default per installed CLI (or existing standard home), using
 *    its standard home: CODEX_HOME or ~/.codex, ~ for AGY (~/.gemini), and
 *    CLAUDE_CONFIG_DIR or ~/.claude;
 *  - additional accounts discovered from existing multi-account directories.
 */
export function defaultMonitoredProfiles(options: DiscoveryOptions = {}): MonitoredProfileConfig[] {
  const env = options.env ?? process.env;
  const home = options.home ?? getUserHome();
  const which = options.which ?? ((name: string) => resolveBinary(name, home, env));

  const codexDir = env['CODEX_HOME'] || path.join(home, '.codex');
  const claudeDir = env['CLAUDE_CONFIG_DIR'] || path.join(home, '.claude');
  const agyMarker = path.join(home, '.gemini', 'antigravity-cli');

  const result: MonitoredProfileConfig[] = [];
  if (which('codex') !== null || isDirectory(codexDir)) {
    result.push({ profileId: 'codex', label: 'Codex', defaultProvider: 'OpenAI', binaryName: 'codex', profileDir: codexDir });
  }
  result.push(...discoverCodexAccounts(home, codexDir));
  if (which('agy') !== null || isDirectory(agyMarker)) {
    result.push({ profileId: 'agy', label: 'AGY', defaultProvider: 'Google', binaryName: 'agy', profileDir: home });
  }
  result.push(...discoverAgyAccounts(home));
  if (which('claude') !== null || isDirectory(claudeDir)) {
    result.push({ profileId: 'claude-code', label: 'Claude Code', defaultProvider: 'Anthropic', binaryName: 'claude', profileDir: claudeDir });
  }
  return result;
}

function resolveBinary(binaryName: string, home: string = getUserHome(), env: NodeJS.ProcessEnv = process.env): string | null {
  // Check standard user bin directory first
  const userBin = path.join(home, '.local/bin', binaryName);
  if (fs.existsSync(userBin)) return userBin;

  // Check PATH
  const pathEnv = env['PATH'] || '';
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

export function discoverProfiles(
  configs: readonly MonitoredProfileConfig[] = defaultMonitoredProfiles(),
  options: DiscoveryOptions = {},
): DiscoveredProfile[] {
  const which = options.which ?? ((name: string) => resolveBinary(name, options.home ?? getUserHome(), options.env ?? process.env));
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

    const execPath = which(binaryName);

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

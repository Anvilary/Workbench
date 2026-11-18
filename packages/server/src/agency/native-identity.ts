import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolveConfiguredExecutable } from '../agents/profiles/executable.js';
import type { CliProvider } from '@agent-workbench/shared';
import type { ProfileDefinition } from '../agents/profiles/definition.js';

export interface NativeIdentity {
  readonly provider: CliProvider;
  readonly home: string;
  readonly bindingId?: string;
}

interface Binding {
  readonly profileId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly environmentOverrides: Readonly<Record<string, string>>;
  readonly identity: NativeIdentity;
  readonly authenticationMode?: 'account';
  readonly artifacts?: readonly { path: string; sha256: string }[];
  readonly launchContext?: Readonly<Record<string, string | null>>;
  readonly commands?: Readonly<Record<string, string>>;
  readonly requiredEnvironment?: readonly string[];
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const sameEnvironment = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]);

const CONTEXT_KEYS = new Set(['HOME', 'USER', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR']);
export async function artifactDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Explicit host attestations, not account guesses from realpath or wrapper names. */
export class NativeIdentities {
  private constructor(private readonly bindings: readonly Binding[]) {}

  static empty(): NativeIdentities { return new NativeIdentities([]); }

  /** Optional recovery attestations must not take down interactive native launch. */
  static async loadForInteractive(file: string): Promise<NativeIdentities> {
    try { return await NativeIdentities.load(file); }
    catch {
      console.warn('[maw] Native identity attestation unavailable; interactive CLI launch remains available, recovery is disabled.');
      return NativeIdentities.empty();
    }
  }

  static async load(file: string): Promise<NativeIdentities> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new NativeIdentities([]);
      throw error;
    }
    if (!record(raw) || ![1, 2].includes(raw.version as number) || !Array.isArray(raw.identities)) {
      throw new Error('Invalid host native identity manifest');
    }
    if (raw.version === 2) {
      const info = await stat(file);
      if ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022)) throw new Error('Native identity manifest must be owned by this user and not writable by others');
    }
    const bindings: Binding[] = [];
    for (const row of raw.identities) {
      if (!record(row) || typeof row.profileId !== 'string' || !(raw.version === 1 ? row.provider === 'codex' : ['codex', 'antigravity', 'claude-code', 'opencode', 'pi'].includes(row.provider as string)) ||
          typeof row.executable !== 'string' || !Array.isArray(row.args) ||
          !row.args.every((arg) => typeof arg === 'string') || !record(row.environmentOverrides) ||
          !Object.values(row.environmentOverrides).every((value) => typeof value === 'string') ||
          typeof row.home !== 'string' || !path.isAbsolute(row.home) ||
          (raw.version === 1 && (await realpath(row.home) !== row.home || !(await stat(row.home)).isDirectory())) ||
          bindings.some((b) => b.profileId === row.profileId)) {
        throw new Error('Invalid or duplicate host native identity binding');
      }
      let verification: Pick<Binding, 'artifacts' | 'launchContext' | 'commands' | 'requiredEnvironment' | 'authenticationMode'> = {};
      if (raw.version === 2) {
        if ((row.provider === 'antigravity' && row.authenticationMode !== 'account') || !Array.isArray(row.artifacts) || row.artifacts.length === 0 || !row.artifacts.every(item => record(item) && typeof item.path === 'string' && path.isAbsolute(item.path) && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)) ||
            !row.artifacts.some(item => record(item) && item.path === row.executable) || !path.isAbsolute(row.executable) ||
            !record(row.launchContext) || typeof row.launchContext.HOME !== 'string' ||
            !Object.entries(row.launchContext).every(([key, value]) => CONTEXT_KEYS.has(key) && (typeof value === 'string' || value === null)) ||
            !record(row.commands) || !Object.entries(row.commands).every(([key, value]) => /^[A-Za-z0-9_.-]+$/.test(key) && typeof value === 'string' && path.isAbsolute(value)) ||
            !Array.isArray(row.requiredEnvironment) || !row.requiredEnvironment.every(key => typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key))) {
          throw new Error('Invalid native execution-context attestation');
        }
        verification = {
          ...(row.provider === 'antigravity' ? { authenticationMode: 'account' as const } : {}),
          artifacts: Object.freeze(row.artifacts.map(item => Object.freeze({ ...item }))) as Binding['artifacts'],
          launchContext: Object.freeze({ ...row.launchContext }) as Binding['launchContext'],
          commands: Object.freeze({ ...row.commands }) as Binding['commands'],
          requiredEnvironment: Object.freeze([...row.requiredEnvironment]) as readonly string[],
        };
      }
      const bindingId = raw.version === 2 ? createHash('sha256').update(JSON.stringify({ profileId: row.profileId, provider: row.provider, executable: row.executable, args: row.args, environmentOverrides: row.environmentOverrides, home: row.home, ...verification })).digest('hex') : undefined;
      bindings.push(Object.freeze({
        profileId: row.profileId, executable: row.executable,
        args: Object.freeze([...row.args] as string[]),
        environmentOverrides: Object.freeze({ ...row.environmentOverrides } as Record<string, string>),
        identity: Object.freeze({ provider: row.provider as CliProvider, home: row.home, ...(bindingId ? { bindingId } : {}) }),
        ...verification,
      }));
    }
    return new NativeIdentities(Object.freeze(bindings));
  }

  forProfile(profile: ProfileDefinition): NativeIdentity | null {
    const binding = this.bindings.find((b) => b.profileId === profile.id);
    return binding && profile.provider === binding.identity.provider &&
      profile.executable === binding.executable &&
      profile.args.length === binding.args.length && profile.args.every((arg, i) => arg === binding.args[i]) &&
      sameEnvironment(profile.environmentOverrides, binding.environmentOverrides) ? binding.identity : null;
  }

  /** Recheck at every launch/capability request, including after a binary upgrade. */
  async verifiedForProfile(profile: ProfileDefinition, environment: NodeJS.ProcessEnv): Promise<NativeIdentity | null> {
    const identity = this.forProfile(profile);
    if (!identity) return null;
    const binding = this.bindings.find(row => row.profileId === profile.id)!;
    try {
      if (await realpath(identity.home) !== identity.home || !(await stat(identity.home)).isDirectory()) return null;
      if (binding.authenticationMode === 'account') {
        let mode: unknown = '';
        try {
          const settingsFile = await realpath(path.join(identity.home, 'settings.json'));
          const relative = path.relative(identity.home, settingsFile);
          if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
          const settings: unknown = JSON.parse(await readFile(settingsFile, 'utf8'));
          if (!record(settings)) return null;
          mode = settings.modelProvider ?? '';
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
        // API-key mode has no established named-account ownership. Never import its secret.
        if (mode !== '') return null;
      }
      for (const [key, value] of Object.entries(binding.launchContext ?? {})) if ((environment[key] ?? null) !== value) return null;
      for (const key of binding.requiredEnvironment ?? []) if (!environment[key]) return null;
      for (const [command, selected] of Object.entries(binding.commands ?? {})) {
        const found = await resolveConfiguredExecutable(command, environment);
        if (found.status !== 'available' || found.file !== selected) return null;
      }
      for (const artifact of binding.artifacts ?? []) if (await artifactDigest(artifact.path) !== artifact.sha256) return null;
      return identity;
    } catch { return null; }
  }

  protectedDirs(): readonly string[] {
    return [...new Set(this.bindings.flatMap(binding => {
      const root = binding.identity.home;
      if (binding.identity.provider !== 'antigravity' || path.basename(root) !== 'antigravity-cli' || path.basename(path.dirname(root)) !== '.gemini') return [root];
      const accountHome = path.dirname(path.dirname(root));
      // Native keyrings/XDG configuration are outside AGY's conversation namespace.
      return [root, path.dirname(root), path.join(accountHome, '.config'), path.join(accountHome, '.local/share/keyrings')];
    }))];
  }
}

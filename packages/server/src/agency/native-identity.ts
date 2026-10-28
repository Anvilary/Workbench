import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CliProvider } from '@agent-workbench/shared';
import type { ProfileDefinition } from '../agents/profiles/definition.js';

export interface NativeIdentity {
  readonly provider: CliProvider;
  readonly home: string;
}

interface Binding {
  readonly profileId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly environmentOverrides: Readonly<Record<string, string>>;
  readonly identity: NativeIdentity;
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const sameEnvironment = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]);

/** Host attestations only: never infer identity from environment or wrapper text. */
export class NativeIdentities {
  private constructor(private readonly bindings: readonly Binding[]) {}

  static async load(file: string): Promise<NativeIdentities> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new NativeIdentities([]);
      throw error;
    }
    if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.identities)) {
      throw new Error('Invalid host native identity manifest');
    }
    const bindings: Binding[] = [];
    for (const row of raw.identities) {
      if (!record(row) || typeof row.profileId !== 'string' || row.provider !== 'codex' ||
          typeof row.executable !== 'string' || !Array.isArray(row.args) ||
          !row.args.every((arg) => typeof arg === 'string') || !record(row.environmentOverrides) ||
          !Object.values(row.environmentOverrides).every((value) => typeof value === 'string') ||
          typeof row.home !== 'string' || !path.isAbsolute(row.home) ||
          await realpath(row.home) !== row.home || !(await stat(row.home)).isDirectory() ||
          bindings.some((b) => b.profileId === row.profileId)) {
        throw new Error('Invalid or duplicate host native identity binding');
      }
      bindings.push(Object.freeze({
        profileId: row.profileId, executable: row.executable,
        args: Object.freeze([...row.args] as string[]),
        environmentOverrides: Object.freeze({ ...row.environmentOverrides } as Record<string, string>),
        identity: Object.freeze({ provider: 'codex' as const, home: row.home }),
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

  protectedDirs(): readonly string[] { return this.bindings.map((b) => b.identity.home); }
}

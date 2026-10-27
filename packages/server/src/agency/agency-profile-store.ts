/**
 * Durable, atomic profile definitions only. No credentials, CLI auth files,
 * process handles, model catalogs or history are ever persisted here.
 * The integration owner chooses a server-owned application data path.
 */
import { copyFile, mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { CliProfileId } from '@agent-workbench/shared';
import {
  applyProfileChanges, defaultDefinitions, validateDefinition,
  type ProfileChanges, type ProfileDefinition,
} from '../agents/profiles/definition.js';

const SCHEMA_VERSION = 1;

export class AgencyProfileStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly filename: string) {
    if (!path.isAbsolute(filename)) throw new Error('Profile store path must be absolute.');
  }

  private decode(text: string): ProfileDefinition[] {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('Invalid Agency profile store.');
    }
    const data = raw as Record<string, unknown>;
    if (data['schemaVersion'] !== SCHEMA_VERSION || !Array.isArray(data['profiles'])) {
      throw new Error('Unsupported Agency profile store version.');
    }
    const defaults = defaultDefinitions();
    const seen = new Set<string>();
    const defined: ProfileDefinition[] = [];
    for (const item of data['profiles']) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error('Invalid profile in store.');
      }
      const id = (item as Record<string, unknown>)['id'];
      if (typeof id !== 'string' || seen.has(id)) throw new Error('Duplicate or invalid profile ID.');
      seen.add(id);
      defined.push(validateDefinition(id, item));
    }
    // Safe additive migration for profiles added to the fixed registry later.
    return defaults.map((item) => defined.find((saved) => saved.id === item.id) ?? item);
  }

  private async readPrimary(): Promise<ProfileDefinition[] | null> {
    let content: string;
    try {
      content = await readFile(this.filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return this.decode(content);
  }

  private async read(): Promise<ProfileDefinition[]> {
    try {
      return (await this.readPrimary()) ?? defaultDefinitions();
    } catch (error) {
      // Only recover malformed content from a prior valid checkpoint. Keep the
      // corrupt file for inspection rather than silently resetting accounts.
      if (!(error instanceof SyntaxError || error instanceof Error &&
            /profile|store|version/i.test(error.message))) throw error;
      let backup: ProfileDefinition[];
      try {
        backup = this.decode(await readFile(this.filename + '.bak', 'utf8'));
      } catch {
        throw new Error('Agency profile store is invalid and no valid backup exists.', { cause: error });
      }
      await rename(this.filename, this.filename + '.corrupt-' + Date.now());
      await this.write(backup, false);
      return backup;
    }
  }

  private async write(definitions: readonly ProfileDefinition[], backup: boolean): Promise<void> {
    const dir = path.dirname(this.filename);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = this.filename + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
    try {
      await writeFile(temp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, profiles: definitions }, null, 2) + '\n', {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      await chmod(temp, 0o600);
      if (backup) {
        try {
          await copyFile(this.filename, this.filename + '.bak');
          await chmod(this.filename + '.bak', 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await rename(temp, this.filename);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(action);
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  listDefinitions(): Promise<readonly ProfileDefinition[]> {
    return this.serialize(() => this.read());
  }

  async getDefinition(id: CliProfileId): Promise<ProfileDefinition | null> {
    const all = await this.listDefinitions();
    return all.find((item) => item.id === id) ?? null;
  }

  configure(id: CliProfileId, changes: ProfileChanges): Promise<ProfileDefinition> {
    return this.serialize(async () => {
      const all = await this.read();
      const index = all.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('Unknown Agency CLI profile.');
      const changed = applyProfileChanges(all[index]!, changes);
      const next = [...all];
      next[index] = changed;
      await this.write(next, true);
      return changed;
    });
  }
}

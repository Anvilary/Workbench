/**
 * Durable, atomic profile definitions only. No credentials, CLI auth files,
 * process handles, model catalogs or history are ever persisted here.
 * The integration owner chooses a server-owned application data path.
 */
import { copyFile, mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { CliProfileId } from '@anvilary/workbench-shared';
import {
  applyProfileChanges, createProfileDefinition, defaultDefinitions,
  installedDefaultDefinitions, identicalLaunchMessage, identicalLaunchPeer, validateDefinition,
  type CreateProfileParams, type ProfileChanges, type ProfileDefinition,
} from '../../agents/profiles/definition.js';

const SCHEMA_VERSION = 1;

class InvalidProfileStoreError extends Error {}

class UnsupportedProfileSchemaError extends Error {
  constructor(version: unknown) {
    super('Unsupported Agency profile store schema version: ' + String(version));
  }
}

export class AgencyProfileStore {
  private pending: Promise<void> = Promise.resolve();

  flush(): Promise<void> { return this.pending; }

  /**
   * `environment` only decides which generic defaults seed a store that does
   * not exist yet (one per CLI installed on its PATH).
   */
  constructor(
    private readonly filename: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    if (!path.isAbsolute(filename)) throw new Error('Profile store path must be absolute.');
  }

  private decode(text: string): ProfileDefinition[] {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new InvalidProfileStoreError('Invalid Agency profile store JSON.', { cause: error });
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new InvalidProfileStoreError('Invalid Agency profile store.');
    }
    const data = raw as Record<string, unknown>;
    // A future version is not corruption. In particular, never replace it
    // with a v1 backup, which would silently discard newer configuration.
    if (data['schemaVersion'] !== SCHEMA_VERSION) {
      throw new UnsupportedProfileSchemaError(data['schemaVersion']);
    }
    if (!Array.isArray(data['profiles'])) {
      throw new InvalidProfileStoreError('Invalid Agency profile list.');
    }
    const seen = new Set<string>();
    const defined: ProfileDefinition[] = [];
    for (const item of data['profiles']) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new InvalidProfileStoreError('Invalid profile in store.');
      }
      const id = (item as Record<string, unknown>)['id'];
      if (typeof id !== 'string' || seen.has(id)) {
        throw new InvalidProfileStoreError('Duplicate or invalid profile ID.');
      }
      seen.add(id);
      try {
        defined.push(validateDefinition(id, item));
      } catch (error) {
        throw new InvalidProfileStoreError('Invalid profile definition.', { cause: error });
      }
    }
    const deleted = Array.isArray(data['deletedProfileIds'])
      ? new Set<string>(data['deletedProfileIds'].filter((x): x is string => typeof x === 'string'))
      : new Set<string>();
    this.deletedProfileIds = deleted;
    // An existing store is authoritative: defaults only seed a store that does
    // not exist yet, so upgrades never add, reorder or drop saved profiles.
    return defined;
  }

  private async readFileOrNull(filename: string): Promise<ProfileDefinition[] | null> {
    let content: string;
    try {
      content = await readFile(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return this.decode(content);
  }

  private async read(): Promise<ProfileDefinition[]> {
    let primary: ProfileDefinition[] | null;
    try {
      primary = await this.readFileOrNull(this.filename);
    } catch (error) {
      // Only malformed v1 content is recoverable. Unsupported future schemas
      // and filesystem errors are not, even when an older backup exists.
      if (!(error instanceof InvalidProfileStoreError)) throw error;
      let backup: ProfileDefinition[] | null;
      try {
        backup = await this.readFileOrNull(this.filename + '.bak');
      } catch {
        throw new Error('Agency profile store is invalid and no valid backup exists.', { cause: error });
      }
      if (backup === null) {
        throw new Error('Agency profile store is invalid and no valid backup exists.', { cause: error });
      }
      await rename(this.filename, this.filename + '.corrupt-' + Date.now());
      await this.write(backup, false, Array.from(this.deletedProfileIds));
      return backup;
    }

    if (primary !== null) return primary;
    // A prior atomic update may leave only the backup. Do not reset profiles.
    // An invalid or unsupported backup fails closed instead of using defaults.
    const backup = await this.readFileOrNull(this.filename + '.bak');
    if (backup === null) return installedDefaultDefinitions(this.environment);
    await this.write(backup, false, Array.from(this.deletedProfileIds));
    return backup;
  }

  private deletedProfileIds = new Set<string>();

  private async write(definitions: readonly ProfileDefinition[], backup: boolean, deletedProfileIds: readonly string[] = []): Promise<void> {
    const dir = path.dirname(this.filename);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = this.filename + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
    try {
      const payload: Record<string, unknown> = {
        schemaVersion: SCHEMA_VERSION,
        profiles: definitions,
      };
      if (deletedProfileIds.length > 0) {
        payload['deletedProfileIds'] = deletedProfileIds;
      }
      await writeFile(temp, JSON.stringify(payload, null, 2) + '\n', {
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
      const peer = await identicalLaunchPeer(changed, next, process.env);
      if (peer !== null) throw new Error(identicalLaunchMessage(peer));
      await this.write(next, true, Array.from(this.deletedProfileIds));
      return changed;
    });
  }

  createProfile(params: CreateProfileParams): Promise<ProfileDefinition> {
    return this.serialize(async () => {
      const all = await this.read();
      const existingIds = all.map((p) => p.id as string);
      const newDef = createProfileDefinition(params, existingIds);
      if (existingIds.includes(newDef.id)) {
        throw new Error('Profile ID already exists: ' + newDef.id);
      }
      const next = [...all, newDef];
      const peer = await identicalLaunchPeer(newDef, next, process.env);
      if (peer !== null) throw new Error(identicalLaunchMessage(peer));
      this.deletedProfileIds.delete(newDef.id);
      await this.write(next, true, Array.from(this.deletedProfileIds));
      return newDef;
    });
  }

  deleteProfile(id: CliProfileId): Promise<void> {
    return this.serialize(async () => {
      const all = await this.read();
      const target = all.find((item) => item.id === id);
      if (!target) throw new Error('Unknown Agency CLI profile.');
      const next = all.filter((item) => item.id !== id);
      const defaults = defaultDefinitions();
      if (defaults.some((d) => d.id === id)) {
        this.deletedProfileIds.add(id);
      }
      await this.write(next, true, Array.from(this.deletedProfileIds));
    });
  }
}

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  DEFAULT_BROWSER_PROFILE_ID,
  isBrowserProfile,
  isValidBrowserProfileId,
  type BrowserProfile,
  type BrowserProfileId,
} from '@agent-workbench/shared';
import { appConfigDir } from '../../shared/app-paths.js';
import { DomainError, UnsupportedSchemaVersionError } from '../../shared/errors/domain-error.js';
import { SerialQueue } from '../../shared/concurrency/serial-queue.js';
import { loadWithBackupRecovery, writeSnapshotWithBackup } from '../../shared/persistence/versioned-json-store.js';

const VERSION = 1;

interface Snapshot {
  version: typeof VERSION;
  profiles: BrowserProfile[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function createMainProfile(timestamp = nowIso()): BrowserProfile {
  return {
    id: DEFAULT_BROWSER_PROFILE_ID,
    name: 'Main',
    createdAt: timestamp,
    updatedAt: timestamp,
    isDefault: true,
  };
}

function emptySnapshot(): Snapshot {
  return {
    version: VERSION,
    profiles: [createMainProfile()],
  };
}

function normalizeName(name: unknown): string {
  if (typeof name !== 'string') throw new DomainError('invalid-request', 'Profile name must be a string');
  const clean = name.trim();
  if (clean.length < 1 || clean.length > 80 || /[\u0000-\u001f\u007f]/.test(clean)) {
    throw new DomainError('invalid-request', 'Profile name must contain 1-80 printable characters');
  }
  return clean;
}

function parseSnapshot(contents: string): Snapshot {
  let decoded: unknown;
  try {
    decoded = JSON.parse(contents) as unknown;
  } catch {
    throw new DomainError('internal-error', 'Corrupt browser profile snapshot');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new DomainError('internal-error', 'Invalid browser profile snapshot');
  }
  const obj = decoded as Record<string, unknown>;
  if (obj['version'] !== VERSION) {
    throw new UnsupportedSchemaVersionError('browser profile', obj['version']);
  }
  if (!Array.isArray(obj['profiles'])) {
    throw new DomainError('internal-error', 'Invalid browser profiles array');
  }
  const profiles: BrowserProfile[] = [];
  const seen = new Set<string>();
  for (const item of obj['profiles']) {
    if (!isBrowserProfile(item) || seen.has(item.id)) {
      throw new DomainError('internal-error', 'Invalid or duplicate browser profile entry');
    }
    seen.add(item.id);
    profiles.push({
      id: item.id,
      name: item.name.trim(),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(item.id === DEFAULT_BROWSER_PROFILE_ID ? { isDefault: true } : {}),
    });
  }
  if (!seen.has(DEFAULT_BROWSER_PROFILE_ID)) {
    profiles.unshift(createMainProfile());
  }
  return { version: VERSION, profiles };
}

/**
 * Durable store for named browser profiles (`Main` default plus custom/cloned profiles).
 * Browser cookies/storage live inside Electron partitions named from the profile ID.
 */
export class BrowserProfileStore {
  private state: Snapshot = emptySnapshot();
  private initialized = false;
  private readonly queue = new SerialQueue();
  readonly filePath: string;

  constructor(filePath: string = path.join(appConfigDir(), 'agency-browser-profiles.json')) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    if (this.initialized) return;
    const result = await loadWithBackupRecovery<Snapshot>({
      filePath: this.filePath,
      parse: parseSnapshot,
      emptyValue: emptySnapshot,
      isUnsupportedSchemaError: (err) => err instanceof UnsupportedSchemaVersionError,
      recoveryErrorMessage: 'Browser profile store is corrupt and backup unavailable',
    });
    this.state = result.value;
    if (result.recoveredFromBackup) {
      await writeSnapshotWithBackup({
        filePath: this.filePath,
        content: JSON.stringify(this.state, null, 2) + '\n',
      });
    }
    this.initialized = true;
  }

  private ensureReady(): void {
    if (!this.initialized) {
      throw new DomainError('internal-error', 'Browser profile store not loaded');
    }
  }

  private transact<T>(fn: (state: Snapshot) => [Snapshot, T]): Promise<T> {
    return this.queue.run(async () => {
      this.ensureReady();
      const [next, value] = fn(this.state);
      await writeSnapshotWithBackup({
        filePath: this.filePath,
        content: JSON.stringify(next, null, 2) + '\n',
      });
      this.state = next;
      return value;
    });
  }

  listProfiles(): BrowserProfile[] {
    this.ensureReady();
    return this.state.profiles.map((p) => ({ ...p }));
  }

  flush(): Promise<void> {
    return this.queue.flush();
  }

  getProfile(id: BrowserProfileId): BrowserProfile | null {
    this.ensureReady();
    const item = this.state.profiles.find((p) => p.id === id);
    return item ? { ...item } : null;
  }

  async createProfile(name: string, sourceProfileId?: BrowserProfileId): Promise<BrowserProfile> {
    const clean = normalizeName(name);
    return this.transact((state) => {
      if (sourceProfileId !== undefined) {
        if (!isValidBrowserProfileId(sourceProfileId) || !state.profiles.some((p) => p.id === sourceProfileId)) {
          throw new DomainError('not-found', `Source browser profile ${sourceProfileId} not found`);
        }
      }
      if (state.profiles.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
        throw new DomainError('conflict', `A browser profile named "${clean}" already exists`);
      }
      const now = nowIso();
      const id = `bp_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const profile: BrowserProfile = {
        id,
        name: clean,
        createdAt: now,
        updatedAt: now,
      };
      return [{ ...state, profiles: [...state.profiles, profile] }, { ...profile }];
    });
  }

  async renameProfile(profileId: BrowserProfileId, name: string): Promise<BrowserProfile> {
    const clean = normalizeName(name);
    return this.transact((state) => {
      const existing = state.profiles.find((p) => p.id === profileId);
      if (!existing) {
        throw new DomainError('not-found', 'Browser profile not found');
      }
      if (state.profiles.some((p) => p.id !== profileId && p.name.toLowerCase() === clean.toLowerCase())) {
        throw new DomainError('conflict', `A browser profile named "${clean}" already exists`);
      }
      const updated: BrowserProfile = {
        ...existing,
        name: clean,
        updatedAt: nowIso(),
      };
      return [
        { ...state, profiles: state.profiles.map((p) => (p.id === profileId ? updated : p)) },
        { ...updated },
      ];
    });
  }

  async deleteProfile(profileId: BrowserProfileId): Promise<void> {
    if (profileId === DEFAULT_BROWSER_PROFILE_ID) {
      throw new DomainError('conflict', 'The default Main browser profile cannot be deleted');
    }
    return this.transact((state) => {
      if (!state.profiles.some((p) => p.id === profileId)) {
        throw new DomainError('not-found', 'Browser profile not found');
      }
      return [
        { ...state, profiles: state.profiles.filter((p) => p.id !== profileId) },
        undefined,
      ];
    });
  }
}

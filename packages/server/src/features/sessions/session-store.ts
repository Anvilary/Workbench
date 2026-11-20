import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { CLI_PROVIDERS, isAgencyTab } from '@agent-workbench/shared';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgencyRuntimeSession, CliProvider } from '@agent-workbench/shared';
import { writeAtomically } from '../../shared/persistence/atomic-write.js';
import { appConfigDir } from '../../shared/app-paths.js';

const VERSION = 2;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIFECYCLES = new Set(['starting', 'running', 'stopping', 'exited', 'failed']);
const ACTIVITIES = new Set(['idle', 'working', 'awaiting-user', 'awaiting-permission', 'unknown', 'offline']);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nullableTimestamp(value: unknown): boolean {
  return value === null || validTimestamp(value);
}

function validSession(value: unknown): value is AgencyRuntimeSession {
  if (!record(value)) return false;
  if (value.tab !== undefined && !isAgencyTab(value.tab)) return false;
  if (value.launchId !== undefined && (typeof value.launchId !== 'string' || !ID_PATTERN.test(value.launchId))) return false;
  if (value.stoppedByUser !== undefined && typeof value.stoppedByUser !== 'boolean') return false;
  if (value.recovery !== undefined && (!record(value.recovery) || !['pending', 'resuming', 'resumed', 'manual', 'failed', 'superseded'].includes(value.recovery.status as string) || (value.recovery.message !== null && typeof value.recovery.message !== 'string'))) return false;
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) return false;
  if (typeof value.workspaceId !== 'string' || !ID_PATTERN.test(value.workspaceId)) return false;
  if (value.terminalId !== null && (typeof value.terminalId !== 'string' || !ID_PATTERN.test(value.terminalId))) return false;
  if (!LIFECYCLES.has(value.lifecycle as string) || !ACTIVITIES.has(value.activity as string)) return false;
  if (![value.createdAt, value.updatedAt].every(validTimestamp)) return false;
  if (![value.startedAt, value.stoppedAt].every(nullableTimestamp)) return false;
  if (value.exitCode !== null && (!Number.isInteger(value.exitCode) || typeof value.exitCode !== 'number')) return false;
  if (value.kind === 'terminal') {
    return value.profileId === null && value.nativeSessionId === null &&
      value.selectedModel === null && value.selectedEffort === null;
  }
  if (value.launchDefinition !== undefined && (!record(value.launchDefinition) || typeof value.launchDefinition.executable !== 'string' || !path.isAbsolute(value.launchDefinition.executable) || !Array.isArray(value.launchDefinition.args) || !value.launchDefinition.args.every(arg => typeof arg === 'string') || (value.launchDefinition.contextRef !== null && typeof value.launchDefinition.contextRef !== 'string'))) return false;
  if (value.nativeIdentity != null && (!record(value.nativeIdentity) ||
      !CLI_PROVIDERS.includes(value.nativeIdentity.provider as CliProvider) ||
      (value.nativeIdentity.bindingId !== undefined && (typeof value.nativeIdentity.bindingId !== 'string' || !/^[a-f0-9]{64}$/.test(value.nativeIdentity.bindingId))) ||
      typeof value.nativeIdentity.home !== 'string' || !path.isAbsolute(value.nativeIdentity.home))) return false;
  if (value.historyAvailability !== undefined &&
      value.historyAvailability !== 'available' && value.historyAvailability !== 'unavailable') return false;
  return value.kind === 'agent' && typeof value.profileId === 'string' && value.profileId.length > 0 &&
    (value.nativeSessionId === null || typeof value.nativeSessionId === 'string') &&
    (value.selectedModel === null || typeof value.selectedModel === 'string') &&
    (value.selectedEffort === null || typeof value.selectedEffort === 'string');
}

export class UnsupportedAgencySessionSchemaError extends Error {
  constructor(version: unknown) {
    super('Unsupported Agency session store schema: ' + String(version));
    this.name = 'UnsupportedAgencySessionSchemaError';
  }
}

function parse(contents: string): AgencyRuntimeSession[] {
  const value: unknown = JSON.parse(contents);
  if (!record(value)) throw new Error('Invalid Agency session store');
  if (!Number.isInteger(value.version)) throw new Error('Missing or invalid Agency session store version');
  if (value.version !== VERSION && value.version !== 1) throw new UnsupportedAgencySessionSchemaError(value.version);
  if (!Array.isArray(value.sessions)) throw new Error('Invalid Agency session store shape');
  if (!value.sessions.every(validSession)) throw new Error('Invalid Agency session record');
  const sessions = value.sessions as AgencyRuntimeSession[];
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) {
    throw new Error('Duplicate Agency runtime IDs');
  }
  const migrated = migrateSessionTabs(sessions);
  const open = migrated.filter(s => s.tab?.current);
  if (new Set(open.map(s => s.tab!.id)).size !== open.length) throw new Error('Duplicate current tab IDs');
  const selected = open.filter(s => s.tab!.selected && !s.tab!.closedAt);
  if (new Set(selected.map(s => s.workspaceId)).size !== selected.length) throw new Error('Multiple selected tabs in one workspace');
  return migrated;
}

/** Deterministic v1 migration retains every runtime/native reference; no process launches. */
export function migrateSessionTabs(sessions: readonly AgencyRuntimeSession[]): AgencyRuntimeSession[] {
  const selected = new Set(sessions.filter(s => s.tab?.current && s.tab.selected && !s.tab.closedAt).map(s => s.workspaceId));
  const defaults = new Map<string, number>();
  for (const [index, session] of sessions.entries()) {
    if (session.tab || session.recovery?.status === 'superseded') continue;
    const previous = defaults.get(session.workspaceId);
    const active = (row: AgencyRuntimeSession) => ['starting','running','stopping'].includes(row.lifecycle);
    if (previous === undefined || (!active(sessions[previous]!) && active(session))) defaults.set(session.workspaceId, index);
  }
  return sessions.map((session, index) => {
    if (session.tab) return session;
    const bytes = createHash('sha256').update('maw-tab:' + session.id).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.toString('hex');
    const id = [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
    const choose = !selected.has(session.workspaceId) && defaults.get(session.workspaceId) === index; if (choose) selected.add(session.workspaceId);
    return { ...session, tab: { id, name: null, ...(session.kind === 'terminal' ? { terminalNumber: sessions.slice(0,index).filter(s => s.workspaceId === session.workspaceId && s.kind === 'terminal').length + 1 } : {}), order: index, selected: choose, closedAt: null, current: session.recovery?.status !== 'superseded' } };
  });
}

/**
 * Durable metadata only. No output, credentials, complete environment or PID is persisted.
 * One writer per server instance. The normal app's local-first single-instance rule applies.
 */
export class AgencySessionStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly file: string = path.join(appConfigDir(), 'agency-sessions.json')) {}

  async load(): Promise<AgencyRuntimeSession[]> {
    let primaryMissing = false;
    let primaryFailure: unknown = null;
    try {
      return parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error instanceof UnsupportedAgencySessionSchemaError) throw error;
      primaryMissing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      primaryFailure = error;
    }

    let backup: AgencyRuntimeSession[];
    try {
      backup = parse(await readFile(this.file + '.bak', 'utf8'));
    } catch (error) {
      if (error instanceof UnsupportedAgencySessionSchemaError) throw error;
      const backupMissing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (primaryMissing && backupMissing) return [];
      // Never treat a damaged or unreadable store as a fresh empty workspace.
      throw new AggregateError([primaryFailure, error], 'Agency session metadata could not be recovered');
    }

    if (!primaryMissing) {
      // Only quarantine AFTER backup has been validated. Preserve the raw
      // damaged bytes, and refuse recovery if quarantine itself fails.
      const quarantine = this.file + '.corrupt-' + randomUUID();
      await rename(this.file, quarantine);
      console.warn('[agency] corrupt session metadata preserved at ' + quarantine);
    }
    // Keep a valid backup untouched until the next successfully committed save.
    return backup;
  }

  /**
   * Each caller supplies a complete immutable snapshot. Writes are sequenced,
   * so a slow fsync/rename cannot replace a newer snapshot with an older one.
   */
  save(sessions: readonly AgencyRuntimeSession[]): Promise<void> {
    const serialized = Buffer.from(JSON.stringify({ version: VERSION, sessions: migrateSessionTabs(sessions) }, null, 2) + '\n', 'utf8');
    const perform = async (): Promise<void> => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await copyFile(this.file, this.file + '.bak').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await writeAtomically(this.file, serialized, { mode: 0o600 });
    };
    const next = this.queue.then(perform);
    this.queue = next.catch(() => undefined);
    return next;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

const ACTIVE_LIFECYCLES = new Set(['starting', 'running', 'stopping']);

/**
 * A session that belongs in live state: any active process, or a tab that is open and is the tab's current
 * runtime attempt. Closed tabs and superseded attempts are history: retained, but not sent with every
 * snapshot or rewritten with every save.
 */
export function isLiveSession(session: AgencyRuntimeSession): boolean {
  if (ACTIVE_LIFECYCLES.has(session.lifecycle)) return true;
  if (!session.tab) return true;
  return session.tab.current !== false && !session.tab.closedAt;
}

export interface AgencySessionPersistence {
  load(): Promise<AgencyRuntimeSession[]>;
  save(sessions: readonly AgencyRuntimeSession[]): Promise<void>;
  flush(): Promise<void>;
}

/**
 * Live rows in `agency-sessions.json` (rewritten on every change), history rows in
 * `agency-sessions-history.json` (rewritten only when the set of history rows changes, e.g. a tab closes).
 * Both files use the regular store format, validated-backup recovery and schema checks.
 *
 * Crash safety: when a row moves to history, history is written first, then live. A crash in between leaves
 * the row in both files; load keeps the most recently updated copy, preferring closed history on timestamp
 * ties (multiple runtime changes can share a millisecond). Older builds read only the live file and simply
 * do not see history (it is not deleted).
 */
export class SplitAgencySessionStore implements AgencySessionPersistence {
  private readonly live: AgencySessionStore;
  private readonly history: AgencySessionStore;
  private queue: Promise<void> = Promise.resolve();
  private savedHistory: readonly AgencyRuntimeSession[] | null = null;

  constructor(readonly file: string, readonly historyFile: string = file.replace(/\.json$/, '') + '-history.json') {
    this.live = new AgencySessionStore(file);
    this.history = new AgencySessionStore(historyFile);
  }

  async load(): Promise<AgencyRuntimeSession[]> {
    const [live, history] = await Promise.all([this.live.load(), this.history.load()]);
    const byId = new Map<string, AgencyRuntimeSession>();
    for (const row of history) byId.set(row.id, row);
    for (const row of live) {
      const other = byId.get(row.id);
      if (!other || row.updatedAt > other.updatedAt || (row.updatedAt === other.updatedAt && !other.tab?.closedAt)) {
        byId.set(row.id, row);
      }
    }
    // Live first (stable order for the runtime), then history in file order.
    const order = [...live.map(row => row.id), ...history.map(row => row.id)];
    const merged = [...new Set(order)].map(id => byId.get(id)!);
    this.savedHistory = null;   // the first save rewrites both files in the split layout
    return merged;
  }

  save(sessions: readonly AgencyRuntimeSession[]): Promise<void> {
    const liveRows = sessions.filter(isLiveSession);
    const historyRows = sessions.filter(row => !isLiveSession(row));
    const perform = async (): Promise<void> => {
      const previous = this.savedHistory;
      // Rows are immutable snapshots: identity comparison detects any change without serializing history.
      const changed = previous === null || previous.length !== historyRows.length || historyRows.some((row, i) => row !== previous[i]);
      if (changed) {
        await this.history.save(historyRows);
        this.savedHistory = historyRows;
      }
      await this.live.save(liveRows);
    };
    const next = this.queue.then(perform);
    this.queue = next.catch(() => { this.savedHistory = null; });
    return next;
  }

  flush(): Promise<void> {
    return this.queue.then(() => Promise.all([this.live.flush(), this.history.flush()])).then(() => undefined);
  }
}

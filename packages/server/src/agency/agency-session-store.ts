import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgencyRuntimeSession } from '@agent-workbench/shared';
import { writeAtomically } from '../atomic-write.js';
import { appConfigDir } from '../paths.js';

const VERSION = 1;
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
  if (value.nativeIdentity != null && (!record(value.nativeIdentity) ||
      !['codex', 'claude-code', 'antigravity'].includes(value.nativeIdentity.provider as string) ||
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
  if (value.version !== VERSION) throw new UnsupportedAgencySessionSchemaError(value.version);
  if (!Array.isArray(value.sessions)) throw new Error('Invalid Agency session store shape');
  if (!value.sessions.every(validSession)) throw new Error('Invalid Agency session record');
  const sessions = value.sessions as AgencyRuntimeSession[];
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) {
    throw new Error('Duplicate Agency runtime IDs');
  }
  return sessions;
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
    const serialized = Buffer.from(JSON.stringify({ version: VERSION, sessions }, null, 2) + '\n', 'utf8');
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

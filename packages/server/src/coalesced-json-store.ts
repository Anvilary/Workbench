/**
 * Coalesced JSON Store with Bounded Trailing-Edge Persistence.
 *
 * Provides safe, efficient persistence for high-frequency runtime state stores
 * (TabActivityManager, AgencySessionRuntime, AgencyLayoutStore).
 *
 * Durability Policy:
 * - High-frequency intermediate transitions (working heartbeats, command prompt
 *   events, intermediate tab focus, transient metadata) use `scheduleSave()`
 *   with a 150 ms trailing debounce and 1,000 ms max-wait ceiling.
 * - Crash-durable, safety-critical transitions (session creation, session
 *   termination, user settings changes, notification acknowledgement, security
 *   settings, server shutdown) use `saveImmediate()`, bypassing the debounce
 *   window to ensure zero loss across crashes or unexpected power failures.
 *
 * Writes are executed atomically using temporary file creation and atomic rename.
 */

import { writeAtomically } from './atomic-write.js';

export interface CoalescedJsonStoreOptions<T> {
  /** Target file path on disk. */
  readonly filePath: string;
  /** Trailing debounce window in milliseconds. Default: 150 ms. */
  readonly debounceMs?: number;
  /** Maximum delay before a scheduled save is forced. Default: 1,000 ms. */
  readonly maxWaitMs?: number;
  /** Custom serializer (defaults to JSON.stringify(data, null, 2) + '\n'). */
  readonly serialize?: (data: T) => Buffer;
  /** Permissions mode for the target file. Default: 0o600. */
  readonly mode?: number;
}

export interface StorePersistenceMetrics {
  totalRequests: number;
  scheduledRequests: number;
  immediateRequests: number;
  actualDiskWrites: number;
  coalescedSavings: number;
  coalescedRatio: number;
}

export const DEFAULT_DEBOUNCE_MS = 150;
export const DEFAULT_MAX_WAIT_MS = 1_000;

export class CoalescedJsonStore<T> {
  private readonly filePath: string;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly serialize: (data: T) => Buffer;
  private readonly mode: number;

  private pendingData: T | null = null;
  private isDirty = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private firstScheduleTime = 0;

  private pendingDeferreds: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  private inFlightWrite: Promise<void> | null = null;
  private disposed = false;

  // Metrics
  private totalRequests = 0;
  private scheduledRequests = 0;
  private immediateRequests = 0;
  private actualDiskWrites = 0;

  constructor(options: CoalescedJsonStoreOptions<T>) {
    this.filePath = options.filePath;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.mode = options.mode ?? 0o600;
    this.serialize =
      options.serialize ??
      ((data: T) => Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8'));
  }

  /**
   * Schedules a debounced save for non-critical, high-frequency updates.
   * Resolves once the write has been durably committed to disk.
   */
  async scheduleSave(data: T): Promise<void> {
    if (this.disposed) {
      throw new Error(`Cannot schedule save on disposed store for ${this.filePath}`);
    }

    this.totalRequests += 1;
    this.scheduledRequests += 1;
    this.pendingData = data;
    this.isDirty = true;

    const promise = new Promise<void>((resolve, reject) => {
      this.pendingDeferreds.push({ resolve, reject });
    });

    const now = Date.now();
    if (this.firstScheduleTime === 0) {
      this.firstScheduleTime = now;
    }

    // Clear previous trailing debounce timer
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const elapsed = now - this.firstScheduleTime;
    if (elapsed >= this.maxWaitMs) {
      // Force write if maxWaitMs exceeded
      void this.executeWrite().catch(() => {});
    } else {
      const waitMs = Math.min(this.debounceMs, this.maxWaitMs - elapsed);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        void this.executeWrite().catch(() => {});
      }, waitMs);
      this.debounceTimer.unref();
    }

    return promise;
  }

  /**
   * Immediately commits data to disk atomically.
   * Cancels any pending debounce timer.
   * Must be used for critical lifecycle and security events:
   * - Session creation / spawn
   * - Session termination / exit
   * - User settings updates
   * - Notification acknowledgement (done/read)
   * - Security-sensitive changes
   */
  async saveImmediate(data: T): Promise<void> {
    if (this.disposed) {
      throw new Error(`Cannot perform immediate save on disposed store for ${this.filePath}`);
    }

    this.totalRequests += 1;
    this.immediateRequests += 1;

    // Clear debounce timer
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.pendingData = data;
    this.isDirty = true;

    const promise = new Promise<void>((resolve, reject) => {
      this.pendingDeferreds.push({ resolve, reject });
    });

    void this.executeWrite().catch(() => {});
    return promise;
  }

  /**
   * Flushes any pending dirty state immediately.
   */
  async flush(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.isDirty) {
      await this.executeWrite();
    } else if (this.inFlightWrite !== null) {
      await this.inFlightWrite;
    }
  }

  /**
   * Flushes pending writes and marks store disposed.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.flush();
  }

  /**
   * Returns metrics on write coalescing performance.
   */
  getMetrics(): StorePersistenceMetrics {
    const coalescedSavings = Math.max(0, this.totalRequests - this.actualDiskWrites);
    const coalescedRatio =
      this.actualDiskWrites > 0
        ? Number((this.totalRequests / this.actualDiskWrites).toFixed(2))
        : 1;
    return {
      totalRequests: this.totalRequests,
      scheduledRequests: this.scheduledRequests,
      immediateRequests: this.immediateRequests,
      actualDiskWrites: this.actualDiskWrites,
      coalescedSavings,
      coalescedRatio,
    };
  }

  private async executeWrite(): Promise<void> {
    if (this.inFlightWrite !== null) {
      // If a write is currently in flight, wait for it to finish and execute again if still dirty
      try {
        await this.inFlightWrite;
      } catch {
        // Handled by that write's deferreds
      }
      if (this.isDirty) {
        return this.executeWrite();
      }
      return;
    }

    if (!this.isDirty || this.pendingData === null) {
      return;
    }

    const dataToWrite = this.pendingData;
    const deferredsToNotify = this.pendingDeferreds;
    this.pendingDeferreds = [];
    this.isDirty = false;
    this.firstScheduleTime = 0;

    this.inFlightWrite = (async () => {
      try {
        const buffer = this.serialize(dataToWrite);
        await writeAtomically(this.filePath, buffer, { mode: this.mode });
        this.actualDiskWrites += 1;
        for (const deferred of deferredsToNotify) {
          deferred.resolve();
        }
      } catch (error) {
        // Keep dirty so subsequent attempts can retry
        this.isDirty = true;
        this.pendingData = dataToWrite;
        for (const deferred of deferredsToNotify) {
          deferred.reject(error);
        }
      } finally {
        this.inFlightWrite = null;
      }
    })();

    await this.inFlightWrite;
  }
}

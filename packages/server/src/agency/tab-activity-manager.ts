/**
 * MAW Lane C - Unified Tab Activity State Manager.
 *
 * Coordinates the 5-state model across CLI, Terminal, and Browser tabs:
 *   - idle
 *   - working
 *   - finished
 *   - unknown
 *   - failed
 *
 * Enforces key invariants:
 *   - A task enters 'finished' only upon a reliable completion signal.
 *   - 'finished' persists until the user opens the tab and inspects/acknowledges it,
 *     then returns to 'idle'.
 *   - Reading a notification in the inbox and acknowledging task completion are distinct.
 *   - Does not guess completion from arbitrary PTY output or pause.
 *   - When shell integration is missing, status is explicitly 'unknown'.
 *   - Audits native CLI providers: generic idle is not turn completion.
 *   - Controlled per-tab turn sequence: consecutive CLI turns produce distinct identities,
 *     replayed turn events deduplicate, and restart recovery never reuses old turn sequences.
 *   - Persists durable state using atomic-write conventions, 0o600 private permissions,
 *     and queue recovery on write failure.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  isTabActivityRecord,
  isMawNotificationItem,
  type MawActivityState,
  type ProjectId,
  type RuntimeSessionId,
  type TabActivityRecord,
  type WorkspaceId,
} from '@agent-workbench/shared';
import { appConfigDir } from '../paths.js';
import { writeAtomically } from '../atomic-write.js';
import type { AgencyNotificationStore, CreateNotificationInput } from './agency-notification-store.js';
import { ShellIntegrationParser } from './shell-integration.js';
import type { BrowserActivityProvider } from './browser-activity-provider.js';

const NOW = (): string => new Date().toISOString();

/** Providers that actually emit verified turn-completion signals via real-time watchers or events. */
const VERIFIED_TURN_PROVIDERS = new Set<string>(['claude-code', 'opencode']);

export interface TabActivityKey {
  workspaceId: WorkspaceId;
  tabId: string;
}

export class TabActivityManager extends EventEmitter {
  private queue: Promise<void> = Promise.resolve();
  private mutations: Promise<void> = Promise.resolve();
  private readonly pendingNotifications = new Map<string, CreateNotificationInput>();
  private shouldDeliver?: (workspaceId: WorkspaceId, tabId: string) => boolean;
  private disposed = false;
  private readonly states = new Map<string, TabActivityRecord>();
  private readonly committedStates = new Map<string, TabActivityRecord>();
  private readonly tabTurnSequences = new Map<string, number>();
  private readonly shellParsers = new Map<string, ShellIntegrationParser>();
  private readonly shellCommandCounters = new Map<string, number>();
  private readonly browserProviders = new Map<string, BrowserActivityProvider>();
  private readonly notificationStore: AgencyNotificationStore;
  readonly file: string;
  private initialized = false;

  constructor(options: {
    notificationStore: AgencyNotificationStore;
    storageDir?: string;
    filePath?: string;
  }) {
    super();
    this.notificationStore = options.notificationStore;
    this.file = options.filePath ?? path.join(options.storageDir ?? appConfigDir(), 'agency-tab-activity.json');
  }

  private makeKey(workspaceId: string, tabId: string): string {
    return `${workspaceId}::${tabId}`;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const records = await this.load();
    for (const record of records) {
      const key = this.makeKey(record.workspaceId, record.tabId);
      let state = record.state;
      let reliableSignal = record.reliableSignal;
      let detail = record.detail;

      // Restore highest known turn sequence so restart recovery cannot reuse old turn IDs
      if (record.turnSequence !== undefined) {
        const prev = this.tabTurnSequences.get(key) ?? 0;
        this.tabTurnSequences.set(key, Math.max(prev, record.turnSequence));
      }

      if (record.closed) {
        // Closed tabs remain closed and do not generate alerts
      } else if (state === 'working') {
        // In-flight tasks without recovery signal become unknown rather than falsely finished
        state = 'unknown';
        reliableSignal = false;
        detail = 'Server restarted while task in-flight (status unknown)';
      } else if (state === 'finished' && !record.acknowledgedAt) {
        // Uninspected finished states remain finished!
        state = 'finished';
      }

      this.states.set(key, {
        ...record,
        state,
        reliableSignal,
        ...(detail ? { detail } : {}),
      });
      this.committedStates.set(key, this.states.get(key)!);
    }
    this.initialized = true;
  }

  async load(): Promise<TabActivityRecord[]> {
    let primaryMissing = false;
    let primaryFailure: unknown = null;
    try {
      const contents = await readFile(this.file, 'utf8');
      return this.parse(contents);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') primaryMissing = true;
      primaryFailure = err;
    }

    let recovered;
    try {
      const backupContents = await readFile(this.file + '.bak', 'utf8');
      recovered = this.parse(backupContents);
    } catch (backupError) {
      const backupMissing = (backupError as NodeJS.ErrnoException).code === 'ENOENT';
      if (primaryMissing && backupMissing) {
        return [];
      }
      throw new AggregateError([primaryFailure, backupError], 'Agency tab activity metadata could not be recovered');
    }
    // A subsequent save copies the primary to .bak. Never let damaged bytes
    // replace the validated recovery copy. Refuse recovery if preservation fails.
    if (!primaryMissing) await rename(this.file, this.file + '.corrupt-' + randomUUID());
    return recovered;
  }

  private parse(contents: string): TabActivityRecord[] {
    const raw: unknown = JSON.parse(contents);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid tab activity file format');
    const root = raw as Record<string, unknown>;
    if (root['version'] !== 1 || !Array.isArray(root['records'])) throw new Error('Unsupported tab activity format');
    const records: TabActivityRecord[] = [];
    for (const item of root['records']) {
      if (!isTabActivityRecord(item)) throw new Error('Invalid tab activity record');
      records.push(item);
    }
    const receipts = root['pendingNotifications'] ?? [];
    if (!Array.isArray(receipts)) throw new Error('Invalid pending notifications');
    const pending = new Map<string, CreateNotificationInput>();
    for (const receipt of receipts) {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Invalid pending notification');
      const item = receipt as Record<string, unknown>;
      if (typeof item['deduplicationKey'] !== 'string' || !item['deduplicationKey'] ||
          !['finished', 'failed'].includes(String(item['state'])) ||
          !isMawNotificationItem({ ...item, id: '00000000-0000-4000-8000-000000000001', read: false, createdAt: new Date(0).toISOString() })) {
        throw new Error('Invalid pending notification');
      }
      pending.set(item['deduplicationKey'], receipt as CreateNotificationInput);
    }
    this.pendingNotifications.clear();
    for (const [key, receipt] of pending) this.pendingNotifications.set(key, receipt);
    return records;
  }

  private async persist(): Promise<void> {
    const records = [...this.states.values()];
    const serialized = Buffer.from(
      JSON.stringify({ version: 1, records, pendingNotifications: [...this.pendingNotifications.values()] }, null, 2) + '\n',
      'utf8',
    );

    const perform = async (): Promise<void> => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await copyFile(this.file, this.file + '.bak').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await writeAtomically(this.file, serialized, { mode: 0o600 });
      this.committedStates.clear();
      for (const record of records) this.committedStates.set(this.makeKey(record.workspaceId, record.tabId), record);
    };

    // Recover write queue after individual failure while failing visibly to caller
    const next = this.queue.then(perform);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation);
    this.mutations = next.then(() => undefined, () => undefined);
    return next;
  }

  flush(): Promise<void> {
    return this.mutations.then(() => this.queue);
  }

  /** Retry after tab reconciliation and periodically; authorization also drops deleted tabs. */
  flushPendingNotifications(shouldDeliver?: (workspaceId: WorkspaceId, tabId: string) => boolean): Promise<void> {
    if (shouldDeliver) this.shouldDeliver = shouldDeliver;
    return this.mutate(async () => {
      try { await this.deliverPendingNotifications(); }
      catch (error) { console.warn('[agency] pending notification delivery deferred: ' + String(error)); }
    });
  }

  private async deliverPendingNotifications(): Promise<void> {
    if (this.disposed) return;
    for (const [key, receipt] of this.pendingNotifications) {
      const record = this.states.get(this.makeKey(receipt.workspaceId, receipt.tabId));
      if (record && !record.closed && (!this.shouldDeliver || this.shouldDeliver(receipt.workspaceId, receipt.tabId))) {
        await this.notificationStore.create(receipt);
      }
      this.pendingNotifications.delete(key);
      try { await this.persist(); }
      catch (error) { this.pendingNotifications.set(key, receipt); throw error; }
    }
  }

  private async saveActivity(record: TabActivityRecord, notification?: CreateNotificationInput): Promise<void> {
    const key = this.makeKey(record.workspaceId, record.tabId);
    const previous = this.states.get(key);
    const dedup = notification?.deduplicationKey;
    const previousReceipt = dedup ? this.pendingNotifications.get(dedup) : undefined;
    this.states.set(key, record);
    if (notification && dedup && !this.notificationStore.hasDeduplicationKey(dedup)) {
      this.pendingNotifications.set(dedup, notification);
    }
    try { await this.persist(); }
    catch (error) {
      if (previous) this.states.set(key, previous); else this.states.delete(key);
      if (dedup) {
        if (previousReceipt) this.pendingNotifications.set(dedup, previousReceipt); else this.pendingNotifications.delete(dedup);
      }
      throw error;
    }
    if (!this.disposed) this.emit('tabActivity', record);
    await this.deliverPendingNotifications();
  }

  /**
   * Returns current snapshot of all active tab activity states.
   */
  snapshot(): TabActivityRecord[] {
    return [...this.committedStates.values()].filter((r) => !r.closed);
  }

  getTabState(workspaceId: WorkspaceId, tabId: string): MawActivityState {
    const key = this.makeKey(workspaceId, tabId);
    return this.committedStates.get(key)?.state ?? 'unknown';
  }

  getRecord(workspaceId: WorkspaceId, tabId: string): TabActivityRecord | null {
    const key = this.makeKey(workspaceId, tabId);
    return this.committedStates.get(key) ?? null;
  }

  /** Register the live tab before accepting events; startup does not imply work. */
  ensureTab(input: Parameters<TabActivityManager['ensureTabInner']>[0]): Promise<TabActivityRecord> {
    return this.mutate(() => this.ensureTabInner(input));
  }

  private async ensureTabInner(input: {
    workspaceId: WorkspaceId;
    tabId: string;
    sessionId?: RuntimeSessionId;
    source: 'cli' | 'shell' | 'browser';
  }): Promise<TabActivityRecord> {
    const key = this.makeKey(input.workspaceId, input.tabId);
    const existing = this.states.get(key);
    if (existing?.closed && (!input.sessionId || input.sessionId === existing.sessionId)) return existing;
    if (existing && !existing.closed && (!input.sessionId || input.sessionId === existing.sessionId)) return existing;
    const next: TabActivityRecord = existing && !existing.closed && existing.state === 'finished' ? {
      ...existing, ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    } : {
      ...input, state: 'unknown', reliableSignal: false, closed: false,
      updatedAt: NOW(), turnSequence: existing?.turnSequence,
      detail: 'Awaiting verified activity evidence',
    };
    this.states.set(key, next);
    try { await this.persist(); }
    catch (error) {
      if (this.states.get(key) === next) {
        if (existing) this.states.set(key, existing); else this.states.delete(key);
      }
      throw error;
    }
    if (input.sessionId && input.sessionId !== existing?.sessionId) {
      this.shellParsers.get(input.tabId)?.dispose();
      this.shellParsers.delete(input.tabId);
      this.shellCommandCounters.delete(input.tabId);
    }
    this.emit('tabActivity', next);
    return next;
  }

  /**
   * Marks a tab closed/deleted so it stops receiving events and never emits stale alerts.
   */
  closeTab(workspaceId: WorkspaceId, tabId: string): Promise<void> {
    return this.mutate(() => this.closeTabInner(workspaceId, tabId));
  }

  private async closeTabInner(workspaceId: WorkspaceId, tabId: string): Promise<void> {
    const key = this.makeKey(workspaceId, tabId);
    const existing = this.states.get(key);
    const removedReceipts = [...this.pendingNotifications].filter(([, receipt]) => receipt.workspaceId === workspaceId && receipt.tabId === tabId);
    for (const [dedup] of removedReceipts) this.pendingNotifications.delete(dedup);
    {
      const next: TabActivityRecord = {
        ...(existing ?? { workspaceId, tabId, source: 'manual' as const }),
        closed: true,
        state: 'idle',
        updatedAt: NOW(),
        reliableSignal: true,
        detail: 'tab-closed',
      };
      this.states.set(key, next);
      try { await this.persist(); }
      catch (error) {
        for (const [dedup, receipt] of removedReceipts) this.pendingNotifications.set(dedup, receipt);
        if (this.states.get(key) === next) {
          if (existing) this.states.set(key, existing); else this.states.delete(key);
        }
        throw error;
      }
      this.emit('tabActivity', next);
    }
    const parser = this.shellParsers.get(tabId);
    if (parser) {
      parser.dispose();
      this.shellParsers.delete(tabId);
    }
    this.shellCommandCounters.delete(tabId);
  }

  /**
   * User opened the tab and inspected the result, or explicitly acknowledged it.
   * If in 'finished' state, returns to 'idle'.
   */
  acknowledgeTab(workspaceId: WorkspaceId, tabId: string): Promise<TabActivityRecord | null> {
    return this.mutate(() => this.acknowledgeTabInner(workspaceId, tabId));
  }

  private async acknowledgeTabInner(workspaceId: WorkspaceId, tabId: string): Promise<TabActivityRecord | null> {
    const key = this.makeKey(workspaceId, tabId);
    const current = this.states.get(key);

    if (current && current.state === 'finished') {
      const next: TabActivityRecord = {
        ...current,
        state: 'idle',
        updatedAt: NOW(),
        acknowledgedAt: NOW(),
        reliableSignal: true,
        detail: 'inspected-and-acknowledged',
      };
      this.states.set(key, next);

      // Acknowledge shell parser if present
      const parser = this.shellParsers.get(tabId);
      parser?.acknowledge();

      // Acknowledge browser provider if present
      for (const provider of this.browserProviders.values()) {
        provider.acknowledgeTab(tabId);
      }

      try { await this.persist(); }
      catch (error) { if (this.states.get(key) === next) this.states.set(key, current); throw error; }
      this.emit('tabActivity', next);
      return next;
    }
    return current ?? null;
  }

  /**
   * Handles native CLI session activity updates from AgencySessionRuntime.
   * Audits turn-completion evidence: generic idle is NOT completion!
   * Enforces distinct per-turn identities so consecutive turns produce separate alerts.
   */
  handleCliActivity(input: Parameters<TabActivityManager['handleCliActivityInner']>[0]): Promise<void> {
    return this.mutate(() => this.handleCliActivityInner(input));
  }

  private async handleCliActivityInner(input: {
    workspaceId: WorkspaceId;
    projectId?: ProjectId;
    tabId: string;
    sessionId: RuntimeSessionId;
    provider?: string | null;
    tabName?: string | null;
    previousActivity?: string;
    nextActivity: string;
    lifecycle: string;
    exitCode?: number | null;
    taskId?: string;
    /** Only an explicit scoped provider event may close a turn successfully. */
    completionEvidence?: 'native-turn' | 'status-transition';
  }): Promise<void> {
    const key = this.makeKey(input.workspaceId, input.tabId);
    const existing = this.states.get(key);

    // Closed or deleted tabs must not generate stale completion alerts
    if (existing?.closed) return;
    if (input.taskId && input.taskId !== existing?.taskId &&
        (this.notificationStore.hasDeduplicationKey(`cli-turn:${input.workspaceId}:${input.tabId}:${input.taskId}`) ||
         this.notificationStore.hasDeduplicationKey(`cli-fail:${input.workspaceId}:${input.tabId}:${input.taskId}`) ||
         this.pendingNotifications.has(`cli-turn:${input.workspaceId}:${input.tabId}:${input.taskId}`) ||
         this.pendingNotifications.has(`cli-fail:${input.workspaceId}:${input.tabId}:${input.taskId}`))) return;

    let nextState: MawActivityState = 'unknown';
    let reliable = false;
    let detail = '';

    // Manage per-tab turn sequence:
    // When transitioning into 'working', a new turn begins. Advance sequence.
    let currentSeq = this.tabTurnSequences.get(key) ?? existing?.turnSequence ?? 0;
    const startsTurn = input.nextActivity === 'working' && existing?.state !== 'working' &&
      (!input.taskId || input.taskId !== existing?.taskId);
    if (startsTurn &&
        (!input.taskId || input.taskId !== existing?.taskId)) {
      currentSeq += 1;
      this.tabTurnSequences.set(key, currentSeq);
    }
    const currentTaskId = input.taskId ?? (startsTurn ? undefined : existing?.taskId) ?? `turn-${currentSeq > 0 ? currentSeq : 1}`;
    const sameTask = currentTaskId === existing?.taskId;
    if (sameTask && existing?.state === 'failed' &&
        (input.taskId ? input.nextActivity !== 'failed' : input.nextActivity !== 'working')) return;
    // Replayed terminal events must not revive an acknowledged task or overwrite its result.
    if (sameTask && existing?.acknowledgedAt && input.nextActivity !== 'working') return;
    if (sameTask && existing?.state === 'finished' && input.nextActivity !== 'working' &&
        input.nextActivity !== 'finished' && input.completionEvidence !== 'status-transition') return;
    if (sameTask && existing?.acknowledgedAt && input.nextActivity === 'working' && input.taskId) return;
    if (sameTask && existing?.state === 'finished' && input.taskId && input.nextActivity === 'working') return;

    if (input.lifecycle === 'failed' || (input.lifecycle === 'exited' && typeof input.exitCode === 'number' && input.exitCode !== 0)) {
      nextState = 'failed';
      reliable = true;
      detail = `CLI failed or exited with code ${input.exitCode ?? 'error'}`;
    } else if (input.nextActivity === 'finished' && input.completionEvidence === 'native-turn' && input.taskId) {
      nextState = 'finished';
      reliable = true;
      detail = `Native ${input.provider ?? 'CLI'} turn completed`;
    } else if (input.nextActivity === 'failed' && input.completionEvidence === 'native-turn' && input.taskId) {
      nextState = 'failed';
      reliable = true;
      detail = `Native ${input.provider ?? 'CLI'} turn failed`;
    } else if (input.nextActivity === 'working') {
      nextState = 'working';
      reliable = true;
      detail = 'CLI working on task';
    } else if (existing?.state === 'working' && input.nextActivity === 'idle') {
      // Audit turn completion signals:
      // Only providers with verified turn-completion signals emit 'finished'.
      // Generic idle or providers with statusSource: false (Codex, unconfigured Antigravity) are NOT finished!
      const isVerifiedTurnProvider = input.completionEvidence === 'status-transition' && input.provider && VERIFIED_TURN_PROVIDERS.has(input.provider);
      if (isVerifiedTurnProvider) {
        nextState = 'finished';
        reliable = true;
        detail = `CLI provider ${input.provider} turn finished`;
      } else {
        nextState = 'idle';
        reliable = false;
        detail = `Generic CLI idle (provider ${input.provider ?? 'unknown'} does not emit verified turn completion signals)`;
      }
    } else if (input.nextActivity === 'idle') {
      // If already finished and not yet acknowledged, persist 'finished'!
      if (existing?.state === 'finished' && !existing.acknowledgedAt) {
        return;
      }
      nextState = 'idle';
      reliable = false;
      detail = 'CLI idle';
    } else if (input.nextActivity === 'awaiting-user' || input.nextActivity === 'awaiting-permission') {
      nextState = 'working';
      reliable = true;
      detail = 'Awaiting user input or permission';
    } else {
      nextState = 'unknown';
      reliable = false;
    }

    // Finished persists until acknowledged by opening tab
    if (existing?.state === 'finished' && !existing.acknowledgedAt && nextState !== 'working' && nextState !== 'finished' && sameTask) {
      return;
    }

    const record: TabActivityRecord = {
      workspaceId: input.workspaceId,
      tabId: input.tabId,
      sessionId: input.sessionId,
      taskId: currentTaskId,
      turnSequence: currentSeq > 0 ? currentSeq : undefined,
      state: nextState,
      updatedAt: NOW(),
      reliableSignal: reliable,
      source: 'cli',
      detail,
      closed: false,
    };
    let notification: CreateNotificationInput | undefined;

    // Create notification upon entering finished or failed with STABLE distinct turn ID deduplication
    if (nextState === 'finished' && reliable) {
      const tabLabel = input.tabName || 'CLI Agent';
      const deduplicationKey = `cli-turn:${input.workspaceId}:${input.tabId}:${currentTaskId}`;
      notification = {
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        tabId: input.tabId,
        sessionId: input.sessionId,
        title: tabLabel,
        body: 'Agent completed task',
        state: 'finished',
        deduplicationKey,
        metadata: { kind: 'cli', tabName: input.tabName ?? '' },
      };
    } else if (nextState === 'failed' && reliable) {
      const tabLabel = input.tabName || 'CLI Agent';
      const deduplicationKey = `cli-fail:${input.workspaceId}:${input.tabId}:${currentTaskId}`;
      notification = {
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        tabId: input.tabId,
        sessionId: input.sessionId,
        title: tabLabel,
        body: detail || 'Agent encountered an error',
        state: 'failed',
        deduplicationKey,
        metadata: { kind: 'cli', tabName: input.tabName ?? '', exitCode: input.exitCode ?? null },
      };
    }
    await this.saveActivity(record, notification);
  }

  /**
   * Attaches a shell terminal session to OSC 133 activity tracking.
   */
  getOrCreateShellParser(
    workspaceId: WorkspaceId,
    tabId: string,
    options?: {
      projectId?: ProjectId;
      tabName?: string | null;
      sessionId?: RuntimeSessionId;
    },
  ): ShellIntegrationParser {
    let parser = this.shellParsers.get(tabId);
    if (!parser) {
      parser = new ShellIntegrationParser();
      this.shellParsers.set(tabId, parser);

      const key = this.makeKey(workspaceId, tabId);
      const existing = this.states.get(key);
      this.shellCommandCounters.set(tabId, existing?.turnSequence ?? 0);

      // If no persisted state exists or if in-flight on restart, initialize
      if (!existing) {
        this.states.set(key, {
          workspaceId,
          tabId,
          ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
          state: 'unknown',
          updatedAt: NOW(),
          reliableSignal: false,
          source: 'shell',
          detail: 'Awaiting shell integration hooks',
          closed: false,
        });
      }

      parser.on('commandStart', () => {
        const count = (this.shellCommandCounters.get(tabId) ?? 0) + 1;
        this.shellCommandCounters.set(tabId, count);
      });

      parser.on('state', (state: MawActivityState, detail?: string) => {
        if (detail === 'acknowledged') return;
        const count = this.shellCommandCounters.get(tabId) ?? 0;
        const exitCode = parser!.getLastExitCode();
        const reliableSignal = parser!.hasIntegration() && state !== 'unknown';
        void this.mutate(async () => {
          const current = this.states.get(key);
          if (current?.closed || (options?.sessionId && current?.sessionId && current.sessionId !== options.sessionId)) return;
          if (current?.state === 'finished' && !current.acknowledgedAt && state === 'idle') return;
          const cmdId = `cmd-${count}`;
          const record: TabActivityRecord = {
            workspaceId, tabId, ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
            taskId: cmdId, turnSequence: count, state, updatedAt: NOW(), reliableSignal,
            source: 'shell', closed: false, ...(detail ? { detail } : {}),
          };
          const notification: CreateNotificationInput | undefined = state === 'finished' || state === 'failed' ? {
            workspaceId, ...(options?.projectId ? { projectId: options.projectId } : {}),
            tabId, ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
            title: options?.tabName || 'Terminal',
            body: state === 'finished' ? 'Command finished successfully' : `Command failed with exit code ${exitCode ?? 'error'}`,
            state, deduplicationKey: `${state === 'finished' ? 'shell-cmd' : 'shell-cmd-fail'}:${workspaceId}:${tabId}:${cmdId}`,
            metadata: { kind: 'shell', tabName: options?.tabName ?? '', exitCode: state === 'finished' ? 0 : exitCode },
          } : undefined;
          await this.saveActivity(record, notification);
        }).catch(error => console.warn('[agency] failed persisting shell activity/outbox: ' + String(error)));
      });
    }
    return parser;
  }

  feedShellOutput(tabId: string, chunk: string): void {
    const parser = this.shellParsers.get(tabId);
    if (parser) {
      parser.feed(chunk);
    }
  }

  /**
   * Registers a browser activity provider for web tabs.
   */
  registerBrowserProvider(provider: BrowserActivityProvider): void {
    this.browserProviders.set(provider.id, provider);
  }

  dispose(): void {
    this.disposed = true;
    for (const parser of this.shellParsers.values()) {
      parser.dispose();
    }
    this.shellParsers.clear();
    this.shellCommandCounters.clear();
    this.tabTurnSequences.clear();
    this.browserProviders.clear();
    this.removeAllListeners();
  }
}

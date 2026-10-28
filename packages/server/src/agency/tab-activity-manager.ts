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
 *   - Persists durable state: in-flight becomes 'unknown' on restart, uninspected
 *     'finished' states persist, closed tabs do not alert, and stable deduplication keys
 *     prevent duplicate notifications.
 */

import { EventEmitter } from 'node:events';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isTabActivityRecord,
  type MawActivityState,
  type ProjectId,
  type RuntimeSessionId,
  type TabActivityRecord,
  type WorkspaceId,
} from '@agent-workbench/shared';
import { appConfigDir } from '../paths.js';
import type { AgencyNotificationStore } from './agency-notification-store.js';
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
  private readonly states = new Map<string, TabActivityRecord>();
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

    try {
      const backupContents = await readFile(this.file + '.bak', 'utf8');
      return this.parse(backupContents);
    } catch (backupError) {
      const backupMissing = (backupError as NodeJS.ErrnoException).code === 'ENOENT';
      if (primaryMissing && backupMissing) {
        return [];
      }
      throw new AggregateError([primaryFailure, backupError], 'Agency tab activity metadata could not be recovered');
    }
  }

  private parse(contents: string): TabActivityRecord[] {
    const raw: unknown = JSON.parse(contents);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid tab activity file format');
    const root = raw as Record<string, unknown>;
    if (root['version'] !== 1 || !Array.isArray(root['records'])) throw new Error('Unsupported tab activity format');
    const records: TabActivityRecord[] = [];
    for (const item of root['records']) {
      if (isTabActivityRecord(item)) {
        records.push(item);
      }
    }
    return records;
  }

  private async persist(): Promise<void> {
    this.queue = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = path.join(path.dirname(this.file), `.agency-tab-activity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tmp`);
      const payload = JSON.stringify({
        version: 1,
        records: [...this.states.values()],
      }, null, 2);
      await writeFile(temp, payload, 'utf8');
      try {
        await copyFile(this.file, this.file + '.bak');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      await rename(temp, this.file);
    });
    return this.queue;
  }

  /**
   * Returns current snapshot of all active tab activity states.
   */
  snapshot(): TabActivityRecord[] {
    return [...this.states.values()].filter((r) => !r.closed);
  }

  getTabState(workspaceId: WorkspaceId, tabId: string): MawActivityState {
    const key = this.makeKey(workspaceId, tabId);
    return this.states.get(key)?.state ?? 'unknown';
  }

  getRecord(workspaceId: WorkspaceId, tabId: string): TabActivityRecord | null {
    const key = this.makeKey(workspaceId, tabId);
    return this.states.get(key) ?? null;
  }

  /**
   * Marks a tab closed/deleted so it stops receiving events and never emits stale alerts.
   */
  async closeTab(workspaceId: WorkspaceId, tabId: string): Promise<void> {
    const key = this.makeKey(workspaceId, tabId);
    const existing = this.states.get(key);
    if (existing) {
      const next: TabActivityRecord = {
        ...existing,
        closed: true,
        state: 'idle',
        updatedAt: NOW(),
        reliableSignal: true,
        detail: 'tab-closed',
      };
      this.states.set(key, next);
      await this.persist();
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
  async acknowledgeTab(workspaceId: WorkspaceId, tabId: string): Promise<TabActivityRecord | null> {
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

      await this.persist();
      this.emit('tabActivity', next);
      return next;
    }
    return current ?? null;
  }

  /**
   * Handles native CLI session activity updates from AgencySessionRuntime.
   * Audits turn-completion evidence: generic idle is NOT completion!
   */
  async handleCliActivity(input: {
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
  }): Promise<void> {
    const key = this.makeKey(input.workspaceId, input.tabId);
    const existing = this.states.get(key);

    // Closed or deleted tabs must not generate stale completion alerts
    if (existing?.closed) return;

    let nextState: MawActivityState = 'unknown';
    let reliable = false;
    let detail = '';
    const currentTaskId = input.taskId || existing?.taskId || input.sessionId;

    if (input.lifecycle === 'failed' || (input.lifecycle === 'exited' && input.exitCode !== null && input.exitCode !== 0)) {
      nextState = 'failed';
      reliable = true;
      detail = `CLI failed or exited with code ${input.exitCode ?? 'error'}`;
    } else if (input.nextActivity === 'working') {
      nextState = 'working';
      reliable = true;
      detail = 'CLI working on task';
    } else if (input.previousActivity === 'working' && input.nextActivity === 'idle') {
      // Audit turn completion signals:
      // Only providers with verified turn-completion signals emit 'finished'.
      // Generic idle or providers with statusSource: false (Codex, unconfigured Antigravity) are NOT finished!
      const isVerifiedTurnProvider = input.provider && VERIFIED_TURN_PROVIDERS.has(input.provider);
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
    if (existing?.state === 'finished' && !existing.acknowledgedAt && nextState === 'idle') {
      return;
    }

    const record: TabActivityRecord = {
      workspaceId: input.workspaceId,
      tabId: input.tabId,
      sessionId: input.sessionId,
      taskId: currentTaskId,
      state: nextState,
      updatedAt: NOW(),
      reliableSignal: reliable,
      source: 'cli',
      detail,
      closed: false,
    };
    this.states.set(key, record);
    await this.persist();
    this.emit('tabActivity', record);

    // Create notification upon entering finished or failed with STABLE task ID deduplication
    if (nextState === 'finished' && reliable) {
      const tabLabel = input.tabName || 'CLI Agent';
      const deduplicationKey = `cli-turn:${input.workspaceId}:${input.tabId}:${currentTaskId}`;
      await this.notificationStore.create({
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        tabId: input.tabId,
        sessionId: input.sessionId,
        title: tabLabel,
        body: 'Agent completed task',
        state: 'finished',
        deduplicationKey,
      });
    } else if (nextState === 'failed' && reliable) {
      const tabLabel = input.tabName || 'CLI Agent';
      const deduplicationKey = `cli-fail:${input.workspaceId}:${input.tabId}:${currentTaskId}`;
      await this.notificationStore.create({
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        tabId: input.tabId,
        sessionId: input.sessionId,
        title: tabLabel,
        body: detail || 'Agent encountered an error',
        state: 'failed',
        deduplicationKey,
      });
    }
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
        const current = this.states.get(key);
        if (current?.closed) return;

        // 'finished' persists until acknowledged
        if (current?.state === 'finished' && !current.acknowledgedAt && state === 'idle') {
          return;
        }

        const cmdId = `cmd-${this.shellCommandCounters.get(tabId) ?? 1}`;
        const record: TabActivityRecord = {
          workspaceId,
          tabId,
          ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
          taskId: cmdId,
          state,
          updatedAt: NOW(),
          reliableSignal: parser!.hasIntegration() && state !== 'unknown',
          source: 'shell',
          closed: false,
          ...(detail ? { detail } : {}),
        };
        this.states.set(key, record);
        void this.persist();
        this.emit('tabActivity', record);

        if (state === 'finished') {
          const tabLabel = options?.tabName || 'Terminal';
          void this.notificationStore.create({
            workspaceId,
            ...(options?.projectId ? { projectId: options.projectId } : {}),
            tabId,
            ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
            title: tabLabel,
            body: 'Command finished successfully',
            state: 'finished',
            deduplicationKey: `shell-cmd:${workspaceId}:${tabId}:${cmdId}`,
          });
        } else if (state === 'failed') {
          const tabLabel = options?.tabName || 'Terminal';
          const exitCode = parser!.getLastExitCode();
          void this.notificationStore.create({
            workspaceId,
            ...(options?.projectId ? { projectId: options.projectId } : {}),
            tabId,
            ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
            title: tabLabel,
            body: `Command failed with exit code ${exitCode ?? 'error'}`,
            state: 'failed',
            deduplicationKey: `shell-cmd-fail:${workspaceId}:${tabId}:${cmdId}`,
          });
        }
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
    for (const parser of this.shellParsers.values()) {
      parser.dispose();
    }
    this.shellParsers.clear();
    this.shellCommandCounters.clear();
    this.states.clear();
    this.browserProviders.clear();
    this.removeAllListeners();
  }
}

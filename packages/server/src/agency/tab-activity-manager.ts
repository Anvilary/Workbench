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
 */

import { EventEmitter } from 'node:events';
import type {
  MawActivityState,
  ProjectId,
  RuntimeSessionId,
  TabActivityRecord,
  WorkspaceId,
} from '@agent-workbench/shared';
import type { AgencyNotificationStore } from './agency-notification-store.js';
import { ShellIntegrationParser } from './shell-integration.js';
import type { BrowserActivityProvider } from './browser-activity-provider.js';

const NOW = (): string => new Date().toISOString();

export interface TabActivityKey {
  workspaceId: WorkspaceId;
  tabId: string;
}

export class TabActivityManager extends EventEmitter {
  private readonly states = new Map<string, TabActivityRecord>();
  private readonly shellParsers = new Map<string, ShellIntegrationParser>();
  private readonly browserProviders = new Map<string, BrowserActivityProvider>();
  private readonly notificationStore: AgencyNotificationStore;

  constructor(options: { notificationStore: AgencyNotificationStore }) {
    super();
    this.notificationStore = options.notificationStore;
  }

  private makeKey(workspaceId: string, tabId: string): string {
    return `${workspaceId}::${tabId}`;
  }

  /**
   * Returns current snapshot of all tab activity states.
   */
  snapshot(): TabActivityRecord[] {
    return [...this.states.values()];
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

      this.emit('tabActivity', next);
      return next;
    }
    return current ?? null;
  }

  /**
   * Handles native CLI session activity updates from AgencySessionRuntime.
   */
  async handleCliActivity(input: {
    workspaceId: WorkspaceId;
    projectId?: ProjectId;
    tabId: string;
    sessionId: RuntimeSessionId;
    tabName?: string | null;
    previousActivity?: string;
    nextActivity: string;
    lifecycle: string;
    exitCode?: number | null;
  }): Promise<void> {
    const key = this.makeKey(input.workspaceId, input.tabId);
    const existing = this.states.get(key);

    let nextState: MawActivityState = 'unknown';
    let reliable = false;
    let detail = '';

    if (input.lifecycle === 'failed' || (input.lifecycle === 'exited' && input.exitCode !== null && input.exitCode !== 0)) {
      nextState = 'failed';
      reliable = true;
      detail = `CLI failed or exited with code ${input.exitCode ?? 'error'}`;
    } else if (input.nextActivity === 'working') {
      nextState = 'working';
      reliable = true;
      detail = 'CLI working on task';
    } else if (input.previousActivity === 'working' && input.nextActivity === 'idle') {
      // Verified native turn completion signal!
      nextState = 'finished';
      reliable = true;
      detail = 'CLI finished turn';
    } else if (input.nextActivity === 'idle') {
      // If already finished and not yet acknowledged, persist 'finished'!
      if (existing?.state === 'finished') {
        return;
      }
      nextState = 'idle';
      reliable = true;
      detail = 'CLI idle';
    } else if (input.nextActivity === 'awaiting-user' || input.nextActivity === 'awaiting-permission') {
      // Needs input or permission
      nextState = 'working';
      reliable = true;
      detail = 'Awaiting user input or permission';
    } else {
      nextState = 'unknown';
      reliable = false;
    }

    // Finished persists until acknowledged by opening tab
    if (existing?.state === 'finished' && nextState === 'idle') {
      return;
    }

    const record: TabActivityRecord = {
      workspaceId: input.workspaceId,
      tabId: input.tabId,
      sessionId: input.sessionId,
      state: nextState,
      updatedAt: NOW(),
      reliableSignal: reliable,
      source: 'cli',
      detail,
    };
    this.states.set(key, record);
    this.emit('tabActivity', record);

    // Create notification upon entering finished or failed
    if (nextState === 'finished' && reliable) {
      const tabLabel = input.tabName || 'CLI Agent';
      await this.notificationStore.create({
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        tabId: input.tabId,
        sessionId: input.sessionId,
        title: tabLabel,
        body: 'Agent completed task',
        state: 'finished',
        deduplicationKey: `cli-finish:${input.workspaceId}:${input.tabId}:${Math.floor(Date.now() / 60_000)}`,
      });
    } else if (nextState === 'failed' && reliable) {
      const tabLabel = input.tabName || 'CLI Agent';
      await this.notificationStore.create({
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        tabId: input.tabId,
        sessionId: input.sessionId,
        title: tabLabel,
        body: detail || 'Agent encountered an error',
        state: 'failed',
        deduplicationKey: `cli-fail:${input.workspaceId}:${input.tabId}:${Math.floor(Date.now() / 60_000)}`,
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
      // Initialize state to unknown until integration signals are received
      this.states.set(key, {
        workspaceId,
        tabId,
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        state: 'unknown',
        updatedAt: NOW(),
        reliableSignal: false,
        source: 'shell',
        detail: 'Awaiting shell integration hooks',
      });

      parser.on('state', (state: MawActivityState, detail?: string) => {
        const existing = this.states.get(key);
        // 'finished' persists until acknowledged
        if (existing?.state === 'finished' && state === 'idle') {
          return;
        }

        const record: TabActivityRecord = {
          workspaceId,
          tabId,
          ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
          state,
          updatedAt: NOW(),
          reliableSignal: parser!.isIntegrationEstablished(),
          source: 'shell',
          ...(detail ? { detail } : {}),
        };
        this.states.set(key, record);
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
            deduplicationKey: `shell-finish:${workspaceId}:${tabId}:${Math.floor(Date.now() / 60_000)}`,
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
            deduplicationKey: `shell-fail:${workspaceId}:${tabId}:${Math.floor(Date.now() / 60_000)}`,
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
    this.states.clear();
    this.browserProviders.clear();
    this.removeAllListeners();
  }
}

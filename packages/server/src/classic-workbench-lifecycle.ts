/**
 * Lifecycle coordinator for legacy Classic Workbench services.
 *
 * In MAW Next-Generation, Agency mode is the primary runtime view. Eagerly
 * starting Classic Workbench services (SessionIndex, VaultService, and
 * watchSessions) on server boot attaches thousands of inotify filesystem
 * watchers across ~/.claude/projects, ~/.codex/sessions, etc., and parses
 * history trees, spiking server RSS and cold start latency.
 *
 * ClassicWorkbenchLifecycle defers starting these legacy indexers and filesystem
 * watchers until classic mode is actively used (e.g. non-agency WS connection,
 * classic API/WS message, or MAW_EAGER_CLASSIC=1).
 */

import type { SessionIndex } from './session-index.js';
import type { VaultService } from './vault/service.js';
import type { ConversationHub } from './conversation-hub.js';
import type { AgentRegistry } from './agents/registry.js';
import { watchSessions } from './session-watcher.js';

export interface ClassicWorkbenchServices {
  readonly index: SessionIndex;
  readonly vault: VaultService;
  readonly conversations: ConversationHub;
  readonly agents: AgentRegistry;
}

export interface ClassicLifecycleOptions {
  /** If true, initialize immediately on instantiation instead of deferring. */
  readonly eager?: boolean;
  /** Optional custom watcher factory for testing. */
  readonly watchSessionsFn?: typeof watchSessions;
}

export class ClassicWorkbenchLifecycle {
  private started = false;
  private startPromise: Promise<void> | null = null;
  private stopWatching: (() => void) | null = null;
  private onHistoryGrew: ((agent: any, filePath: string) => void) | null = null;
  private disposed = false;

  constructor(
    private readonly services: ClassicWorkbenchServices,
    private readonly options: ClassicLifecycleOptions = {},
  ) {
    if (options.eager || process.env['MAW_EAGER_CLASSIC'] === '1') {
      void this.ensureStarted();
    }
  }

  /** True once Classic Workbench indexing and watchers have fully started. */
  isStarted(): boolean {
    return this.started;
  }

  /** True if initialization has been requested and is currently in-flight. */
  isStarting(): boolean {
    return this.startPromise !== null && !this.started;
  }

  /**
   * Idempotently starts SessionIndex, VaultService, and session filesystem watchers.
   * Concurrent callers receive the same Promise.
   */
  async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new Error('Cannot start ClassicWorkbenchLifecycle after disposal');
    }
    if (this.started) return;
    if (this.startPromise !== null) return this.startPromise;

    this.startPromise = (async () => {
      // 1. Start the SessionIndex (loads cache and scans session history)
      await this.services.index.start();

      if (this.disposed) return;

      // 2. Start the VaultService
      this.services.vault.start();

      // 3. Attach history filesystem watchers (inotify / chokidar)
      const watcherFn = this.options.watchSessionsFn ?? watchSessions;
      this.stopWatching = watcherFn(
        this.services.index,
        this.services.conversations,
        this.services.agents,
      );

      // 4. Hook conversation growing events
      this.onHistoryGrew = (agent, filePath) => {
        void this.services.index.refreshPath(agent, filePath);
      };
      this.services.conversations.on('historyGrew', this.onHistoryGrew);

      this.started = true;
    })().catch((error) => {
      // Allow retry if starting failed
      this.startPromise = null;
      throw error;
    });

    return this.startPromise;
  }

  /**
   * Shuts down filesystem watchers, unbinds conversation listeners, and disposes VaultService.
   */
  dispose(): void {
    this.disposed = true;
    if (this.stopWatching !== null) {
      this.stopWatching();
      this.stopWatching = null;
    }
    if (this.onHistoryGrew !== null) {
      this.services.conversations.off('historyGrew', this.onHistoryGrew);
      this.onHistoryGrew = null;
    }
    this.services.vault.dispose();
    this.started = false;
    this.startPromise = null;
  }
}

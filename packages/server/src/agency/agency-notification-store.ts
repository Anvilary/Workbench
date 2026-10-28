/**
 * MAW Lane C - Server-Side Durable Notification Store.
 *
 * Requirements:
 *   - Preserves notifications across MAW browser refresh and server restart.
 *   - Atomic write and .bak backup resilience (matching AgencySessionStore).
 *   - In-memory fast access with serialized disk persistence queue.
 *   - Deduplication of repeated completion events via deduplicationKey.
 *   - Toast dismissal does NOT delete inbox history.
 *   - Reading an inbox item vs acknowledging tab completion are distinct.
 */

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type {
  MawActivityState,
  MawNotificationItem,
  ProjectId,
  RuntimeSessionId,
  WorkspaceId,
} from '@agent-workbench/shared';
import { isMawNotificationItem } from '@agent-workbench/shared';
import { writeAtomically } from '../atomic-write.js';
import { appConfigDir } from '../paths.js';

const VERSION = 1;
const NOW = (): string => new Date().toISOString();

export interface CreateNotificationInput {
  workspaceId: WorkspaceId;
  projectId?: ProjectId;
  tabId: string;
  sessionId?: RuntimeSessionId;
  title: string;
  body: string;
  state: MawActivityState;
  deduplicationKey?: string;
  metadata?: Record<string, unknown>;
}

export class AgencyNotificationStore extends EventEmitter {
  private queue: Promise<void> = Promise.resolve();
  private readonly notifications = new Map<string, MawNotificationItem>();
  private readonly deduplicationIndex = new Map<string, { id: string; createdAt: number }>();
  private initialized = false;

  constructor(readonly file: string = path.join(appConfigDir(), 'agency-notifications.json')) {
    super();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const loaded = await this.load();
    for (const item of loaded) {
      this.notifications.set(item.id, item);
      if (item.deduplicationKey) {
        this.deduplicationIndex.set(item.deduplicationKey, {
          id: item.id,
          createdAt: Date.parse(item.createdAt),
        });
      }
    }
    this.initialized = true;
  }

  async load(): Promise<MawNotificationItem[]> {
    let primaryMissing = false;
    let primaryFailure: unknown = null;

    try {
      const contents = await readFile(this.file, 'utf8');
      return this.parse(contents);
    } catch (error) {
      primaryMissing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      primaryFailure = error;
    }

    try {
      const backupContents = await readFile(this.file + '.bak', 'utf8');
      return this.parse(backupContents);
    } catch (backupError) {
      const backupMissing = (backupError as NodeJS.ErrnoException).code === 'ENOENT';
      if (primaryMissing && backupMissing) {
        return [];
      }
      throw new AggregateError([primaryFailure, backupError], 'Agency notification metadata could not be recovered');
    }
  }

  private parse(contents: string): MawNotificationItem[] {
    const raw: unknown = JSON.parse(contents);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid notification store format');
    }
    const root = raw as Record<string, unknown>;
    if (root['version'] !== VERSION || !Array.isArray(root['notifications'])) {
      throw new Error('Unsupported notification store version or shape');
    }
    const items: MawNotificationItem[] = [];
    for (const item of root['notifications']) {
      if (!isMawNotificationItem(item)) {
        throw new Error('Invalid notification item shape');
      }
      items.push(item);
    }
    return items;
  }

  list(workspaceId?: WorkspaceId): MawNotificationItem[] {
    const all = [...this.notifications.values()];
    const filtered = workspaceId ? all.filter((item) => item.workspaceId === workspaceId) : all;
    return filtered.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  get(id: string): MawNotificationItem | null {
    return this.notifications.get(id) ?? null;
  }

  unreadCount(workspaceId?: WorkspaceId): number {
    return this.list(workspaceId).filter((item) => !item.read).length;
  }

  /**
   * Creates a notification with automatic deduplication by stable event/task ID.
   * If a notification with the same deduplicationKey already exists, returns null.
   */
  async create(input: CreateNotificationInput): Promise<MawNotificationItem | null> {
    if (input.deduplicationKey) {
      const existing = this.deduplicationIndex.get(input.deduplicationKey);
      if (existing) {
        // Stable task or event ID already alerted: deduplicate
        return null;
      }
    }

    const id = randomUUID();
    const now = NOW();
    const item: MawNotificationItem = {
      id,
      workspaceId: input.workspaceId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      tabId: input.tabId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      title: input.title,
      body: input.body,
      state: input.state,
      read: false,
      createdAt: now,
      readAt: null,
      dismissedAt: null,
      acknowledgedAt: null,
      ...(input.deduplicationKey ? { deduplicationKey: input.deduplicationKey } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    this.notifications.set(id, item);
    if (input.deduplicationKey) {
      this.deduplicationIndex.set(input.deduplicationKey, { id, createdAt: Date.now() });
    }

    await this.persist();
    this.emit('created', item);
    this.emit('changed', item);
    return item;
  }

  async markRead(notificationId: string): Promise<MawNotificationItem | null> {
    const existing = this.notifications.get(notificationId);
    if (!existing) return null;
    if (existing.read) return existing;

    const updated: MawNotificationItem = {
      ...existing,
      read: true,
      readAt: NOW(),
    };

    this.notifications.set(notificationId, updated);
    await this.persist();
    this.emit('changed', updated);
    return updated;
  }

  async markAllRead(): Promise<MawNotificationItem[]> {
    const changed: MawNotificationItem[] = [];
    const now = NOW();

    for (const [id, item] of this.notifications) {
      if (!item.read) {
        const updated: MawNotificationItem = {
          ...item,
          read: true,
          readAt: now,
        };
        this.notifications.set(id, updated);
        changed.push(updated);
        this.emit('changed', updated);
      }
    }

    if (changed.length > 0) {
      await this.persist();
    }
    return changed;
  }

  /**
   * Dismisses a toast without deleting from inbox history.
   */
  async dismiss(notificationId: string): Promise<MawNotificationItem | null> {
    const existing = this.notifications.get(notificationId);
    if (!existing) return null;

    const updated: MawNotificationItem = {
      ...existing,
      dismissedAt: NOW(),
    };

    this.notifications.set(notificationId, updated);
    await this.persist();
    this.emit('changed', updated);
    return updated;
  }

  async acknowledge(notificationId: string): Promise<MawNotificationItem | null> {
    const existing = this.notifications.get(notificationId);
    if (!existing) return null;

    const updated: MawNotificationItem = {
      ...existing,
      acknowledgedAt: NOW(),
    };

    this.notifications.set(notificationId, updated);
    await this.persist();
    this.emit('changed', updated);
    return updated;
  }

  private async persist(): Promise<void> {
    const items = [...this.notifications.values()];
    const serialized = Buffer.from(
      JSON.stringify({ version: VERSION, notifications: items }, null, 2) + '\n',
      'utf8',
    );

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

  dispose(): void {
    this.notifications.clear();
    this.deduplicationIndex.clear();
    this.removeAllListeners();
  }
}

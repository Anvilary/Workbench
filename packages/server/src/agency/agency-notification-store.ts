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

import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
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
const MAX_NOTIFICATIONS = 150;
const MAX_DEDUP_INDEX_SIZE = 1000;

class UnsupportedAgencyNotificationSchemaError extends Error {
  constructor(version: unknown) {
    super('Unsupported Agency notification store version: ' + String(version));
    this.name = 'UnsupportedAgencyNotificationSchemaError';
  }
}
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
  private mutations: Promise<void> = Promise.resolve();
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
      if (error instanceof UnsupportedAgencyNotificationSchemaError) throw error;
      primaryMissing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      primaryFailure = error;
    }

    let recovered;
    try {
      const backupContents = await readFile(this.file + '.bak', 'utf8');
      recovered = this.parse(backupContents);
    } catch (backupError) {
      if (backupError instanceof UnsupportedAgencyNotificationSchemaError) throw backupError;
      const backupMissing = (backupError as NodeJS.ErrnoException).code === 'ENOENT';
      if (primaryMissing && backupMissing) {
        return [];
      }
      throw new AggregateError([primaryFailure, backupError], 'Agency notification metadata could not be recovered');
    }
    // A subsequent save copies the primary to .bak. Never let damaged bytes
    // replace the validated recovery copy. Refuse recovery if preservation fails.
    if (!primaryMissing) await rename(this.file, this.file + '.corrupt-' + randomUUID());
    return recovered;
  }

  private parse(contents: string): MawNotificationItem[] {
    const raw: unknown = JSON.parse(contents);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid notification store format');
    }
    const root = raw as Record<string, unknown>;
    if (!Number.isInteger(root['version'])) throw new Error('Invalid notification store version');
    if (root['version'] !== VERSION) throw new UnsupportedAgencyNotificationSchemaError(root['version']);
    if (!Array.isArray(root['notifications'])) throw new Error('Invalid notification store shape');
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

  hasDeduplicationKey(key: string): boolean {
    return this.deduplicationIndex.has(key);
  }

  unreadCount(workspaceId?: WorkspaceId): number {
    return this.list(workspaceId).filter((item) => !item.read && !item.acknowledgedAt).length;
  }

  /**
   * Creates a notification with automatic deduplication by stable event/task ID.
   * If a notification with the same deduplicationKey already exists, returns null.
   */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation);
    this.mutations = next.then(() => undefined, () => undefined);
    return next;
  }

  create(input: CreateNotificationInput): Promise<MawNotificationItem | null> {
    return this.mutate(() => this.createItem(input));
  }

  private async createItem(input: CreateNotificationInput): Promise<MawNotificationItem | null> {
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

    // Bound inbox retention: prune oldest acknowledged and read items if capacity exceeded
    if (this.notifications.size > MAX_NOTIFICATIONS) {
      const candidates = [...this.notifications.values()]
        .filter((n) => n.read && n.acknowledgedAt && n.id !== id)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const excess = this.notifications.size - MAX_NOTIFICATIONS;
      for (let i = 0; i < Math.min(excess, candidates.length); i++) {
        const victim = candidates[i];
        if (victim) this.notifications.delete(victim.id);
      }
    }

    // Bound deduplication index retention: retain a safe replay horizon while
    // evicting ancient keys for items that were already pruned from the inbox.
    if (this.deduplicationIndex.size > MAX_DEDUP_INDEX_SIZE) {
      for (const [key, entry] of this.deduplicationIndex) {
        if (!this.notifications.has(entry.id)) {
          this.deduplicationIndex.delete(key);
          if (this.deduplicationIndex.size <= MAX_DEDUP_INDEX_SIZE) break;
        }
      }
    }

    try { await this.persist(); }
    catch (error) {
      if (this.notifications.get(id) === item) this.notifications.delete(id);
      if (input.deduplicationKey) this.deduplicationIndex.delete(input.deduplicationKey);
      throw error;
    }
    this.emit('created', item);
    this.emit('changed', item);
    return item;
  }

  markRead(notificationId: string): Promise<MawNotificationItem | null> {
    return this.mutate(() => this.markReadItem(notificationId));
  }

  private async markReadItem(notificationId: string): Promise<MawNotificationItem | null> {
    const existing = this.notifications.get(notificationId);
    if (!existing) return null;
    if (existing.read) return existing;

    const updated: MawNotificationItem = {
      ...existing,
      read: true,
      readAt: NOW(),
    };

    this.notifications.set(notificationId, updated);
    try { await this.persist(); }
    catch (error) {
      if (this.notifications.get(notificationId) === updated) this.notifications.set(notificationId, existing);
      throw error;
    }
    this.emit('changed', updated);
    return updated;
  }

  markAllRead(): Promise<MawNotificationItem[]> {
    return this.mutate(() => this.markAllReadItems());
  }

  private async markAllReadItems(): Promise<MawNotificationItem[]> {
    const changed: MawNotificationItem[] = [];
    const previous = new Map(this.notifications);
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
      }
    }

    if (changed.length > 0) {
      try { await this.persist(); }
      catch (error) {
        for (const item of changed) if (this.notifications.get(item.id) === item) this.notifications.set(item.id, previous.get(item.id)!);
        throw error;
      }
      for (const item of changed) this.emit('changed', item);
    }
    return changed;
  }

  /**
   * Dismisses a toast without deleting from inbox history.
   */
  dismiss(notificationId: string): Promise<MawNotificationItem | null> {
    return this.mutate(() => this.dismissItem(notificationId));
  }

  private async dismissItem(notificationId: string): Promise<MawNotificationItem | null> {
    const existing = this.notifications.get(notificationId);
    if (!existing) return null;

    const updated: MawNotificationItem = {
      ...existing,
      dismissedAt: NOW(),
    };

    this.notifications.set(notificationId, updated);
    try { await this.persist(); }
    catch (error) {
      if (this.notifications.get(notificationId) === updated) this.notifications.set(notificationId, existing);
      throw error;
    }
    this.emit('changed', updated);
    return updated;
  }

  acknowledge(notificationId: string): Promise<MawNotificationItem | null> {
    return this.mutate(() => this.acknowledgeItem(notificationId));
  }

  purgeWorkspace(workspaceId: WorkspaceId): Promise<number> {
    return this.mutate(() => this.purgeMatching((item) => item.workspaceId === workspaceId));
  }

  purgeProject(projectId: ProjectId): Promise<number> {
    return this.mutate(() => this.purgeMatching((item) => item.projectId === projectId));
  }

  private async purgeMatching(predicate: (item: MawNotificationItem) => boolean): Promise<number> {
    const removedItems: MawNotificationItem[] = [];
    const removedDedup: Array<[string, { id: string; createdAt: number }]> = [];

    for (const [id, item] of this.notifications) {
      if (predicate(item)) {
        removedItems.push(item);
        this.notifications.delete(id);
        if (item.deduplicationKey) {
          const entry = this.deduplicationIndex.get(item.deduplicationKey);
          if (entry && entry.id === id) {
            removedDedup.push([item.deduplicationKey, entry]);
            this.deduplicationIndex.delete(item.deduplicationKey);
          }
        }
      }
    }

    if (removedItems.length === 0) return 0;

    try {
      await this.persist();
    } catch (error) {
      for (const item of removedItems) {
        this.notifications.set(item.id, item);
      }
      for (const [key, entry] of removedDedup) {
        this.deduplicationIndex.set(key, entry);
      }
      throw error;
    }

    return removedItems.length;
  }

  private async acknowledgeItem(notificationId: string): Promise<MawNotificationItem | null> {
    const existing = this.notifications.get(notificationId);
    if (!existing) return null;

    const now = NOW();
    const updated: MawNotificationItem = {
      ...existing,
      acknowledgedAt: existing.acknowledgedAt ?? now,
      read: true,
      readAt: existing.readAt ?? now,
      dismissedAt: existing.dismissedAt ?? now,
    };

    this.notifications.set(notificationId, updated);
    try { await this.persist(); }
    catch (error) {
      if (this.notifications.get(notificationId) === updated) this.notifications.set(notificationId, existing);
      throw error;
    }
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
    return this.mutations.then(() => this.queue);
  }

  dispose(): void {
    this.notifications.clear();
    this.deduplicationIndex.clear();
    this.removeAllListeners();
  }
}

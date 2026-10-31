import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  type WorkspaceId,
  type WorkspacePaneLayout,
  isWorkspacePaneLayout,
} from '@agent-workbench/shared';
import { writeAtomically } from '../atomic-write.js';
import { appConfigDir } from '../paths.js';

const VERSION = 1;

export class AgencyLayoutStore {
  private queue: Promise<void> = Promise.resolve();
  private mutations: Promise<void> = Promise.resolve();
  private readonly layouts = new Map<WorkspaceId, WorkspacePaneLayout>();
  private initialized = false;

  constructor(
    readonly file: string = path.join(appConfigDir(), 'agency-layouts.json'),
    private readonly write: typeof writeAtomically = writeAtomically,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const loaded = await this.load();
    for (const layout of loaded) {
      this.layouts.set(layout.workspaceId, layout);
    }
    this.initialized = true;
  }

  async load(): Promise<WorkspacePaneLayout[]> {
    let primaryMissing = false;
    let primaryFailure: unknown = null;

    try {
      const contents = await readFile(this.file, 'utf8');
      return this.parse(contents);
    } catch (error) {
      primaryMissing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      primaryFailure = error;
    }

    let recovered: WorkspacePaneLayout[] = [];
    try {
      const backupContents = await readFile(this.file + '.bak', 'utf8');
      recovered = this.parse(backupContents);
    } catch (backupError) {
      const backupMissing = (backupError as NodeJS.ErrnoException).code === 'ENOENT';
      if (primaryMissing && backupMissing) {
        return [];
      }
      throw new AggregateError([primaryFailure, backupError], 'Agency layout store could not be recovered');
    }

    if (!primaryMissing) {
      await rename(this.file, this.file + '.corrupt-' + randomUUID()).catch(() => {});
    }
    return recovered;
  }

  private parse(contents: string): WorkspacePaneLayout[] {
    const raw: unknown = JSON.parse(contents);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid Agency layout store: expected object');
    }
    const record = raw as Record<string, unknown>;
    if (record.version !== VERSION) {
      throw new Error(`Unsupported Agency layout store version: ${record.version}`);
    }
    if (!Array.isArray(record.layouts)) {
      throw new Error('Invalid Agency layout store: layouts must be an array');
    }
    const valid: WorkspacePaneLayout[] = [];
    for (const item of record.layouts) {
      if (isWorkspacePaneLayout(item)) {
        valid.push(item);
      }
    }
    return valid;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation);
    this.mutations = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Write `layouts` without publishing them into memory first.
   * A rejected write leaves the queue usable so the next save can persist.
   */
  private async persist(layouts: Iterable<WorkspacePaneLayout>): Promise<void> {
    const payload = JSON.stringify({
      version: VERSION,
      layouts: [...layouts],
    }, null, 2);

    const write = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await copyFile(this.file, this.file + '.bak').catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      });
      await this.write(this.file, Buffer.from(payload, 'utf8'), { mode: 0o600 });
    });
    this.queue = write.then(() => undefined, () => undefined);
    return write;
  }

  get(workspaceId: WorkspaceId): WorkspacePaneLayout | undefined {
    return this.layouts.get(workspaceId);
  }

  list(): WorkspacePaneLayout[] {
    return [...this.layouts.values()];
  }

  async save(layout: WorkspacePaneLayout): Promise<void> {
    if (!isWorkspacePaneLayout(layout)) {
      throw new Error('Invalid WorkspacePaneLayout payload');
    }
    return this.mutate(async () => {
      const next = new Map(this.layouts);
      next.set(layout.workspaceId, layout);
      await this.persist(next.values());
      this.layouts.set(layout.workspaceId, layout);
    });
  }

  async delete(workspaceId: WorkspaceId): Promise<void> {
    return this.mutate(async () => {
      if (!this.layouts.has(workspaceId)) return;
      const next = new Map(this.layouts);
      next.delete(workspaceId);
      await this.persist(next.values());
      this.layouts.delete(workspaceId);
    });
  }

  flush(): Promise<void> {
    return this.mutations.then(() => this.queue);
  }
}
